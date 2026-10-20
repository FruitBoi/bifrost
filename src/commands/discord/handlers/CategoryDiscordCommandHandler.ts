import {
    ChannelType,
    Client,
    EmbedBuilder,
    PermissionFlagsBits,
} from 'discord.js';
import { LinkService } from '../../../services/LinkService';
import CategorySyncService, {
    CategorySyncItem,
} from '../../../services/categorySync/CategorySyncService';
import DiscordCommandHandler, {
    DiscordCommandHandlerMessage,
} from '../DiscordCommandHandler';
import { getDiscordCommandUsage } from '../../../commands/commandList';
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

/**
 * `category <fluxerChannelId> | unlink | confirm` — bridges every text
 * channel of the current channel's category to threads inside one Fluxer
 * channel (or removes such a bridge). Actions are previewed first and
 * executed with `confirm`.
 */
export default class CategoryDiscordCommandHandler extends DiscordCommandHandler {
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
        message: DiscordCommandHandlerMessage,
        description: string
    ) {
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

    /** Replies with one embed per description chunk; the footer goes on the last. */
    private async replyChunked(
        message: DiscordCommandHandlerMessage,
        lines: string[],
        color: number,
        separator = '\n'
    ) {
        const chunks = chunkDescriptionLines(lines, separator);
        const embeds = chunks.map((chunk) =>
            new EmbedBuilder()
                .setDescription(chunk.join(separator))
                .setColor(color)
        );
        embeds[embeds.length - 1]
            .setFooter(this.footer(message))
            .setTimestamp();
        await message.reply({ embeds });
    }

    /**
     * The category of the channel the command was run in: a text channel's
     * parent, or for a thread the parent text channel's parent.
     */
    private currentCategoryId(
        message: DiscordCommandHandlerMessage
    ): string | null {
        const channel = message.channel;
        if (channel.isThread()) return channel.parent?.parentId ?? null;
        if (channel.type === ChannelType.GuildText) {
            return channel.parentId ?? null;
        }
        return null;
    }

    public async handleCommand(
        message: DiscordCommandHandlerMessage,
        _command: string,
        ...args: string[]
    ): Promise<void> {
        if (!message.inGuild()) {
            await this.replyError(
                message,
                'This command must be used in a server.'
            );
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

        const arg = args[0]?.toLowerCase();

        if (arg === 'confirm') {
            await this.handleConfirm(message);
            return;
        }

        const categoryId = this.currentCategoryId(message);
        if (!categoryId) {
            await this.replyError(
                message,
                'This command must be run inside a text channel (or one of its threads) that belongs to a category.'
            );
            return;
        }

        if (arg === undefined) {
            await this.handleShow(message, categoryId);
            return;
        }

        if (arg === 'unlink') {
            await this.handleUnlink(message, categoryId);
            return;
        }

        await this.handlePreview(message, categoryId, args[0]);
    }

    private async handleShow(
        message: DiscordCommandHandlerMessage,
        categoryId: string
    ) {
        const categoryLink = await this.linkService
            .getCategoryLinkByDiscordCategoryId(categoryId)
            .catch(() => null);
        if (!categoryLink) {
            await message.reply(getDiscordCommandUsage('category'));
            return;
        }

        const links = await this.linkService.getChannelLinksForCategoryLink(
            categoryLink.id
        );
        await message.reply({
            embeds: [
                new EmbedBuilder()
                    .setDescription(
                        `Category <#${categoryId}> is bridged to Fluxer channel \`${categoryLink.fluxerChannelId}\` ` +
                            `with **${links.length}** channel↔thread link${links.length === 1 ? '' : 's'}.\n` +
                            `Run \`${COMMAND_PREFIX}category unlink\` to remove the category link.`
                    )
                    .setColor(EmbedColors.Info)
                    .setFooter(this.footer(message))
                    .setTimestamp(),
            ],
        });
    }

    private async handlePreview(
        message: DiscordCommandHandlerMessage,
        categoryId: string,
        fluxerChannelId: string
    ) {
        const guildLink = await this.linkService
            .getGuildLinkForDiscordGuild(message.guildId!)
            .catch(() => null);
        if (!guildLink) {
            await this.replyError(
                message,
                `This server is not linked to a Fluxer guild. Link one first with \`${COMMAND_PREFIX}link <fluxer-guild-id>\`.`
            );
            return;
        }

        let preview;
        try {
            preview = await this.categorySyncService.preview(
                guildLink,
                categoryId,
                fluxerChannelId
            );
        } catch (err: unknown) {
            await this.replyError(
                message,
                `Cannot bridge this category: ${(err as Error).message}`
            );
            return;
        }

        const lines = [
            `Bridge category **${preview.discordCategoryName}** → **#${preview.fluxerChannelName}**:`,
            ...preview.channels.map((channel) =>
                channel.alreadyLinked
                    ? `#${channel.name} (already linked, will be skipped)`
                    : `#${channel.name}`
            ),
        ];
        if (preview.channels.length === 0) {
            lines.push('*(no text channels in this category yet)*');
        }
        lines.push(
            `\nRun \`${COMMAND_PREFIX}category confirm\` to bridge them.`
        );

        this.setPending(message.author.id, {
            type: 'create',
            guildLinkId: guildLink.id,
            discordCategoryId: categoryId,
            fluxerChannelId,
        });
        await this.replyChunked(message, lines, EmbedColors.Warning);
    }

    private async handleUnlink(
        message: DiscordCommandHandlerMessage,
        categoryId: string
    ) {
        const categoryLink = await this.linkService
            .getCategoryLinkByDiscordCategoryId(categoryId)
            .catch(() => null);
        if (!categoryLink) {
            await this.replyError(
                message,
                `Category <#${categoryId}> is not linked. Run \`${COMMAND_PREFIX}category <fluxerChannelId>\` to bridge it.`
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
                        `This removes the category link and its ${links.length} channel↔thread link${links.length === 1 ? '' : 's'}. The Fluxer threads stay.\n` +
                            `Run \`${COMMAND_PREFIX}category confirm\` to proceed.`
                    )
                    .setColor(EmbedColors.Warning)
                    .setFooter(this.footer(message))
                    .setTimestamp(),
            ],
        });
    }

    private async handleConfirm(message: DiscordCommandHandlerMessage) {
        const pending = this.takePending(message.author.id);
        if (!pending) {
            await this.replyError(
                message,
                `No pending category action. Run \`${COMMAND_PREFIX}category <fluxerChannelId>\` or \`${COMMAND_PREFIX}category unlink\` first.`
            );
            return;
        }

        if (pending.type === 'remove') {
            try {
                const categoryLink = await this.linkService.getCategoryLinkById(
                    pending.categoryLinkId
                );
                if (!categoryLink) {
                    throw new Error('The category link no longer exists');
                }
                const { removedLinks } =
                    await this.categorySyncService.removeCategoryLink(
                        categoryLink
                    );
                await message.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setDescription(
                                `Removed the category link for <#${categoryLink.discordCategoryId}> and ${removedLinks} channel↔thread link${removedLinks === 1 ? '' : 's'}.`
                            )
                            .setColor(EmbedColors.Success)
                            .setFooter(this.footer(message))
                            .setTimestamp(),
                    ],
                });
            } catch (err: unknown) {
                await this.replyError(
                    message,
                    `Failed to remove category link: ${(err as Error).message}`
                );
                logger.error('Category unlink failed:', err);
            }
            return;
        }

        try {
            const guildLink = await this.linkService.getGuildLinkById(
                pending.guildLinkId
            );
            if (!guildLink) {
                throw new Error('The guild link no longer exists');
            }
            const { result } =
                await this.categorySyncService.createCategoryLink(
                    guildLink,
                    pending.discordCategoryId,
                    pending.fluxerChannelId
                );

            const lines = [
                `Bridged category <#${pending.discordCategoryId}>: ` +
                    `**${result.linked.length}** linked, **${result.skipped.length}** skipped, **${result.failed.length}** failed.`,
            ];
            const section = (
                title: string,
                items: CategorySyncItem[],
                render: (item: CategorySyncItem) => string
            ) => {
                if (items.length === 0) return;
                lines.push(`\n**${title}**`);
                lines.push(...items.map(render));
            };
            section('Linked', result.linked, (i) => `#${i.channelName}`);
            section('Skipped', result.skipped, (i) => `#${i.channelName}`);
            section(
                'Failed',
                result.failed,
                (i) => `#${i.channelName}: ${i.reason ?? 'unknown error'}`
            );

            await this.replyChunked(message, lines, EmbedColors.Success);
        } catch (err: unknown) {
            await this.replyError(
                message,
                `Failed to bridge category: ${(err as Error).message}`
            );
            logger.error('Category link failed:', err);
        }
    }
}
