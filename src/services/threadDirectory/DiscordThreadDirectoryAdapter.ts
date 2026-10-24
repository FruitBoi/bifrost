import {
    AnyThreadChannel,
    ChannelType,
    Client,
    EmbedBuilder,
    NewsChannel,
    TextChannel,
} from 'discord.js';
import { EmbedColors } from '../../utils/embeds';
import logger from '../../utils/logging/logger';
import {
    DirectoryRender,
    DirectoryThread,
    ThreadDirectoryError,
    ThreadDirectoryPlatformAdapter,
} from './ThreadDirectoryService';

/** Archived threads per page; Discord's maximum. */
const ARCHIVED_PAGE_SIZE = 100;
/** Safety net against an API that keeps answering `hasMore` without progress. */
const MAX_ARCHIVED_PAGES = 50;

/** Discord error codes meaning the message (or its channel) is gone. */
const UNKNOWN_MESSAGE = 10008;
const UNKNOWN_CHANNEL = 10003;

function isGoneError(err: unknown): boolean {
    if (typeof err !== 'object' || err === null) return false;
    const { code, status } = err as { code?: unknown; status?: unknown };
    return (
        code === UNKNOWN_MESSAGE || code === UNKNOWN_CHANNEL || status === 404
    );
}

/** Embeds of a directory: title on the first, timestamp on the last. */
export function buildDiscordDirectoryEmbeds(
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

type DirectoryChannel = TextChannel | NewsChannel;

/** Discord side of the threads directory. */
export default class DiscordThreadDirectoryAdapter implements ThreadDirectoryPlatformAdapter {
    readonly platform = 'discord' as const;

    constructor(private readonly client: Client) {}

    async listThreads(
        _guildId: string,
        channelId: string
    ): Promise<DirectoryThread[]> {
        const channel = await this.fetchDirectoryChannel(channelId);
        const threads = new Map<string, DirectoryThread>();
        const add = (thread: AnyThreadChannel) => {
            if (thread.parentId !== channelId) return;
            if (thread.type === ChannelType.PrivateThread) return;
            threads.set(thread.id, { id: thread.id, name: thread.name });
        };

        const active = await channel.threads.fetchActive();
        active.threads.forEach(add);

        try {
            let before: Date | undefined;
            for (let page = 0; page < MAX_ARCHIVED_PAGES; page++) {
                const archived = await channel.threads.fetchArchived({
                    type: 'public',
                    before,
                    limit: ARCHIVED_PAGE_SIZE,
                });
                archived.threads.forEach(add);

                const last = archived.threads.last();
                const lastArchivedAt = last?.archivedAt ?? null;
                if (!archived.hasMore || !lastArchivedAt) break;
                if (before && lastArchivedAt.getTime() >= before.getTime()) {
                    break;
                }
                before = lastArchivedAt;
            }
        } catch (err) {
            logger.warn(
                `⚠️ Could not list archived threads of Discord channel ${channelId}; listing active threads only:`,
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
            embeds: buildDiscordDirectoryEmbeds(render),
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
            const channel = await this.fetchDirectoryChannel(channelId);
            await channel.messages.edit(messageId, {
                embeds: buildDiscordDirectoryEmbeds(render),
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
            const channel = await this.fetchDirectoryChannel(channelId);
            await channel.messages.delete(messageId);
        } catch (err) {
            if (isGoneError(err)) return;
            throw err;
        }
    }

    messageUrl(guildId: string, channelId: string, messageId: string): string {
        return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
    }

    /** The channel as a text or announcement channel, else 'unsupported_channel'. */
    private async fetchDirectoryChannel(
        channelId: string
    ): Promise<DirectoryChannel> {
        const channel = await this.client.channels.fetch(channelId);
        if (
            !channel ||
            (channel.type !== ChannelType.GuildText &&
                channel.type !== ChannelType.GuildAnnouncement)
        ) {
            throw new ThreadDirectoryError(
                'unsupported_channel',
                'Threads directories can only be posted in text or announcement channels.'
            );
        }
        return channel;
    }
}
