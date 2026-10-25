/**
 * Per-server command role allowlists (issue #43): server administrators pick
 * which roles may use the role-gated commands in their own server, instead of
 * every server sharing the global `roles.moderator` / `roles.identity` lists
 * from config.yml.
 *
 * A server (platform + guild ID) with at least one stored role for a group
 * uses exactly those roles for that group; the config list no longer applies
 * there. A server with none uses the config list as before. So the first
 * {@link CommandRoleService.addRoles} starts a fresh list rather than copying
 * the defaults, and removing the last role (or a reset) falls back to them.
 *
 * Permission checks run on every gated command, so lookups are cached per
 * (platform, guild, group) and the cache entry is dropped on every write.
 */
import { MessagePlatform } from '../../db/entities/MessageLink';
import { CommandRoleGroup } from '../../db/entities/CommandRole';
import { CommandRoleRepository } from '../../db/repositories/CommandRoleRepository';
import logger from '../../utils/logging/logger';

export type { CommandRoleGroup };

export const COMMAND_ROLE_GROUPS: readonly CommandRoleGroup[] = [
    'moderator',
    'identity',
] as const;

/** Most roles one server may allowlist for one group. */
export const MAX_ROLES_PER_GROUP = 25;

/** Allowlisted role IDs for one group in the guild a command runs in. */
export type RoleIdsResolver = (guildId: string) => Promise<readonly string[]>;

export interface CommandRoleSettings {
    roleIds: readonly string[];
    /** False when the server has no list of its own and the config defaults apply. */
    custom: boolean;
}

/** Thrown when a write would leave more than {@link MAX_ROLES_PER_GROUP} roles in a group. */
export class CommandRoleLimitError extends Error {
    constructor(
        readonly group: CommandRoleGroup,
        readonly count: number
    ) {
        super(
            `A server can allowlist at most ${MAX_ROLES_PER_GROUP} roles for ${group} commands (this would make ${count}).`
        );
        this.name = 'CommandRoleLimitError';
    }
}

/** Trims, drops empties and dedupes while keeping the first-seen order. */
const normalize = (roleIds: readonly string[]): string[] => [
    ...new Set(roleIds.map((id) => id.trim()).filter((id) => id.length > 0)),
];

export default class CommandRoleService {
    /** Stored role IDs (possibly empty) per (platform, guild, group). */
    private readonly cache = new Map<string, readonly string[]>();

    /**
     * @param repository Where the per-server lists are stored.
     * @param defaults The config lists, used by servers without their own.
     */
    constructor(
        private readonly repository: CommandRoleRepository,
        private readonly defaults: Record<CommandRoleGroup, readonly string[]>
    ) {}

    /**
     * Role IDs allowed to use the group's commands in the server. Never
     * rejects: a database failure is logged and the config defaults are
     * used, so a hiccup cannot break the permission check itself.
     */
    async getRoleIds(
        platform: MessagePlatform,
        guildId: string,
        group: CommandRoleGroup
    ): Promise<readonly string[]> {
        try {
            return (await this.getSettings(platform, guildId, group)).roleIds;
        } catch (err) {
            logger.warn(
                `⚠️ Failed to load the ${group} command roles for ${platform} guild ${guildId}, using the config defaults:`,
                err
            );
            return this.defaults[group];
        }
    }

    /** Binds a platform and group, for handlers that only know the guild ID. */
    resolver(
        platform: MessagePlatform,
        group: CommandRoleGroup
    ): RoleIdsResolver {
        return (guildId) => this.getRoleIds(platform, guildId, group);
    }

    /** The effective list and whether it is the server's own. Rejects on database errors. */
    async getSettings(
        platform: MessagePlatform,
        guildId: string,
        group: CommandRoleGroup
    ): Promise<CommandRoleSettings> {
        const key = this.key(platform, guildId, group);
        let stored = this.cache.get(key);
        if (!stored) {
            stored = await this.repository.list(platform, guildId, group);
            this.cache.set(key, stored);
        }
        return this.toSettings(group, stored);
    }

    /**
     * Adds roles to the server's list (starting a fresh one when it has
     * none). Already stored IDs are ignored.
     * @throws CommandRoleLimitError when the list would exceed {@link MAX_ROLES_PER_GROUP}.
     */
    async addRoles(
        platform: MessagePlatform,
        guildId: string,
        group: CommandRoleGroup,
        roleIds: readonly string[]
    ): Promise<CommandRoleSettings> {
        const stored = await this.repository.list(platform, guildId, group);
        const added = normalize(roleIds).filter((id) => !stored.includes(id));
        const count = stored.length + added.length;
        if (count > MAX_ROLES_PER_GROUP)
            throw new CommandRoleLimitError(group, count);
        return this.write(platform, guildId, group, () =>
            this.repository.add(platform, guildId, group, added)
        );
    }

    /** Removes roles; when none are left the config defaults apply again. */
    async removeRoles(
        platform: MessagePlatform,
        guildId: string,
        group: CommandRoleGroup,
        roleIds: readonly string[]
    ): Promise<CommandRoleSettings> {
        return this.write(platform, guildId, group, () =>
            this.repository.remove(platform, guildId, group, normalize(roleIds))
        );
    }

    /**
     * Replaces the server's list; an empty array resets it to the defaults.
     * @throws CommandRoleLimitError when more than {@link MAX_ROLES_PER_GROUP} distinct roles are given.
     */
    async setRoles(
        platform: MessagePlatform,
        guildId: string,
        group: CommandRoleGroup,
        roleIds: readonly string[]
    ): Promise<CommandRoleSettings> {
        const ids = normalize(roleIds);
        if (ids.length > MAX_ROLES_PER_GROUP)
            throw new CommandRoleLimitError(group, ids.length);
        return this.write(platform, guildId, group, () =>
            this.repository.replace(platform, guildId, group, ids)
        );
    }

    /** Drops the server's list so the config defaults apply again. */
    async resetRoles(
        platform: MessagePlatform,
        guildId: string,
        group: CommandRoleGroup
    ): Promise<CommandRoleSettings> {
        return this.setRoles(platform, guildId, group, []);
    }

    /**
     * Runs a write and returns the fresh settings. The cache entry is
     * dropped even when the write fails, since it may have partly applied.
     */
    private async write(
        platform: MessagePlatform,
        guildId: string,
        group: CommandRoleGroup,
        run: () => Promise<void>
    ): Promise<CommandRoleSettings> {
        try {
            await run();
        } finally {
            this.cache.delete(this.key(platform, guildId, group));
        }
        return this.getSettings(platform, guildId, group);
    }

    private toSettings(
        group: CommandRoleGroup,
        stored: readonly string[]
    ): CommandRoleSettings {
        return stored.length > 0
            ? { roleIds: stored, custom: true }
            : { roleIds: this.defaults[group], custom: false };
    }

    private key(
        platform: MessagePlatform,
        guildId: string,
        group: CommandRoleGroup
    ): string {
        return JSON.stringify([platform, guildId, group]);
    }
}
