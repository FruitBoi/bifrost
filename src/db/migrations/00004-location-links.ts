import { randomUUID } from 'crypto';
import { DataTypes, QueryTypes, Sequelize } from 'sequelize';
import type { Migration } from '../migrator';

/**
 * Generalises channel links into links between *locations*. Each side of a
 * link is a text channel or a thread inside one:
 *
 * - channel_links.discordThreadId / fluxerThreadId (nullable): set when that
 *   side is a thread. The *ChannelId column then holds the thread's parent,
 *   which owns the webhook used to post into the thread.
 * - The unique indexes on discordChannelId / fluxerChannelId from 00002 now
 *   only cover channel rows (thread rows share their parent's channel id);
 *   the thread id columns get their own unique indexes.
 * - Rows of the thread_links table introduced in 00003 are converted into
 *   channel_links rows (inheriting the parent link's webhooks), message_links
 *   and queued_messages are re-pointed at the new rows, and thread_links plus
 *   the threadLinkId columns are dropped.
 *
 * SQLite note: Sequelize drops a column by rebuilding the table, which loses
 * that table's indexes (and foreign keys). The indexes are re-created here;
 * the message_links foreign keys are not, which only affects cascade deletes
 * that the application performs explicitly anyway.
 */

interface ThreadLinkRow {
    id: string;
    guildLinkId: string;
    channelLinkId: string;
    discordThreadId: string;
    fluxerThreadId: string;
    createdAt: Date | string;
}

interface ChannelLinkRow {
    id: string;
    guildLinkId: string;
    discordChannelId: string;
    discordThreadId: string | null;
    fluxerChannelId: string;
    fluxerThreadId: string | null;
    discordWebhookId: string;
    discordWebhookToken: string;
    fluxerWebhookId: string;
    fluxerWebhookToken: string;
    linkId: string;
    autoSyncThreads: boolean | number;
    createdAt: Date | string;
}

function newLinkId(): string {
    return randomUUID().replace(/-/g, '').slice(0, 10);
}

async function withSqliteForeignKeysOff(
    sequelize: Sequelize,
    fn: () => Promise<void>
): Promise<void> {
    const isSqlite = sequelize.getDialect() === 'sqlite';
    if (isSqlite) await sequelize.query('PRAGMA foreign_keys = OFF');
    try {
        await fn();
    } finally {
        if (isSqlite) await sequelize.query('PRAGMA foreign_keys = ON');
    }
}

export const up: Migration = async ({ context: queryInterface }) => {
    const sequelize = queryInterface.sequelize;
    const isSqlite = sequelize.getDialect() === 'sqlite';

    // 1. Thread id columns.
    await queryInterface.addColumn('channel_links', 'discordThreadId', {
        type: DataTypes.STRING,
        allowNull: true,
    });
    await queryInterface.addColumn('channel_links', 'fluxerThreadId', {
        type: DataTypes.STRING,
        allowNull: true,
    });

    // 2. Indexes: channel uniqueness only for channel rows, plus thread ids.
    await queryInterface.removeIndex(
        'channel_links',
        'channel_links_discord_channel_id'
    );
    await queryInterface.removeIndex(
        'channel_links',
        'channel_links_fluxer_channel_id'
    );
    await queryInterface.addIndex('channel_links', ['discordChannelId'], {
        unique: true,
        where: { discordThreadId: null },
        name: 'channel_links_discord_channel_id',
    });
    await queryInterface.addIndex('channel_links', ['fluxerChannelId'], {
        unique: true,
        where: { fluxerThreadId: null },
        name: 'channel_links_fluxer_channel_id',
    });
    await queryInterface.addIndex('channel_links', ['discordThreadId'], {
        unique: true,
        name: 'channel_links_discord_thread_id',
    });
    await queryInterface.addIndex('channel_links', ['fluxerThreadId'], {
        unique: true,
        name: 'channel_links_fluxer_thread_id',
    });
    await queryInterface.addIndex('channel_links', ['discordChannelId'], {
        name: 'channel_links_discord_parent_channel_id',
    });
    await queryInterface.addIndex('channel_links', ['fluxerChannelId'], {
        name: 'channel_links_fluxer_parent_channel_id',
    });

    // 3. Convert thread_links rows into channel_links rows.
    const threadLinks = await sequelize.query<ThreadLinkRow>(
        'SELECT * FROM thread_links',
        { type: QueryTypes.SELECT }
    );
    for (const threadLink of threadLinks) {
        const [parent] = await sequelize.query<ChannelLinkRow>(
            'SELECT * FROM channel_links WHERE id = :id',
            {
                type: QueryTypes.SELECT,
                replacements: { id: threadLink.channelLinkId },
            }
        );
        if (!parent) continue; // orphan; its message links are left as-is

        const id = randomUUID();
        await queryInterface.bulkInsert('channel_links', [
            {
                id,
                guildLinkId: threadLink.guildLinkId,
                discordChannelId: parent.discordChannelId,
                discordThreadId: threadLink.discordThreadId,
                fluxerChannelId: parent.fluxerChannelId,
                fluxerThreadId: threadLink.fluxerThreadId,
                discordWebhookId: parent.discordWebhookId,
                discordWebhookToken: parent.discordWebhookToken,
                fluxerWebhookId: parent.fluxerWebhookId,
                fluxerWebhookToken: parent.fluxerWebhookToken,
                linkId: newLinkId(),
                autoSyncThreads: false,
                createdAt: threadLink.createdAt,
            },
        ]);
        await queryInterface.bulkUpdate(
            'message_links',
            { channelLinkId: id },
            { threadLinkId: threadLink.id }
        );
        await queryInterface.bulkUpdate(
            'queued_messages',
            { channelLinkId: id },
            { threadLinkId: threadLink.id }
        );
    }

    // 4. Drop the thread_links layer.
    await queryInterface.removeIndex(
        'message_links',
        'message_links_thread_link_id'
    );
    await withSqliteForeignKeysOff(sequelize, async () => {
        await queryInterface.removeColumn('message_links', 'threadLinkId');
        await queryInterface.removeColumn('queued_messages', 'threadLinkId');
        await queryInterface.dropTable('thread_links');
    });
    if (isSqlite) {
        await queryInterface.addIndex('message_links', ['discordMessageId'], {
            unique: true,
            name: 'message_links_discord_message_id',
        });
        await queryInterface.addIndex('message_links', ['fluxerMessageId'], {
            unique: true,
            name: 'message_links_fluxer_message_id',
        });
        await queryInterface.addIndex('message_links', ['guildLinkId'], {
            name: 'message_links_guild_link_id',
        });
        await queryInterface.addIndex(
            'queued_messages',
            ['direction', 'createdAt'],
            { name: 'queued_messages_direction_created_at' }
        );
    }
};

export const down: Migration = async ({ context: queryInterface }) => {
    const sequelize = queryInterface.sequelize;
    const isSqlite = sequelize.getDialect() === 'sqlite';

    // 1. Recreate the thread_links layer from 00003.
    await queryInterface.createTable('thread_links', {
        id: { type: DataTypes.UUID, primaryKey: true },
        guildLinkId: { type: DataTypes.UUID, allowNull: false },
        channelLinkId: {
            type: DataTypes.UUID,
            allowNull: false,
            references: { model: 'channel_links', key: 'id' },
            onDelete: 'CASCADE',
        },
        discordThreadId: { type: DataTypes.STRING, allowNull: false },
        fluxerThreadId: { type: DataTypes.STRING, allowNull: false },
        createdAt: { type: DataTypes.DATE, allowNull: false },
    });
    await queryInterface.addIndex('thread_links', ['discordThreadId'], {
        unique: true,
        name: 'thread_links_discord_thread_id',
    });
    await queryInterface.addIndex('thread_links', ['fluxerThreadId'], {
        unique: true,
        name: 'thread_links_fluxer_thread_id',
    });
    await queryInterface.addIndex('thread_links', ['channelLinkId'], {
        name: 'thread_links_channel_link_id',
    });
    await queryInterface.addIndex('thread_links', ['guildLinkId'], {
        name: 'thread_links_guild_link_id',
    });
    await queryInterface.addColumn('message_links', 'threadLinkId', {
        type: DataTypes.UUID,
        allowNull: true,
    });
    await queryInterface.addIndex('message_links', ['threadLinkId'], {
        name: 'message_links_thread_link_id',
    });
    await queryInterface.addColumn('queued_messages', 'threadLinkId', {
        type: DataTypes.UUID,
        allowNull: true,
    });

    // 2. Move thread<->thread rows under a linked parent back to thread_links.
    //    Mixed links and thread pairs without a linked parent cannot be
    //    represented in the old schema and are dropped.
    const threadRows = await sequelize.query<ChannelLinkRow>(
        'SELECT * FROM channel_links WHERE discordThreadId IS NOT NULL OR fluxerThreadId IS NOT NULL',
        { type: QueryTypes.SELECT }
    );
    for (const row of threadRows) {
        let parent: ChannelLinkRow | undefined;
        if (row.discordThreadId && row.fluxerThreadId) {
            [parent] = await sequelize.query<ChannelLinkRow>(
                'SELECT * FROM channel_links WHERE discordChannelId = :d AND fluxerChannelId = :f AND discordThreadId IS NULL AND fluxerThreadId IS NULL',
                {
                    type: QueryTypes.SELECT,
                    replacements: {
                        d: row.discordChannelId,
                        f: row.fluxerChannelId,
                    },
                }
            );
        }

        if (parent) {
            const threadLinkId = randomUUID();
            await queryInterface.bulkInsert('thread_links', [
                {
                    id: threadLinkId,
                    guildLinkId: row.guildLinkId,
                    channelLinkId: parent.id,
                    discordThreadId: row.discordThreadId,
                    fluxerThreadId: row.fluxerThreadId,
                    createdAt: row.createdAt,
                },
            ]);
            await queryInterface.bulkUpdate(
                'message_links',
                { channelLinkId: parent.id, threadLinkId },
                { channelLinkId: row.id }
            );
            await queryInterface.bulkUpdate(
                'queued_messages',
                { channelLinkId: parent.id, threadLinkId },
                { channelLinkId: row.id }
            );
        } else {
            await queryInterface.bulkDelete('message_links', {
                channelLinkId: row.id,
            });
            await queryInterface.bulkDelete('queued_messages', {
                channelLinkId: row.id,
            });
        }
        await queryInterface.bulkDelete('channel_links', { id: row.id });
    }

    // 3. Drop the thread columns and restore 00002's indexes.
    for (const name of [
        'channel_links_discord_parent_channel_id',
        'channel_links_fluxer_parent_channel_id',
        'channel_links_discord_thread_id',
        'channel_links_fluxer_thread_id',
        'channel_links_discord_channel_id',
        'channel_links_fluxer_channel_id',
    ]) {
        await queryInterface.removeIndex('channel_links', name);
    }
    await withSqliteForeignKeysOff(sequelize, async () => {
        await queryInterface.removeColumn('channel_links', 'fluxerThreadId');
        await queryInterface.removeColumn('channel_links', 'discordThreadId');
    });
    await queryInterface.addIndex('channel_links', ['discordChannelId'], {
        unique: true,
        name: 'channel_links_discord_channel_id',
    });
    await queryInterface.addIndex('channel_links', ['fluxerChannelId'], {
        unique: true,
        name: 'channel_links_fluxer_channel_id',
    });
    if (isSqlite) {
        await queryInterface.addIndex('channel_links', ['guildLinkId'], {
            name: 'channel_links_guild_link_id',
        });
    }
};
