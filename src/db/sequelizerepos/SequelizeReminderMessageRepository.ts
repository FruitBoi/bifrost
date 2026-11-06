import { Op } from 'sequelize';
import { ReminderPlatform } from '../entities/Reminder';
import {
    ReminderMessage,
    ReminderMessageKind,
} from '../entities/ReminderMessage';
import { ReminderMessageModel } from '../models';
import { ReminderMessageRepository } from '../repositories/ReminderMessageRepository';

/**
 * Sequelize hands DATE columns back as Date objects, but a raw string can
 * sneak through on SQLite (e.g. after a bulk insert); normalise so callers
 * can rely on `createdAt.getTime()`.
 */
function toDate(value: unknown): Date {
    return value instanceof Date ? value : new Date(value as string);
}

function toReminderMessage(model: ReminderMessageModel): ReminderMessage {
    const row = model.toJSON() as ReminderMessage & { id?: number };
    return {
        platform: row.platform,
        messageId: row.messageId,
        kind: row.kind,
        userId: row.userId,
        guildId: row.guildId,
        channelId: row.channelId,
        message: row.message,
        createdAt: toDate(row.createdAt),
    };
}

export class SequelizeReminderMessageRepository implements ReminderMessageRepository {
    async save(data: ReminderMessage): Promise<void> {
        const { platform, messageId } = data;
        const existing = await ReminderMessageModel.findOne({
            where: { platform, messageId },
        });
        if (existing) await existing.update({ ...data });
        else await ReminderMessageModel.create({ ...data });
    }

    async findByMessage(
        platform: ReminderPlatform,
        messageId: string
    ): Promise<ReminderMessage | null> {
        const model = await ReminderMessageModel.findOne({
            where: { platform, messageId },
        });
        return model ? toReminderMessage(model) : null;
    }

    async findLatest(
        platform: ReminderPlatform,
        userId: string,
        guildId: string,
        kind: ReminderMessageKind,
        since: Date
    ): Promise<ReminderMessage | null> {
        const model = await ReminderMessageModel.findOne({
            where: {
                platform,
                userId,
                guildId,
                kind,
                createdAt: { [Op.gte]: since },
            },
            order: [
                ['createdAt', 'DESC'],
                ['id', 'DESC'],
            ],
        });
        return model ? toReminderMessage(model) : null;
    }

    async deleteOlderThan(before: Date): Promise<number> {
        return ReminderMessageModel.destroy({
            where: { createdAt: { [Op.lt]: before } },
        });
    }
}
