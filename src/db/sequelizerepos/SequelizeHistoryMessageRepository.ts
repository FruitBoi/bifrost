import { randomUUID } from 'crypto';
import { Op } from 'sequelize';
import { MessagePlatform } from '../entities/MessageLink';
import { HistoryMessageModel } from '../models/HistoryMessageModel';
import {
    CreateHistoryMessageData,
    HistoryMessageRepository,
} from '../repositories/HistoryMessageRepository';

/** Keeps `IN (...)` lists well under every dialect's parameter limit. */
const IN_CHUNK_SIZE = 500;

export class SequelizeHistoryMessageRepository implements HistoryMessageRepository {
    async createMany(rows: CreateHistoryMessageData[]): Promise<void> {
        if (rows.length === 0) return;
        // ignoreDuplicates relies on the unique (sourcePlatform,
        // sourceMessageId) index: SQLite emits INSERT OR IGNORE, Postgres
        // ON CONFLICT DO NOTHING.
        await HistoryMessageModel.bulkCreate(
            rows.map((row) => ({ id: randomUUID(), ...row })),
            { ignoreDuplicates: true }
        );
    }

    async findTransferredIds(
        sourcePlatform: MessagePlatform,
        sourceMessageIds: readonly string[]
    ): Promise<Set<string>> {
        const found = new Set<string>();
        if (sourceMessageIds.length === 0) return found;

        for (let i = 0; i < sourceMessageIds.length; i += IN_CHUNK_SIZE) {
            const chunk = sourceMessageIds.slice(i, i + IN_CHUNK_SIZE);
            const models = await HistoryMessageModel.findAll({
                attributes: ['sourceMessageId'],
                where: {
                    sourcePlatform,
                    sourceMessageId: { [Op.in]: chunk },
                },
            });
            for (const model of models) found.add(model.sourceMessageId);
        }
        return found;
    }

    async deleteByChannelLinkId(channelLinkId: string): Promise<void> {
        await HistoryMessageModel.destroy({ where: { channelLinkId } });
    }

    async deleteByGuildLinkId(guildLinkId: string): Promise<void> {
        await HistoryMessageModel.destroy({ where: { guildLinkId } });
    }

    async count(): Promise<number> {
        return HistoryMessageModel.count();
    }
}
