import { MessagePlatform } from '../entities/MessageLink';
import { CommandRoleGroup } from '../entities/CommandRole';

/** Per-server command role allowlists (issue #43). */
export interface CommandRoleRepository {
    /** Stored role IDs of the group in the server, sorted; empty when it has none. */
    list(
        platform: MessagePlatform,
        guildId: string,
        group: CommandRoleGroup
    ): Promise<string[]>;

    /** Stores the role IDs; ones already stored are left alone. */
    add(
        platform: MessagePlatform,
        guildId: string,
        group: CommandRoleGroup,
        roleIds: readonly string[]
    ): Promise<void>;

    /** Deletes the role IDs; unknown ones are ignored. */
    remove(
        platform: MessagePlatform,
        guildId: string,
        group: CommandRoleGroup,
        roleIds: readonly string[]
    ): Promise<void>;

    /** Atomically replaces the group's stored roles (empty array deletes them all). */
    replace(
        platform: MessagePlatform,
        guildId: string,
        group: CommandRoleGroup,
        roleIds: readonly string[]
    ): Promise<void>;
}
