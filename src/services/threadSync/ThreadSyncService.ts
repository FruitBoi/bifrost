import {
    AnyThreadChannel as DiscordThreadChannel,
    Client as DiscordClient,
    TextChannel as DiscordTextChannel,
    ThreadAutoArchiveDuration as DiscordThreadAutoArchiveDuration,
} from 'discord.js';
import {
    Channel as FluxerChannel,
    Client as FluxerClient,
    ThreadAutoArchiveDuration as FluxerThreadAutoArchiveDuration,
    ThreadChannel as FluxerThreadChannel,
} from '@fluxerjs/core';
import { ChannelLink, isChannelPairLink } from '../../db/entities/ChannelLink';
import DiscordEntityResolver from '../entityResolver/DiscordEntityResolver';
import FluxerEntityResolver from '../entityResolver/FluxerEntityResolver';
import LinkProvisioner from '../LinkProvisioner';
import { LinkService } from '../LinkService';
import logger from '../../utils/logging/logger';
import {
    isFluxerApiBlockError,
    markFluxerApiBlocked,
} from '../../utils/fluxerApiGuard';

const THREAD_NAME_MAX_LENGTH = 100;
const VALID_AUTO_ARCHIVE_MINUTES = new Set([60, 1440, 4320, 10080]);

/**
 * Controls whether a counterpart thread is created when none is linked yet.
 * - `auto`: only when the parent channel↔channel link has `autoSyncThreads`
 * - `never`: lookup only
 */
export type ThreadAutoCreate = 'auto' | 'never';

/**
 * Automatic thread bridging for channel↔channel links with `autoSyncThreads`
 * enabled, plus rename/delete mirroring for any link whose sides are threads.
 *
 * A bridged thread pair is an ordinary link row with both thread IDs set; it
 * shares the parent channels' webhooks (see LinkProvisioner).
 */
export default class ThreadSyncService {
    private discordClient: DiscordClient | null = null;
    private fluxerClient: FluxerClient | null = null;

    /** De-duplicates concurrent creation attempts for the same source thread. */
    private readonly inFlight = new Map<string, Promise<ChannelLink | null>>();

    /**
     * Threads this bridge created itself. Thread-create events for these must
     * never be mirrored back, even if they arrive before the link is persisted.
     */
    private readonly bridgeCreated = new Set<string>();

    constructor(
        private readonly linkService: LinkService,
        private readonly linkProvisioner: LinkProvisioner,
        private readonly discordEntityResolver: DiscordEntityResolver,
        private readonly fluxerEntityResolver: FluxerEntityResolver
    ) {}

    setDiscordClient(client: DiscordClient) {
        this.discordClient = client;
    }

    setFluxerClient(client: FluxerClient) {
        this.fluxerClient = client;
    }

    private ensureDiscordClient(): DiscordClient {
        if (!this.discordClient) {
            throw new Error('Discord client not set in ThreadSyncService');
        }
        return this.discordClient;
    }

    private ensureFluxerClient(): FluxerClient {
        if (!this.fluxerClient) {
            throw new Error('Fluxer client not set in ThreadSyncService');
        }
        return this.fluxerClient;
    }

    /** Thread names are 1-100 characters on both platforms. */
    static normalizeThreadName(name: string | null | undefined): string {
        const trimmed = (name ?? '').trim();
        if (trimmed.length === 0) return 'thread';
        return trimmed.slice(0, THREAD_NAME_MAX_LENGTH);
    }

    private static autoArchiveMinutes(
        value: number | null | undefined
    ): number | undefined {
        if (value === null || value === undefined) return undefined;
        return VALID_AUTO_ARCHIVE_MINUTES.has(value) ? value : undefined;
    }

    private async dedupe(
        key: string,
        factory: () => Promise<ChannelLink | null>
    ): Promise<ChannelLink | null> {
        const existing = this.inFlight.get(key);
        if (existing) return existing;

        const promise = factory().finally(() => this.inFlight.delete(key));
        this.inFlight.set(key, promise);
        return promise;
    }

    // ---------------------------------------------------------------------
    // Resolution (lookup + optional auto-create)
    // ---------------------------------------------------------------------

    /**
     * Returns the link for a Discord thread. When none exists and the thread's
     * parent channel has a channel↔channel link with auto-sync on, a Fluxer
     * counterpart is created and linked. Threads the bridge created itself are
     * never mirrored.
     */
    async resolveDiscordThread(
        thread: DiscordThreadChannel,
        autoCreate: ThreadAutoCreate = 'auto'
    ): Promise<ChannelLink | null> {
        const existing = await this.linkService.getChannelLinkByDiscordLocation(
            thread.id
        );
        if (existing) return existing;

        if (autoCreate === 'never') return null;
        if (!thread.parentId) return null;
        if (this.bridgeCreated.has(`discord:${thread.id}`)) return null;
        if (thread.ownerId && thread.ownerId === this.discordClient?.user?.id) {
            return null;
        }

        const parentLink =
            await this.linkService.getChannelLinkByDiscordLocation(
                thread.parentId
            );
        if (
            !parentLink ||
            !isChannelPairLink(parentLink) ||
            !parentLink.autoSyncThreads
        ) {
            return null;
        }

        return this.dedupe(`discord:${thread.id}`, () =>
            this.createCounterpartForDiscordThread(thread, parentLink)
        );
    }

    /** Mirror of {@link resolveDiscordThread}. */
    async resolveFluxerThread(
        thread: FluxerThreadChannel,
        autoCreate: ThreadAutoCreate = 'auto'
    ): Promise<ChannelLink | null> {
        const existing = await this.linkService.getChannelLinkByFluxerLocation(
            thread.id
        );
        if (existing) return existing;

        if (autoCreate === 'never') return null;
        if (!thread.parentId) return null;
        if (this.bridgeCreated.has(`fluxer:${thread.id}`)) return null;
        if (thread.ownerId && thread.ownerId === this.fluxerClient?.user?.id) {
            return null;
        }

        const parentLink =
            await this.linkService.getChannelLinkByFluxerLocation(
                thread.parentId
            );
        if (
            !parentLink ||
            !isChannelPairLink(parentLink) ||
            !parentLink.autoSyncThreads
        ) {
            return null;
        }

        return this.dedupe(`fluxer:${thread.id}`, () =>
            this.createCounterpartForFluxerThread(thread, parentLink)
        );
    }

    // ---------------------------------------------------------------------
    // Counterpart creation
    // ---------------------------------------------------------------------

    private async createCounterpartForDiscordThread(
        thread: DiscordThreadChannel,
        parentLink: ChannelLink
    ): Promise<ChannelLink | null> {
        const name = ThreadSyncService.normalizeThreadName(thread.name);
        const autoArchiveDuration = ThreadSyncService.autoArchiveMinutes(
            thread.autoArchiveDuration
        ) as FluxerThreadAutoArchiveDuration | undefined;

        let fluxerThread: FluxerThreadChannel;
        try {
            fluxerThread = await this.startFluxerThread(
                thread.id,
                parentLink,
                name,
                autoArchiveDuration
            );
        } catch (err) {
            if (isFluxerApiBlockError(err)) markFluxerApiBlocked();
            logger.error(
                `Failed to create Fluxer counterpart for Discord thread ${thread.id}:`,
                err
            );
            return null;
        }

        this.bridgeCreated.add(`fluxer:${fluxerThread.id}`);
        await Promise.all([
            thread.join().catch(() => undefined),
            fluxerThread.join().catch(() => undefined),
        ]);

        return this.persistThreadLink(parentLink, thread.id, fluxerThread.id);
    }

    private async createCounterpartForFluxerThread(
        thread: FluxerThreadChannel,
        parentLink: ChannelLink
    ): Promise<ChannelLink | null> {
        const name = ThreadSyncService.normalizeThreadName(thread.name);
        const autoArchiveDuration = ThreadSyncService.autoArchiveMinutes(
            thread.autoArchiveDuration
        ) as DiscordThreadAutoArchiveDuration | undefined;

        let discordThread: DiscordThreadChannel;
        try {
            discordThread = await this.startDiscordThread(
                thread.id,
                parentLink,
                name,
                autoArchiveDuration
            );
        } catch (err) {
            logger.error(
                `Failed to create Discord counterpart for Fluxer thread ${thread.id}:`,
                err
            );
            return null;
        }

        this.bridgeCreated.add(`discord:${discordThread.id}`);
        await Promise.all([
            discordThread.join().catch(() => undefined),
            thread.join().catch(() => undefined),
        ]);

        return this.persistThreadLink(parentLink, discordThread.id, thread.id);
    }

    /**
     * Starts a Fluxer thread for a Discord thread. If the Discord thread was
     * started from a bridged message, the Fluxer thread is attached to the
     * bridged copy of that message so both threads hang off the same post;
     * otherwise a standalone thread is created in the linked channel.
     */
    private async startFluxerThread(
        discordThreadId: string,
        parentLink: ChannelLink,
        name: string,
        autoArchiveDuration: FluxerThreadAutoArchiveDuration | undefined
    ): Promise<FluxerThreadChannel> {
        const client = this.ensureFluxerClient();

        // On Discord a thread started from a message shares that message's ID.
        const starterLink =
            await this.linkService.getMessageLinkByDiscordMessageId(
                discordThreadId
            );
        if (starterLink && starterLink.channelLinkId === parentLink.id) {
            try {
                const starter = await client.channels.fetchMessage(
                    parentLink.fluxerChannelId,
                    starterLink.fluxerMessageId
                );
                return await starter.startThread({ name, autoArchiveDuration });
            } catch (err) {
                logger.warn(
                    `Could not start Fluxer thread from bridged message ${starterLink.fluxerMessageId}, creating a standalone thread instead:`,
                    err
                );
            }
        }

        const channel = await client.channels.fetch(parentLink.fluxerChannelId);
        if (!channel.isText()) {
            throw new Error(
                `Fluxer channel ${parentLink.fluxerChannelId} does not support threads`
            );
        }
        return channel.threads.create({
            name,
            autoArchiveDuration,
            reason: 'Bridged from Discord thread',
        });
    }

    /** Mirror of {@link startFluxerThread}. */
    private async startDiscordThread(
        fluxerThreadId: string,
        parentLink: ChannelLink,
        name: string,
        autoArchiveDuration: DiscordThreadAutoArchiveDuration | undefined
    ): Promise<DiscordThreadChannel> {
        const client = this.ensureDiscordClient();
        const guildLink = await this.linkService.getGuildLinkById(
            parentLink.guildLinkId
        );

        const starterLink =
            await this.linkService.getMessageLinkByFluxerMessageId(
                fluxerThreadId
            );
        if (
            guildLink &&
            starterLink &&
            starterLink.channelLinkId === parentLink.id
        ) {
            try {
                const starter = await this.discordEntityResolver.fetchMessage(
                    guildLink.discordGuildId,
                    parentLink.discordChannelId,
                    starterLink.discordMessageId
                );
                if (!starter.hasThread) {
                    return await starter.startThread({
                        name,
                        autoArchiveDuration,
                        reason: 'Bridged from Fluxer thread',
                    });
                }
            } catch (err) {
                logger.warn(
                    `Could not start Discord thread from bridged message ${starterLink.discordMessageId}, creating a standalone thread instead:`,
                    err
                );
            }
        }

        const channel = await client.channels.fetch(
            parentLink.discordChannelId
        );
        if (!channel || !(channel instanceof DiscordTextChannel)) {
            throw new Error(
                `Discord channel ${parentLink.discordChannelId} does not support threads`
            );
        }
        return channel.threads.create({
            name,
            autoArchiveDuration,
            reason: 'Bridged from Fluxer thread',
        });
    }

    private async persistThreadLink(
        parentLink: ChannelLink,
        discordThreadId: string,
        fluxerThreadId: string
    ): Promise<ChannelLink | null> {
        const guildLink = await this.linkService.getGuildLinkById(
            parentLink.guildLinkId
        );
        if (!guildLink) return null;

        try {
            const link = await this.linkProvisioner.createLink({
                guildLink,
                discord: {
                    channelId: parentLink.discordChannelId,
                    threadId: discordThreadId,
                },
                fluxer: {
                    channelId: parentLink.fluxerChannelId,
                    threadId: fluxerThreadId,
                },
            });
            logger.info(
                `Bridged thread: discord=${discordThreadId} ↔ fluxer=${fluxerThreadId} (under channel link ${parentLink.linkId})`
            );
            return link;
        } catch (err) {
            // Most likely a race where the other side already persisted it.
            const existing =
                (await this.linkService.getChannelLinkByDiscordLocation(
                    discordThreadId
                )) ??
                (await this.linkService.getChannelLinkByFluxerLocation(
                    fluxerThreadId
                ));
            if (existing) return existing;
            logger.error('Failed to persist thread link:', err);
            return null;
        }
    }

    // ---------------------------------------------------------------------
    // Event handlers
    // ---------------------------------------------------------------------

    /** Mirrors a Discord thread rename to a Fluxer thread linked to it. */
    async handleDiscordThreadUpdate(
        oldThread: DiscordThreadChannel,
        newThread: DiscordThreadChannel
    ): Promise<void> {
        if (oldThread.name === newThread.name) return;

        const link = await this.linkService.getChannelLinkByDiscordLocation(
            newThread.id
        );
        if (
            !link ||
            link.discordThreadId !== newThread.id ||
            !link.fluxerThreadId
        )
            return;

        const fluxerThread = await this.fluxerEntityResolver.fetchThread(
            link.fluxerThreadId
        );
        if (!fluxerThread) return;

        const name = ThreadSyncService.normalizeThreadName(newThread.name);
        // Equal names mean this update is the echo of a rename we just mirrored.
        if (fluxerThread.name === name) return;

        try {
            await fluxerThread.edit({ name });
        } catch (err) {
            if (isFluxerApiBlockError(err)) markFluxerApiBlocked();
            logger.error(
                `Failed to rename Fluxer thread ${link.fluxerThreadId}:`,
                err
            );
        }
    }

    /** Mirrors a Fluxer thread rename to a Discord thread linked to it. */
    async handleFluxerThreadUpdate(
        oldThread: FluxerChannel,
        newThread: FluxerThreadChannel
    ): Promise<void> {
        const oldName = (oldThread as { name?: string | null }).name ?? null;
        if (oldName === newThread.name) return;

        const link = await this.linkService.getChannelLinkByFluxerLocation(
            newThread.id
        );
        if (
            !link ||
            link.fluxerThreadId !== newThread.id ||
            !link.discordThreadId
        )
            return;

        const discordThread = await this.discordEntityResolver.fetchThread(
            link.discordThreadId
        );
        if (!discordThread) return;

        const name = ThreadSyncService.normalizeThreadName(newThread.name);
        if (discordThread.name === name) return;

        try {
            await discordThread.setName(name, 'Renamed on Fluxer');
        } catch (err) {
            logger.error(
                `Failed to rename Discord thread ${link.discordThreadId}:`,
                err
            );
        }
    }

    /**
     * A deleted thread drops its link (and the shared webhook, if nothing else
     * uses it). The other side is left untouched; mirroring deletion is
     * intentionally out of scope.
     */
    async handleDiscordThreadDelete(threadId: string): Promise<void> {
        const link =
            await this.linkService.getChannelLinkByDiscordLocation(threadId);
        if (!link || link.discordThreadId !== threadId) return;
        await this.linkProvisioner
            .removeLink(link)
            .catch((err) =>
                logger.error(
                    'Failed to remove link after Discord thread deletion:',
                    err
                )
            );
        this.bridgeCreated.delete(`discord:${threadId}`);
        if (link.fluxerThreadId)
            this.bridgeCreated.delete(`fluxer:${link.fluxerThreadId}`);
        logger.info(`Discord thread ${threadId} deleted; link removed.`);
    }

    async handleFluxerThreadDelete(threadId: string): Promise<void> {
        const link =
            await this.linkService.getChannelLinkByFluxerLocation(threadId);
        if (!link || link.fluxerThreadId !== threadId) return;
        await this.linkProvisioner
            .removeLink(link)
            .catch((err) =>
                logger.error(
                    'Failed to remove link after Fluxer thread deletion:',
                    err
                )
            );
        this.bridgeCreated.delete(`fluxer:${threadId}`);
        if (link.discordThreadId)
            this.bridgeCreated.delete(`discord:${link.discordThreadId}`);
        logger.info(`Fluxer thread ${threadId} deleted; link removed.`);
    }
}
