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
    DirectoryRender,
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

/** Embeds of a directory: title on the first, timestamp on the last. */
export function buildFluxerDirectoryEmbeds(
    render: DirectoryRender
): EmbedBuilder[] {
    return render.descriptions.map((description, i) => {
        const embed = new EmbedBuilder()
            .setColor(EmbedColors.Info)
            .setDescription(description);
        if (i === 0) embed.setTitle(render.title);
        if (i === render.descriptions.length - 1) embed.setTimestamp();
        return embed;
    });
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

    async sendDirectory(
        channelId: string,
        render: DirectoryRender
    ): Promise<string> {
        const channel = await this.fetchDirectoryChannel(channelId);
        const message = await channel.send({
            embeds: buildFluxerDirectoryEmbeds(render),
            allowedMentions: { parse: [] },
        });
        return message.id;
    }

    async editDirectory(
        channelId: string,
        messageId: string,
        render: DirectoryRender
    ): Promise<boolean> {
        try {
            const message = await this.client.channels.fetchMessage(
                channelId,
                messageId
            );
            await message.edit({
                embeds: buildFluxerDirectoryEmbeds(render),
                allowedMentions: { parse: [] },
            });
            return true;
        } catch (err) {
            if (isGoneError(err)) return false;
            throw err;
        }
    }

    async deleteDirectory(channelId: string, messageId: string): Promise<void> {
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
