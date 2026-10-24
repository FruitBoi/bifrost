import {
    ChannelType,
    Client,
    EmbedBuilder,
    fetchActiveThreads,
    TextChannel,
    ThreadChannel,
} from '@fluxerjs/core';
import { EmbedColors } from '../../utils/embeds';
import logger from '../../utils/logging/logger';
import {
    DirectoryChannel,
    DirectoryPage,
    DirectoryRole,
    DirectoryThread,
    ThreadDirectoryError,
    ThreadDirectoryPlatformAdapter,
} from './ThreadDirectoryService';

/** Archived threads per page; the API's maximum. */
const ARCHIVED_PAGE_SIZE = 100;
/** Safety net against an API that keeps answering `hasMore` without progress. */
const MAX_ARCHIVED_PAGES = 50;

/** The message (or its channel) no longer exists. */
function isGoneError(err: unknown): boolean {
    if (typeof err !== 'object' || err === null) return false;
    const { code, statusCode, status } = err as {
        code?: unknown;
        statusCode?: unknown;
        status?: unknown;
    };
    return (
        statusCode === 404 ||
        status === 404 ||
        code === 'MESSAGE_NOT_FOUND' ||
        code === 'CHANNEL_NOT_FOUND' ||
        code === 'UNKNOWN_MESSAGE' ||
        code === 'UNKNOWN_CHANNEL' ||
        code === 10008 ||
        code === 10003
    );
}

/** The bot may not do that (missing permission or role hierarchy). */
function isForbiddenError(err: unknown): boolean {
    if (typeof err !== 'object' || err === null) return false;
    const { code, statusCode, status } = err as {
        code?: unknown;
        statusCode?: unknown;
        status?: unknown;
    };
    return (
        statusCode === 403 ||
        status === 403 ||
        code === 'MISSING_PERMISSIONS' ||
        code === 'MISSING_ACCESS' ||
        code === 'FORBIDDEN' ||
        code === 'ACCESS_DENIED' ||
        code === 50013 ||
        code === 50001
    );
}

/** Embeds of one directory message: its title on the first, its timestamp on the last. */
export function buildFluxerDirectoryEmbeds(
    page: DirectoryPage
): EmbedBuilder[] {
    return page.descriptions.map((description, i) => {
        const embed = new EmbedBuilder()
            .setColor(EmbedColors.Info)
            .setDescription(description);
        if (i === 0 && page.title) embed.setTitle(page.title);
        if (i === page.descriptions.length - 1 && page.timestamp) {
            embed.setTimestamp();
        }
        return embed;
    });
}

/** Content plus embed titles and descriptions of a message, newline-joined. */
export function fluxerMessageText(message: {
    content?: string | null;
    embeds?: ReadonlyArray<{
        title?: string | null;
        description?: string | null;
    }> | null;
}): string {
    const parts: string[] = [];
    if (message.content) parts.push(message.content);
    for (const embed of message.embeds ?? []) {
        if (embed.title) parts.push(embed.title);
        if (embed.description) parts.push(embed.description);
    }
    return parts.join('\n');
}

/** Fluxer side of the threads directory. */
export default class FluxerThreadDirectoryAdapter implements ThreadDirectoryPlatformAdapter {
    readonly platform = 'fluxer' as const;

    constructor(private readonly client: Client) {}

    async listThreads(
        guildId: string,
        channelId: string
    ): Promise<DirectoryThread[]> {
        const channel = await this.fetchDirectoryChannel(channelId);
        const threads = new Map<string, DirectoryThread>();
        const add = (thread: ThreadChannel) => {
            if (thread.parentId !== channelId) return;
            if (thread.type === ChannelType.PrivateThread) return;
            threads.set(thread.id, {
                id: thread.id,
                name: thread.name ?? thread.id,
            });
        };

        const active = await fetchActiveThreads(this.client, guildId);
        active.threads.forEach(add);

        try {
            let before: string | undefined;
            for (let page = 0; page < MAX_ARCHIVED_PAGES; page++) {
                const archived = await channel.threads.fetchArchived({
                    type: 'public',
                    before,
                    limit: ARCHIVED_PAGE_SIZE,
                });
                archived.threads.forEach(add);

                const last = archived.threads[archived.threads.length - 1];
                const lastArchivedAt = last?.archiveTimestamp ?? null;
                if (!archived.hasMore || !lastArchivedAt) break;
                if (lastArchivedAt === before) break;
                before = lastArchivedAt;
            }
        } catch (err) {
            logger.warn(
                `⚠️ Could not list archived threads of Fluxer channel ${channelId}; listing active threads only:`,
                err
            );
        }

        return [...threads.values()];
    }

    async sendDirectoryMessage(
        channelId: string,
        page: DirectoryPage
    ): Promise<string> {
        const channel = await this.fetchDirectoryChannel(channelId);
        const message = await channel.send({
            embeds: buildFluxerDirectoryEmbeds(page),
            allowedMentions: { parse: [] },
        });
        return message.id;
    }

    async editDirectoryMessage(
        channelId: string,
        messageId: string,
        page: DirectoryPage
    ): Promise<boolean> {
        try {
            const message = await this.client.channels.fetchMessage(
                channelId,
                messageId
            );
            await message.edit({
                embeds: buildFluxerDirectoryEmbeds(page),
                allowedMentions: { parse: [] },
            });
            return true;
        } catch (err) {
            if (isGoneError(err)) return false;
            throw err;
        }
    }

    async deleteDirectoryMessage(
        channelId: string,
        messageId: string
    ): Promise<void> {
        try {
            const message = await this.client.channels.fetchMessage(
                channelId,
                messageId
            );
            await message.delete();
        } catch (err) {
            if (isGoneError(err)) return;
            throw err;
        }
    }

    messageUrl(guildId: string, channelId: string, messageId: string): string {
        return `https://fluxer.app/channels/${guildId}/${channelId}/${messageId}`;
    }

    async resolveChannel(
        guildId: string,
        id: string
    ): Promise<DirectoryChannel | null> {
        try {
            const channel = await this.client.channels.fetch(id);
            if (!channel || !channel.isGuild() || channel.guildId !== guildId)
                return null;
            return {
                id: channel.id,
                name: channel.name ?? channel.id,
                parentId: channel.parentId ?? null,
            };
        } catch {
            return null;
        }
    }

    async listRoles(guildId: string): Promise<DirectoryRole[]> {
        const guild = await this.client.guilds.fetch(guildId);
        const roles = await guild.fetchRoles();
        // Fluxer has no integration-managed roles.
        return roles.map((role) => ({
            id: role.id,
            name: role.name,
            managed: false,
            permissions: role.permissions.bitfield,
        }));
    }

    async memberRoleIds(guildId: string, userId: string): Promise<string[]> {
        const member = await this.fetchMember(guildId, userId);
        return [...member.roles.roleIds];
    }

    async addMemberRole(
        guildId: string,
        userId: string,
        roleId: string
    ): Promise<void> {
        const member = await this.fetchMember(guildId, userId);
        try {
            await member.roles.add(roleId);
        } catch (err) {
            throw this.roleError(err);
        }
    }

    async removeMemberRole(
        guildId: string,
        userId: string,
        roleId: string
    ): Promise<void> {
        const member = await this.fetchMember(guildId, userId);
        try {
            await member.roles.remove(roleId);
        } catch (err) {
            throw this.roleError(err);
        }
    }

    async fetchMessageText(
        channelId: string,
        messageId: string
    ): Promise<string | null> {
        try {
            const message = await this.client.channels.fetchMessage(
                channelId,
                messageId
            );
            return fluxerMessageText(message);
        } catch (err) {
            if (isGoneError(err) || isForbiddenError(err)) return null;
            throw err;
        }
    }

    private async fetchMember(guildId: string, userId: string) {
        const guild = await this.client.guilds.fetch(guildId);
        return guild.fetchMember(userId);
    }

    /** 'role_forbidden' for permission errors; anything else unchanged. */
    private roleError(err: unknown): unknown {
        if (!isForbiddenError(err)) return err;
        return new ThreadDirectoryError(
            'role_forbidden',
            'I am not allowed to manage that role (missing Manage Roles, or the role is above mine).'
        );
    }

    /** The channel as a text or announcement channel, else 'unsupported_channel'. */
    private async fetchDirectoryChannel(
        channelId: string
    ): Promise<TextChannel> {
        const channel = await this.client.channels.fetch(channelId);
        if (
            !channel ||
            (channel.type !== ChannelType.GuildText &&
                channel.type !== ChannelType.GuildAnnouncement) ||
            !(channel instanceof TextChannel)
        ) {
            throw new ThreadDirectoryError(
                'unsupported_channel',
                'Threads directories can only be posted in text or announcement channels.'
            );
        }
        return channel;
    }
}
