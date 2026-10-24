import {
    ThreadDirectory,
    ThreadDirectoryEntry,
    ThreadDirectoryPlatform,
} from '../entities/ThreadDirectory';
import { ThreadDirectoryEntryModel, ThreadDirectoryModel } from '../models';
import {
    SaveThreadDirectoryData,
    SaveThreadDirectoryEntryData,
    ThreadDirectoryRepository,
} from '../repositories/ThreadDirectoryRepository';

/**
 * Sequelize hands DATE columns back as Date objects, but a raw string can
 * sneak through on SQLite; normalise so callers can rely on `getTime()`.
 */
function toDate(value: unknown): Date {
    return value instanceof Date ? value : new Date(value as string);
}

function toThreadDirectory(model: ThreadDirectoryModel): ThreadDirectory {
    const row = model.toJSON() as ThreadDirectory;
    return {
        ...row,
        createdAt: toDate(row.createdAt),
        updatedAt: toDate(row.updatedAt),
    };
}

function toThreadDirectoryEntry(
    model: ThreadDirectoryEntryModel
): ThreadDirectoryEntry {
    const row = model.toJSON() as ThreadDirectoryEntry;
    return {
        ...row,
        description: row.description ?? null,
        // SQLite stores booleans as 0/1.
        hidden: Boolean(row.hidden),
        createdAt: toDate(row.createdAt),
        updatedAt: toDate(row.updatedAt),
    };
}

export class SequelizeThreadDirectoryRepository implements ThreadDirectoryRepository {
    async findDirectory(
        platform: ThreadDirectoryPlatform,
        channelId: string
    ): Promise<ThreadDirectory | null> {
        const model = await ThreadDirectoryModel.findOne({
            where: { platform, channelId },
        });
        return model ? toThreadDirectory(model) : null;
    }

    async saveDirectory(
        data: SaveThreadDirectoryData
    ): Promise<ThreadDirectory> {
        const where = { platform: data.platform, channelId: data.channelId };
        const existing = await ThreadDirectoryModel.findOne({ where });
        if (existing) {
            await existing.update({
                guildId: data.guildId,
                messageId: data.messageId,
                title: data.title,
            });
            return toThreadDirectory(existing);
        }
        const model = await ThreadDirectoryModel.create({ ...data });
        return toThreadDirectory(model);
    }

    async deleteDirectory(
        platform: ThreadDirectoryPlatform,
        channelId: string
    ): Promise<boolean> {
        const destroyed = await ThreadDirectoryModel.destroy({
            where: { platform, channelId },
        });
        return destroyed > 0;
    }

    async listEntries(
        platform: ThreadDirectoryPlatform,
        channelId: string
    ): Promise<ThreadDirectoryEntry[]> {
        const models = await ThreadDirectoryEntryModel.findAll({
            where: { platform, channelId },
            order: [['id', 'ASC']],
        });
        return models.map(toThreadDirectoryEntry);
    }

    async saveEntry(
        data: SaveThreadDirectoryEntryData
    ): Promise<ThreadDirectoryEntry> {
        const where = { platform: data.platform, threadId: data.threadId };
        const existing = await ThreadDirectoryEntryModel.findOne({ where });
        if (existing) {
            const changes: {
                channelId: string;
                description?: string | null;
                hidden?: boolean;
            } = {
                channelId: data.channelId,
            };
            if (data.description !== undefined) {
                changes.description = data.description;
            }
            if (data.hidden !== undefined) changes.hidden = data.hidden;
            await existing.update(changes);
            return toThreadDirectoryEntry(existing);
        }
        const model = await ThreadDirectoryEntryModel.create({
            platform: data.platform,
            channelId: data.channelId,
            threadId: data.threadId,
            description: data.description ?? null,
            hidden: data.hidden ?? false,
        });
        return toThreadDirectoryEntry(model);
    }

    async deleteEntry(
        platform: ThreadDirectoryPlatform,
        threadId: string
    ): Promise<void> {
        await ThreadDirectoryEntryModel.destroy({
            where: { platform, threadId },
        });
    }
}
