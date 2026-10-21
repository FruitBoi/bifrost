import {
    Channel,
    Client,
    Guild,
    GuildEmoji,
    Message,
    ThreadChannel,
    VoiceChannel,
} from '@fluxerjs/core';
import NodeCache from 'node-cache';
import logger from '../../utils/logging/logger';
import {
    isFluxerApiBlockError,
    isFluxerApiBlocked,
    markFluxerApiBlocked,
} from '../../utils/fluxerApiGuard';
import EntityResolver from '../entityResolver/EntityResolver';
import { GeneralRole } from '../mentionBridge/MentionBridgeService';

const EMOJI_FAILURE_TTL_SECONDS = 30;
const ROLE_FAILURE_TTL_SECONDS = 30;

export default class FluxerEntityResolver implements EntityResolver<
    Guild,
    Channel,
    Message,
    GuildEmoji
> {
    private fluxerClient: Client | null = null;
    private readonly emojiCache = new NodeCache({
        stdTTL: 60,
        useClones: false,
    });
    private readonly roleCache = new NodeCache({
        stdTTL: 60,
        useClones: false,
    });

    setFluxerClient(client: Client) {
        this.fluxerClient = client;
    }

    private ensureClient(): Client {
        if (!this.fluxerClient) {
            throw new Error('Fluxer client not set in FluxerEntityResolver');
        }
        return this.fluxerClient;
    }

    async fetchGuild(guildId: string): Promise<Guild | null> {
        const client = this.ensureClient();

        try {
            return await client.guilds.fetch(guildId);
        } catch {
            return null;
        }
    }

    /**
     * Fetches a channel that belongs to the given guild. Guild channel listings
     * do not include threads, so thread IDs fall back to a direct channel fetch
     * and are verified against the guild.
     */
    async fetchChannel(
        guildOrId: string | Guild,
        channelId: string
    ): Promise<Channel | null> {
        const client = this.ensureClient();

        try {
            const guild =
                typeof guildOrId === 'string'
                    ? await this.fetchGuild(guildOrId)
                    : guildOrId;

            if (!guild) return null;

            const listed = (await guild.fetchChannels()).find(
                (ch) => ch.id === channelId
            );
            if (listed) return listed;

            const direct = await client.channels.fetch(channelId);
            if (!direct || !direct.isGuild() || direct.guildId !== guild.id) {
                return null;
            }
            return direct;
        } catch {
            return null;
        }
    }

    /** Fetches a thread by ID; returns null when the ID is not a thread. */
    async fetchThread(threadId: string): Promise<ThreadChannel | null> {
        const client = this.ensureClient();

        try {
            const channel = await client.channels.fetch(threadId);
            if (!channel || !channel.isThread()) return null;
            return channel;
        } catch {
            return null;
        }
    }

    /** Fetches a voice channel of the guild; null for any other channel type. */
    async fetchVoiceChannel(
        guildOrId: string | Guild,
        channelId: string
    ): Promise<VoiceChannel | null> {
        const channel = await this.fetchChannel(guildOrId, channelId);
        if (!channel || !channel.isVoice()) return null;
        return channel;
    }

    /** Lists the guild's voice channels; empty when the guild is unknown. */
    async listVoiceChannels(
        guildOrId: string | Guild
    ): Promise<{ id: string; name: string }[]> {
        this.ensureClient();

        try {
            const guild =
                typeof guildOrId === 'string'
                    ? await this.fetchGuild(guildOrId)
                    : guildOrId;
            if (!guild) return [];

            return (await guild.fetchChannels())
                .filter((channel) => channel.isVoice())
                .map((channel) => ({
                    id: channel.id,
                    name: channel.name ?? channel.id,
                }));
        } catch {
            return [];
        }
    }

    async fetchMessage(
        guildOrId: string | Guild,
        channelOrId: string | Channel,
        messageId: string
    ): Promise<Message> {
        const channel =
            typeof channelOrId === 'string'
                ? await this.fetchChannel(guildOrId, channelOrId)
                : channelOrId;

        if (!channel) {
            throw new Error('Fluxer channel not found');
        }

        if (!channel.isTextBased()) {
            throw new Error('Fluxer channel is not text-based');
        }

        return await channel.messages.fetch(messageId);
    }

    async fetchEmojis(guildId: string | Guild): Promise<GuildEmoji[]> {
        const id = typeof guildId === 'string' ? guildId : guildId.id;

        const cached = this.emojiCache.get<GuildEmoji[]>(id);
        if (cached) return cached;
        if (isFluxerApiBlocked()) return [];

        try {
            const guild =
                typeof guildId === 'string'
                    ? await this.ensureClient().guilds.fetch(guildId)
                    : guildId;

            const emojisColl = await guild.fetchEmojis();
            const emojis = emojisColl.map((e) => e);
            this.emojiCache.set(id, emojis);
            return emojis;
        } catch (err) {
            if (isFluxerApiBlockError(err)) markFluxerApiBlocked();
            logger.warn(
                `⚠️ Could not fetch Fluxer emojis for guild ${id}, relaying without emoji resolution:`,
                err
            );
            this.emojiCache.set(id, [], EMOJI_FAILURE_TTL_SECONDS);
            return [];
        }
    }

    /**
     * Lists the guild's roles (including @everyone, whose id is the guild id),
     * cached for a minute. A failed fetch is logged and yields an empty list
     * for a short while so a flaky API is not hammered on every message.
     */
    async fetchRoles(guildId: string | Guild): Promise<GeneralRole[]> {
        const id = typeof guildId === 'string' ? guildId : guildId.id;

        const cached = this.roleCache.get<GeneralRole[]>(id);
        if (cached) return cached;
        if (isFluxerApiBlocked()) return [];

        try {
            const guild =
                typeof guildId === 'string'
                    ? await this.ensureClient().guilds.fetch(guildId)
                    : guildId;

            const roles = (await guild.fetchRoles()).map((role) => ({
                id: role.id,
                name: role.name,
            }));
            this.roleCache.set(id, roles);
            return roles;
        } catch (err) {
            if (isFluxerApiBlockError(err)) markFluxerApiBlocked();
            logger.warn(
                `⚠️ Could not fetch Fluxer roles for guild ${id}, relaying role mentions as plaintext:`,
                err
            );
            this.roleCache.set(id, [], ROLE_FAILURE_TTL_SECONDS);
            return [];
        }
    }
}
