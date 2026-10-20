import {
    Client,
    EmbedBuilder,
    Message,
    PermissionsBitField,
} from '@fluxerjs/core';
import { LinkService } from '../../../services/LinkService';
import CategorySyncService, {
    CategorySyncItem,
} from '../../../services/categorySync/CategorySyncService';
import FluxerCommandHandler from '../FluxerCommandHandler';
import { getFluxerCommandUsage } from '../../commandList';
import { COMMAND_PREFIX } from '../../../utils/env';
import logger from '../../../utils/logging/logger';
import { chunkDescriptionLines, EmbedColors } from '../../../utils/embeds';

type PendingCategoryAction =
    | {
          type: 'create';
          guildLinkId: string;
          discordCategoryId: string;
          fluxerChannelId: string;
      }
    | { type: 'remove'; categoryLinkId: string };

export default class CategoryFluxerCommandHandler extends FluxerCommandHandler {
    private pending = new Map<
        string,
        { action: PendingCategoryAction; timer: NodeJS.Timeout }
    >();

    constructor(
        client: Client,
        private readonly linkService: LinkService,
        private readonly categorySyncService: CategorySyncService
    ) {
        super(client);
    }

    private setPending(userId: string, action: PendingCategoryAction) {
        const existing = this.pending.get(userId);
        if (existing) clearTimeout(existing.timer);
        const timer = setTimeout(
            () => this.pending.delete(userId),
            5 * 60 * 1000
        );
        this.pending.set(userId, { action, timer });
    }

    private takePending(userId: string): PendingCategoryAction | null {
        const entry = this.pending.get(userId);
        if (!entry) return null;
        clearTimeout(entry.timer);
        this.pending.delete(userId);
        return entry.action;
    }

    private async replyError(
        message: Message,
        description: string
    ): Promise<void> {
        await message.reply({
            embeds: [
                new EmbedBuilder()
                    .setDescription(description)
                    .setColor(EmbedColors.Error)
                    .setFooter(this.footer(message))
                    .setTimestamp(),
            ],
        });
    }

    /**
     * The Fluxer channel that hosts the category's threads: the invoking
     * channel, or its parent when the command is run inside a thread.
     */
    private async resolveHostChannelId(message: Message): Promise<string> {
        const channel =
            message.channel ??
            (await message.resolveChannel().catch(() => null));
        if (channel?.isThread() && channel.parentId) {
            return channel.parentId;
        }
        return message.channelId;
    }

    private formatItems(items: CategorySyncItem[], withReason = false) {
        return items.map((item) =>
            withReason && item.reason
                ? `#${item.channelName} — ${item.reason}`
                : `#${item.channelName}`
        );
    }

    public async handleCommand(
        message: Message,
        _command: string,
        ...args: string[]
    ): Promise<void> {
        const footer = this.footer(message);

        if (!message.guildId) {
            await this.replyError(
                message,
                'This command must be used in a server.'
            );
            return;
        }

        if (
            !(await this.requirePermission(
                message,
                PermissionsBitField.Flags.ManageWebhooks,
                'Manage Webhooks'
            ))
        )
            return;

        const hostChannelId = await this.resolveHostChannelId(message);
        const sub = args[0]?.toLowerCase();

        // ------------------------------------------------------------------
        // confirm
        // ------------------------------------------------------------------
        if (sub === 'confirm') {
            const pending = this.takePending(message.author.id);
            if (!pending) {
                await this.replyError(
                    message,
                    `No pending category action. Run \`${COMMAND_PREFIX}category <discord-category-id>\` or \`${COMMAND_PREFIX}category unlink <discord-category-id>\` first.`
                );
                return;
            }

            if (pending.type === 'create') {
                try {
                    const guildLink = await this.linkService.getGuildLinkById(
                        pending.guildLinkId
                    );
                    if (!guildLink) {
                        throw new Error('this server is no longer linked');
                    }
                    const { result } =
                        await this.categorySyncService.createCategoryLink(
                            guildLink,
                            pending.discordCategoryId,
                            pending.fluxerChannelId
                        );

                    const lines: string[] = [
                        `Linked Discord category \`${pending.discordCategoryId}\` → <#${pending.fluxerChannelId}>.\n` +
                            `**${result.linked.length}** linked · **${result.skipped.length}** skipped · **${result.failed.length}** failed`,
                    ];
                    if (result.linked.length > 0) {
                        lines.push(
                            `**Linked**\n${this.formatItems(result.linked).join('\n')}`
                        );
                    }
                    if (result.skipped.length > 0) {
                        lines.push(
                            `**Skipped**\n${this.formatItems(result.skipped, true).join('\n')}`
                        );
                    }
                    if (result.failed.length > 0) {
                        lines.push(
                            `**Failed**\n${this.formatItems(result.failed, true).join('\n')}`
                        );
                    }

                    const chunks = chunkDescriptionLines(lines);
                    const embeds = chunks.map((chunk) =>
                        new EmbedBuilder()
                            .setDescription(chunk.join('\n\n'))
                            .setColor(
                                result.failed.length > 0
                                    ? EmbedColors.Warning
                                    : EmbedColors.Success
                            )
                    );
                    embeds[embeds.length - 1].setFooter(footer).setTimestamp();
                    await message.reply({ embeds });
                } catch (err: unknown) {
                    await this.replyError(
                        message,
                        `Failed to link category: ${(err as Error).message}`
                    );
                    logger.error('Category link failed:', err);
                }
                return;
            }

            try {
                const categoryLink = await this.linkService.getCategoryLinkById(
                    pending.categoryLinkId
                );
                if (!categoryLink) {
                    throw new Error('that category link no longer exists');
                }
                const { removedLinks } =
                    await this.categorySyncService.removeCategoryLink(
                        categoryLink
                    );
                await message.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setDescription(
                                `Removed the category link for Discord category \`${categoryLink.discordCategoryId}\` and **${removedLinks}** channel ↔ thread link(s). The Fluxer threads were kept.`
                            )
                            .setColor(EmbedColors.Success)
                            .setFooter(footer)
                            .setTimestamp(),
                    ],
                });
            } catch (err: unknown) {
                await this.replyError(
                    message,
                    `Failed to unlink category: ${(err as Error).message}`
                );
                logger.error('Category unlink failed:', err);
            }
            return;
        }

        // ------------------------------------------------------------------
        // no args: list category links hosted by this channel
        // ------------------------------------------------------------------
        if (!sub) {
            try {
                const categoryLinks =
                    await this.linkService.getCategoryLinksForFluxerChannel(
                        hostChannelId
                    );
                if (categoryLinks.length === 0) {
                    await message.reply(getFluxerCommandUsage('category'));
                    return;
                }
                const lines = await Promise.all(
                    categoryLinks.map(async (categoryLink) => {
                        const links =
                            await this.linkService.getChannelLinksForCategoryLink(
                                categoryLink.id
                            );
                        return `📁 \`${categoryLink.discordCategoryId}\` · ${links.length} channel(s)`;
                    })
                );
                const chunks = chunkDescriptionLines(lines, '\n');
                const embeds = chunks.map((chunk, i) =>
                    new EmbedBuilder()
                        .setTitle(
                            i === 0
                                ? `Discord categories bridged into <#${hostChannelId}>`
                                : null
                        )
                        .setDescription(chunk.join('\n'))
                        .setColor(EmbedColors.Info)
                );
                embeds[embeds.length - 1].setFooter(footer).setTimestamp();
                await message.reply({ embeds });
            } catch (err: unknown) {
                await this.replyError(
                    message,
                    `Failed to list category links: ${(err as Error).message}`
                );
                logger.error('Error listing category links:', err);
            }
            return;
        }

        const guildLink = await this.linkService
            .getGuildLinkForFluxerGuild(message.guildId)
            .catch(() => null);
        if (!guildLink) {
            await this.replyError(
                message,
                `This server is not linked to a Discord guild. Link one first with \`${COMMAND_PREFIX}link <discord-guild-id>\`.`
            );
            return;
        }

        // ------------------------------------------------------------------
        // unlink <discordCategoryId>
        // ------------------------------------------------------------------
        if (sub === 'unlink') {
            const discordCategoryId = args[1];
            if (!discordCategoryId) {
                await message.reply(getFluxerCommandUsage('category'));
                return;
            }
            const categoryLink =
                await this.linkService.getCategoryLinkByDiscordCategoryId(
                    discordCategoryId
                );
            if (!categoryLink || categoryLink.guildLinkId !== guildLink.id) {
                await this.replyError(
                    message,
                    `Discord category \`${discordCategoryId}\` is not linked in this server.`
                );
                return;
            }
            const links = await this.linkService.getChannelLinksForCategoryLink(
                categoryLink.id
            );

            this.setPending(message.author.id, {
                type: 'remove',
                categoryLinkId: categoryLink.id,
            });
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription(
                            `This removes the category link for Discord category \`${discordCategoryId}\` → <#${categoryLink.fluxerChannelId}> and its **${links.length}** channel ↔ thread link(s). The Fluxer threads stay.\n` +
                                `Run \`${COMMAND_PREFIX}category confirm\` to proceed.`
                        )
                        .setColor(EmbedColors.Warning)
                        .setFooter(footer)
                        .setTimestamp(),
                ],
            });
            return;
        }

        // ------------------------------------------------------------------
        // <discordCategoryId>: preview
        // ------------------------------------------------------------------
        const discordCategoryId = args[0];
        try {
            const preview = await this.categorySyncService.preview(
                guildLink,
                discordCategoryId,
                hostChannelId
            );

            const channelLines = preview.channels.map((channel) =>
                channel.alreadyLinked
                    ? `~~#${channel.name}~~ (already linked, skipped)`
                    : `#${channel.name}`
            );
            const toLink = preview.channels.filter(
                (c) => !c.alreadyLinked
            ).length;
            const header =
                `Found Discord category **${preview.discordCategoryName}** with ${preview.channels.length} text channel(s).\n` +
                `Each one will get a thread inside **#${preview.fluxerChannelName}** (**${toLink}** to bridge).`;
            const trailer = `Run \`${COMMAND_PREFIX}category confirm\` to proceed.`;

            const lines = [
                header,
                ...(channelLines.length > 0
                    ? [channelLines.join('\n')]
                    : ['*(no text channels)*']),
                trailer,
            ];
            const chunks = chunkDescriptionLines(lines);
            const embeds = chunks.map((chunk) =>
                new EmbedBuilder()
                    .setDescription(chunk.join('\n\n'))
                    .setColor(EmbedColors.Warning)
            );
            embeds[embeds.length - 1].setFooter(footer).setTimestamp();

            this.setPending(message.author.id, {
                type: 'create',
                guildLinkId: guildLink.id,
                discordCategoryId,
                fluxerChannelId: hostChannelId,
            });
            await message.reply({ embeds });
        } catch (err: unknown) {
            await this.replyError(
                message,
                `Cannot link category \`${discordCategoryId}\`: ${(err as Error).message}`
            );
            logger.error('Category preview failed:', err);
        }
    }
}
