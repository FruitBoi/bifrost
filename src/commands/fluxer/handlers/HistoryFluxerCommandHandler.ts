import {
    Channel,
    Client,
    EmbedBuilder,
    Guild,
    GuildMember,
    Message,
    PermissionFlags,
} from '@fluxerjs/core';
import FluxerCommandHandler from '../FluxerCommandHandler';
import { memberPermissionsIn } from './RemindMeFluxerCommandHandler';
import { getFluxerCommandUsage } from '../../commandList';
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
import FluxerHistorySource, {
    FluxerHistoryChannel,
} from '../../../services/history/FluxerHistorySource';
import type FluxerToDiscordMessageRelay from '../../../services/messageRelay/FluxerToDiscordMessageRelay';
import type ThreadSyncService from '../../../services/threadSync/ThreadSyncService';
import type { LinkService } from '../../../services/LinkService';
import type { ChannelLink } from '../../../db/entities/ChannelLink';
import { COMMAND_PREFIX } from '../../../utils/env';
import { EmbedColors } from '../../../utils/embeds';
import logger from '../../../utils/logging/logger';

export interface HistoryFluxerCommandOptions {
    linkService: LinkService;
    threadSyncService: ThreadSyncService;
    messageRelay: FluxerToDiscordMessageRelay;
    historyService: HistoryTransferService;
    moderatorRoleIds: readonly string[];
    limits: HistoryArgsLimits;
    delayMs: number;
}

/**
 * `history [num|all|confirm|status|stop] [switches]` (alias `backfill`):
 * copies the history of the linked channel or thread the command is run in
 * to its Discord counterpart, through the same pipeline as live bridging
 * (issue #16). A moderator command (`roles.moderator`), bot prefix only.
 * `all` needs a `confirm` within two minutes; already bridged messages are
 * skipped so re-runs resume; the job runs in the background and this
 * handler keeps its status reply up to date.
 */
export default class HistoryFluxerCommandHandler extends FluxerCommandHandler {
    private readonly pending = new PendingHistoryStore();

    constructor(
        client: Client,
        private readonly options: HistoryFluxerCommandOptions
    ) {
        super(client);
    }

    private embed(
        message: Message,
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
        message: Message,
        description: string,
        color: number
    ): Promise<void> {
        await message.reply({
            embeds: [this.embed(message, description, color)],
        });
    }

    /** An error line followed by the command usage, in one reply. */
    private async replyUsage(
        message: Message,
        error: string | null
    ): Promise<void> {
        const usage = getFluxerCommandUsage('history');
        const embeds = [...(usage.embeds ?? [])];
        if (error) {
            embeds.unshift(this.embed(message, error, EmbedColors.Error));
        }
        await message.reply({ ...usage, embeds });
    }

    /** The bot's own member in `guild`: from the cache, else fetched. */
    private async fetchOwnMember(guild: Guild): Promise<GuildMember | null> {
        if (guild.members.me) return guild.members.me;
        const userId = this.getClient().user?.id;
        if (!userId) return null;
        return guild.fetchMember(userId).catch((err: unknown) => {
            logger.warn(
                `⚠️ Could not fetch the bot's own member in Fluxer guild ${guild.id}:`,
                err
            );
            return null;
        });
    }

    /** The link of the channel, resolving a thread like the live relay does. */
    private async resolveLink(
        message: Message,
        channel: FluxerHistoryChannel
    ): Promise<ChannelLink | null> {
        const link =
            await this.options.linkService.getChannelLinkByFluxerLocation(
                message.channelId
            );
        if (link) return link;
        if (channel.isThread()) {
            return this.options.threadSyncService.resolveFluxerThread(channel);
        }
        return null;
    }

    private jobEmbed(
        message: Message,
        job: HistoryJob,
        link: ChannelLink
    ): EmbedBuilder {
        const description = describeHistoryJob(job, {
            target: historyTargetLabel(link, 'fluxer'),
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
        message: Message,
        _command: string,
        ...args: string[]
    ): Promise<void> {
        if (!message.guildId) {
            await this.reply(
                message,
                'This command must be used in a server.',
                EmbedColors.Error
            );
            return;
        }
        if (message.author.bot || message.webhookId) {
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

        const resolved: Channel | null =
            message.channel ??
            (await message.resolveChannel().catch(() => null));
        if (!resolved || !(resolved.isText() || resolved.isThread())) {
            await this.reply(
                message,
                'History can only be transferred from text channels and threads.',
                EmbedColors.Error
            );
            return;
        }
        const channel: FluxerHistoryChannel = resolved;

        const link = await this.resolveLink(message, channel);
        if (!link) {
            await this.reply(
                message,
                `This channel is not linked to a Discord channel or thread. Use \`${COMMAND_PREFIX}link\` first.`,
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

        const guild =
            message.guild ?? (await message.resolveGuild().catch(() => null));
        const me = guild ? await this.fetchOwnMember(guild) : null;
        const myPermissions = me ? memberPermissionsIn(me, channel) : null;
        if (
            !myPermissions ||
            !myPermissions.has(PermissionFlags.ReadMessageHistory)
        ) {
            await this.reply(
                message,
                'I need the `Read Message History` permission in this channel to transfer its history.',
                EmbedColors.Error
            );
            return;
        }

        const { historyService } = this.options;
        const target = historyTargetLabel(link, 'fluxer');

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

        const source = new FluxerHistorySource({
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
            `📜 History transfer ${job.id} requested by ${message.author.id} for Fluxer channel ${message.channelId} (link ${link.id})`
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
