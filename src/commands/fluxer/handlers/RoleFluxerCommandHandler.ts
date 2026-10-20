import { Client, EmbedBuilder, Message } from '@fluxerjs/core';
import { LinkService } from '../../../services/LinkService';
import DiscordEntityResolver from '../../../services/entityResolver/DiscordEntityResolver';
import FluxerCommandHandler from '../FluxerCommandHandler';
import { getFluxerCommandUsage } from '../../commandList';
import logger from '../../../utils/logging/logger';
import { EmbedColors } from '../../../utils/embeds';

const MENTION_PATTERN = /^<@!?(\d+)>$/;
const SNOWFLAKE_PATTERN = /^\d{15,25}$/;

/**
 * `role <@fluxerUser> <discordUserId>`: looks up the roles of the Discord user
 * in the linked Discord guild and adds every Fluxer role with the same name to
 * the mentioned Fluxer member. Only members holding one of the configured
 * Fluxer role IDs may run it.
 */
export default class RoleFluxerCommandHandler extends FluxerCommandHandler {
    constructor(
        client: Client,
        private readonly linkService: LinkService,
        private readonly discordEntityResolver: DiscordEntityResolver,
        private readonly allowedRoleIds: readonly string[]
    ) {
        super(client);
    }

    private async reply(
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

        const guild =
            message.guild ?? (await message.resolveGuild().catch(() => null));
        if (!guild) {
            await this.reply(
                message,
                'Could not resolve this server.',
                EmbedColors.Error
            );
            return;
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
            return;
        }
        if (!this.allowedRoleIds.some((id) => author.roles.has(id))) {
            await this.reply(
                message,
                'You do not have a role that is allowed to use this command.',
                EmbedColors.Error
            );
            return;
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
            await message.reply(getFluxerCommandUsage('role'));
            return;
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
            return;
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
            return;
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
            return;
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
            return;
        }

        // @everyone is implicit on both sides and never copied; managed roles
        // belong to bots/integrations/boosting and are not user-assignable.
        const discordRoleNames = discordMember.roles.cache
            .filter((role) => role.id !== discordGuild.id && !role.managed)
            .map((role) => role.name);
        if (discordRoleNames.length === 0) {
            await this.reply(
                message,
                `The Discord user has no roles to copy.`,
                EmbedColors.Warning
            );
            return;
        }

        let fluxerRoles;
        try {
            fluxerRoles = await guild.fetchRoles();
        } catch (err) {
            logger.error('❌ Failed to fetch Fluxer roles:', err);
            await this.reply(
                message,
                `Failed to fetch the Fluxer roles: ${(err as Error).message}`,
                EmbedColors.Error
            );
            return;
        }

        const names = new Set(discordRoleNames);
        const matching = fluxerRoles.filter(
            (role) => role.id !== guild.id && names.has(role.name)
        );
        const unmatched = [...names].filter(
            (name) => !matching.some((role) => role.name === name)
        );

        const added: string[] = [];
        const already: string[] = [];
        const failed: string[] = [];
        for (const role of matching) {
            if (targetMember.roles.has(role.id)) {
                already.push(role.name);
                continue;
            }
            try {
                await targetMember.roles.add(role.id);
                added.push(role.name);
            } catch (err) {
                logger.warn(
                    `⚠️ Could not add Fluxer role ${role.name} (${role.id}) to ${targetUserId}:`,
                    err
                );
                failed.push(role.name);
            }
        }

        const list = (items: string[]) =>
            items.map((name) => `\`${name}\``).join(', ');
        const lines = [
            `Copied roles of Discord user \`${discordUserId}\` to <@${targetUserId}>.`,
        ];
        if (added.length) lines.push(`**Added:** ${list(added)}`);
        if (already.length) lines.push(`**Already had:** ${list(already)}`);
        if (failed.length)
            lines.push(
                `**Failed (check the bot's Manage Roles permission and role position):** ${list(failed)}`
            );
        if (unmatched.length)
            lines.push(`**No Fluxer role with this name:** ${list(unmatched)}`);

        await this.reply(
            message,
            lines.join('\n'),
            failed.length
                ? EmbedColors.Warning
                : added.length
                  ? EmbedColors.Success
                  : EmbedColors.Info
        );
    }
}
