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
import DiscordEntityResolver from '../entityResolver/DiscordEntityResolver';
import FluxerEntityResolver from '../entityResolver/FluxerEntityResolver';
import { LinkService } from '../LinkService';

/** Discord shows a typing indicator for ~10 s; clients resend every ~8–10 s. */
const DEFAULT_THROTTLE_MS = 8000;

/** Throttle entries are pruned once the map grows past this many keys. */
const PRUNE_THRESHOLD = 500;

type Direction = 'discord_to_fluxer' | 'fluxer_to_discord';

/** Anything with a `sendTyping` method (discord.js and Fluxer channels both qualify). */
interface TypingTarget {
    sendTyping(): Promise<unknown>;
}

function canSendTyping(channel: unknown): channel is TypingTarget {
    return (
        typeof channel === 'object' &&
        channel !== null &&
        typeof (channel as { sendTyping?: unknown }).sendTyping === 'function'
    );
}

/**
 * Mirrors "user is typing" indicators across linked channels.
 *
 * Webhooks cannot type, so the bot account triggers the typing indicator in
 * the linked location; the other side sees "<bot> is typing…". Triggers are
 * throttled per target location to roughly one per indicator lifetime.
 *
 * The indicator may linger a few seconds after the bridged message appears:
 * neither platform lets a bot stop typing explicitly, and a message posted
 * through a webhook does not clear the bot's own indicator.
 */
export default class TypingBridgeService {
    private readonly linkService: LinkService;
    private readonly discordEntityResolver: DiscordEntityResolver;
    private readonly fluxerEntityResolver: FluxerEntityResolver;
    private readonly throttleMs: number;
    private readonly now: () => number;

    /** `${direction}:${targetLocationId}` → when typing was last triggered. */
    private readonly lastTriggered = new Map<string, number>();

    constructor({
        linkService,
        discordEntityResolver,
        fluxerEntityResolver,
        throttleMs = DEFAULT_THROTTLE_MS,
        now = Date.now,
    }: {
        linkService: LinkService;
        discordEntityResolver: DiscordEntityResolver;
        fluxerEntityResolver: FluxerEntityResolver;
        /** Min gap between typing triggers per target location; default 8000. */
        throttleMs?: number;
        /** Clock for tests; default Date.now. */
        now?: () => number;
    }) {
        this.linkService = linkService;
        this.discordEntityResolver = discordEntityResolver;
        this.fluxerEntityResolver = fluxerEntityResolver;
        this.throttleMs = throttleMs;
        this.now = now;
    }

    /** A Discord user started typing in Discord channel/thread `channelId`; trigger typing in the linked Fluxer location. */
    async handleDiscordTyping(channelId: string): Promise<void> {
        try {
            if (isFluxerApiBlocked()) return;

            const link =
                await this.linkService.getChannelLinkByDiscordLocation(
                    channelId
                );
            if (!link) return;
            if (!this.claim('discord_to_fluxer', fluxerLocationId(link))) {
                return;
            }

            const channel = await this.resolveFluxerTarget(link);
            if (!canSendTyping(channel)) return;
            await channel.sendTyping();
        } catch (error) {
            if (isFluxerApiBlockError(error)) markFluxerApiBlocked();
            logger.debug(
                `⌨️ Could not mirror Discord typing in ${channelId} to Fluxer:`,
                error
            );
        }
    }

    /** A Fluxer user started typing in Fluxer channel/thread `channelId`; trigger typing in the linked Discord location. */
    async handleFluxerTyping(channelId: string): Promise<void> {
        try {
            const link =
                await this.linkService.getChannelLinkByFluxerLocation(
                    channelId
                );
            if (!link) return;
            if (!this.claim('fluxer_to_discord', discordLocationId(link))) {
                return;
            }

            const channel = await this.resolveDiscordTarget(link);
            if (!canSendTyping(channel)) return;
            await channel.sendTyping();
        } catch (error) {
            logger.debug(
                `⌨️ Could not mirror Fluxer typing in ${channelId} to Discord:`,
                error
            );
        }
    }

    /**
     * Records a trigger for the target and returns true, or returns false when
     * the target was triggered less than `throttleMs` ago. Runs synchronously
     * so concurrent events for the same target fire only once; the timestamp
     * stays even if the send later fails, so a missing permission does not
     * cost an API call per keystroke burst.
     */
    private claim(direction: Direction, targetId: string): boolean {
        const now = this.now();
        const key = `${direction}:${targetId}`;
        const last = this.lastTriggered.get(key);
        if (last !== undefined && now - last < this.throttleMs) return false;

        this.lastTriggered.set(key, now);
        if (this.lastTriggered.size > PRUNE_THRESHOLD) this.prune(now);
        return true;
    }

    /** Drops entries whose throttle window has passed. */
    private prune(now: number): void {
        for (const [key, at] of this.lastTriggered) {
            if (now - at >= this.throttleMs) this.lastTriggered.delete(key);
        }
    }

    private async resolveFluxerTarget(link: ChannelLink): Promise<unknown> {
        if (link.fluxerThreadId) {
            return this.fluxerEntityResolver.fetchThread(link.fluxerThreadId);
        }
        const guildLink = await this.linkService.getGuildLinkById(
            link.guildLinkId
        );
        if (!guildLink) return null;
        return this.fluxerEntityResolver.fetchChannel(
            guildLink.fluxerGuildId,
            link.fluxerChannelId
        );
    }

    private async resolveDiscordTarget(link: ChannelLink): Promise<unknown> {
        if (link.discordThreadId) {
            return this.discordEntityResolver.fetchThread(link.discordThreadId);
        }
        const guildLink = await this.linkService.getGuildLinkById(
            link.guildLinkId
        );
        if (!guildLink) return null;
        return this.discordEntityResolver.fetchChannel(
            guildLink.discordGuildId,
            link.discordChannelId
        );
    }
}
