import { DataTypes, QueryInterface } from 'sequelize';
import type { Migration } from '../migrator';

/**
 * Threads directory follow-up (issue #37): directories spanning several
 * messages, roles linked to threads, and channels/threads added from outside
 * the directory channel.
 *
 * - thread_directories.extraMessageIds: JSON array of the 2nd..nth message
 *   IDs (`messageId` stays the first); '[]' for existing directories.
 * - thread_directory_entries.guildId: guild of the directory, backfilled
 *   from thread_directories where the directory still exists.
 * - thread_directory_entries.roleId: role linked to the entry, or null.
 * - thread_directory_entries.added: true for entries listed with
 *   `directory add` (living outside the directory channel).
 * - The unique index moves from (platform, threadId) to
 *   (platform, channelId, threadId), since an added thread may be listed by
 *   several directories; (platform, guildId) is indexed for `lfg` lookups.
 */

interface IndexSpec {
    table: string;
    fields: string[];
    name: string;
    unique?: boolean;
}

/** Indexes the 00014 schema has (and SQLite loses when it rebuilds a table). */
const OLD_INDEXES: IndexSpec[] = [
    {
        table: 'thread_directories',
        fields: ['platform', 'channelId'],
        name: 'thread_directories_platform_channel_id',
        unique: true,
    },
    {
        table: 'thread_directory_entries',
        fields: ['platform', 'threadId'],
        name: 'thread_directory_entries_platform_thread_id',
        unique: true,
    },
    {
        table: 'thread_directory_entries',
        fields: ['platform', 'channelId'],
        name: 'thread_directory_entries_platform_channel_id',
    },
];

const ENTRY_UNIQUE_INDEX = 'thread_directory_entries_platform_channel_thread';
const ENTRY_GUILD_INDEX = 'thread_directory_entries_platform_guild_id';

async function indexNames(
    queryInterface: QueryInterface,
    table: string
): Promise<Set<string>> {
    const indexes = (await queryInterface.showIndex(table)) as {
        name: string;
    }[];
    return new Set(indexes.map((index) => index.name));
}

export const up: Migration = async ({ context: queryInterface }) => {
    const sequelize = queryInterface.sequelize;

    await queryInterface.addColumn('thread_directories', 'extraMessageIds', {
        type: DataTypes.TEXT,
        allowNull: false,
        defaultValue: '[]',
    });
    await queryInterface.addColumn('thread_directory_entries', 'guildId', {
        type: DataTypes.STRING,
        allowNull: true,
    });
    await queryInterface.addColumn('thread_directory_entries', 'roleId', {
        type: DataTypes.STRING,
        allowNull: true,
    });
    await queryInterface.addColumn('thread_directory_entries', 'added', {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
    });

    // A correlated subquery works the same on SQLite and Postgres.
    await sequelize.query(
        `UPDATE thread_directory_entries SET "guildId" = (
            SELECT d."guildId" FROM thread_directories d
            WHERE d.platform = thread_directory_entries.platform
              AND d."channelId" = thread_directory_entries."channelId"
        ) WHERE "guildId" IS NULL`
    );

    await queryInterface.removeIndex(
        'thread_directory_entries',
        'thread_directory_entries_platform_thread_id'
    );
    await queryInterface.addIndex(
        'thread_directory_entries',
        ['platform', 'channelId', 'threadId'],
        { name: ENTRY_UNIQUE_INDEX, unique: true }
    );
    await queryInterface.addIndex(
        'thread_directory_entries',
        ['platform', 'guildId'],
        { name: ENTRY_GUILD_INDEX }
    );
};

export const down: Migration = async ({ context: queryInterface }) => {
    const sequelize = queryInterface.sequelize;
    const isSqlite = sequelize.getDialect() === 'sqlite';

    // Added entries cannot be represented before this migration, and the
    // old unique (platform, threadId) index allows one row per thread.
    await sequelize.query(
        'DELETE FROM thread_directory_entries WHERE "added" = :added',
        { replacements: { added: true } }
    );
    await sequelize.query(
        `DELETE FROM thread_directory_entries WHERE id NOT IN (
            SELECT MIN(id) FROM thread_directory_entries
            GROUP BY platform, "threadId"
        )`
    );

    await queryInterface.removeIndex(
        'thread_directory_entries',
        ENTRY_GUILD_INDEX
    );
    await queryInterface.removeIndex(
        'thread_directory_entries',
        ENTRY_UNIQUE_INDEX
    );
    // Sequelize's SQLite table rebuild turns every column of a composite
    // unique index into a UNIQUE column of its own, so drop the indexes
    // first and recreate them afterwards (harmless on Postgres).
    for (const index of OLD_INDEXES) {
        const existing = await indexNames(queryInterface, index.table);
        if (existing.has(index.name)) {
            await queryInterface.removeIndex(index.table, index.name);
        }
    }

    // SQLite drops a column by rebuilding the table, which loses its indexes
    // and rejects the rebuild while foreign keys are enforced.
    if (isSqlite) await sequelize.query('PRAGMA foreign_keys = OFF');
    try {
        await queryInterface.removeColumn('thread_directory_entries', 'added');
        await queryInterface.removeColumn('thread_directory_entries', 'roleId');
        await queryInterface.removeColumn(
            'thread_directory_entries',
            'guildId'
        );
        await queryInterface.removeColumn(
            'thread_directories',
            'extraMessageIds'
        );
    } finally {
        if (isSqlite) await sequelize.query('PRAGMA foreign_keys = ON');
    }

    for (const index of OLD_INDEXES) {
        await queryInterface.addIndex(index.table, index.fields, {
            name: index.name,
            unique: index.unique,
        });
    }
};
