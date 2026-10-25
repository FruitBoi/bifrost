import type CommandRoleService from '../services/commandRoles/CommandRoleService';
import {
    CommandRoleLimitError,
    MAX_ROLES_PER_GROUP,
    type CommandRoleGroup,
    type CommandRoleSettings,
} from '../services/commandRoles/CommandRoleService';
import type { MessagePlatform } from '../db/entities/MessageLink';
import { parseRoleRef } from '../utils/channelRef';
import { COMMAND_PREFIX } from '../utils/env';

/**
 * `commandroles`: lets a server's administrators choose which roles may use
 * the role-gated commands in that server (issue #43). This file holds the
 * platform-neutral parts: argument parsing, role resolution and rendering.
 */

export const COMMAND_ROLES_COMMAND_NAMES = [
    'commandroles',
    'cmdroles',
    'roleperms',
] as const;

/** Commands each group gates, for the overview. */
const GROUP_COMMANDS: Record<CommandRoleGroup, readonly string[]> = {
    moderator: ['clean', 'history'],
    identity: ['role', 'map'],
};

const GROUP_ALIASES: Record<string, CommandRoleGroup> = {
    moderator: 'moderator',
    moderators: 'moderator',
    mod: 'moderator',
    mods: 'moderator',
    identity: 'identity',
    role: 'identity',
    map: 'identity',
};

export type CommandRolesAction =
    | { kind: 'show-all' }
    | { kind: 'show'; group: CommandRoleGroup }
    | {
          kind: 'add' | 'remove' | 'set';
          group: CommandRoleGroup;
          roleRefs: string[];
      }
    | { kind: 'reset'; group: CommandRoleGroup }
    | { kind: 'error'; message: string };

export const COMMAND_ROLES_USAGE =
    `Usage: \`${COMMAND_PREFIX}commandroles [moderator|identity] [add|remove|set <roles...> | reset]\`\n` +
    '> Roles are mentions, IDs or exact role names (separate names with commas).';

function usageError(prefix: string): CommandRolesAction {
    return { kind: 'error', message: `${prefix}\n${COMMAND_ROLES_USAGE}` };
}

/** The group named by `name` (case-insensitive, with aliases), or null. */
export function parseCommandRoleGroup(name: string): CommandRoleGroup | null {
    return GROUP_ALIASES[name.toLowerCase()] ?? null;
}

/**
 * Splits role arguments into references. Mentions and IDs stand alone; other
 * words are joined into one name per comma-separated piece, so
 * `Server Mods, Helpers` gives two names.
 */
export function splitRoleRefs(args: string[]): string[] {
    const refs: string[] = [];
    for (const piece of args.join(' ').split(',')) {
        let name: string[] = [];
        const flush = () => {
            if (name.length > 0) refs.push(name.join(' '));
            name = [];
        };
        for (const token of piece.split(/\s+/).filter(Boolean)) {
            if (parseRoleRef(token)) {
                flush();
                refs.push(token);
            } else {
                name.push(token);
            }
        }
        flush();
    }
    return refs;
}

export function parseCommandRolesArgs(args: string[]): CommandRolesAction {
    if (args.length === 0) return { kind: 'show-all' };
    const group = parseCommandRoleGroup(args[0]);
    if (!group) {
        return usageError(`Unknown role group \`${args[0]}\`.`);
    }
    const verb = args[1]?.toLowerCase();
    if (!verb) return { kind: 'show', group };

    if (verb === 'reset') {
        return args.length > 2
            ? usageError('`reset` takes no roles.')
            : { kind: 'reset', group };
    }
    const kind =
        verb === 'add'
            ? 'add'
            : verb === 'remove' || verb === 'rm'
              ? 'remove'
              : verb === 'set'
                ? 'set'
                : null;
    if (!kind) return usageError(`Unknown action \`${args[1]}\`.`);
    const roleRefs = splitRoleRefs(args.slice(2));
    if (roleRefs.length === 0) {
        return usageError(`\`${kind}\` needs at least one role.`);
    }
    return { kind, group, roleRefs };
}

export interface GuildRoleInfo {
    id: string;
    name: string;
}

export interface ResolvedRoleRefs {
    roleIds: string[];
    /** References that matched no role. */
    unknown: string[];
}

/**
 * Resolves references to role IDs against the server's roles. Names match
 * case-insensitively (a leading `@` is ignored). Raw IDs and mentions of
 * roles that do not exist are kept only when `allowUnknownIds` (removing a
 * deleted role), otherwise reported as unknown. `@everyone` (whose ID is
 * the guild ID) is never accepted by name.
 */
export function resolveRoleRefs(
    refs: readonly string[],
    roles: readonly GuildRoleInfo[],
    options: { allowUnknownIds?: boolean } = {}
): ResolvedRoleRefs {
    const roleIds: string[] = [];
    const unknown: string[] = [];
    for (const ref of refs) {
        const id = parseRoleRef(ref);
        let resolved: string | undefined;
        if (id) {
            resolved =
                roles.find((r) => r.id === id)?.id ??
                (options.allowUnknownIds ? id : undefined);
        } else {
            const wanted = ref.replace(/^@/, '').trim().toLowerCase();
            const matches = roles.filter(
                (r) => r.name.toLowerCase() === wanted
            );
            resolved = matches[0]?.id;
        }
        if (!resolved) unknown.push(ref);
        else if (!roleIds.includes(resolved)) roleIds.push(resolved);
    }
    return { roleIds, unknown };
}

/** Message for references that matched no role. */
export function describeUnknownRoles(unknown: readonly string[]): string {
    return `No such role in this server: ${unknown.map((u) => `\`${u}\``).join(', ')}.`;
}

/** One embed line for a group's settings. */
export function renderCommandRoleLine(
    group: CommandRoleGroup,
    settings: CommandRoleSettings
): string {
    const commands = GROUP_COMMANDS[group].join(', ');
    const mentions = settings.roleIds.map((id) => `<@&${id}>`).join(', ');
    let value: string;
    if (settings.custom) value = mentions;
    else if (settings.roleIds.length === 0) {
        value = 'nobody (config default is empty)';
    } else value = `config default: ${mentions}`;
    return `**${group}** (${commands}): ${value}`;
}

/** The groups a platform can configure (identity commands are Fluxer-only). */
export function groupsForPlatform(
    platform: MessagePlatform
): readonly CommandRoleGroup[] {
    return platform === 'fluxer' ? ['moderator', 'identity'] : ['moderator'];
}

/** Why `identity` cannot be configured on Discord. */
export const IDENTITY_FLUXER_ONLY_MESSAGE =
    'The `identity` group (`role` / `map`) only exists on Fluxer; configure it there.';

export interface CommandRolesOutcome {
    kind: 'info' | 'success' | 'error';
    title?: string;
    description: string;
}

export interface CommandRolesContext {
    service: CommandRoleService;
    platform: MessagePlatform;
    guildId: string;
    /** Replies with an error and yields false when the author is no administrator. */
    requireAdmin: () => Promise<boolean>;
    fetchRoles: () => Promise<GuildRoleInfo[]>;
}

/** Overview lines for `groups`. */
async function renderGroups(
    ctx: CommandRolesContext,
    groups: readonly CommandRoleGroup[]
): Promise<string> {
    const lines: string[] = [];
    for (const group of groups) {
        const settings = await ctx.service.getSettings(
            ctx.platform,
            ctx.guildId,
            group
        );
        lines.push(renderCommandRoleLine(group, settings));
    }
    return lines.join('\n');
}

/**
 * Runs a parsed action for one server. Returns null when `requireAdmin`
 * already replied (permission denied); otherwise what to reply with. Shared
 * by both platforms, which only differ in the context they supply.
 */
export async function runCommandRolesAction(
    action: CommandRolesAction,
    ctx: CommandRolesContext
): Promise<CommandRolesOutcome | null> {
    const allowed = groupsForPlatform(ctx.platform);
    if (action.kind === 'error') {
        return { kind: 'error', description: action.message };
    }
    if (action.kind === 'show-all') {
        return {
            kind: 'info',
            title: 'Command roles',
            description:
                (await renderGroups(ctx, allowed)) +
                `\n\nChange them with \`${COMMAND_PREFIX}commandroles <group> add|remove|set <roles...>\` or \`reset\` (Administrator).`,
        };
    }
    if (!allowed.includes(action.group)) {
        return { kind: 'error', description: IDENTITY_FLUXER_ONLY_MESSAGE };
    }
    if (action.kind === 'show') {
        return {
            kind: 'info',
            title: 'Command roles',
            description: await renderGroups(ctx, [action.group]),
        };
    }

    if (!(await ctx.requireAdmin())) return null;

    let roleIds: string[] = [];
    if (action.kind !== 'reset') {
        let roles: GuildRoleInfo[];
        try {
            roles = await ctx.fetchRoles();
        } catch {
            return {
                kind: 'error',
                description: 'Could not fetch the roles of this server.',
            };
        }
        const resolved = resolveRoleRefs(action.roleRefs, roles, {
            allowUnknownIds: action.kind === 'remove',
        });
        if (resolved.unknown.length > 0) {
            return {
                kind: 'error',
                description: describeUnknownRoles(resolved.unknown),
            };
        }
        roleIds = resolved.roleIds;
    }

    try {
        const args = [ctx.platform, ctx.guildId, action.group] as const;
        const settings =
            action.kind === 'add'
                ? await ctx.service.addRoles(...args, roleIds)
                : action.kind === 'remove'
                  ? await ctx.service.removeRoles(...args, roleIds)
                  : action.kind === 'set'
                    ? await ctx.service.setRoles(...args, roleIds)
                    : await ctx.service.resetRoles(...args);
        return {
            kind: 'success',
            title: 'Command roles updated',
            description: renderCommandRoleLine(action.group, settings),
        };
    } catch (err) {
        if (err instanceof CommandRoleLimitError) {
            return {
                kind: 'error',
                description: `A group can have at most ${MAX_ROLES_PER_GROUP} roles per server.`,
            };
        }
        throw err;
    }
}
