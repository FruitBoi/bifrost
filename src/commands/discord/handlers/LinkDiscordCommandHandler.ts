import { Client, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { LinkService } from '../../../services/LinkService';
import { WebhookService } from '../../../services/WebhookService';
import FluxerEntityResolver from '../../../services/entityResolver/FluxerEntityResolver';
import ThreadSyncService from '../../../services/threadSync/ThreadSyncService';
import DiscordCommandHandler, {
    DiscordCommandHandlerMessage,
} from '../DiscordCommandHandler';
import { COMMAND_PREFIX } from '../../../utils/env';
import logger from '../../../utils/logging/logger';
import { EmbedColors } from '../../../utils/embeds';

type PendingLink =
    | { type: 'guild'; fluxerGuildId: string; guildName: string }
    | {
          type: 'channel';
          fluxerChannelId: string;
          channelName: string;
          guildLinkId: string;
          discordChannelId: string;
      }
    | {
          type: 'thread';
          channelLinkId: string;
          discordThreadId: string;
          fluxerThreadId: string;
          threadName: string;
      };

export default class LinkDiscordCommandHandler extends DiscordCommandHandler {
    private pending = new Map<
        string,
        { action: PendingLink; timer: NodeJS.Timeout }
    >();

    constructor(
        client: Client,
        private readonly linkService: LinkService,
        private readonly webhookService: WebhookService,
        private readonly fluxerEntityResolver: FluxerEntityResolver,
        private readonly threadSyncService: ThreadSyncService
    ) {
        super(client);
    }

    private setPending(userId: string, action: PendingLink) {
        const existing = this.pending.get(userId);
        if (existing) clearTimeout(existing.timer);
        const timer = setTimeout(
            () => this.pending.delete(userId),
            5 * 60 * 1000
        );
        this.pending.set(userId, { action, timer });
    }

    private takePending(userId: string): PendingLink | null {
        const entry = this.pending.get(userId);
        if (!entry) return null;
        clearTimeout(entry.timer);
        this.pending.delete(userId);
        return entry.action;
    }

    public async handleCommand(
        message: DiscordCommandHandlerMessage,
        _command: string,
        ...args: string[]
    ): Promise<void> {
        const footer = this.footer(message);

        // Confirm flow
        if (args[0]?.toLowerCase() === 'confirm') {
            const pending = this.takePending(message.author.id);
            if (!pending) {
                await message.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setDescription(
                                `No pending link action. Run \`${COMMAND_PREFIX}link <id>\` first.`
                            )
                            .setColor(EmbedColors.Error)
                            .setFooter(footer)
                            .setTimestamp(),
                    ],
                });
                return;
            }

            if (pending.type === 'guild') {
                if (
                    !(await this.requirePermission(
                        message,
                        PermissionFlagsBits.ManageGuild,
                        'Manage Guild'
                    ))
                )
                    return;
                try {
                    await this.linkService.createGuildLink(
                        message.guildId!,
                        pending.fluxerGuildId
                    );
                    await message.reply({
                        embeds: [
                            new EmbedBuilder()
                                .setDescription(
                                    `This Discord server is now bridged with Fluxer guild **${pending.guildName}**.\n` +
                                        `Use \`${COMMAND_PREFIX}link <fluxer-channel-id>\` in any channel to start linking channels.`
                                )
                                .setColor(EmbedColors.Success)
                                .setFooter(footer)
                                .setTimestamp(),
                        ],
                    });
                } catch (err: unknown) {
                    await message.reply({
                        embeds: [
                            new EmbedBuilder()
                                .setDescription(
                                    `Failed to link guild: ${(err as Error).message}`
                                )
                                .setColor(EmbedColors.Error)
                                .setFooter(footer)
                                .setTimestamp(),
                        ],
                    });
                    logger.error('Link guild failed:', err);
                }
            } else if (pending.type === 'thread') {
                if (
                    !(await this.requirePermission(
                        message,
                        PermissionFlagsBits.ManageWebhooks,
                        'Manage Webhooks'
                    ))
                )
                    return;
                try {
                    const channelLink =
                        await this.linkService.getChannelLinkById(
                            pending.channelLinkId
                        );
                    if (!channelLink) {
                        throw new Error(
                            'The parent channel link no longer exists'
                        );
                    }
                    await this.threadSyncService.linkExistingThreads({
                        channelLink,
                        discordThreadId: pending.discordThreadId,
                        fluxerThreadId: pending.fluxerThreadId,
                    });
                    await message.reply({
                        embeds: [
                            new EmbedBuilder()
                                .setDescription(
                                    `Linked thread <#${pending.discordThreadId}> ↔ **${pending.threadName}** successfully.\n` +
                                        `Messages, edits, deletes and renames will now be bridged between the two threads.`
                                )
                                .setColor(EmbedColors.Success)
                                .setFooter(footer)
                                .setTimestamp(),
                        ],
                    });
                } catch (err: unknown) {
                    await message.reply({
                        embeds: [
                            new EmbedBuilder()
                                .setDescription(
                                    `Failed to link thread: ${(err as Error).message}`
                                )
                                .setColor(EmbedColors.Error)
                                .setFooter(footer)
                                .setTimestamp(),
                        ],
                    });
                    logger.error('Link thread failed:', err);
                }
            } else {
                if (
                    !(await this.requirePermission(
                        message,
                        PermissionFlagsBits.ManageWebhooks,
                        'Manage Webhooks'
                    ))
                )
                    return;
                try {
                    const discordWebhook =
                        await this.webhookService.createDiscordWebhook(
                            pending.discordChannelId,
                            `Fluxer Bridge Webhook for channel ${pending.discordChannelId}`
                        );
                    const fluxerWebhook =
                        await this.webhookService.createFluxerWebhook(
                            pending.fluxerChannelId,
                            `Discord Bridge Webhook for channel ${pending.fluxerChannelId}`
                        );
                    await this.linkService.createChannelLink({
                        guildLinkId: pending.guildLinkId,
                        discordChannelId: pending.discordChannelId,
                        fluxerChannelId: pending.fluxerChannelId,
                        discordWebhookId: discordWebhook.id,
                        discordWebhookToken: discordWebhook.token,
                        fluxerWebhookId: fluxerWebhook.id,
                        fluxerWebhookToken: fluxerWebhook.token,
                    });
                    await message.reply({
                        embeds: [
                            new EmbedBuilder()
                                .setDescription(
                                    `Linked <#${pending.discordChannelId}> ↔ **#${pending.channelName}** successfully.`
                                )
                                .setColor(EmbedColors.Success)
                                .setFooter(footer)
                                .setTimestamp(),
                        ],
                    });
                } catch (err: unknown) {
                    await message.reply({
                        embeds: [
                            new EmbedBuilder()
                                .setDescription(
                                    `Failed to link channel: ${(err as Error).message}`
                                )
                                .setColor(EmbedColors.Error)
                                .setFooter(footer)
                                .setTimestamp(),
                        ],
                    });
                    logger.error('Link channel failed:', err);
                }
            }
            return;
        }

        // Detection phase
        const id = args[0];
        if (!id) {
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription(
                            `Usage: \`${COMMAND_PREFIX}link <id>\`\n` +
                                `> Provide a Fluxer guild ID to bridge servers, or a Fluxer channel ID to bridge channels.\n` +
                                `> Inside a thread of a linked channel, provide a Fluxer thread ID to bridge threads.\n` +
                                `> Then run \`${COMMAND_PREFIX}link confirm\` to proceed.`
                        )
                        .setColor(EmbedColors.Error)
                        .setFooter(footer)
                        .setTimestamp(),
                ],
            });
            return;
        }

        // 0. Inside a thread: link this thread to a Fluxer thread
        if (message.channel.isThread()) {
            await this.handleThreadLink(message, id);
            return;
        }

        // 1. Try Fluxer guild
        const fluxerGuild = await this.fluxerEntityResolver
            .fetchGuild(id)
            .catch(() => null);
        if (fluxerGuild) {
            if (
                !(await this.requirePermission(
                    message,
                    PermissionFlagsBits.ManageGuild,
                    'Manage Guild'
                ))
            )
                return;
            const guildName = (fluxerGuild as { name?: string }).name ?? id;
            this.setPending(message.author.id, {
                type: 'guild',
                fluxerGuildId: id,
                guildName,
            });
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription(
                            `Found Fluxer guild **${guildName}**.\n` +
                                `Run \`${COMMAND_PREFIX}link confirm\` to bridge this Discord server to it.`
                        )
                        .setColor(EmbedColors.Warning)
                        .setFooter(footer)
                        .setTimestamp(),
                ],
            });
            return;
        }

        // 2. Try Fluxer channel (requires existing guild link)
        const guildLink = await this.linkService
            .getGuildLinkForDiscordGuild(message.guildId!)
            .catch(() => null);
        if (guildLink) {
            const fluxerChannel = await this.fluxerEntityResolver
                .fetchChannel(guildLink.fluxerGuildId, id)
                .catch(() => null);
            if (fluxerChannel) {
                if (
                    !(await this.requirePermission(
                        message,
                        PermissionFlagsBits.ManageWebhooks,
                        'Manage Webhooks'
                    ))
                )
                    return;
                const channelName =
                    (fluxerChannel as { name?: string }).name ?? id;
                this.setPending(message.author.id, {
                    type: 'channel',
                    fluxerChannelId: id,
                    channelName,
                    guildLinkId: guildLink.id,
                    discordChannelId: message.channelId,
                });
                await message.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setDescription(
                                `Found Fluxer channel **#${channelName}**.\n` +
                                    `Run \`${COMMAND_PREFIX}link confirm\` to link <#${message.channelId}> to it.`
                            )
                            .setColor(EmbedColors.Warning)
                            .setFooter(footer)
                            .setTimestamp(),
                    ],
                });
                return;
            }
        }

        // 3. Nothing found
        const hint = guildLink
            ? ''
            : ` (Link a Fluxer guild first with \`${COMMAND_PREFIX}link <fluxer-guild-id>\`)`;
        await message.reply({
            embeds: [
                new EmbedBuilder()
                    .setDescription(
                        `Could not find a Fluxer guild or channel with ID \`${id}\`.${hint}`
                    )
                    .setColor(EmbedColors.Error)
                    .setFooter(footer)
                    .setTimestamp(),
            ],
        });
    }

    private async handleThreadLink(
        message: DiscordCommandHandlerMessage,
        fluxerThreadId: string
    ): Promise<void> {
        const footer = this.footer(message);
        const thread = message.channel;
        if (!thread.isThread()) return;

        const parentId = thread.parentId;
        const channelLink = parentId
            ? await this.linkService
                  .getChannelLinkByDiscordChannelId(parentId)
                  .catch(() => null)
            : null;
        if (!channelLink) {
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription(
                            `This thread's parent channel is not linked. ` +
                                `Link the parent channel first with \`${COMMAND_PREFIX}link <fluxer-channel-id>\`, then link threads inside it.`
                        )
                        .setColor(EmbedColors.Error)
                        .setFooter(footer)
                        .setTimestamp(),
                ],
            });
            return;
        }

        const existing = await this.linkService
            .getThreadLinkByDiscordThreadId(thread.id)
            .catch(() => null);
        if (existing) {
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription(
                            `This thread is already linked to Fluxer thread \`${existing.fluxerThreadId}\`.\n` +
                                `Use \`${COMMAND_PREFIX}unlink ${existing.fluxerThreadId}\` to remove it first.`
                        )
                        .setColor(EmbedColors.Error)
                        .setFooter(footer)
                        .setTimestamp(),
                ],
            });
            return;
        }

        const fluxerThread = await this.fluxerEntityResolver
            .fetchThread(fluxerThreadId)
            .catch(() => null);
        if (!fluxerThread) {
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription(
                            `Could not find a Fluxer thread with ID \`${fluxerThreadId}\`.\n` +
                                `> Inside a thread, \`${COMMAND_PREFIX}link <id>\` expects the ID of a thread in the linked Fluxer channel.`
                        )
                        .setColor(EmbedColors.Error)
                        .setFooter(footer)
                        .setTimestamp(),
                ],
            });
            return;
        }

        if (fluxerThread.parentId !== channelLink.fluxerChannelId) {
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription(
                            `Fluxer thread \`${fluxerThreadId}\` is not a thread of the linked Fluxer channel \`${channelLink.fluxerChannelId}\`.\n` +
                                `> Threads can only be bridged to threads of the channel their parent is linked to.`
                        )
                        .setColor(EmbedColors.Error)
                        .setFooter(footer)
                        .setTimestamp(),
                ],
            });
            return;
        }

        if (
            !(await this.requirePermission(
                message,
                PermissionFlagsBits.ManageWebhooks,
                'Manage Webhooks'
            ))
        )
            return;

        const threadName = fluxerThread.name ?? fluxerThreadId;
        this.setPending(message.author.id, {
            type: 'thread',
            channelLinkId: channelLink.id,
            discordThreadId: thread.id,
            fluxerThreadId,
            threadName,
        });
        await message.reply({
            embeds: [
                new EmbedBuilder()
                    .setDescription(
                        `Found Fluxer thread **${threadName}**.\n` +
                            `Run \`${COMMAND_PREFIX}link confirm\` to link this thread to it.`
                    )
                    .setColor(EmbedColors.Warning)
                    .setFooter(footer)
                    .setTimestamp(),
            ],
        });
    }
}
