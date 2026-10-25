import { MessagePlatform } from './MessageLink';

/**
 * Group of role-gated commands whose allowlist a server can override
 * (issue #43): `moderator` gates `clean` and `history`, `identity` gates the
 * Fluxer `role`/`map` commands.
 */
export type CommandRoleGroup = 'moderator' | 'identity';

/** One allowlisted role of a group in one Discord or Fluxer server. */
export interface CommandRole {
    platform: MessagePlatform;
    /** Raw platform guild ID (not a guild link: allowlists are per server). */
    guildId: string;
    roleGroup: CommandRoleGroup;
    roleId: string;
}
