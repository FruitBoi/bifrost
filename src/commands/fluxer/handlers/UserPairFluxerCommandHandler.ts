import {
    Client,
    EmbedBuilder,
    Guild,
    GuildMember,
    Message,
} from '@fluxerjs/core';
import {
    Guild as DiscordGuild,
    GuildMember as DiscordGuildMember,
} from 'discord.js';
import { GuildLink } from '../../../db/entities/GuildLink';
import { LinkService } from '../../../services/LinkService';
import DiscordEntityResolver from '../../../services/entityResolver/DiscordEntityResolver';
import FluxerCommandHandler from '../FluxerCommandHandler';
import { getFluxerCommandUsage } from '../../commandList';
import { EmbedColors } from '../../../utils/embeds';

const MENTION_PATTERN = /^<@!?(\d+)>$/;
const SNOWFLAKE_PATTERN = /^\d{15,25}$/;

/** Everything a `<@fluxerUser> <discordUserId>` command needs, fully resolved. */
export interface ResolvedUserPair {
    guild: Guild;
    guildLink: GuildLink;
    discordGuild: DiscordGuild;
    discordMember: DiscordGuildMember;
    targetUserId: string;
    targetMember: GuildMember;
}

/**
 * Shared preamble of the Fluxer commands that pair a Fluxer member with a
 * Discord user (`role`, `map`): permission check against the configured
 * role IDs, argument parsing, and resolution of both members in the linked
 * guilds. Every failure is reported to the caller and yields null.
 */
export default abstract class UserPairFluxerCommandHandler extends FluxerCommandHandler {
    constructor(
        client: Client,
        protected readonly linkService: LinkService,
        protected readonly discordEntityResolver: DiscordEntityResolver,
        protected readonly allowedRoleIds: readonly string[]
    ) {
        super(client);
    }

    protected async reply(
        message: Message,
        description: string,
        color: number
    ): Promise<void> {
        await message.reply({
            embeds: [
                new EmbedBuilder()
                    .setDescription(description)
                    .setColor(color)
                    .setFooter(this.footer(message))
                    .setTimestamp(),
            ],
        });
    }

    protected async resolveUserPair(
        message: Message,
        commandName: string,
        args: string[]
    ): Promise<ResolvedUserPair | null> {
        if (!message.guildId) {
            await this.reply(
                message,
                'This command must be used in a server.',
                EmbedColors.Error
            );
            return null;
        }

        const guild =
            message.guild ?? (await message.resolveGuild().catch(() => null));
        if (!guild) {
            await this.reply(
                message,
                'Could not resolve this server.',
                EmbedColors.Error
            );
            return null;
        }

        // Permission: the caller must hold one of the allowed role IDs.
        const author = await guild
            .fetchMember(message.author.id)
            .catch(() => null);
        if (!author) {
            await this.reply(
                message,
                'Could not fetch your member information.',
                EmbedColors.Error
            );
            return null;
        }
        if (!this.allowedRoleIds.some((id) => author.roles.has(id))) {
            await this.reply(
                message,
                'You do not have a role that is allowed to use this command.',
                EmbedColors.Error
            );
            return null;
        }

        const targetMatch = args[0]?.match(MENTION_PATTERN);
        const targetUserId =
            targetMatch?.[1] ??
            (args[0] && SNOWFLAKE_PATTERN.test(args[0]) ? args[0] : null);
        const discordUserId = args[1];
        if (
            args.length !== 2 ||
            !targetUserId ||
            !discordUserId ||
            !SNOWFLAKE_PATTERN.test(discordUserId)
        ) {
            await message.reply(getFluxerCommandUsage(commandName));
            return null;
        }

        const guildLink = await this.linkService
            .getGuildLinkForFluxerGuild(message.guildId)
            .catch(() => null);
        if (!guildLink) {
            await this.reply(
                message,
                'This server is not linked to a Discord server.',
                EmbedColors.Error
            );
            return null;
        }

        const discordGuild = await this.discordEntityResolver.fetchGuild(
            guildLink.discordGuildId
        );
        if (!discordGuild) {
            await this.reply(
                message,
                'Could not access the linked Discord server.',
                EmbedColors.Error
            );
            return null;
        }

        const discordMember = await discordGuild.members
            .fetch(discordUserId)
            .catch(() => null);
        if (!discordMember) {
            await this.reply(
                message,
                `No member with the ID \`${discordUserId}\` was found in the linked Discord server.`,
                EmbedColors.Error
            );
            return null;
        }

        const targetMember = await guild
            .fetchMember(targetUserId)
            .catch(() => null);
        if (!targetMember) {
            await this.reply(
                message,
                `<@${targetUserId}> is not a member of this server.`,
                EmbedColors.Error
            );
            return null;
        }

        return {
            guild,
            guildLink,
            discordGuild,
            discordMember,
            targetUserId,
            targetMember,
        };
    }
}
