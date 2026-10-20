import { Op } from 'sequelize';
import { Reminder, ReminderPlatform } from '../entities/Reminder';
import { ReminderModel } from '../models';
import {
    CreateReminderData,
    ReminderRepository,
} from '../repositories/ReminderRepository';

/**
 * Sequelize hands DATE columns back as Date objects, but a raw string can
 * sneak through on SQLite (e.g. after a bulk insert); normalise so callers
 * can rely on `dueAt.getTime()`.
 */
function toDate(value: unknown): Date {
    return value instanceof Date ? value : new Date(value as string);
}

function toReminder(model: ReminderModel): Reminder {
    const row = model.toJSON() as Reminder;
    return {
        ...row,
        dueAt: toDate(row.dueAt),
        createdAt: toDate(row.createdAt),
    };
}

export class SequelizeReminderRepository implements ReminderRepository {
    async create(data: CreateReminderData): Promise<Reminder> {
        const model = await ReminderModel.create({ ...data, attempts: 0 });
        return toReminder(model);
    }

    async findById(id: number): Promise<Reminder | null> {
        const model = await ReminderModel.findOne({ where: { id } });
        return model ? toReminder(model) : null;
    }

    async findByUser(
        platform: ReminderPlatform,
        userId: string,
        guildId?: string
    ): Promise<Reminder[]> {
        const models = await ReminderModel.findAll({
            where: {
                platform,
                userId,
                ...(guildId === undefined ? {} : { guildId }),
            },
            order: [
                ['dueAt', 'ASC'],
                ['id', 'ASC'],
            ],
        });
        return models.map(toReminder);
    }

    async findByChannel(
        platform: ReminderPlatform,
        channelId: string
    ): Promise<Reminder[]> {
        const models = await ReminderModel.findAll({
            where: { platform, channelId },
            order: [
                ['dueAt', 'ASC'],
                ['id', 'ASC'],
            ],
        });
        return models.map(toReminder);
    }

    async countByUser(
        platform: ReminderPlatform,
        userId: string
    ): Promise<number> {
        return ReminderModel.count({ where: { platform, userId } });
    }

    async findDue(before: Date, limit = 100): Promise<Reminder[]> {
        const models = await ReminderModel.findAll({
            where: { dueAt: { [Op.lte]: before } },
            order: [
                ['dueAt', 'ASC'],
                ['id', 'ASC'],
            ],
            limit,
        });
        return models.map(toReminder);
    }

    async incrementAttempts(id: number): Promise<void> {
        await ReminderModel.increment('attempts', { where: { id } });
    }

    async deleteById(id: number): Promise<boolean> {
        const destroyed = await ReminderModel.destroy({ where: { id } });
        return destroyed > 0;
    }

    async deleteByUser(
        platform: ReminderPlatform,
        userId: string
    ): Promise<number> {
        return ReminderModel.destroy({ where: { platform, userId } });
    }

    async count(): Promise<number> {
        return ReminderModel.count();
    }
}
