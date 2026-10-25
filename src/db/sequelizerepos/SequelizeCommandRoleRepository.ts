import sequelize from '../sequelize';
import { MessagePlatform } from '../entities/MessageLink';
import { CommandRoleGroup } from '../entities/CommandRole';
import { CommandRoleModel } from '../models';
import { CommandRoleRepository } from '../repositories/CommandRoleRepository';

export class SequelizeCommandRoleRepository implements CommandRoleRepository {
    async list(
        platform: MessagePlatform,
        guildId: string,
        group: CommandRoleGroup
    ): Promise<string[]> {
        const rows = await CommandRoleModel.findAll({
            attributes: ['roleId'],
            where: { platform, guildId, roleGroup: group },
            order: [['roleId', 'ASC']],
        });
        return rows.map((row) => row.roleId);
    }

    async add(
        platform: MessagePlatform,
        guildId: string,
        group: CommandRoleGroup,
        roleIds: readonly string[]
    ): Promise<void> {
        if (roleIds.length === 0) return;
        // ignoreDuplicates is INSERT ... ON CONFLICT DO NOTHING on Postgres and
        // INSERT OR IGNORE on SQLite, so re-adding a stored role is a no-op.
        await CommandRoleModel.bulkCreate(
            roleIds.map((roleId) => ({
                platform,
                guildId,
                roleGroup: group,
                roleId,
            })),
            { ignoreDuplicates: true }
        );
    }

    async remove(
        platform: MessagePlatform,
        guildId: string,
        group: CommandRoleGroup,
        roleIds: readonly string[]
    ): Promise<void> {
        if (roleIds.length === 0) return;
        await CommandRoleModel.destroy({
            where: {
                platform,
                guildId,
                roleGroup: group,
                roleId: [...roleIds],
            },
        });
    }

    async replace(
        platform: MessagePlatform,
        guildId: string,
        group: CommandRoleGroup,
        roleIds: readonly string[]
    ): Promise<void> {
        // One transaction, so a failed insert never leaves the server with an
        // empty list (which would silently fall back to the config defaults).
        await sequelize.transaction(async (transaction) => {
            await CommandRoleModel.destroy({
                where: { platform, guildId, roleGroup: group },
                transaction,
            });
            if (roleIds.length === 0) return;
            await CommandRoleModel.bulkCreate(
                [...new Set(roleIds)].map((roleId) => ({
                    platform,
                    guildId,
                    roleGroup: group,
                    roleId,
                })),
                { transaction }
            );
        });
    }
}
