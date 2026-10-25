import type { RoleIdsResolver } from '../../../services/commandRoles/CommandRoleService';
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
import { UserLink } from '../../../db/entities/UserLink';
import { LinkService } from '../../../services/LinkService';
import DiscordEntityResolver from '../../../services/entityResolver/DiscordEntityResolver';
import ThreadMemberSyncService, {
    ThreadMemberSyncResult,
} from '../../../services/threadMemberSync/ThreadMemberSyncService';
import FluxerCommandHandler from '../FluxerCommandHandler';
import { getFluxerCommandUsage } from '../../commandList';
import logger from '../../../utils/logging/logger';
import { EmbedColors } from '../../../utils/embeds';

const MENTION_PATTERN = /^<@!?(\d+)>$/;
const SNOWFLAKE_PATTERN = /^\d{15,25}$/;

/** Longest list rendered in the reply; the rest is summarised as "+N more". */
const MAX_LISTED = 20;

function list(items: string[], max = MAX_LISTED): string {
    const shown = items.slice(0, max).map((name) => `\`${name}\``);
    const rest = items.length - shown.length;
    return rest > 0 ? `${shown.join(', ')} +${rest} more` : shown.join(', ');
}

/** Everything a `<@fluxerUser> <discordUserId>` command needs, fully resolved. */
interface ResolvedUserPair {
    guild: Guild;
    guildLink: GuildLink;
    discordGuild: DiscordGuild;
    discordMember: DiscordGuildMember;
    targetUserId: string;
    targetMember: GuildMember;
}

/** What recording the identity mapping of a pair did. */
type IdentityOutcome =
    | { kind: 'mapped'; replaced: UserLink[] }
    | { kind: 'unchanged' }
    | { kind: 'error'; message: string };

/**
 * The Fluxer `role` command (alias `map`), which pairs a Fluxer member with a
 * Discord user. It takes `<@fluxerUser> <discordUserId>`, only members
 * holding one of the server's identity role IDs (issue #43) may run it, and it treats the
 * mentioned Fluxer member as the given Discord user:
 *
 * 1. adds every Fluxer role named like one of the Discord user's roles,
 * 2. records the identity mapping (replacing an existing one) so pings of
 *    either account are bridged to the other, and
 * 3. adds the Fluxer member to every bridged thread whose Discord side the
 *    Discord user is a member of.
 *
 * One instance is registered under both names; both do exactly the same.
 */
export default class IdentityFluxerCommandHandler extends FluxerCommandHandler {
    constructor(
        client: Client,
        private readonly linkService: LinkService,
        private readonly discordEntityResolver: DiscordEntityResolver,
        private readonly threadMemberSyncService: ThreadMemberSyncService,
        private readonly allowedRoleIds: RoleIdsResolver
    ) {
        super(client);
    }

    public async handleCommand(
        message: Message,
        command: string,
        ...args: string[]
    ): Promise<void> {
        const pair = await this.resolveUserPair(message, command, args);
        if (!pair) return;
        await this.applyIdentity(message, pair);
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

    /** "Discord user `id` (username)" */
    private describeDiscordUser(member: DiscordGuildMember): string {
        return `Discord user \`${member.id}\` (${member.user.username})`;
    }

    /**
     * Permission check against the configured role IDs, argument parsing, and
     * resolution of both members in the linked guilds. Every failure is
     * reported to the caller and yields null.
     */
    private async resolveUserPair(
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
        const roleIds = message.guildId
            ? await this.allowedRoleIds(message.guildId)
            : [];
        if (!(await this.requireRole(message, roleIds))) {
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

    /**
     * Records the identity mapping of `pair` (used to bridge pings),
     * replacing any existing mapping of either account.
     */
    private async recordIdentity({
        guildLink,
        discordMember,
        targetUserId,
    }: ResolvedUserPair): Promise<IdentityOutcome> {
        try {
            const { unchanged, replaced } = await this.linkService.setUserLink({
                guildLinkId: guildLink.id,
                discordUserId: discordMember.id,
                fluxerUserId: targetUserId,
            });
            logger.info(
                `👥 Mapped Fluxer user ${targetUserId} to Discord user ${discordMember.id} in guild link ${guildLink.id}${unchanged ? ' (unchanged)' : ''}`
            );
            return unchanged
                ? { kind: 'unchanged' }
                : { kind: 'mapped', replaced };
        } catch (err) {
            logger.error(
                `❌ Could not record identity mapping for Fluxer user ${targetUserId} ↔ Discord user ${discordMember.id}:`,
                err
            );
            return { kind: 'error', message: (err as Error).message };
        }
    }

    /** Copies roles, records the mapping and syncs threads, then replies once. */
    private async applyIdentity(
        message: Message,
        pair: ResolvedUserPair
    ): Promise<void> {
        const {
            guild,
            guildLink,
            discordGuild,
            discordMember,
            targetUserId,
            targetMember,
        } = pair;

        // ------------------------------------------------------------------
        // 1. Roles
        // ------------------------------------------------------------------

        // @everyone is implicit on both sides and never copied; managed roles
        // belong to bots/integrations/boosting and are not user-assignable.
        const discordRoleNames = discordMember.roles.cache
            .filter((role) => role.id !== discordGuild.id && !role.managed)
            .map((role) => role.name);

        const added: string[] = [];
        const already: string[] = [];
        const failed: string[] = [];
        let unmatched: string[] = [];
        if (discordRoleNames.length > 0) {
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
            unmatched = [...names].filter(
                (name) => !matching.some((role) => role.name === name)
            );

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
        }

        // ------------------------------------------------------------------
        // 2. Identity mapping (used to bridge pings)
        // ------------------------------------------------------------------

        const identity = await this.recordIdentity(pair);
        const identityFailed = identity.kind === 'error';
        let identityLine: string;
        switch (identity.kind) {
            case 'mapped': {
                const replacedNotes = identity.replaced.map((old) =>
                    old.discordUserId !== discordMember.id
                        ? `was Discord user \`${old.discordUserId}\``
                        : `Discord user \`${old.discordUserId}\` was <@${old.fluxerUserId}>`
                );
                identityLine =
                    `**Identity:** <@${targetUserId}> is now mapped to Discord user \`${discordMember.id}\`; pings of either account are bridged to the other.` +
                    (replacedNotes.length
                        ? ` Replaced previous mapping (${replacedNotes.join('; ')}).`
                        : '');
                break;
            }
            case 'unchanged':
                identityLine = `**Identity:** <@${targetUserId}> was already mapped to Discord user \`${discordMember.id}\`; pings keep bridging between them.`;
                break;
            case 'error':
                identityLine = `**Identity:** could not record the mapping: ${identity.message}`;
                break;
        }

        // ------------------------------------------------------------------
        // 3. Thread membership
        // ------------------------------------------------------------------

        let threads: ThreadMemberSyncResult | null = null;
        let threadsError: string | null = null;
        try {
            threads =
                await this.threadMemberSyncService.addFluxerUserToDiscordUsersThreads(
                    {
                        guildLinkId: guildLink.id,
                        discordUserId: discordMember.id,
                        fluxerUserId: targetUserId,
                    }
                );
        } catch (err) {
            logger.error(
                `❌ Thread membership sync failed for Fluxer user ${targetUserId}:`,
                err
            );
            threadsError = (err as Error).message;
        }

        // ------------------------------------------------------------------
        // Reply
        // ------------------------------------------------------------------

        const lines = [
            `Treating <@${targetUserId}> as ${this.describeDiscordUser(discordMember)}.`,
        ];
        if (discordRoleNames.length === 0) {
            lines.push('**Roles:** the Discord user has no roles to copy.');
        }
        if (added.length) lines.push(`**Added roles:** ${list(added)}`);
        if (already.length)
            lines.push(`**Already had roles:** ${list(already)}`);
        if (failed.length)
            lines.push(
                `**Failed roles (check the bot's Manage Roles permission and role position):** ${list(failed)}`
            );
        if (unmatched.length)
            lines.push(`**No Fluxer role with this name:** ${list(unmatched)}`);

        lines.push(identityLine);

        if (threads) {
            const names = (refs: { name: string }[]) =>
                list(refs.map((ref) => ref.name));
            if (threads.examined === 0) {
                lines.push('**Threads:** no bridged threads in this server.');
            } else if (
                threads.added.length === 0 &&
                threads.already.length === 0 &&
                threads.failed.length === 0 &&
                threads.unchecked.length === 0
            ) {
                lines.push(
                    `**Threads:** the Discord user is in none of the ${threads.examined} bridged thread${threads.examined === 1 ? '' : 's'}.`
                );
            }
            if (threads.added.length)
                lines.push(`**Added to threads:** ${names(threads.added)}`);
            if (threads.already.length)
                lines.push(`**Already in threads:** ${names(threads.already)}`);
            if (threads.failed.length)
                lines.push(
                    `**Could not add to threads:** ${list(
                        threads.failed.map(
                            (f) => `${f.thread.name} (${f.reason})`
                        )
                    )}`
                );
            if (threads.unchecked.length)
                lines.push(
                    `**Threads not checked on Discord:** ${list(
                        threads.unchecked.map(
                            (u) => `${u.thread.name} (${u.reason})`
                        )
                    )}`
                );
        } else {
            lines.push(`**Threads:** membership sync failed: ${threadsError}`);
        }

        const anyFailure =
            failed.length > 0 ||
            identityFailed ||
            !threads ||
            threads.failed.length > 0 ||
            threads.unchecked.length > 0;
        const anyChange =
            added.length > 0 ||
            (threads !== null && threads.added.length > 0) ||
            !identityFailed;

        await this.reply(
            message,
            lines.join('\n'),
            anyFailure
                ? EmbedColors.Warning
                : anyChange
                  ? EmbedColors.Success
                  : EmbedColors.Info
        );
    }
}
