import { ClaudeRequest } from '../entities/ClaudeRequest';
import { ClaudeRequestModel } from '../models';
import {
    ClaudeRequestRepository,
    CreateClaudeRequestData,
} from '../repositories/ClaudeRequestRepository';

/**
 * Sequelize hands DATE columns back as Date objects, but a raw string can
 * sneak through on SQLite (e.g. after a bulk insert); normalise so callers
 * can rely on `createdAt.getTime()`.
 */
function toDate(value: unknown): Date {
    return value instanceof Date ? value : new Date(value as string);
}

function toClaudeRequest(model: ClaudeRequestModel): ClaudeRequest {
    const row = model.toJSON() as ClaudeRequest;
    return {
        ...row,
        messageId: row.messageId ?? null,
        createdAt: toDate(row.createdAt),
    };
}

export class SequelizeClaudeRequestRepository implements ClaudeRequestRepository {
    async create(data: CreateClaudeRequestData): Promise<ClaudeRequest> {
        const model = await ClaudeRequestModel.create({
            ...data,
            attempts: 0,
        });
        return toClaudeRequest(model);
    }

    async findById(id: number): Promise<ClaudeRequest | null> {
        const model = await ClaudeRequestModel.findOne({ where: { id } });
        return model ? toClaudeRequest(model) : null;
    }

    async findAll(limit?: number): Promise<ClaudeRequest[]> {
        const models = await ClaudeRequestModel.findAll({
            order: [['id', 'ASC']],
            ...(limit === undefined ? {} : { limit }),
        });
        return models.map(toClaudeRequest);
    }

    async incrementAttempts(id: number): Promise<void> {
        await ClaudeRequestModel.increment('attempts', { where: { id } });
    }

    async deleteById(id: number): Promise<boolean> {
        const destroyed = await ClaudeRequestModel.destroy({ where: { id } });
        return destroyed > 0;
    }

    async count(): Promise<number> {
        return ClaudeRequestModel.count();
    }
}
