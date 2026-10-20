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
import { ChannelLink } from '../../db/entities/ChannelLink';
import { ThreadLink } from '../../db/entities/ThreadLink';
import DiscordEntityResolver from '../entityResolver/DiscordEntityResolver';
import FluxerEntityResolver from '../entityResolver/FluxerEntityResolver';
import { LinkContext, LinkService } from '../LinkService';
import logger from '../../utils/logging/logger';
import {
    isFluxerApiBlockError,
    markFluxerApiBlocked,
} from '../../utils/fluxerApiGuard';

const THREAD_NAME_MAX_LENGTH = 100;
const VALID_AUTO_ARCHIVE_MINUTES = new Set([60, 1440, 4320, 10080]);

/**
 * Controls whether a counterpart thread is created when none is linked yet.
 * - `auto`: only when the parent channel link has `autoSyncThreads` enabled
 * - `never`: lookup only
 */
export type ThreadAutoCreate = 'auto' | 'never';

/**
 * Keeps Discord threads and Fluxer threads paired.
 *
 * Both platforms post into threads through the *parent channel's* webhook with
 * a thread target, so a thread link needs no webhooks of its own; it is just
 * the pair of thread IDs under an existing channel link.
 */
export default class ThreadSyncService {
    private discordClient: DiscordClient | null = null;
    private fluxerClient: FluxerClient | null = null;

    /** De-duplicates concurrent creation attempts for the same source thread. */
    private readonly inFlight = new Map<string, Promise<ThreadLink | null>>();

    /**
     * Threads this bridge created itself. Thread-create events for these must
     * never be mirrored back, even if they arrive before the link is persisted.
     */
    private readonly bridgeCreated = new Set<string>();

    constructor(
        private readonly linkService: LinkService,
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
        factory: () => Promise<ThreadLink | null>
    ): Promise<ThreadLink | null> {
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
     * Resolves the bridge context for a Discord thread. When no link exists and
     * the parent channel link auto-syncs threads, the Fluxer counterpart is
     * created on the fly. Threads the bridge created itself are never mirrored.
     */
    async resolveDiscordThread(
        thread: DiscordThreadChannel,
        autoCreate: ThreadAutoCreate = 'auto'
    ): Promise<LinkContext | null> {
        const existing = await this.linkService.getThreadLinkByDiscordThreadId(
            thread.id
        );
        if (existing) {
            const channelLink = await this.linkService.getChannelLinkById(
                existing.channelLinkId
            );
            return channelLink ? { channelLink, threadLink: existing } : null;
        }

        if (autoCreate === 'never') return null;
        if (!thread.parentId) return null;
        if (this.bridgeCreated.has(`discord:${thread.id}`)) return null;
        if (thread.ownerId && thread.ownerId === this.discordClient?.user?.id) {
            return null;
        }

        const channelLink =
            await this.linkService.getChannelLinkByDiscordChannelId(
                thread.parentId
            );
        if (!channelLink || !channelLink.autoSyncThreads) return null;

        const threadLink = await this.dedupe(`discord:${thread.id}`, () =>
            this.createCounterpartForDiscordThread(thread, channelLink)
        );
        return threadLink ? { channelLink, threadLink } : null;
    }

    /**
     * Resolves the bridge context for a Fluxer thread. Mirror of
     * {@link resolveDiscordThread}.
     */
    async resolveFluxerThread(
        thread: FluxerThreadChannel,
        autoCreate: ThreadAutoCreate = 'auto'
    ): Promise<LinkContext | null> {
        const existing = await this.linkService.getThreadLinkByFluxerThreadId(
            thread.id
        );
        if (existing) {
            const channelLink = await this.linkService.getChannelLinkById(
                existing.channelLinkId
            );
            return channelLink ? { channelLink, threadLink: existing } : null;
        }

        if (autoCreate === 'never') return null;
        if (!thread.parentId) return null;
        if (this.bridgeCreated.has(`fluxer:${thread.id}`)) return null;
        if (thread.ownerId && thread.ownerId === this.fluxerClient?.user?.id) {
            return null;
        }

        const channelLink =
            await this.linkService.getChannelLinkByFluxerChannelId(
                thread.parentId
            );
        if (!channelLink || !channelLink.autoSyncThreads) return null;

        const threadLink = await this.dedupe(`fluxer:${thread.id}`, () =>
            this.createCounterpartForFluxerThread(thread, channelLink)
        );
        return threadLink ? { channelLink, threadLink } : null;
    }

    // ---------------------------------------------------------------------
    // Counterpart creation
    // ---------------------------------------------------------------------

    private async createCounterpartForDiscordThread(
        thread: DiscordThreadChannel,
        channelLink: ChannelLink
    ): Promise<ThreadLink | null> {
        const name = ThreadSyncService.normalizeThreadName(thread.name);
        const autoArchiveDuration = ThreadSyncService.autoArchiveMinutes(
            thread.autoArchiveDuration
        ) as FluxerThreadAutoArchiveDuration | undefined;

        let fluxerThread: FluxerThreadChannel;
        try {
            fluxerThread = await this.startFluxerThread(
                thread.id,
                channelLink,
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

        return this.persistThreadLink(channelLink, thread.id, fluxerThread.id);
    }

    private async createCounterpartForFluxerThread(
        thread: FluxerThreadChannel,
        channelLink: ChannelLink
    ): Promise<ThreadLink | null> {
        const name = ThreadSyncService.normalizeThreadName(thread.name);
        const autoArchiveDuration = ThreadSyncService.autoArchiveMinutes(
            thread.autoArchiveDuration
        ) as DiscordThreadAutoArchiveDuration | undefined;

        let discordThread: DiscordThreadChannel;
        try {
            discordThread = await this.startDiscordThread(
                thread.id,
                channelLink,
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

        return this.persistThreadLink(channelLink, discordThread.id, thread.id);
    }

    /**
     * Starts a Fluxer thread for a Discord thread. If the Discord thread was
     * started from a bridged message, the Fluxer thread is attached to the
     * bridged copy of that message so both threads hang off the same post;
     * otherwise a standalone thread is created in the linked channel.
     */
    private async startFluxerThread(
        discordThreadId: string,
        channelLink: ChannelLink,
        name: string,
        autoArchiveDuration: FluxerThreadAutoArchiveDuration | undefined
    ): Promise<FluxerThreadChannel> {
        const client = this.ensureFluxerClient();

        // On Discord a thread started from a message shares that message's ID.
        const starterLink =
            await this.linkService.getMessageLinkByDiscordMessageId(
                discordThreadId
            );
        if (
            starterLink &&
            starterLink.channelLinkId === channelLink.id &&
            !starterLink.threadLinkId
        ) {
            try {
                const starter = await client.channels.fetchMessage(
                    channelLink.fluxerChannelId,
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

        const channel = await client.channels.fetch(
            channelLink.fluxerChannelId
        );
        if (!channel.isText()) {
            throw new Error(
                `Fluxer channel ${channelLink.fluxerChannelId} does not support threads`
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
        channelLink: ChannelLink,
        name: string,
        autoArchiveDuration: DiscordThreadAutoArchiveDuration | undefined
    ): Promise<DiscordThreadChannel> {
        const client = this.ensureDiscordClient();
        const guildLink = await this.linkService.getGuildLinkById(
            channelLink.guildLinkId
        );

        const starterLink =
            await this.linkService.getMessageLinkByFluxerMessageId(
                fluxerThreadId
            );
        if (
            guildLink &&
            starterLink &&
            starterLink.channelLinkId === channelLink.id &&
            !starterLink.threadLinkId
        ) {
            try {
                const starter = await this.discordEntityResolver.fetchMessage(
                    guildLink.discordGuildId,
                    channelLink.discordChannelId,
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
            channelLink.discordChannelId
        );
        if (!channel || !(channel instanceof DiscordTextChannel)) {
            throw new Error(
                `Discord channel ${channelLink.discordChannelId} does not support threads`
            );
        }
        return channel.threads.create({
            name,
            autoArchiveDuration,
            reason: 'Bridged from Fluxer thread',
        });
    }

    private async persistThreadLink(
        channelLink: ChannelLink,
        discordThreadId: string,
        fluxerThreadId: string
    ): Promise<ThreadLink | null> {
        try {
            const link = await this.linkService.createThreadLink({
                channelLinkId: channelLink.id,
                discordThreadId,
                fluxerThreadId,
            });
            logger.info(
                `Bridged thread: discord=${discordThreadId} ↔ fluxer=${fluxerThreadId} (channel link ${channelLink.linkId})`
            );
            return link;
        } catch (err) {
            // Most likely a race where the other side already persisted it.
            const existing =
                (await this.linkService.getThreadLinkByDiscordThreadId(
                    discordThreadId
                )) ??
                (await this.linkService.getThreadLinkByFluxerThreadId(
                    fluxerThreadId
                ));
            if (existing) return existing;
            logger.error('Failed to persist thread link:', err);
            return null;
        }
    }

    // ---------------------------------------------------------------------
    // Manual linking
    // ---------------------------------------------------------------------

    /**
     * Links two existing threads. Both must be children of the two channels of
     * the given channel link.
     */
    async linkExistingThreads({
        channelLink,
        discordThreadId,
        fluxerThreadId,
    }: {
        channelLink: ChannelLink;
        discordThreadId: string;
        fluxerThreadId: string;
    }): Promise<ThreadLink> {
        const [discordThread, fluxerThread] = await Promise.all([
            this.discordEntityResolver.fetchThread(discordThreadId),
            this.fluxerEntityResolver.fetchThread(fluxerThreadId),
        ]);

        if (!discordThread) {
            throw new Error('Discord thread not found');
        }
        if (discordThread.parentId !== channelLink.discordChannelId) {
            throw new Error(
                'Discord thread does not belong to the linked Discord channel'
            );
        }
        if (!fluxerThread) {
            throw new Error('Fluxer thread not found');
        }
        if (fluxerThread.parentId !== channelLink.fluxerChannelId) {
            throw new Error(
                'Fluxer thread does not belong to the linked Fluxer channel'
            );
        }

        const link = await this.linkService.createThreadLink({
            channelLinkId: channelLink.id,
            discordThreadId,
            fluxerThreadId,
        });

        await Promise.all([
            discordThread.join().catch(() => undefined),
            fluxerThread.join().catch(() => undefined),
        ]);

        return link;
    }

    async unlinkThread(threadLinkId: string): Promise<ThreadLink> {
        const removed = await this.linkService.removeThreadLink(threadLinkId);
        this.bridgeCreated.delete(`discord:${removed.discordThreadId}`);
        this.bridgeCreated.delete(`fluxer:${removed.fluxerThreadId}`);
        return removed;
    }

    // ---------------------------------------------------------------------
    // Event handlers
    // ---------------------------------------------------------------------

    /** Mirrors a Discord thread rename to its Fluxer counterpart. */
    async handleDiscordThreadUpdate(
        oldThread: DiscordThreadChannel,
        newThread: DiscordThreadChannel
    ): Promise<void> {
        if (oldThread.name === newThread.name) return;

        const threadLink =
            await this.linkService.getThreadLinkByDiscordThreadId(newThread.id);
        if (!threadLink) return;

        const fluxerThread = await this.fluxerEntityResolver.fetchThread(
            threadLink.fluxerThreadId
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
                `Failed to rename Fluxer thread ${threadLink.fluxerThreadId}:`,
                err
            );
        }
    }

    /** Mirrors a Fluxer thread rename to its Discord counterpart. */
    async handleFluxerThreadUpdate(
        oldThread: FluxerChannel,
        newThread: FluxerThreadChannel
    ): Promise<void> {
        const oldName = (oldThread as { name?: string | null }).name ?? null;
        if (oldName === newThread.name) return;

        const threadLink = await this.linkService.getThreadLinkByFluxerThreadId(
            newThread.id
        );
        if (!threadLink) return;

        const discordThread = await this.discordEntityResolver.fetchThread(
            threadLink.discordThreadId
        );
        if (!discordThread) return;

        const name = ThreadSyncService.normalizeThreadName(newThread.name);
        if (discordThread.name === name) return;

        try {
            await discordThread.setName(name, 'Renamed on Fluxer');
        } catch (err) {
            logger.error(
                `Failed to rename Discord thread ${threadLink.discordThreadId}:`,
                err
            );
        }
    }

    /**
     * A deleted thread simply drops its link. The counterpart thread is left
     * untouched; mirroring deletion is intentionally out of scope.
     */
    async handleDiscordThreadDelete(threadId: string): Promise<void> {
        const threadLink =
            await this.linkService.getThreadLinkByDiscordThreadId(threadId);
        if (!threadLink) return;
        await this.unlinkThread(threadLink.id).catch((err) =>
            logger.error(
                'Failed to remove thread link after Discord thread deletion:',
                err
            )
        );
        logger.info(`Discord thread ${threadId} deleted; thread link removed.`);
    }

    async handleFluxerThreadDelete(threadId: string): Promise<void> {
        const threadLink =
            await this.linkService.getThreadLinkByFluxerThreadId(threadId);
        if (!threadLink) return;
        await this.unlinkThread(threadLink.id).catch((err) =>
            logger.error(
                'Failed to remove thread link after Fluxer thread deletion:',
                err
            )
        );
        logger.info(`Fluxer thread ${threadId} deleted; thread link removed.`);
    }
}
