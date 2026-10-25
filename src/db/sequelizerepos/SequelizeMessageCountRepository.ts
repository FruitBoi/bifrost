import { fn, col, Op, WhereOptions } from 'sequelize';
import sequelize from '../sequelize';
import { MessagePlatform } from '../entities/MessageLink';
import { MessageCountModel } from '../models';
import { MessageCountRepository } from '../repositories/MessageCountRepository';

export class SequelizeMessageCountRepository implements MessageCountRepository {
    async increment(
        guildLinkId: string,
        sourcePlatform: MessagePlatform,
        hour: number
    ): Promise<void> {
        // One statement, so concurrent bumps of the same bucket never lose an
        // update. ON CONFLICT ... DO UPDATE works on Postgres and SQLite 3.24+;
        // the composite primary key is the conflict target.
        await sequelize.query(
            'INSERT INTO "message_counts" ("guildLinkId", "sourcePlatform", "hour", "count") ' +
                'VALUES (:guildLinkId, :sourcePlatform, :hour, 1) ' +
                'ON CONFLICT ("guildLinkId", "sourcePlatform", "hour") ' +
                'DO UPDATE SET "count" = "message_counts"."count" + 1',
            { replacements: { guildLinkId, sourcePlatform, hour } }
        );
    }

    async sumByPlatform(
        guildLinkId: string,
        sinceHour?: number
    ): Promise<Record<MessagePlatform, number>> {
        const where: WhereOptions =
            sinceHour === undefined
                ? { guildLinkId }
                : { guildLinkId, hour: { [Op.gte]: sinceHour } };
        const rows = (await MessageCountModel.findAll({
            attributes: ['sourcePlatform', [fn('SUM', col('count')), 'total']],
            where,
            group: ['sourcePlatform'],
            raw: true,
        })) as unknown as { sourcePlatform: string; total: unknown }[];

        const sums: Record<MessagePlatform, number> = { discord: 0, fluxer: 0 };
        for (const row of rows) {
            // Postgres returns SUM over INTEGER as a bigint string.
            if (
                row.sourcePlatform === 'discord' ||
                row.sourcePlatform === 'fluxer'
            )
                sums[row.sourcePlatform] = Number(row.total) || 0;
        }
        return sums;
    }

    async firstHour(guildLinkId: string): Promise<number | null> {
        const min: unknown = await MessageCountModel.min('hour', {
            where: { guildLinkId },
        });
        if (min === null || min === undefined) return null;
        const hour = Number(min);
        return Number.isFinite(hour) ? hour : null;
    }
}
