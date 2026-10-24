import { Op } from 'sequelize';
import { ClaudeRequestPlatform } from '../entities/ClaudeRequest';
import { ClaudeRequestNotice } from '../entities/ClaudeRequestNotice';
import { ClaudeRequestNoticeModel } from '../models';
import {
    ClaudeRequestNoticeRepository,
    CreateClaudeRequestNoticeData,
} from '../repositories/ClaudeRequestNoticeRepository';

/**
 * Sequelize hands DATE columns back as Date objects, but a raw string can
 * sneak through on SQLite (e.g. after a bulk insert); normalise so callers
 * can rely on `createdAt.getTime()`.
 */
function toDate(value: unknown): Date {
    return value instanceof Date ? value : new Date(value as string);
}

function toClaudeRequestNotice(
    model: ClaudeRequestNoticeModel
): ClaudeRequestNotice {
    const row = model.toJSON() as ClaudeRequestNotice;
    return { ...row, createdAt: toDate(row.createdAt) };
}

export class SequelizeClaudeRequestNoticeRepository implements ClaudeRequestNoticeRepository {
    /** Throws on a duplicate (platform, noticeMessageId); callers catch. */
    async create(
        data: CreateClaudeRequestNoticeData
    ): Promise<ClaudeRequestNotice> {
        const model = await ClaudeRequestNoticeModel.create({ ...data });
        return toClaudeRequestNotice(model);
    }

    async findByNoticeMessage(
        platform: ClaudeRequestPlatform,
        noticeMessageId: string
    ): Promise<ClaudeRequestNotice | null> {
        const model = await ClaudeRequestNoticeModel.findOne({
            where: { platform, noticeMessageId },
        });
        return model ? toClaudeRequestNotice(model) : null;
    }

    async deleteOlderThan(cutoff: Date): Promise<number> {
        return ClaudeRequestNoticeModel.destroy({
            where: { createdAt: { [Op.lt]: cutoff } },
        });
    }
}
