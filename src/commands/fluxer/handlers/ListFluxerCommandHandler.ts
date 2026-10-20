import {
    Client,
    EmbedBuilder,
    Message,
    PermissionsBitField,
} from '@fluxerjs/core';
import { LinkService } from '../../../services/LinkService';
import {
    ChannelLink,
    discordLocationId,
    fluxerLocationId,
    isChannelPairLink,
} from '../../../db/entities/ChannelLink';
import { GuildLink } from '../../../db/entities/GuildLink';
import FluxerCommandHandler from '../FluxerCommandHandler';
import DiscordEntityResolver from '../../../services/entityResolver/DiscordEntityResolver';
import logger from '../../../utils/logging/logger';
import { chunkDescriptionLines, EmbedColors } from '../../../utils/embeds';
import { FLUXER_OWNER_ID } from '../../../utils/env';

export default class ListFluxerCommandHandler extends FluxerCommandHandler {
    constructor(
        client: Client,
        private readonly linkService: LinkService,
        private readonly discordEntityResolver: DiscordEntityResolver
    ) {
        super(client);
    }

    private async discordSideLabel(
        link: ChannelLink,
        discordGuildId: string
    ): Promise<string> {
        const locationId = discordLocationId(link);
        const url = `https://discord.com/channels/${discordGuildId}/${locationId}`;
        if (link.discordThreadId) {
            const thread = await this.discordEntityResolver
                .fetchThread(link.discordThreadId)
                .catch(() => null);
            return `🧵 [${thread?.name ?? link.discordThreadId}](${url})`;
        }
        const channel = await this.discordEntityResolver
            .fetchChannel(discordGuildId, link.discordChannelId)
            .catch(() => null);
        const name =
            (channel as { name?: string } | null)?.name ??
            link.discordChannelId;
        return `[#${name}](${url})`;
    }

    private async buildChannelLines(
        channelLinks: ChannelLink[],
        discordGuildId: string,
        showLinkId = false
    ): Promise<string[]> {
        return Promise.all(
            channelLinks.map(async (link) => {
                const discordLabel = await this.discordSideLabel(
                    link,
                    discordGuildId
                );
                const fluxerIcon = link.fluxerThreadId ? '🧵 ' : '';
                const suffix = showLinkId ? ` | \`${link.linkId}\`` : '';
                const autoThreads =
                    isChannelPairLink(link) && link.autoSyncThreads
                        ? ' · 🧵 auto-threads'
                        : '';
                // Fluxer on left, Discord on right (viewing from Fluxer)
                return `${fluxerIcon}<#${fluxerLocationId(link)}> ←→ ${discordLabel}${suffix}${autoThreads}\n  └ \`${fluxerLocationId(link)}\` · \`${discordLocationId(link)}\``;
            })
        );
    }

    /** One line per category link of the guild, listed before the channel links. */
    private async buildCategoryLines(guildLink: GuildLink): Promise<string[]> {
        const categoryLinks = await this.linkService
            .getCategoryLinksForGuildLink(guildLink.id)
            .catch(() => []);
        return Promise.all(
            categoryLinks.map(async (categoryLink) => {
                const [category, links] = await Promise.all([
                    this.discordEntityResolver
                        .fetchChannel(
                            guildLink.discordGuildId,
                            categoryLink.discordCategoryId
                        )
                        .catch(() => null),
                    this.linkService
                        .getChannelLinksForCategoryLink(categoryLink.id)
                        .catch(() => []),
                ]);
                const name =
                    (category as { name?: string } | null)?.name ??
                    categoryLink.discordCategoryId;
                const url = `https://discord.com/channels/${guildLink.discordGuildId}/${categoryLink.discordCategoryId}`;
                return `📁 [${name}](${url}) → <#${categoryLink.fluxerChannelId}> · ${links.length} channel(s)`;
            })
        );
    }

    /**
     * "Voice links" section, listed after the channel links: a header line
     * followed by `🔊 <#fluxer> ←→ [🔊 discord](url) · state` per link.
     * Empty when the guild has no voice links.
     */
    private async buildVoiceLines(guildLink: GuildLink): Promise<string[]> {
        const voiceLinks = await this.linkService
            .getVoiceLinksForGuildLink(guildLink.id)
            .catch(() => []);
        if (voiceLinks.length === 0) return [];
        const lines = await Promise.all(
            voiceLinks.map(async (link) => {
                const channel = await this.discordEntityResolver
                    .fetchVoiceChannel(
                        guildLink.discordGuildId,
                        link.discordChannelId
                    )
                    .catch(() => null);
                const name = channel?.name ?? link.discordChannelId;
                const url = `https://discord.com/channels/${guildLink.discordGuildId}/${link.discordChannelId}`;
                const state = link.enabled ? '✅ enabled' : '⛔ disabled';
                // Fluxer on left, Discord on right (viewing from Fluxer)
                return `🔊 <#${link.fluxerChannelId}> ←→ [🔊 ${name}](${url}) · ${state}\n  └ \`${link.fluxerChannelId}\` · \`${link.discordChannelId}\``;
            })
        );
        return ['**Voice links**', ...lines];
    }

    public async handleCommand(
        message: Message,
        _command: string,
        ...args: string[]
    ): Promise<void> {
        const footer = this.footer(message);

        if (args[0]?.toLowerCase() === 'all') {
            if (!FLUXER_OWNER_ID || message.author.id !== FLUXER_OWNER_ID) {
                logger.warn(
                    `[list all] ⚠️ Non-owner attempted list all: user=${message.author.username} (${message.author.id}), guildId=${message.guildId ?? 'DM'}, channelId=${message.channelId}, content="${message.content}"`
                );
                await message.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setDescription(
                                'You do not have permission to use this command.'
                            )
                            .setColor(EmbedColors.Error)
                            .setFooter(footer)
                            .setTimestamp(),
                    ],
                });
                return;
            }

            try {
                const guildLinks = await this.linkService.getAllGuildLinks();

                if (guildLinks.length === 0) {
                    await message.reply({
                        embeds: [
                            new EmbedBuilder()
                                .setDescription('No guild bridges configured.')
                                .setColor(EmbedColors.Warning)
                                .setFooter(footer)
                                .setTimestamp(),
                        ],
                    });
                    return;
                }

                const embeds: EmbedBuilder[] = [];

                for (const guildLink of guildLinks) {
                    const [channelLinks, discordGuild, fluxerGuild] =
                        await Promise.all([
                            this.linkService.getChannelLinksForFluxerGuild(
                                guildLink.fluxerGuildId
                            ),
                            this.discordEntityResolver
                                .fetchGuild(guildLink.discordGuildId)
                                .catch(() => null),
                            this.getClient()
                                .guilds.fetch(guildLink.fluxerGuildId)
                                .catch(() => null),
                        ]);

                    const discordGuildName =
                        (discordGuild as { name?: string } | null)?.name ??
                        guildLink.discordGuildId;
                    const fluxerGuildName =
                        (fluxerGuild as { name?: string } | null)?.name ??
                        guildLink.fluxerGuildId;
                    const title = `Fluxer: ${fluxerGuildName} (${guildLink.fluxerGuildId}) | Discord: ${discordGuildName} (${guildLink.discordGuildId})`;

                    const categoryLines =
                        await this.buildCategoryLines(guildLink);
                    const voiceLines = await this.buildVoiceLines(guildLink);

                    if (
                        channelLinks.length === 0 &&
                        categoryLines.length === 0 &&
                        voiceLines.length === 0
                    ) {
                        embeds.push(
                            new EmbedBuilder()
                                .setTitle(title)
                                .setDescription('*(no channel links)*')
                                .setColor(EmbedColors.Info)
                        );
                    } else {
                        const lines = [
                            ...categoryLines,
                            ...(await this.buildChannelLines(
                                channelLinks,
                                guildLink.discordGuildId,
                                true
                            )),
                            ...voiceLines,
                        ];
                        const chunks = chunkDescriptionLines(lines);
                        chunks.forEach((chunk, i) => {
                            embeds.push(
                                new EmbedBuilder()
                                    .setTitle(i === 0 ? title : null)
                                    .setDescription(chunk.join('\n\n'))
                                    .setColor(EmbedColors.Info)
                            );
                        });
                    }
                }

                embeds[embeds.length - 1].setFooter(footer).setTimestamp();

                if (!message.guildId) {
                    await message.reply({ embeds });
                } else {
                    try {
                        const dm = await (
                            message.author as {
                                createDM?: () => Promise<{
                                    send: (data: unknown) => Promise<unknown>;
                                }>;
                            }
                        ).createDM?.();
                        if (!dm) throw new Error('DM not supported');
                        await dm.send({ embeds });
                    } catch {
                        await message.reply({
                            embeds: [
                                new EmbedBuilder()
                                    .setDescription(
                                        'Could not send DM — ensure your DMs are open.'
                                    )
                                    .setColor(EmbedColors.Error)
                                    .setFooter(footer)
                                    .setTimestamp(),
                            ],
                        });
                        logger.error(
                            '❌ Failed to DM %list all output to Fluxer user:',
                            message.author.id
                        );
                    }
                }
            } catch (err: unknown) {
                await message.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setDescription(
                                `Failed to list all links: ${(err as Error).message}`
                            )
                            .setColor(EmbedColors.Error)
                            .setFooter(footer)
                            .setTimestamp(),
                    ],
                });
                logger.error('❌ Error listing all links:', err);
            }
            return;
        }

        if (args[0] && /^\d{17,20}$/.test(args[0])) {
            const serverId = args[0];
            if (!FLUXER_OWNER_ID || message.author.id !== FLUXER_OWNER_ID) {
                logger.warn(
                    `[list] ⚠️ Non-owner attempted server ID lookup: user=${message.author.username} (${message.author.id}), serverId=${serverId}, guildId=${message.guildId ?? 'DM'}, channelId=${message.channelId}, content="${message.content}"`
                );
                // Fall through to normal list behaviour
            } else {
                try {
                    let guildLink =
                        await this.linkService.getGuildLinkForFluxerGuild(
                            serverId
                        );
                    if (!guildLink) {
                        guildLink =
                            await this.linkService.getGuildLinkForDiscordGuild(
                                serverId
                            );
                    }

                    if (!guildLink) {
                        await message.reply({
                            embeds: [
                                new EmbedBuilder()
                                    .setDescription(
                                        `No guild bridge found for server ID \`${serverId}\`.`
                                    )
                                    .setColor(EmbedColors.Warning)
                                    .setFooter(footer)
                                    .setTimestamp(),
                            ],
                        });
                        return;
                    }

                    const [channelLinks, discordGuild, fluxerGuild] =
                        await Promise.all([
                            this.linkService.getChannelLinksForFluxerGuild(
                                guildLink.fluxerGuildId
                            ),
                            this.discordEntityResolver
                                .fetchGuild(guildLink.discordGuildId)
                                .catch(() => null),
                            this.getClient()
                                .guilds.fetch(guildLink.fluxerGuildId)
                                .catch(() => null),
                        ]);

                    const discordGuildName =
                        (discordGuild as { name?: string } | null)?.name ??
                        guildLink.discordGuildId;
                    const fluxerGuildName =
                        (fluxerGuild as { name?: string } | null)?.name ??
                        guildLink.fluxerGuildId;
                    const title = `Fluxer: ${fluxerGuildName} (${guildLink.fluxerGuildId}) | Discord: ${discordGuildName} (${guildLink.discordGuildId})`;

                    const categoryLines =
                        await this.buildCategoryLines(guildLink);
                    const voiceLines = await this.buildVoiceLines(guildLink);

                    if (
                        channelLinks.length === 0 &&
                        categoryLines.length === 0 &&
                        voiceLines.length === 0
                    ) {
                        await message.reply({
                            embeds: [
                                new EmbedBuilder()
                                    .setTitle(title)
                                    .setDescription('*(no channel links)*')
                                    .setColor(EmbedColors.Info)
                                    .setFooter(footer)
                                    .setTimestamp(),
                            ],
                        });
                        return;
                    }

                    const lines = [
                        ...categoryLines,
                        ...(await this.buildChannelLines(
                            channelLinks,
                            guildLink.discordGuildId,
                            true
                        )),
                        ...voiceLines,
                    ];
                    const chunks = chunkDescriptionLines(lines);
                    const embeds = chunks.map((chunk, i) =>
                        new EmbedBuilder()
                            .setTitle(i === 0 ? title : null)
                            .setDescription(chunk.join('\n\n'))
                            .setColor(EmbedColors.Info)
                    );
                    embeds[embeds.length - 1].setFooter(footer).setTimestamp();

                    if (!message.guildId) {
                        await message.reply({ embeds });
                    } else {
                        try {
                            const dm = await (
                                message.author as {
                                    createDM?: () => Promise<{
                                        send: (
                                            data: unknown
                                        ) => Promise<unknown>;
                                    }>;
                                }
                            ).createDM?.();
                            if (!dm) throw new Error('DM not supported');
                            await dm.send({ embeds });
                        } catch {
                            await message.reply({
                                embeds: [
                                    new EmbedBuilder()
                                        .setDescription(
                                            'Could not send DM — ensure your DMs are open.'
                                        )
                                        .setColor(EmbedColors.Error)
                                        .setFooter(footer)
                                        .setTimestamp(),
                                ],
                            });
                        }
                    }
                } catch (err: unknown) {
                    await message.reply({
                        embeds: [
                            new EmbedBuilder()
                                .setDescription(
                                    `Failed to list links for server \`${serverId}\`: ${(err as Error).message}`
                                )
                                .setColor(EmbedColors.Error)
                                .setFooter(footer)
                                .setTimestamp(),
                        ],
                    });
                    logger.error('❌ Error listing links by server ID:', err);
                }
                return;
            }
        }

        if (!message.guildId) {
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription(
                            'This command must be used in a server.'
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
                PermissionsBitField.Flags.ManageWebhooks,
                'Manage Webhooks'
            ))
        )
            return;

        try {
            const guildLink = await this.linkService.getGuildLinkForFluxerGuild(
                message.guildId!
            );

            if (!guildLink) {
                await message.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setDescription(
                                'No guild bridge found for this server.'
                            )
                            .setColor(EmbedColors.Warning)
                            .setFooter(footer)
                            .setTimestamp(),
                    ],
                });
                return;
            }

            const channelLinks =
                await this.linkService.getChannelLinksForFluxerGuild(
                    message.guildId!
                );

            const categoryLines = await this.buildCategoryLines(guildLink);
            const voiceLines = await this.buildVoiceLines(guildLink);

            if (
                channelLinks.length === 0 &&
                categoryLines.length === 0 &&
                voiceLines.length === 0
            ) {
                await message.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setDescription(
                                'No channel links found for this server.'
                            )
                            .setColor(EmbedColors.Warning)
                            .setFooter(footer)
                            .setTimestamp(),
                    ],
                });
                return;
            }

            const lines = [
                ...categoryLines,
                ...(await this.buildChannelLines(
                    channelLinks,
                    guildLink.discordGuildId
                )),
                ...voiceLines,
            ];
            const chunks = chunkDescriptionLines(lines);
            const embeds = chunks.map((chunk, i) =>
                new EmbedBuilder()
                    .setTitle(
                        i === 0 ? 'Fluxer ↔ Discord | Linked Channels' : null
                    )
                    .setDescription(chunk.join('\n\n'))
                    .setColor(EmbedColors.Info)
            );
            embeds[embeds.length - 1].setFooter(footer).setTimestamp();

            await message.reply({ embeds });
        } catch (err: unknown) {
            await message.reply({
                embeds: [
                    new EmbedBuilder()
                        .setDescription(
                            `Failed to list channel links: ${(err as Error).message}`
                        )
                        .setColor(EmbedColors.Error)
                        .setFooter(footer)
                        .setTimestamp(),
                ],
            });
            logger.error('❌ Error listing channel links:', err);
        }
    }
}
