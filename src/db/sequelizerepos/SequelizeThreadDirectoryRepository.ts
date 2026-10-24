import { Op } from 'sequelize';
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

/** The stored JSON array of extra message IDs; anything malformed reads as none. */
function parseExtraMessageIds(value: unknown): string[] {
    if (typeof value !== 'string') return [];
    try {
        const parsed: unknown = JSON.parse(value);
        return Array.isArray(parsed)
            ? parsed.filter((id): id is string => typeof id === 'string')
            : [];
    } catch {
        return [];
    }
}

function toThreadDirectory(model: ThreadDirectoryModel): ThreadDirectory {
    const { extraMessageIds, ...row } = model.toJSON() as Omit<
        ThreadDirectory,
        'messageIds'
    > & { extraMessageIds?: string };
    return {
        ...row,
        messageIds: [row.messageId, ...parseExtraMessageIds(extraMessageIds)],
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
        guildId: row.guildId ?? null,
        description: row.description ?? null,
        roleId: row.roleId ?? null,
        // SQLite stores booleans as 0/1.
        hidden: Boolean(row.hidden),
        added: Boolean(row.added),
        createdAt: toDate(row.createdAt),
        updatedAt: toDate(row.updatedAt),
    };
}

/** Column values of a directory's message list. */
function messageColumns(messageIds: string[]) {
    if (messageIds.length === 0) {
        throw new Error('A threads directory needs at least one message.');
    }
    return {
        messageId: messageIds[0],
        extraMessageIds: JSON.stringify(messageIds.slice(1)),
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
                ...messageColumns(data.messageIds),
                title: data.title,
            });
            return toThreadDirectory(existing);
        }
        const model = await ThreadDirectoryModel.create({
            platform: data.platform,
            guildId: data.guildId,
            channelId: data.channelId,
            ...messageColumns(data.messageIds),
            title: data.title,
        });
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

    async listRoleEntries(
        platform: ThreadDirectoryPlatform,
        guildId: string
    ): Promise<ThreadDirectoryEntry[]> {
        const models = await ThreadDirectoryEntryModel.findAll({
            where: { platform, guildId, roleId: { [Op.ne]: null } },
            order: [['id', 'ASC']],
        });
        return models.map(toThreadDirectoryEntry);
    }

    async saveEntry(
        data: SaveThreadDirectoryEntryData
    ): Promise<ThreadDirectoryEntry> {
        const where = {
            platform: data.platform,
            channelId: data.channelId,
            threadId: data.threadId,
        };
        const existing = await ThreadDirectoryEntryModel.findOne({ where });
        if (existing) {
            const changes: Partial<
                Pick<
                    ThreadDirectoryEntry,
                    'guildId' | 'description' | 'hidden' | 'roleId' | 'added'
                >
            > = {};
            if (data.guildId !== undefined) changes.guildId = data.guildId;
            if (data.description !== undefined) {
                changes.description = data.description;
            }
            if (data.hidden !== undefined) changes.hidden = data.hidden;
            if (data.roleId !== undefined) changes.roleId = data.roleId;
            if (data.added !== undefined) changes.added = data.added;
            await existing.update(changes);
            return toThreadDirectoryEntry(existing);
        }
        const model = await ThreadDirectoryEntryModel.create({
            ...where,
            guildId: data.guildId ?? null,
            description: data.description ?? null,
            hidden: data.hidden ?? false,
            roleId: data.roleId ?? null,
            added: data.added ?? false,
        });
        return toThreadDirectoryEntry(model);
    }

    async deleteEntry(
        platform: ThreadDirectoryPlatform,
        channelId: string,
        threadId: string
    ): Promise<boolean> {
        const destroyed = await ThreadDirectoryEntryModel.destroy({
            where: { platform, channelId, threadId },
        });
        return destroyed > 0;
    }

    async deleteEntriesForThread(
        platform: ThreadDirectoryPlatform,
        threadId: string
    ): Promise<string[]> {
        const models = await ThreadDirectoryEntryModel.findAll({
            where: { platform, threadId },
            attributes: ['channelId'],
        });
        if (models.length === 0) return [];
        await ThreadDirectoryEntryModel.destroy({
            where: { platform, threadId },
        });
        return [...new Set(models.map((m) => m.channelId))];
    }
}
