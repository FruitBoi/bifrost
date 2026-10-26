import { BotStateModel } from '../models';
import { BotStateRepository } from '../repositories/BotStateRepository';

export class SequelizeBotStateRepository implements BotStateRepository {
    async get(key: string): Promise<string | null> {
        const row = await BotStateModel.findByPk(key);
        return row ? row.value : null;
    }

    async set(key: string, value: string): Promise<void> {
        await BotStateModel.upsert({ key, value, updatedAt: new Date() });
    }
}
