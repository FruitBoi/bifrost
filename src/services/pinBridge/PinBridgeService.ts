import {
    Message as DiscordMessage,
    MessageType as DiscordMessageType,
    OmitPartialGroupDMChannel,
} from 'discord.js';
import {
    Message as FluxerMessage,
    MessageType as FluxerMessageType,
} from '@fluxerjs/core';
import logger from '../../utils/logging/logger';
import {
    isFluxerApiBlockError,
    isFluxerApiBlocked,
    markFluxerApiBlocked,
} from '../../utils/fluxerApiGuard';
import {
    ChannelLink,
    discordLocationId,
    fluxerLocationId,
} from '../../db/entities/ChannelLink';
import { GuildLink } from '../../db/entities/GuildLink';
import { MessageLink } from '../../db/entities/MessageLink';
import type DiscordEntityResolver from '../entityResolver/DiscordEntityResolver';
import type FluxerEntityResolver from '../entityResolver/FluxerEntityResolver';
import type { LinkService } from '../LinkService';
import type MetricsService from '../MetricsService';
import type DiscordToFluxerMessageRelay from '../messageRelay/DiscordToFluxerMessageRelay';
import type FluxerToDiscordMessageRelay from '../messageRelay/FluxerToDiscordMessageRelay';
import {
    fetchAllDiscordPins,
    fetchAllFluxerPins,
    isDiscordPinsChannel,
    isFluxerPinsChannel,
    PinEntry,
    PinnableMessage,
} from './pinChannels';

type Platform = 'discord' | 'fluxer';
type DiscordPinnedMessage = OmitPartialGroupDMChannel<DiscordMessage<boolean>>;

/** A pin of either side, tagged with the side it lives on. */
type SidedPin =
    | ({ platform: 'discord' } & PinEntry<DiscordPinnedMessage>)
    | ({ platform: 'fluxer' } & PinEntry<FluxerMessage>);

/** The last known pinned message ids of each side of one channel link. */
interface PinSnapshots {
    discord?: Set<string>;
    fluxer?: Set<string>;
}

/** Outcome of putting a message into a pin state. */
type PinOutcome = 'changed' | 'unchanged' | 'missing';

/** Only plain messages and replies are copied; everything else is a system message. */
const DISCORD_CONTENT_TYPES = new Set<number>([
    DiscordMessageType.Default,
    DiscordMessageType.Reply,
]);
const FLUXER_CONTENT_TYPES = new Set<number>([
    FluxerMessageType.Default,
    FluxerMessageType.Reply,
]);

const DEFAULT_DELAY_MS = 1000;

const PLATFORM_NAME: Record<Platform, string> = {
    discord: 'Discord',
    fluxer: 'Fluxer',
};

function otherSide(platform: Platform): Platform {
    return platform === 'discord' ? 'fluxer' : 'discord';
}

/** Metrics label for changes flowing from `source` to the other side. */
function directionFrom(source: Platform): string {
    return source === 'discord' ? 'discord_to_fluxer' : 'fluxer_to_discord';
}

function errorStatus(err: unknown): { status?: unknown; code?: unknown } {
    if (typeof err !== 'object' || err === null) return {};
    const { status, statusCode, httpStatus, code } = err as {
        status?: unknown;
        statusCode?: unknown;
        httpStatus?: unknown;
        code?: unknown;
    };
    return { status: status ?? statusCode ?? httpStatus, code };
}

/** The message (or its channel) is gone: nothing left to pin or unpin. */
function isUnknownError(err: unknown): boolean {
    const { status, code } = errorStatus(err);
    return (
        status === 404 ||
        code === 10008 ||
        code === 10003 ||
        code === 'UNKNOWN_MESSAGE' ||
        code === 'UNKNOWN_CHANNEL'
    );
}

/** Pinning something already pinned is rejected by some APIs with a 409. */
function isConflictError(err: unknown): boolean {
    return errorStatus(err).status === 409;
}

const sleep = (ms: number) =>
    ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();

/** Counts of a {@link PinBridgeService.syncPastPins} run. */
export interface PinSyncResult {
    /** Already-bridged messages newly pinned on Discord. */
    pinnedOnDiscord: number;
    /** Already-bridged messages newly pinned on Fluxer. */
    pinnedOnFluxer: number;
    /** Unbridged pinned Fluxer messages copied to Discord (then pinned). */
    copiedToDiscord: number;
    /** Unbridged pinned Discord messages copied to Fluxer (then pinned). */
    copiedToFluxer: number;
    /** Pinned on both sides already. */
    alreadyInSync: number;
    failed: number;
    /**
     * Unbridged pins that cannot be mirrored and were left alone: copies
     * posted by this link's own webhooks that lost their message link, and
     * system messages.
     */
    skipped?: number;
}

export class PinSyncError extends Error {
    constructor(
        public readonly reason: 'already_running' | 'fluxer_blocked',
        message: string
    ) {
        super(message);
        this.name = 'PinSyncError';
    }
}

/**
 * Mirrors pinned messages between the two sides of channel links (issue #33).
 *
 * Neither platform's pins-update event says which message changed, so each
 * event re-reads the location's pins and diffs them against an in-memory
 * snapshot of the last known pinned ids of that side. Additions and removals
 * of bridged messages are applied to their counterparts; unbridged messages
 * are left alone (only `syncPastPins` copies those over).
 *
 * Whenever the bot pins or unpins on a side it records that in the side's
 * snapshot right away, so the pins-update event its own change triggers sees
 * no difference and nothing bounces back. All work on one channel link runs
 * one after another, so events and syncs never interleave.
 */
export default class PinBridgeService {
    private readonly linkService: LinkService;
    private readonly discordEntityResolver: DiscordEntityResolver;
    private readonly fluxerEntityResolver: FluxerEntityResolver;
    private readonly metricsService?: MetricsService;
    private readonly delayMs: number;

    private discordRelay: DiscordToFluxerMessageRelay | null = null;
    private fluxerRelay: FluxerToDiscordMessageRelay | null = null;

    /** Channel link id → last known pins of each side. */
    private readonly snapshots = new Map<string, PinSnapshots>();
    /** Channel link id → tail of the work queued for that link. */
    private readonly chains = new Map<string, Promise<void>>();
    /** Channel link ids with a `syncPastPins` queued or running. */
    private readonly syncing = new Set<string>();

    constructor({
        linkService,
        discordEntityResolver,
        fluxerEntityResolver,
        metricsService,
        delayMs = DEFAULT_DELAY_MS,
    }: {
        linkService: LinkService;
        discordEntityResolver: DiscordEntityResolver;
        fluxerEntityResolver: FluxerEntityResolver;
        metricsService?: MetricsService;
        /** Pause between copies in `syncPastPins` (a quarter of it between pins). */
        delayMs?: number;
    }) {
        this.linkService = linkService;
        this.discordEntityResolver = discordEntityResolver;
        this.fluxerEntityResolver = fluxerEntityResolver;
        this.metricsService = metricsService;
        this.delayMs = delayMs;
    }

    /** The relay `syncPastPins` copies unbridged Discord pins with. */
    setDiscordRelay(relay: DiscordToFluxerMessageRelay): void {
        this.discordRelay = relay;
    }

    /** The relay `syncPastPins` copies unbridged Fluxer pins with. */
    setFluxerRelay(relay: FluxerToDiscordMessageRelay): void {
        this.fluxerRelay = relay;
    }

    /** Discord CHANNEL_PINS_UPDATE for a channel or thread id. Never throws. */
    async handleDiscordPinsUpdate(discordChannelId: string): Promise<void> {
        await this.handlePinsUpdate('discord', discordChannelId);
    }

    /** Fluxer ChannelPinsUpdate for a channel or thread id. Never throws. */
    async handleFluxerPinsUpdate(fluxerChannelId: string): Promise<void> {
        await this.handlePinsUpdate('fluxer', fluxerChannelId);
    }

    /**
     * `pins sync`: unions the pins of both sides of one channel link. Bridged
     * messages pinned on one side only get pinned on the other; unbridged
     * pinned messages are copied over through the message relay, linked and
     * pinned. Pins are replayed oldest first so the newest ends up on top.
     *
     * Throws {@link PinSyncError} `already_running` when a sync of the link is
     * already queued or running, and `fluxer_blocked` when the Fluxer API is
     * blocked (before starting or while running). Per-message failures are
     * counted in the result instead.
     */
    async syncPastPins(channelLink: ChannelLink): Promise<PinSyncResult> {
        if (this.syncing.has(channelLink.id)) {
            throw new PinSyncError(
                'already_running',
                'A pin sync of this channel is already running'
            );
        }
        if (isFluxerApiBlocked()) {
            throw new PinSyncError(
                'fluxer_blocked',
                'The Fluxer API is temporarily blocked'
            );
        }

        this.syncing.add(channelLink.id);
        try {
            return await this.enqueue(channelLink.id, () =>
                this.runSync(channelLink)
            );
        } catch (error) {
            if (isFluxerApiBlockError(error)) {
                markFluxerApiBlocked();
                throw new PinSyncError(
                    'fluxer_blocked',
                    'The Fluxer API is temporarily blocked'
                );
            }
            throw error;
        } finally {
            this.syncing.delete(channelLink.id);
        }
    }

    private async handlePinsUpdate(
        source: Platform,
        locationId: string
    ): Promise<void> {
        try {
            const channelLink =
                source === 'discord'
                    ? await this.linkService.getChannelLinkByDiscordLocation(
                          locationId
                      )
                    : await this.linkService.getChannelLinkByFluxerLocation(
                          locationId
                      );
            if (!channelLink) return;

            await this.enqueue(channelLink.id, () =>
                this.processPinsUpdate(channelLink, source)
            );
        } catch (error) {
            if (isFluxerApiBlockError(error)) markFluxerApiBlocked();
            logger.error(
                `❌ Error mirroring ${PLATFORM_NAME[source]} pins of channel ${locationId}:`,
                error
            );
            this.metricsService?.pinRelayErrors.inc({
                direction: directionFrom(source),
            });
        }
    }

    /**
     * Diffs the source side's pins against its snapshot and applies the
     * difference to the counterparts. Without a snapshot (first event since
     * start) removals are unknown, so only additions are mirrored.
     */
    private async processPinsUpdate(
        channelLink: ChannelLink,
        source: Platform
    ): Promise<void> {
        // Both sides are needed; leaving the snapshot untouched lets the next
        // event catch up on what changed meanwhile.
        if (isFluxerApiBlocked()) {
            logger.debug(
                `📌 Fluxer API blocked, not mirroring ${PLATFORM_NAME[source]} pins of link ${channelLink.id}`
            );
            return;
        }

        const guildLink = await this.linkService.getGuildLinkById(
            channelLink.guildLinkId
        );
        if (!guildLink) return;

        const current = new Set(
            (await this.listPins(source, channelLink, guildLink)).map(
                (pin) => pin.id
            )
        );
        const snapshots = this.snapshotsFor(channelLink.id);
        const previous = snapshots[source];

        const added = [...current].filter((id) => !previous?.has(id));
        const removed = previous
            ? [...previous].filter((id) => !current.has(id))
            : [];

        for (const id of added) {
            await this.mirrorPin(channelLink, guildLink, source, id, true);
        }
        for (const id of removed) {
            await this.mirrorPin(channelLink, guildLink, source, id, false);
        }

        snapshots[source] = current;
    }

    /**
     * Puts the counterpart of a bridged source message into the given pin
     * state. Unbridged messages are ignored. Errors are logged and counted,
     * except a Fluxer API block, which aborts the whole event.
     */
    private async mirrorPin(
        channelLink: ChannelLink,
        guildLink: GuildLink,
        source: Platform,
        sourceMessageId: string,
        pinned: boolean
    ): Promise<void> {
        const direction = directionFrom(source);
        try {
            const messageLink = await this.findMessageLink(
                source,
                sourceMessageId
            );
            if (!messageLink) return;

            const target = otherSide(source);
            const outcome = await this.setPinned(
                target,
                channelLink,
                guildLink,
                counterpartId(source, messageLink),
                pinned
            );
            if (outcome === 'changed') {
                logger.debug(
                    `📌 ${pinned ? 'Pinned' : 'Unpinned'} ${PLATFORM_NAME[target]} copy of ${PLATFORM_NAME[source]} message ${sourceMessageId}`
                );
                this.metricsService?.pinsRelayed.inc({ direction });
            }
        } catch (error) {
            if (isFluxerApiBlockError(error)) throw error;
            logger.error(
                `❌ Error ${pinned ? 'pinning' : 'unpinning'} counterpart of ${PLATFORM_NAME[source]} message ${sourceMessageId}:`,
                error
            );
            this.metricsService?.pinRelayErrors.inc({ direction });
        }
    }

    private async runSync(channelLink: ChannelLink): Promise<PinSyncResult> {
        const guildLink = await this.linkService.getGuildLinkById(
            channelLink.guildLinkId
        );
        if (!guildLink) {
            throw new Error(`Guild link ${channelLink.guildLinkId} not found`);
        }

        const [discordPins, fluxerPins] = await Promise.all([
            this.listDiscordPins(channelLink, guildLink),
            this.listFluxerPins(channelLink, guildLink),
        ]);

        // The fetched pins become the snapshots right away: every pin made
        // below is recorded in them, so the events it triggers stay quiet.
        const snapshots = this.snapshotsFor(channelLink.id);
        snapshots.discord = new Set(discordPins.map((pin) => pin.id));
        snapshots.fluxer = new Set(fluxerPins.map((pin) => pin.id));

        const pins: SidedPin[] = [
            ...discordPins.map((pin) => ({
                platform: 'discord' as const,
                ...pin,
            })),
            ...fluxerPins.map((pin) => ({
                platform: 'fluxer' as const,
                ...pin,
            })),
        ].sort((a, b) => a.pinnedAt - b.pinnedAt);

        const result: PinSyncResult = {
            pinnedOnDiscord: 0,
            pinnedOnFluxer: 0,
            copiedToDiscord: 0,
            copiedToFluxer: 0,
            alreadyInSync: 0,
            failed: 0,
            skipped: 0,
        };
        // Message links already handled through the pin on the other side.
        const seen = new Set<string>();

        logger.info(
            `📌 Syncing ${discordPins.length} Discord and ${fluxerPins.length} Fluxer pins of link ${channelLink.id}`
        );

        for (const pin of pins) {
            let action: 'copied' | 'pinned' | 'none';
            try {
                action = await this.syncPin(
                    channelLink,
                    guildLink,
                    pin,
                    snapshots,
                    seen,
                    result
                );
            } catch (error) {
                if (isFluxerApiBlockError(error)) {
                    // Some pins may have landed; let the next events rebuild.
                    this.snapshots.delete(channelLink.id);
                    throw error;
                }
                logger.error(
                    `❌ Error syncing pinned ${PLATFORM_NAME[pin.platform]} message ${pin.id}:`,
                    error
                );
                this.metricsService?.pinRelayErrors.inc({
                    direction: directionFrom(pin.platform),
                });
                result.failed++;
                continue;
            }

            if (action === 'copied') await sleep(this.delayMs);
            else if (action === 'pinned') await sleep(this.delayMs / 4);
        }

        logger.info(
            `📌 Pin sync of link ${channelLink.id} done: ${JSON.stringify(result)}`
        );
        return result;
    }

    /** Brings one pin of the sync over to the other side. */
    private async syncPin(
        channelLink: ChannelLink,
        guildLink: GuildLink,
        pin: SidedPin,
        snapshots: PinSnapshots,
        seen: Set<string>,
        result: PinSyncResult
    ): Promise<'copied' | 'pinned' | 'none'> {
        const source = pin.platform;
        const target = otherSide(source);

        const messageLink = await this.findMessageLink(source, pin.id);
        if (messageLink) {
            if (seen.has(messageLink.id)) return 'none';
            seen.add(messageLink.id);

            const targetId = counterpartId(source, messageLink);
            if (snapshots[target]?.has(targetId)) {
                result.alreadyInSync++;
                return 'none';
            }
            const outcome = await this.setPinned(
                target,
                channelLink,
                guildLink,
                targetId,
                true
            );
            if (outcome === 'missing') {
                logger.warn(
                    `⚠️ ${PLATFORM_NAME[target]} copy ${targetId} of pinned ${PLATFORM_NAME[source]} message ${pin.id} no longer exists`
                );
                result.failed++;
                return 'none';
            }
            if (target === 'discord') result.pinnedOnDiscord++;
            else result.pinnedOnFluxer++;
            this.metricsService?.pinsRelayed.inc({
                direction: directionFrom(source),
            });
            return 'pinned';
        }

        const ownWebhookId =
            source === 'discord'
                ? channelLink.discordWebhookId
                : channelLink.fluxerWebhookId;
        if (pin.message.webhookId && pin.message.webhookId === ownWebhookId) {
            // A bridge copy whose message link is gone: copying it back
            // would duplicate the original.
            logger.debug(
                `📌 Skipping pinned ${PLATFORM_NAME[source]} message ${pin.id}: posted by the bridge webhook`
            );
            result.skipped = (result.skipped ?? 0) + 1;
            return 'none';
        }
        const contentTypes =
            source === 'discord' ? DISCORD_CONTENT_TYPES : FLUXER_CONTENT_TYPES;
        if (!contentTypes.has(pin.message.type)) {
            logger.debug(
                `📌 Skipping pinned ${PLATFORM_NAME[source]} system message ${pin.id}`
            );
            result.skipped = (result.skipped ?? 0) + 1;
            return 'none';
        }

        const copyId = await this.copyMessage(channelLink, guildLink, pin);
        if (copyId === null) {
            result.failed++;
            return 'none';
        }
        await this.linkService.createMessageLink({
            discordMessageId: source === 'discord' ? pin.id : copyId,
            fluxerMessageId: source === 'fluxer' ? pin.id : copyId,
            guildLinkId: channelLink.guildLinkId,
            channelLinkId: channelLink.id,
            sourcePlatform: source,
            // A webhook/integration author has no user to ping on the other side.
            sourceAuthorId: pin.message.webhookId
                ? undefined
                : pin.message.author.id,
        });
        await this.setPinned(target, channelLink, guildLink, copyId, true);

        if (target === 'discord') result.copiedToDiscord++;
        else result.copiedToFluxer++;
        this.metricsService?.pinsRelayed.inc({
            direction: directionFrom(source),
        });
        return 'copied';
    }

    /**
     * Posts a copy of an unbridged message on the other side through the
     * live relay. Null when no relay was set for that direction.
     */
    private async copyMessage(
        channelLink: ChannelLink,
        guildLink: GuildLink,
        pin: SidedPin
    ): Promise<string | null> {
        if (pin.platform === 'discord') {
            if (!this.discordRelay) {
                logger.warn(
                    `⚠️ No Discord→Fluxer relay set, cannot copy pinned message ${pin.id}`
                );
                return null;
            }
            const payload = await this.discordRelay.buildPayload(
                pin.message,
                guildLink
            );
            return (await this.discordRelay.sendPayload(channelLink, payload))
                .messageId;
        }

        if (!this.fluxerRelay) {
            logger.warn(
                `⚠️ No Fluxer→Discord relay set, cannot copy pinned message ${pin.id}`
            );
            return null;
        }
        const payload = await this.fluxerRelay.buildPayload(
            pin.message,
            guildLink
        );
        return (await this.fluxerRelay.sendPayload(channelLink, payload))
            .messageId;
    }

    /**
     * Pins or unpins a message on one side and records the result in that
     * side's snapshot, so the pins-update event it causes is not mirrored
     * back. "Already in that state" and "message gone" are not errors.
     */
    private async setPinned(
        platform: Platform,
        channelLink: ChannelLink,
        guildLink: GuildLink,
        messageId: string,
        pinned: boolean
    ): Promise<PinOutcome> {
        const snapshot = this.snapshotsFor(channelLink.id)[platform];
        const record = () => {
            if (pinned) snapshot?.add(messageId);
            else snapshot?.delete(messageId);
        };

        let message: PinnableMessage;
        try {
            message = await this.fetchMessage(
                platform,
                channelLink,
                guildLink,
                messageId
            );
        } catch (error) {
            if (!isUnknownError(error)) throw error;
            logger.debug(
                `📌 ${PLATFORM_NAME[platform]} message ${messageId} no longer exists, cannot ${pinned ? 'pin' : 'unpin'} it`
            );
            snapshot?.delete(messageId);
            return 'missing';
        }

        if (message.pinned === pinned) {
            record();
            return 'unchanged';
        }

        try {
            if (pinned) await message.pin();
            else await message.unpin();
        } catch (error) {
            if (!isConflictError(error) && !isUnknownError(error)) throw error;
            logger.debug(
                `📌 ${PLATFORM_NAME[platform]} message ${messageId} already ${pinned ? 'pinned' : 'unpinned'}`
            );
        }
        record();
        return 'changed';
    }

    private async fetchMessage(
        platform: Platform,
        channelLink: ChannelLink,
        guildLink: GuildLink,
        messageId: string
    ): Promise<PinnableMessage> {
        if (platform === 'discord') {
            // discord.js would answer from its cache, whose `pinned` goes
            // stale (pins do not reliably send a message update); `setPinned`
            // decides on it, so always ask the API.
            const locationId = discordLocationId(channelLink);
            const channel = await this.discordEntityResolver.fetchChannel(
                guildLink.discordGuildId,
                locationId
            );
            if (!channel?.isTextBased()) {
                throw new Error(
                    `Discord channel ${locationId} not found or not text-based`
                );
            }
            return channel.messages.fetch({ message: messageId, force: true });
        }
        return this.fluxerEntityResolver.fetchMessage(
            guildLink.fluxerGuildId,
            fluxerLocationId(channelLink),
            messageId
        );
    }

    private listPins(
        platform: Platform,
        channelLink: ChannelLink,
        guildLink: GuildLink
    ): Promise<PinEntry<unknown>[]> {
        return platform === 'discord'
            ? this.listDiscordPins(channelLink, guildLink)
            : this.listFluxerPins(channelLink, guildLink);
    }

    private async listDiscordPins(
        channelLink: ChannelLink,
        guildLink: GuildLink
    ): Promise<PinEntry<DiscordPinnedMessage>[]> {
        const locationId = discordLocationId(channelLink);
        const channel = await this.discordEntityResolver.fetchChannel(
            guildLink.discordGuildId,
            locationId
        );
        if (!isDiscordPinsChannel<DiscordPinnedMessage>(channel)) {
            throw new Error(
                `Discord channel ${locationId} not found or has no pins`
            );
        }
        return fetchAllDiscordPins(channel);
    }

    private async listFluxerPins(
        channelLink: ChannelLink,
        guildLink: GuildLink
    ): Promise<PinEntry<FluxerMessage>[]> {
        const locationId = fluxerLocationId(channelLink);
        const channel = await this.fluxerEntityResolver.fetchChannel(
            guildLink.fluxerGuildId,
            locationId
        );
        if (!isFluxerPinsChannel<FluxerMessage>(channel)) {
            throw new Error(
                `Fluxer channel ${locationId} not found or has no pins`
            );
        }
        return fetchAllFluxerPins(channel);
    }

    private findMessageLink(
        platform: Platform,
        messageId: string
    ): Promise<MessageLink | null> {
        return platform === 'discord'
            ? this.linkService.getMessageLinkByDiscordMessageId(messageId)
            : this.linkService.getMessageLinkByFluxerMessageId(messageId);
    }

    private snapshotsFor(channelLinkId: string): PinSnapshots {
        let snapshots = this.snapshots.get(channelLinkId);
        if (!snapshots) {
            snapshots = {};
            this.snapshots.set(channelLinkId, snapshots);
        }
        return snapshots;
    }

    /** Runs `fn` after all work queued earlier for the same channel link. */
    private enqueue<T>(
        channelLinkId: string,
        fn: () => Promise<T>
    ): Promise<T> {
        const previous = this.chains.get(channelLinkId) ?? Promise.resolve();
        const run = previous.then(fn);
        const tail = run.then(
            () => undefined,
            () => undefined
        );
        this.chains.set(channelLinkId, tail);
        void tail.then(() => {
            if (this.chains.get(channelLinkId) === tail) {
                this.chains.delete(channelLinkId);
            }
        });
        return run;
    }
}

/** The id of the other side's copy of a bridged message. */
function counterpartId(source: Platform, messageLink: MessageLink): string {
    return source === 'discord'
        ? messageLink.fluxerMessageId
        : messageLink.discordMessageId;
}
