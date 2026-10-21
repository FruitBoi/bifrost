import {
    Client,
    EmbedBuilder,
    GuildMember,
    GuildTextBasedChannel,
    Message,
    PermissionFlagsBits,
} from 'discord.js';
import DiscordCommandHandler, {
    DiscordCommandHandlerMessage,
} from '../DiscordCommandHandler';
import { getDiscordCommandUsage } from '../../commandList';
import { stripCommandInvocation } from '../../commandTrigger';
import {
    describeHistoryConfirmation,
    describeHistoryJob,
    HistoryStatusEditor,
    historyStatusColor,
    historyTargetLabel,
    PendingHistoryStore,
} from '../../historyCommand';
import {
    HISTORY_COMMAND_NAMES,
    HistoryArgsLimits,
    historyFailureMessage,
    parseHistoryArgs,
} from '../../../services/history/historyArgs';
import type {
    HistoryJob,
    HistoryOptions,
} from '../../../services/history/HistorySource';
import HistoryTransferService, {
    HistoryTransferError,
} from '../../../services/history/HistoryTransferService';
import DiscordHistorySource from '../../../services/history/DiscordHistorySource';
import type DiscordToFluxerMessageRelay from '../../../services/messageRelay/DiscordToFluxerMessageRelay';
import type ThreadSyncService from '../../../services/threadSync/ThreadSyncService';
import type { LinkService } from '../../../services/LinkService';
import type { ChannelLink } from '../../../db/entities/ChannelLink';
import { COMMAND_PREFIX } from '../../../utils/env';
import { EmbedColors } from '../../../utils/embeds';
import logger from '../../../utils/logging/logger';

export interface HistoryDiscordCommandOptions {
    linkService: LinkService;
    threadSyncService: ThreadSyncService;
    messageRelay: DiscordToFluxerMessageRelay;
    historyService: HistoryTransferService;
    moderatorRoleIds: readonly string[];
    limits: HistoryArgsLimits;
    delayMs: number;
}

/**
 * `history [num|all|confirm|status|stop] [switches]` (alias `backfill`):
 * copies the history of the linked channel or thread the command is run in
 * to its Fluxer counterpart, through the same pipeline as live bridging
 * (issue #16). A moderator command (`roles.moderator`), bot prefix only.
 * `all` needs a `confirm` within two minutes; already bridged messages are
 * skipped so re-runs resume; the job runs in the background and this
 * handler keeps its status reply up to date.
 */
export default class HistoryDiscordCommandHandler extends DiscordCommandHandler {
    private readonly pending = new PendingHistoryStore();

    constructor(
        client: Client,
        private readonly options: HistoryDiscordCommandOptions
    ) {
        super(client);
    }

    private embed(
        message: DiscordCommandHandlerMessage,
        description: string,
        color: number
    ): EmbedBuilder {
        return new EmbedBuilder()
            .setDescription(description)
            .setColor(color)
            .setFooter(this.footer(message))
            .setTimestamp();
    }

    private async reply(
        message: DiscordCommandHandlerMessage,
        description: string,
        color: number
    ): Promise<void> {
        await message.reply({
            embeds: [this.embed(message, description, color)],
        });
    }

    /** Replies with the usage embed, preceded by an error embed when given. */
    private async replyUsage(
        message: DiscordCommandHandlerMessage,
        error?: string
    ): Promise<void> {
        const usage = getDiscordCommandUsage('history');
        if (!error) {
            await message.reply(usage);
            return;
        }
        await message.reply({
            embeds: [
                this.embed(message, error, EmbedColors.Error),
                ...(usage.embeds ?? []),
            ],
        });
    }

    /** The link of the channel, resolving a thread like the live relay does. */
    private async resolveLink(
        message: DiscordCommandHandlerMessage,
        channel: GuildTextBasedChannel
    ): Promise<ChannelLink | null> {
        const link =
            await this.options.linkService.getChannelLinkByDiscordLocation(
                message.channelId
            );
        if (link) return link;
        if (channel.isThread()) {
            return this.options.threadSyncService.resolveDiscordThread(channel);
        }
        return null;
    }

    private jobEmbed(
        message: DiscordCommandHandlerMessage,
        job: HistoryJob,
        link: ChannelLink
    ): EmbedBuilder {
        const description = describeHistoryJob(job, {
            target: historyTargetLabel(link, 'discord'),
            queuePosition: this.options.historyService.queuePosition(link.id),
            delayMs: this.options.delayMs,
            now: Date.now(),
        });
        return this.embed(
            message,
            description,
            historyStatusColor(job.progress.status)
        );
    }

    public async handleCommand(
        message: DiscordCommandHandlerMessage,
        _command: string,
        ...args: string[]
    ): Promise<void> {
        if (!message.inGuild()) {
            await this.reply(
                message,
                'This command must be used in a server.',
                EmbedColors.Error
            );
            return;
        }
        if (message.author.bot) {
            await this.reply(
                message,
                'Bots cannot use this command.',
                EmbedColors.Error
            );
            return;
        }
        if (!(await this.requireRole(message, this.options.moderatorRoleIds))) {
            return;
        }

        const raw =
            stripCommandInvocation(
                message.content,
                [COMMAND_PREFIX],
                HISTORY_COMMAND_NAMES
            ) ?? args.join(' ');
        const parsed = parseHistoryArgs(raw, this.options.limits);
        if (!parsed.ok) {
            await this.replyUsage(message, historyFailureMessage(parsed));
            return;
        }

        // Voice channels count as text-based in discord.js; history is
        // bridged for text channels, announcement channels and threads.
        const channel = message.channel;
        if (!channel.isTextBased() || channel.isVoiceBased()) {
            await this.reply(
                message,
                'History can only be transferred from text channels and threads.',
                EmbedColors.Error
            );
            return;
        }

        const link = await this.resolveLink(message, channel);
        if (!link) {
            await this.reply(
                message,
                `This channel is not linked to a Fluxer channel or thread. Use \`${COMMAND_PREFIX}link\` first.`,
                EmbedColors.Error
            );
            return;
        }
        const guildLink = await this.options.linkService.getGuildLinkById(
            link.guildLinkId
        );
        if (!guildLink) {
            await this.reply(
                message,
                'The server link behind this channel link could not be found.',
                EmbedColors.Error
            );
            return;
        }

        let me: GuildMember | null = message.guild.members.me;
        if (!me) {
            me = await message.guild.members.fetchMe().catch(() => null);
        }
        if (
            !me ||
            !me
                .permissionsIn(channel)
                .has(PermissionFlagsBits.ReadMessageHistory)
        ) {
            await this.reply(
                message,
                'I need the `Read Message History` permission in this channel to transfer its history.',
                EmbedColors.Error
            );
            return;
        }

        const { historyService } = this.options;
        const target = historyTargetLabel(link, 'discord');

        if (parsed.action === 'status') {
            const job = historyService.getJob(link.id);
            if (!job) {
                const elsewhere = historyService.activeCount;
                await this.reply(
                    message,
                    'No history transfer is running or queued for this channel.' +
                        (elsewhere > 0
                            ? `\n${elsewhere} transfer(s) are running or queued in other channels.`
                            : ''),
                    EmbedColors.Info
                );
                return;
            }
            await message.reply({
                embeds: [this.jobEmbed(message, job, link)],
            });
            return;
        }

        if (parsed.action === 'stop') {
            const stopped = historyService.stop(link.id);
            await this.reply(
                message,
                stopped
                    ? 'Stopping the history transfer for this channel. Already posted copies stay; re-run `history` later to continue where it stopped.'
                    : 'No history transfer is running or queued for this channel.',
                stopped ? EmbedColors.Warning : EmbedColors.Info
            );
            return;
        }

        let options: HistoryOptions;
        if (parsed.action === 'confirm') {
            const pending = this.pending.take(message.author.id);
            if (!pending) {
                await this.reply(
                    message,
                    `Nothing to confirm. Run \`${COMMAND_PREFIX}history all\` first; a confirmation is valid for 2 minutes.`,
                    EmbedColors.Error
                );
                return;
            }
            if (pending.channelLinkId !== link.id) {
                await this.reply(
                    message,
                    'Your pending history transfer was requested in another channel; run `history confirm` there.',
                    EmbedColors.Error
                );
                return;
            }
            options = pending.options;
        } else {
            options = parsed.options;
            if (parsed.needsConfirm) {
                this.pending.set(message.author.id, {
                    options,
                    channelLinkId: link.id,
                });
                await this.reply(
                    message,
                    describeHistoryConfirmation(
                        options,
                        target,
                        this.options.delayMs
                    ),
                    EmbedColors.Warning
                );
                return;
            }
        }

        const source = new DiscordHistorySource({
            client: this.getClient(),
            channel,
            link,
            guildLink,
            relay: this.options.messageRelay,
            linkService: this.options.linkService,
        });

        let statusMessage: Message | null = null;
        // Progress reported before the status reply exists is shown as soon
        // as it does.
        let missed: HistoryJob | null = null;
        const render = (job: HistoryJob) => this.jobEmbed(message, job, link);
        const tracker = new HistoryStatusEditor(async (job) => {
            if (!statusMessage) {
                missed = job;
                return;
            }
            await statusMessage.edit({ embeds: [render(job)] });
        });

        let job: HistoryJob;
        try {
            job = historyService.start(
                source,
                options,
                message.author.id,
                (progress) => tracker.update(progress)
            );
        } catch (err) {
            if (err instanceof HistoryTransferError) {
                await this.reply(
                    message,
                    err.reason === 'already_running'
                        ? `A history transfer is already running or queued for this channel. \`${COMMAND_PREFIX}history status\` shows it, \`${COMMAND_PREFIX}history stop\` cancels it.`
                        : err.message,
                    EmbedColors.Error
                );
                return;
            }
            throw err;
        }

        logger.info(
            `📜 History transfer ${job.id} requested by ${message.author.id} for Discord channel ${message.channelId} (link ${link.id})`
        );

        try {
            statusMessage = await message.reply({
                embeds: [render(job)],
            });
            tracker.shown(job);
            if (missed) tracker.update(missed);
        } catch (err) {
            logger.warn(
                `⚠️ Could not post the history transfer status for link ${link.id}; the transfer runs anyway:`,
                err
            );
        }
    }
}
