import { ThreadDirectoryPlatform } from '../db/entities/ThreadDirectory';
import ThreadDirectoryService, {
    LfgRole,
} from '../services/threadDirectory/ThreadDirectoryService';
import { parseChannelRef, parseRoleRef } from '../utils/channelRef';
import { EmbedColors } from '../utils/embeds';
import logger from '../utils/logging/logger';
import { COMMAND_PREFIX } from '../utils/env';
import {
    DirectoryReply,
    directoryErrorMessage,
    restAfterWords,
} from './directoryCommand';

/**
 * What an `lfg` invocation asks for: the list of LFG roles, or toggling one.
 * `target` is a role ID, a channel/thread ID, or a role or entry name.
 */
export type LfgAction = { kind: 'list' } | { kind: 'toggle'; target: string };

export interface LfgListReply {
    list: true;
    header: string;
    /** One entry per LFG role, to be split across embeds. */
    lines: string[];
}

/**
 * Parses `lfg [list | <role | thread>]`. `args` are the words after the
 * command name. A lone role or channel reference becomes its ID; anything
 * else is kept as a name (spaces included).
 */
export function parseLfgCommand(opts: {
    content: string;
    prefix: string;
    args: string[];
}): LfgAction {
    const { content, prefix, args } = opts;
    if (
        args.length === 0 ||
        (args.length === 1 && args[0].toLowerCase() === 'list')
    )
        return { kind: 'list' };
    if (args.length === 1) {
        const id = parseRoleRef(args[0]) ?? parseChannelRef(args[0]);
        if (id) return { kind: 'toggle', target: id };
    }
    const name = restAfterWords(content, prefix, 1, args);
    return name ? { kind: 'toggle', target: name } : { kind: 'list' };
}

/** One line of the LFG role list; `has` marks a role the member has. */
export function lfgRoleLine(role: LfgRole, has: boolean): string {
    const description = role.description
        ? ` (${role.description.replace(/\s*\n\s*/g, ' ')})`
        : '';
    return `${has ? '✅ ' : ''}<@&${role.roleId}> — <#${role.threadId}>${description}`;
}

/** Runs a parsed `lfg` action for `userId`; thrown errors become error replies. */
export async function runLfgAction(
    service: ThreadDirectoryService,
    platform: ThreadDirectoryPlatform,
    guildId: string,
    userId: string,
    action: LfgAction
): Promise<DirectoryReply | LfgListReply> {
    try {
        if (action.kind === 'list') {
            const [roles, memberRoleIds] = await Promise.all([
                service.listLfgRoles(platform, guildId),
                service.memberLfgRoleIds(platform, guildId, userId),
            ]);
            if (roles.length === 0)
                return {
                    description: `This server has no LFG roles yet. Moderators can link one to a threads directory entry with \`${COMMAND_PREFIX}directory role\`.`,
                    color: EmbedColors.Info,
                };
            const has = new Set(memberRoleIds);
            return {
                list: true,
                header: `**LFG roles** — run \`${COMMAND_PREFIX}lfg <role>\` to give yourself one, and again to remove it. ✅ marks the ones you have.`,
                lines: roles.map((role) =>
                    lfgRoleLine(role, has.has(role.roleId))
                ),
            };
        }

        const { role, added } = await service.toggleLfgRole(
            platform,
            guildId,
            userId,
            action.target
        );
        return {
            description: added
                ? `Gave you <@&${role.id}>.`
                : `Removed <@&${role.id}> from you.`,
            color: EmbedColors.Success,
        };
    } catch (err: unknown) {
        const friendly = directoryErrorMessage(err, guildId);
        if (friendly)
            return { description: friendly, color: EmbedColors.Error };
        logger.error('❌ LFG command failed:', err);
        return {
            description: 'Something went wrong while updating your LFG roles.',
            color: EmbedColors.Error,
        };
    }
}
