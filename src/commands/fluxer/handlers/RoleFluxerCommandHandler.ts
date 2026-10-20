import { Client, Message } from '@fluxerjs/core';
import { LinkService } from '../../../services/LinkService';
import DiscordEntityResolver from '../../../services/entityResolver/DiscordEntityResolver';
import ThreadMemberSyncService, {
    ThreadMemberSyncResult,
} from '../../../services/threadMemberSync/ThreadMemberSyncService';
import UserPairFluxerCommandHandler from './UserPairFluxerCommandHandler';
import logger from '../../../utils/logging/logger';
import { EmbedColors } from '../../../utils/embeds';

/** Longest list rendered in the reply; the rest is summarised as "+N more". */
const MAX_LISTED = 20;

function list(items: string[], max = MAX_LISTED): string {
    const shown = items.slice(0, max).map((name) => `\`${name}\``);
    const rest = items.length - shown.length;
    return rest > 0 ? `${shown.join(', ')} +${rest} more` : shown.join(', ');
}

/**
 * `role <@fluxerUser> <discordUserId>`: treats the mentioned Fluxer member as
 * the given Discord user and
 *
 * 1. adds every Fluxer role named like one of the Discord user's roles,
 * 2. records the identity mapping (user link) so pings of either account are
 *    bridged to the other, and
 * 3. adds the Fluxer member to every bridged thread whose Discord side the
 *    Discord user is a member of.
 *
 * Only members holding one of the configured Fluxer role IDs may run it.
 * `map` records the mapping alone, without replacing an existing one.
 */
export default class RoleFluxerCommandHandler extends UserPairFluxerCommandHandler {
    constructor(
        client: Client,
        linkService: LinkService,
        discordEntityResolver: DiscordEntityResolver,
        private readonly threadMemberSyncService: ThreadMemberSyncService,
        allowedRoleIds: readonly string[]
    ) {
        super(client, linkService, discordEntityResolver, allowedRoleIds);
    }

    public async handleCommand(
        message: Message,
        _command: string,
        ...args: string[]
    ): Promise<void> {
        const pair = await this.resolveUserPair(message, 'role', args);
        if (!pair) return;
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

        let identityLine: string;
        let identityFailed = false;
        try {
            const { unchanged, replaced } = await this.linkService.setUserLink({
                guildLinkId: guildLink.id,
                discordUserId: discordMember.id,
                fluxerUserId: targetUserId,
            });
            const replacedNotes = replaced.map((old) =>
                old.discordUserId !== discordMember.id
                    ? `was Discord user \`${old.discordUserId}\``
                    : `Discord user \`${old.discordUserId}\` was <@${old.fluxerUserId}>`
            );
            identityLine = unchanged
                ? `**Identity:** <@${targetUserId}> was already mapped to Discord user \`${discordMember.id}\`; pings keep bridging between them.`
                : `**Identity:** <@${targetUserId}> is now mapped to Discord user \`${discordMember.id}\`; pings of either account are bridged to the other.` +
                  (replacedNotes.length
                      ? ` Replaced previous mapping (${replacedNotes.join('; ')}).`
                      : '');
            logger.info(
                `👥 Mapped Fluxer user ${targetUserId} to Discord user ${discordMember.id} in guild link ${guildLink.id}${unchanged ? ' (unchanged)' : ''}`
            );
        } catch (err) {
            identityFailed = true;
            logger.error(
                `❌ Could not record identity mapping for Fluxer user ${targetUserId} ↔ Discord user ${discordMember.id}:`,
                err
            );
            identityLine = `**Identity:** could not record the mapping: ${(err as Error).message}`;
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
            `Treating <@${targetUserId}> as Discord user \`${discordMember.id}\` (${discordMember.user.username}).`,
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
