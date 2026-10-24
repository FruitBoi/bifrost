import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { Umzug, SequelizeStorage } from 'umzug';
import sequelize from '../../src/db/sequelize';
import * as baseline from '../../src/db/migrations/00001-baseline';
import * as indexes from '../../src/db/migrations/00002-add-channel-link-indexes';
import * as threadLinks from '../../src/db/migrations/00003-add-thread-links';
import * as locationLinks from '../../src/db/migrations/00004-location-links';
import * as categoryLinks from '../../src/db/migrations/00005-category-links';
import * as voiceLinks from '../../src/db/migrations/00006-voice-links';
import * as messageLinkAuthors from '../../src/db/migrations/00007-message-link-authors';
import * as userLinks from '../../src/db/migrations/00008-user-links';
import * as reminders from '../../src/db/migrations/00009-reminders';
import * as historyMessages from '../../src/db/migrations/00010-history-messages';
import * as claudeRequests from '../../src/db/migrations/00011-claude-requests';
import * as userTimezones from '../../src/db/migrations/00012-user-timezones';
import * as claudeRequestNotices from '../../src/db/migrations/00013-claude-request-notices';
import { MessageLinkModel } from '../../src/db/models';
import { SequelizeCategoryLinkRepository } from '../../src/db/sequelizerepos/SequelizeCategoryLinkRepository';
import { SequelizeClaudeRequestRepository } from '../../src/db/sequelizerepos/SequelizeClaudeRequestRepository';
import { SequelizeClaudeRequestNoticeRepository } from '../../src/db/sequelizerepos/SequelizeClaudeRequestNoticeRepository';
import { SequelizeChannelLinkRepository } from '../../src/db/sequelizerepos/SequelizeChannelLinkRepository';
import { SequelizeHistoryMessageRepository } from '../../src/db/sequelizerepos/SequelizeHistoryMessageRepository';
import { SequelizeMessageLinkRepository } from '../../src/db/sequelizerepos/SequelizeMessageLinkRepository';
import { SequelizeReminderRepository } from '../../src/db/sequelizerepos/SequelizeReminderRepository';
import { SequelizeUserTimezoneRepository } from '../../src/db/sequelizerepos/SequelizeUserTimezoneRepository';
import { SequelizeUserLinkRepository } from '../../src/db/sequelizerepos/SequelizeUserLinkRepository';
import { SequelizeVoiceLinkRepository } from '../../src/db/sequelizerepos/SequelizeVoiceLinkRepository';

// Same storage/context as src/db/migrator.ts, but over the TypeScript sources
// (the real migrator globs the compiled dist/ files).
const umzug = new Umzug({
    migrations: [
        { name: '00001-baseline.js', up: baseline.up, down: baseline.down },
        {
            name: '00002-add-channel-link-indexes.js',
            up: indexes.up,
            down: indexes.down,
        },
        {
            name: '00003-add-thread-links.js',
            up: threadLinks.up,
            down: threadLinks.down,
        },
        {
            name: '00004-location-links.js',
            up: locationLinks.up,
            down: locationLinks.down,
        },
        {
            name: '00005-category-links.js',
            up: categoryLinks.up,
            down: categoryLinks.down,
        },
        {
            name: '00006-voice-links.js',
            up: voiceLinks.up,
            down: voiceLinks.down,
        },
        {
            name: '00007-message-link-authors.js',
            up: messageLinkAuthors.up,
            down: messageLinkAuthors.down,
        },
        {
            name: '00008-user-links.js',
            up: userLinks.up,
            down: userLinks.down,
        },
        {
            name: '00009-reminders.js',
            up: reminders.up,
            down: reminders.down,
        },
        {
            name: '00010-history-messages.js',
            up: historyMessages.up,
            down: historyMessages.down,
        },
        {
            name: '00011-claude-requests.js',
            up: claudeRequests.up,
            down: claudeRequests.down,
        },
        {
            name: '00012-user-timezones.js',
            up: userTimezones.up,
            down: userTimezones.down,
        },
        {
            name: '00013-claude-request-notices.js',
            up: claudeRequestNotices.up,
            down: claudeRequestNotices.down,
        },
    ],
    context: sequelize.getQueryInterface(),
    storage: new SequelizeStorage({ sequelize }),
    logger: undefined,
});

const qi = sequelize.getQueryInterface();
const executed = async () => (await umzug.executed()).map((m) => m.name);
// Sequelize v6 types showIndex() as Promise<object>; this is its real shape.
interface IndexInfo {
    name: string;
    unique: boolean;
    fields: { attribute: string }[];
}
const showIndexes = async (table: string) =>
    (await qi.showIndex(table)) as IndexInfo[];
const now = new Date();
const select = async <T>(sql: string) => (await sequelize.query(sql))[0] as T[];

beforeAll(async () => {
    const file = path.join(process.env.BF_CONFIG_PATH!, 'data.sqlite');
    fs.rmSync(file, { force: true });
    await sequelize.authenticate();
});

afterAll(async () => {
    await sequelize.close();
});

describe('migrations 00003 + 00004 on an existing SQLite database', () => {
    it('00003 applies on top of a populated 00002 schema without touching existing rows', async () => {
        await umzug.up({ to: '00002-add-channel-link-indexes.js' });
        await qi.bulkInsert('guild_links', [
            {
                id: 'g1',
                discordGuildId: 'dg',
                fluxerGuildId: 'fg',
                createdAt: now,
            },
        ]);
        await qi.bulkInsert('channel_links', [
            {
                id: 'c1',
                guildLinkId: 'g1',
                discordChannelId: 'dc',
                fluxerChannelId: 'fc',
                discordWebhookId: 'dw',
                discordWebhookToken: 't',
                fluxerWebhookId: 'fw',
                fluxerWebhookToken: 't',
                linkId: 'abc',
                createdAt: now,
            },
        ]);
        await qi.bulkInsert('message_links', [
            {
                id: 'm1',
                guildLinkId: 'g1',
                channelLinkId: 'c1',
                discordMessageId: 'dm',
                fluxerMessageId: 'fm',
                createdAt: now,
            },
        ]);

        await umzug.up({ to: '00003-add-thread-links.js' });
        expect(await executed()).toEqual([
            '00001-baseline.js',
            '00002-add-channel-link-indexes.js',
            '00003-add-thread-links.js',
        ]);
        expect(
            (await qi.describeTable('channel_links')).autoSyncThreads
        ).toMatchObject({ allowNull: false, defaultValue: false });
        expect(await qi.tableExists('thread_links')).toBe(true);
    });

    it('00004 converts thread_links rows into location links and re-points their messages', async () => {
        // State as left by a deployment that ran 00003: one bridged thread
        // under c1 with a message and a queued retry inside it.
        await qi.bulkInsert('thread_links', [
            {
                id: 'tl1',
                guildLinkId: 'g1',
                channelLinkId: 'c1',
                discordThreadId: 'dt0',
                fluxerThreadId: 'ft0',
                createdAt: now,
            },
        ]);
        await qi.bulkInsert('message_links', [
            {
                id: 'm2',
                guildLinkId: 'g1',
                channelLinkId: 'c1',
                threadLinkId: 'tl1',
                discordMessageId: 'dm-thread',
                fluxerMessageId: 'fm-thread',
                createdAt: now,
            },
        ]);
        await qi.bulkInsert('queued_messages', [
            {
                id: 'q1',
                direction: 'discord_to_fluxer',
                channelLinkId: 'c1',
                threadLinkId: 'tl1',
                sourceMessageId: 's',
                payload: '{}',
                retryCount: 0,
                createdAt: now,
            },
        ]);

        // Runs through 00005 as well: the models (and so the repositories
        // used below) describe the current schema, including categoryLinkId.
        await umzug.up();
        expect(await executed()).toContain('00004-location-links.js');

        const cols = await qi.describeTable('channel_links');
        expect(cols.discordThreadId).toMatchObject({ allowNull: true });
        expect(cols.fluxerThreadId).toMatchObject({ allowNull: true });
        expect(await qi.tableExists('thread_links')).toBe(false);
        expect(
            (await qi.describeTable('message_links')).threadLinkId
        ).toBeUndefined();
        expect(
            (await qi.describeTable('queued_messages')).threadLinkId
        ).toBeUndefined();

        const repo = new SequelizeChannelLinkRepository();
        const converted = await repo.findByDiscordLocation('dt0');
        expect(converted).toMatchObject({
            guildLinkId: 'g1',
            discordChannelId: 'dc',
            discordThreadId: 'dt0',
            fluxerChannelId: 'fc',
            fluxerThreadId: 'ft0',
            discordWebhookId: 'dw',
            fluxerWebhookId: 'fw',
            autoSyncThreads: false,
        });
        expect(converted!.id).not.toBe('c1');
        expect(converted!.linkId).toHaveLength(10);

        const channel = await repo.findById('c1');
        expect(channel).toMatchObject({
            discordThreadId: null,
            fluxerThreadId: null,
            autoSyncThreads: false,
        });

        const [m2] = await select<{ channelLinkId: string }>(
            "SELECT channelLinkId FROM message_links WHERE id = 'm2'"
        );
        expect(m2.channelLinkId).toBe(converted!.id);
        const [m1] = await select<{ channelLinkId: string }>(
            "SELECT channelLinkId FROM message_links WHERE id = 'm1'"
        );
        expect(m1.channelLinkId).toBe('c1');
        const [q1] = await select<{ channelLinkId: string }>(
            "SELECT channelLinkId FROM queued_messages WHERE id = 'q1'"
        );
        expect(q1.channelLinkId).toBe(converted!.id);

        // Indexes lost by the SQLite table rebuilds are back.
        const messageIndexes = (await qi.showIndex('message_links')).map(
            (i) => i.name
        );
        expect(messageIndexes).toEqual(
            expect.arrayContaining([
                'message_links_discord_message_id',
                'message_links_fluxer_message_id',
                'message_links_guild_link_id',
            ])
        );
        await expect(
            qi.bulkInsert('message_links', [
                {
                    id: 'm-dup',
                    guildLinkId: 'g1',
                    channelLinkId: 'c1',
                    discordMessageId: 'dm',
                    fluxerMessageId: 'fm-other',
                    createdAt: now,
                },
            ])
        ).rejects.toThrow();
    });

    it('lets a channel row and thread rows share the same parent channel', async () => {
        const repo = new SequelizeChannelLinkRepository();
        const threadLink = await repo.create({
            guildLinkId: 'g1',
            discordChannelId: 'dc',
            discordThreadId: 'dt1',
            fluxerChannelId: 'fc',
            fluxerThreadId: 'ft1',
            discordWebhookId: 'dw',
            discordWebhookToken: 't',
            fluxerWebhookId: 'fw',
            fluxerWebhookToken: 't',
        });
        const mixed = await repo.create({
            guildLinkId: 'g1',
            discordChannelId: 'dc',
            discordThreadId: 'dt2',
            fluxerChannelId: 'fother',
            fluxerThreadId: null,
            discordWebhookId: 'dw',
            discordWebhookToken: 't',
            fluxerWebhookId: 'fw2',
            fluxerWebhookToken: 't',
        });

        expect((await repo.findByDiscordLocation('dc'))?.id).toBe('c1');
        expect((await repo.findByDiscordLocation('dt1'))?.id).toBe(
            threadLink.id
        );
        expect((await repo.findByFluxerLocation('fother'))?.id).toBe(mixed.id);
        expect((await repo.findAllByDiscordChannel('dc')).length).toBe(4);
        expect(await repo.countByDiscordWebhookId('dw')).toBe(4);
        expect(await repo.countByFluxerWebhookId('fw2')).toBe(1);
    });

    it('rejects a second channel row for the same channel and duplicate thread ids', async () => {
        const repo = new SequelizeChannelLinkRepository();
        const base = {
            guildLinkId: 'g1',
            discordWebhookId: 'dw',
            discordWebhookToken: 't',
            fluxerWebhookId: 'fw',
            fluxerWebhookToken: 't',
        };
        await expect(
            repo.create({
                ...base,
                discordChannelId: 'dc',
                fluxerChannelId: 'fc-unused',
            })
        ).rejects.toThrow();
        await expect(
            repo.create({
                ...base,
                discordChannelId: 'dc-unused',
                fluxerChannelId: 'fc',
            })
        ).rejects.toThrow();
        await expect(
            repo.create({
                ...base,
                discordChannelId: 'dc',
                discordThreadId: 'dt1',
                fluxerChannelId: 'fc',
                fluxerThreadId: 'ft-new',
            })
        ).rejects.toThrow();
        await expect(
            repo.create({
                ...base,
                discordChannelId: 'dc',
                discordThreadId: 'dt-new',
                fluxerChannelId: 'fc',
                fluxerThreadId: 'ft1',
            })
        ).rejects.toThrow();
    });

    it('stores and toggles autoSyncThreads and keeps message links on thread rows', async () => {
        const repo = new SequelizeChannelLinkRepository();
        const messages = new SequelizeMessageLinkRepository();
        const threadLink = (await repo.findByDiscordLocation('dt1'))!;

        await messages.createMessageLink('g1', threadLink.id, 'dm2', 'fm2');
        expect(
            (await messages.getMessageLinkByDiscordMessageId('dm2'))
                ?.channelLinkId
        ).toBe(threadLink.id);

        expect(
            (await repo.setAutoSyncThreads('c1', true)).autoSyncThreads
        ).toBe(true);
        expect((await repo.findById('c1'))?.autoSyncThreads).toBe(true);
    });

    it('00005 adds category_links and channel_links.categoryLinkId, and rolls back cleanly', async () => {
        const CHANNEL_LINK_INDEXES = [
            'channel_links_discord_channel_id',
            'channel_links_fluxer_channel_id',
            'channel_links_discord_thread_id',
            'channel_links_fluxer_thread_id',
            'channel_links_discord_parent_channel_id',
            'channel_links_fluxer_parent_channel_id',
            'channel_links_guild_link_id',
        ];
        const indexNames = async (table: string) =>
            (await showIndexes(table)).map((i) => i.name);

        expect(await executed()).toContain('00005-category-links.js');

        expect(await qi.tableExists('category_links')).toBe(true);
        const categoryIndexes = await showIndexes('category_links');
        const unique = categoryIndexes.find(
            (i) => i.name === 'category_links_discord_category_id'
        );
        expect(unique).toBeDefined();
        expect(unique!.unique).toBe(true);
        expect(unique!.fields.map((f) => f.attribute)).toEqual([
            'discordCategoryId',
        ]);
        expect(
            (await qi.describeTable('channel_links')).categoryLinkId
        ).toMatchObject({ allowNull: true });
        expect(await indexNames('channel_links')).toContain(
            'channel_links_category_link_id'
        );

        // Repositories work against the new schema.
        const categories = new SequelizeCategoryLinkRepository();
        const created = await categories.create({
            guildLinkId: 'g1',
            discordCategoryId: 'dcat',
            fluxerChannelId: 'fhost',
        });
        expect(created).toMatchObject({
            guildLinkId: 'g1',
            discordCategoryId: 'dcat',
            fluxerChannelId: 'fhost',
        });
        expect(created.id).toBeTruthy();
        expect(await categories.findByDiscordCategoryId('dcat')).toMatchObject({
            id: created.id,
        });
        expect(await categories.findById(created.id)).toMatchObject({
            discordCategoryId: 'dcat',
        });
        expect(
            (await categories.findAllByGuild('g1')).map((c) => c.id)
        ).toEqual([created.id]);
        expect(
            (await categories.findAllByFluxerChannelId('fhost')).map(
                (c) => c.id
            )
        ).toEqual([created.id]);
        expect(await categories.getCategoryLinksCount()).toBe(1);
        await expect(
            categories.create({
                guildLinkId: 'g1',
                discordCategoryId: 'dcat',
                fluxerChannelId: 'fhost-2',
            })
        ).rejects.toThrow();

        const channels = new SequelizeChannelLinkRepository();
        const bridged = await channels.create({
            guildLinkId: 'g1',
            discordChannelId: 'dc-cat',
            discordThreadId: null,
            fluxerChannelId: 'fhost',
            fluxerThreadId: 'ft-cat',
            discordWebhookId: 'dw-cat',
            discordWebhookToken: 't',
            fluxerWebhookId: 'fw-cat',
            fluxerWebhookToken: 't',
            categoryLinkId: created.id,
        });
        expect(bridged.categoryLinkId).toBe(created.id);
        expect(
            (await channels.findAllByCategoryLink(created.id)).map((l) => l.id)
        ).toEqual([bridged.id]);
        expect(await channels.findAllByCategoryLink('nope')).toEqual([]);
        // Rows from before the migration have a null categoryLinkId.
        expect((await channels.findById('c1'))?.categoryLinkId).toBeNull();

        await channels.deleteById(bridged.id);
        await categories.deleteById(created.id);
        expect(await categories.getCategoryLinksCount()).toBe(0);

        // Roll back: column and table gone, every 00004 index still present.
        await umzug.down({ to: '00005-category-links.js' });
        expect(await executed()).toEqual([
            '00001-baseline.js',
            '00002-add-channel-link-indexes.js',
            '00003-add-thread-links.js',
            '00004-location-links.js',
        ]);
        expect(
            (await qi.describeTable('channel_links')).categoryLinkId
        ).toBeUndefined();
        expect(await qi.tableExists('category_links')).toBe(false);
        const after = await indexNames('channel_links');
        expect(after).toEqual(expect.arrayContaining(CHANNEL_LINK_INDEXES));
        expect(after).not.toContain('channel_links_category_link_id');
        await expect(
            qi.bulkInsert('channel_links', [
                {
                    id: 'c-dup-5',
                    guildLinkId: 'g1',
                    discordChannelId: 'dc',
                    fluxerChannelId: 'fc-y',
                    discordWebhookId: 'dw',
                    discordWebhookToken: 't',
                    fluxerWebhookId: 'fw',
                    fluxerWebhookToken: 't',
                    linkId: 'dup5',
                    createdAt: now,
                },
            ])
        ).rejects.toThrow();
        // Existing rows survived the SQLite table rebuild.
        expect(
            (await select<{ id: string }>('SELECT id FROM channel_links'))
                .length
        ).toBe(4);

        await umzug.up();
        expect(await executed()).toContain('00005-category-links.js');
        expect(await qi.tableExists('category_links')).toBe(true);
        expect(
            (await qi.describeTable('channel_links')).categoryLinkId
        ).toBeDefined();
    });

    it('00006 adds voice_links with its indexes, and rolls back cleanly', async () => {
        expect(await executed()).toContain('00006-voice-links.js');
        expect(await qi.tableExists('voice_links')).toBe(true);

        const cols = await qi.describeTable('voice_links');
        expect(cols.guildLinkId).toMatchObject({ allowNull: false });
        expect(cols.discordChannelId).toMatchObject({ allowNull: false });
        expect(cols.fluxerChannelId).toMatchObject({ allowNull: false });
        expect(cols.enabled).toMatchObject({
            allowNull: false,
            defaultValue: true,
        });
        expect(cols.createdAt).toMatchObject({ allowNull: false });

        const indexes = await showIndexes('voice_links');
        const byName = (name: string) => indexes.find((i) => i.name === name);
        expect(byName('voice_links_discord_channel_id')).toMatchObject({
            unique: true,
            fields: [{ attribute: 'discordChannelId' }],
        });
        expect(byName('voice_links_fluxer_channel_id')).toMatchObject({
            unique: true,
            fields: [{ attribute: 'fluxerChannelId' }],
        });
        expect(byName('voice_links_guild_link_id')).toMatchObject({
            unique: false,
            fields: [{ attribute: 'guildLinkId' }],
        });

        // The repository works against the new schema.
        const voice = new SequelizeVoiceLinkRepository();
        const created = await voice.create({
            guildLinkId: 'g1',
            discordChannelId: 'dvc',
            fluxerChannelId: 'fvc',
        });
        expect(created).toMatchObject({
            guildLinkId: 'g1',
            discordChannelId: 'dvc',
            fluxerChannelId: 'fvc',
            enabled: true,
        });
        expect(created.id).toBeTruthy();
        expect(created.createdAt).toBeInstanceOf(Date);
        expect(await voice.findById(created.id)).toMatchObject({
            discordChannelId: 'dvc',
        });
        expect(await voice.findByDiscordChannelId('dvc')).toMatchObject({
            id: created.id,
        });
        expect(await voice.findByFluxerChannelId('fvc')).toMatchObject({
            id: created.id,
        });
        expect(await voice.findByDiscordChannelId('nope')).toBeNull();
        expect((await voice.findAllByGuild('g1')).map((v) => v.id)).toEqual([
            created.id,
        ]);
        expect((await voice.findAll()).map((v) => v.id)).toEqual([created.id]);
        expect(await voice.getVoiceLinksCount()).toBe(1);

        const disabled = await voice.create({
            guildLinkId: 'g1',
            discordChannelId: 'dvc-off',
            fluxerChannelId: 'fvc-off',
            enabled: false,
        });
        expect(disabled.enabled).toBe(false);
        expect((await voice.setEnabled(created.id, false))?.enabled).toBe(
            false
        );
        expect((await voice.findById(created.id))?.enabled).toBe(false);
        expect((await voice.setEnabled(created.id, true))?.enabled).toBe(true);
        expect(await voice.setEnabled('missing', true)).toBeNull();

        // Each voice channel can be linked only once.
        await expect(
            voice.create({
                guildLinkId: 'g1',
                discordChannelId: 'dvc',
                fluxerChannelId: 'fvc-other',
            })
        ).rejects.toThrow();
        await expect(
            voice.create({
                guildLinkId: 'g1',
                discordChannelId: 'dvc-other',
                fluxerChannelId: 'fvc',
            })
        ).rejects.toThrow();

        await voice.deleteById(disabled.id);
        expect(await voice.findById(disabled.id)).toBeNull();
        expect(await voice.getVoiceLinksCount()).toBe(1);
        await voice.deleteByGuildLinkId('g1');
        expect(await voice.getVoiceLinksCount()).toBe(0);

        // Roll back: the table is gone and nothing else was touched.
        await umzug.down({ to: '00006-voice-links.js' });
        expect(await executed()).toEqual([
            '00001-baseline.js',
            '00002-add-channel-link-indexes.js',
            '00003-add-thread-links.js',
            '00004-location-links.js',
            '00005-category-links.js',
        ]);
        expect(await qi.tableExists('voice_links')).toBe(false);
        expect(await qi.tableExists('category_links')).toBe(true);
        expect(
            (await select<{ id: string }>('SELECT id FROM channel_links'))
                .length
        ).toBe(4);

        await umzug.up();
        expect(await executed()).toContain('00006-voice-links.js');
        expect(await qi.tableExists('voice_links')).toBe(true);
        expect(await voice.getVoiceLinksCount()).toBe(0);
    });

    it('00007 adds message_links.sourcePlatform/sourceAuthorId, and rolls back cleanly', async () => {
        const MESSAGE_LINK_INDEXES = [
            'message_links_discord_message_id',
            'message_links_fluxer_message_id',
            'message_links_guild_link_id',
        ];
        const indexNames = async (table: string) =>
            (await showIndexes(table)).map((i) => i.name);

        expect(await executed()).toContain('00007-message-link-authors.js');
        const cols = await qi.describeTable('message_links');
        expect(cols.sourcePlatform).toMatchObject({ allowNull: true });
        expect(cols.sourceAuthorId).toMatchObject({ allowNull: true });

        // The repository round-trips the source, and leaves it null when the
        // caller does not know it.
        const messages = new SequelizeMessageLinkRepository();
        await messages.createMessageLink('g1', 'c1', 'dm-src', 'fm-src', {
            platform: 'fluxer',
            authorId: 'fu-1',
        });
        await messages.createMessageLink('g1', 'c1', 'dm-nosrc', 'fm-nosrc');
        expect(
            await messages.getMessageLinkByDiscordMessageId('dm-src')
        ).toMatchObject({
            guildLinkId: 'g1',
            channelLinkId: 'c1',
            discordMessageId: 'dm-src',
            fluxerMessageId: 'fm-src',
            sourcePlatform: 'fluxer',
            sourceAuthorId: 'fu-1',
        });
        expect(
            await messages.getMessageLinkByFluxerMessageId('fm-nosrc')
        ).toMatchObject({
            discordMessageId: 'dm-nosrc',
            sourcePlatform: null,
            sourceAuthorId: null,
        });
        // Rows from before the migration have no source either.
        expect(
            await messages.getMessageLinkByDiscordMessageId('dm')
        ).toMatchObject({ sourcePlatform: null, sourceAuthorId: null });
        const countBefore = await messages.getMessageLinksCount();

        // Roll back: columns gone, rows and every index still present.
        await umzug.down({ to: '00007-message-link-authors.js' });
        expect(await executed()).toEqual([
            '00001-baseline.js',
            '00002-add-channel-link-indexes.js',
            '00003-add-thread-links.js',
            '00004-location-links.js',
            '00005-category-links.js',
            '00006-voice-links.js',
        ]);
        const after = await qi.describeTable('message_links');
        expect(after.sourcePlatform).toBeUndefined();
        expect(after.sourceAuthorId).toBeUndefined();
        expect(after.discordMessageId).toBeDefined();
        expect(await indexNames('message_links')).toEqual(
            expect.arrayContaining(MESSAGE_LINK_INDEXES)
        );
        const unique = (await showIndexes('message_links')).find(
            (i) => i.name === 'message_links_discord_message_id'
        );
        expect(unique!.unique).toBe(true);
        await expect(
            qi.bulkInsert('message_links', [
                {
                    id: 'm-dup-7',
                    guildLinkId: 'g1',
                    channelLinkId: 'c1',
                    discordMessageId: 'dm-src',
                    fluxerMessageId: 'fm-other-7',
                    createdAt: now,
                },
            ])
        ).rejects.toThrow();
        expect(
            (await select<{ id: string }>('SELECT id FROM message_links'))
                .length
        ).toBe(countBefore);

        await umzug.up();
        expect(await executed()).toContain('00007-message-link-authors.js');
        expect(
            (await qi.describeTable('message_links')).sourceAuthorId
        ).toBeDefined();
        // The rebuild kept the rows; the dropped columns come back empty.
        expect(await messages.getMessageLinksCount()).toBe(countBefore);
        expect(
            await messages.getMessageLinkByDiscordMessageId('dm-src')
        ).toMatchObject({ sourcePlatform: null, sourceAuthorId: null });

        for (const discordMessageId of ['dm-src', 'dm-nosrc']) {
            const link =
                await messages.getMessageLinkByDiscordMessageId(
                    discordMessageId
                );
            await messages.deleteMessageLink(link!.id);
        }
        expect(await messages.getMessageLinksCount()).toBe(countBefore - 2);
    });

    it('00008 adds user_links with its indexes, and rolls back cleanly', async () => {
        expect(await executed()).toContain('00008-user-links.js');
        expect(await qi.tableExists('user_links')).toBe(true);

        const cols = await qi.describeTable('user_links');
        expect(cols.id).toMatchObject({ primaryKey: true });
        expect(cols.guildLinkId).toMatchObject({ allowNull: false });
        expect(cols.discordUserId).toMatchObject({ allowNull: false });
        expect(cols.fluxerUserId).toMatchObject({ allowNull: false });
        expect(cols.createdAt).toMatchObject({ allowNull: false });

        const indexes = await showIndexes('user_links');
        const byName = (name: string) => indexes.find((i) => i.name === name);
        expect(byName('user_links_guild_discord_user')).toMatchObject({
            unique: true,
            fields: [
                { attribute: 'guildLinkId' },
                { attribute: 'discordUserId' },
            ],
        });
        expect(byName('user_links_guild_fluxer_user')).toMatchObject({
            unique: true,
            fields: [
                { attribute: 'guildLinkId' },
                { attribute: 'fluxerUserId' },
            ],
        });
        expect(byName('user_links_guild_link_id')).toMatchObject({
            unique: false,
            fields: [{ attribute: 'guildLinkId' }],
        });

        // The repository works against the new schema.
        const users = new SequelizeUserLinkRepository();
        const created = await users.create({
            guildLinkId: 'g1',
            discordUserId: 'du-1',
            fluxerUserId: 'fu-1',
        });
        expect(created).toMatchObject({
            guildLinkId: 'g1',
            discordUserId: 'du-1',
            fluxerUserId: 'fu-1',
        });
        expect(created.id).toBeTruthy();
        expect(created.createdAt).toBeInstanceOf(Date);
        expect(await users.findById(created.id)).toMatchObject({
            discordUserId: 'du-1',
            fluxerUserId: 'fu-1',
        });
        expect(await users.findById('missing')).toBeNull();
        expect(await users.findByDiscordUser('g1', 'du-1')).toMatchObject({
            id: created.id,
        });
        expect(await users.findByFluxerUser('g1', 'fu-1')).toMatchObject({
            id: created.id,
        });
        expect(await users.findByDiscordUser('g1', 'nope')).toBeNull();
        expect(await users.findByFluxerUser('g1', 'nope')).toBeNull();
        // Lookups are scoped to the guild link.
        expect(await users.findByDiscordUser('g-other', 'du-1')).toBeNull();
        expect(await users.findByFluxerUser('g-other', 'fu-1')).toBeNull();

        const second = await users.create({
            guildLinkId: 'g1',
            discordUserId: 'du-2',
            fluxerUserId: 'fu-2',
        });
        expect((await users.findAllByGuild('g1')).map((u) => u.id)).toEqual([
            created.id,
            second.id,
        ]);
        expect(await users.findAllByGuild('g-other')).toEqual([]);
        expect(await users.getUserLinksCount()).toBe(2);

        // The mapping is one-to-one inside a guild link: neither the Discord
        // user nor the Fluxer user can be mapped a second time there...
        await expect(
            users.create({
                guildLinkId: 'g1',
                discordUserId: 'du-1',
                fluxerUserId: 'fu-other',
            })
        ).rejects.toThrow();
        await expect(
            users.create({
                guildLinkId: 'g1',
                discordUserId: 'du-other',
                fluxerUserId: 'fu-1',
            })
        ).rejects.toThrow();
        expect(await users.getUserLinksCount()).toBe(2);
        // ...but the same users can be mapped again under another guild link.
        const elsewhere = await users.create({
            guildLinkId: 'g-other',
            discordUserId: 'du-1',
            fluxerUserId: 'fu-1',
        });
        expect(elsewhere.id).not.toBe(created.id);
        expect(await users.findByDiscordUser('g-other', 'du-1')).toMatchObject({
            id: elsewhere.id,
        });
        expect(await users.findByDiscordUser('g1', 'du-1')).toMatchObject({
            id: created.id,
        });
        expect(await users.getUserLinksCount()).toBe(3);

        await users.deleteById(second.id);
        expect(await users.findById(second.id)).toBeNull();
        expect(await users.getUserLinksCount()).toBe(2);
        await users.deleteByGuildLinkId('g1');
        expect(await users.findAllByGuild('g1')).toEqual([]);
        expect(await users.findById(elsewhere.id)).toMatchObject({
            guildLinkId: 'g-other',
        });
        expect(await users.getUserLinksCount()).toBe(1);
        await users.deleteByGuildLinkId('g-other');
        expect(await users.getUserLinksCount()).toBe(0);

        // Roll back: the table is gone and nothing else was touched.
        await umzug.down({ to: '00008-user-links.js' });
        expect(await executed()).toEqual([
            '00001-baseline.js',
            '00002-add-channel-link-indexes.js',
            '00003-add-thread-links.js',
            '00004-location-links.js',
            '00005-category-links.js',
            '00006-voice-links.js',
            '00007-message-link-authors.js',
        ]);
        expect(await qi.tableExists('user_links')).toBe(false);
        expect(await qi.tableExists('message_links')).toBe(true);
        expect(await qi.tableExists('voice_links')).toBe(true);
        expect(await qi.tableExists('category_links')).toBe(true);
        expect(
            (await qi.describeTable('message_links')).sourceAuthorId
        ).toBeDefined();
        expect(
            (await select<{ id: string }>('SELECT id FROM channel_links'))
                .length
        ).toBe(4);

        await umzug.up();
        expect(await executed()).toContain('00008-user-links.js');
        expect(await qi.tableExists('user_links')).toBe(true);
        expect(await users.getUserLinksCount()).toBe(0);
    });

    it('rolls 00004 back to the thread_links schema and re-applies', async () => {
        await umzug.down({ to: '00004-location-links.js' });
        expect(await executed()).toEqual([
            '00001-baseline.js',
            '00002-add-channel-link-indexes.js',
            '00003-add-thread-links.js',
        ]);

        const cols = await qi.describeTable('channel_links');
        expect(cols.discordThreadId).toBeUndefined();
        expect(cols.autoSyncThreads).toBeDefined();
        expect(await qi.tableExists('thread_links')).toBe(true);

        // thread<->thread rows under c1 went back to thread_links; the mixed
        // link (dt2 <-> #fother) cannot be represented and was dropped.
        const threadRows = await select<{
            channelLinkId: string;
            discordThreadId: string;
            fluxerThreadId: string;
        }>('SELECT * FROM thread_links ORDER BY discordThreadId');
        expect(threadRows.map((r) => r.discordThreadId)).toEqual([
            'dt0',
            'dt1',
        ]);
        expect(threadRows.every((r) => r.channelLinkId === 'c1')).toBe(true);
        expect(
            (await select<{ id: string }>('SELECT id FROM channel_links')).map(
                (r) => r.id
            )
        ).toEqual(['c1']);

        const [m2] = await select<{
            channelLinkId: string;
            threadLinkId: string;
        }>(
            "SELECT channelLinkId, threadLinkId FROM message_links WHERE id = 'm2'"
        );
        expect(m2.channelLinkId).toBe('c1');
        const [restored] = await select<{ id: string }>(
            "SELECT id FROM thread_links WHERE discordThreadId = 'dt0'"
        );
        expect(m2.threadLinkId).toBe(restored.id);
        expect(await MessageLinkModel.count({ where: { id: 'm1' } })).toBe(1);

        // The pre-thread unique index is back.
        await expect(
            qi.bulkInsert('channel_links', [
                {
                    id: 'c-dup',
                    guildLinkId: 'g1',
                    discordChannelId: 'dc',
                    fluxerChannelId: 'fc-x',
                    discordWebhookId: 'dw',
                    discordWebhookToken: 't',
                    fluxerWebhookId: 'fw',
                    fluxerWebhookToken: 't',
                    linkId: 'dup',
                    createdAt: now,
                },
            ])
        ).rejects.toThrow();

        await umzug.up();
        expect(await executed()).toContain('00004-location-links.js');
        expect(await executed()).toContain('00005-category-links.js');
        expect(await executed()).toContain('00006-voice-links.js');
        expect(await executed()).toContain('00007-message-link-authors.js');
        expect(await executed()).toContain('00008-user-links.js');
        expect(
            (
                await new SequelizeChannelLinkRepository().findByDiscordLocation(
                    'dt0'
                )
            )?.fluxerThreadId
        ).toBe('ft0');
        expect(await qi.tableExists('category_links')).toBe(true);
        expect(await qi.tableExists('voice_links')).toBe(true);
        expect(await qi.tableExists('user_links')).toBe(true);
    });
});

describe('migration 00009-reminders', () => {
    it('adds reminders with its indexes, works with the repository, and rolls back cleanly', async () => {
        await umzug.up();
        expect(await executed()).toContain('00009-reminders.js');
        expect(await qi.tableExists('reminders')).toBe(true);

        const cols = await qi.describeTable('reminders');
        expect(cols.id).toMatchObject({ primaryKey: true, type: 'INTEGER' });
        expect(cols.platform).toMatchObject({ allowNull: false });
        expect(cols.userId).toMatchObject({ allowNull: false });
        expect(cols.guildId).toMatchObject({ allowNull: false });
        expect(cols.channelId).toMatchObject({ allowNull: false });
        expect(cols.message).toMatchObject({ allowNull: false });
        expect(cols.dueAt).toMatchObject({ allowNull: false });
        expect(cols.attempts).toMatchObject({ allowNull: false });
        expect(Number(cols.attempts.defaultValue)).toBe(0);
        expect(cols.createdAt).toMatchObject({ allowNull: false });

        const indexes = await showIndexes('reminders');
        const byName = (name: string) => indexes.find((i) => i.name === name);
        expect(byName('reminders_due_at')).toMatchObject({
            unique: false,
            fields: [{ attribute: 'dueAt' }],
        });
        expect(byName('reminders_platform_user')).toMatchObject({
            unique: false,
            fields: [{ attribute: 'platform' }, { attribute: 'userId' }],
        });
        expect(byName('reminders_platform_channel')).toMatchObject({
            unique: false,
            fields: [{ attribute: 'platform' }, { attribute: 'channelId' }],
        });

        // The repository works against the new schema: ids are small
        // auto-incremented integers shared by both platforms.
        const repo = new SequelizeReminderRepository();
        expect(await repo.count()).toBe(0);
        const base = Date.now() - (Date.now() % 1000);
        const first = await repo.create({
            platform: 'discord',
            userId: 'u1',
            guildId: 'g1',
            channelId: 'c1',
            message: 'first',
            dueAt: new Date(base + 60_000),
        });
        const second = await repo.create({
            platform: 'fluxer',
            userId: 'u1',
            guildId: 'fg1',
            channelId: 'fc1',
            message: 'second',
            dueAt: new Date(base - 60_000),
        });
        const third = await repo.create({
            platform: 'discord',
            userId: 'u1',
            guildId: 'g2',
            channelId: 'c2',
            message: 'third',
            dueAt: new Date(base - 1000),
        });
        const other = await repo.create({
            platform: 'discord',
            userId: 'u2',
            guildId: 'g1',
            channelId: 'c1',
            message: 'someone else',
            dueAt: new Date(base + 120_000),
        });
        expect(Number.isInteger(first.id)).toBe(true);
        expect(first.id).toBe(1);
        expect(second.id).toBe(first.id + 1);
        expect(third.id).toBe(second.id + 1);
        expect(other.id).toBe(third.id + 1);
        expect(first).toMatchObject({
            platform: 'discord',
            userId: 'u1',
            guildId: 'g1',
            channelId: 'c1',
            message: 'first',
            attempts: 0,
        });
        expect(first.dueAt).toBeInstanceOf(Date);
        expect(first.dueAt.getTime()).toBe(base + 60_000);
        expect(first.createdAt).toBeInstanceOf(Date);
        expect(await repo.count()).toBe(4);

        const found = await repo.findById(first.id);
        expect(found).toMatchObject({ id: first.id, message: 'first' });
        expect(found?.dueAt).toBeInstanceOf(Date);
        expect(found?.dueAt.getTime()).toBe(base + 60_000);
        expect(await repo.findById(9999)).toBeNull();

        // findByUser: scoped by platform (and guild when given), soonest first.
        expect(
            (await repo.findByUser('discord', 'u1')).map((r) => r.id)
        ).toEqual([third.id, first.id]);
        expect(
            (await repo.findByUser('discord', 'u1', 'g1')).map((r) => r.id)
        ).toEqual([first.id]);
        expect(
            (await repo.findByUser('fluxer', 'u1')).map((r) => r.id)
        ).toEqual([second.id]);
        expect(await repo.findByUser('fluxer', 'u1', 'g1')).toEqual([]);
        expect(await repo.countByUser('discord', 'u1')).toBe(2);
        expect(await repo.countByUser('fluxer', 'u1')).toBe(1);
        expect(await repo.countByUser('discord', 'nobody')).toBe(0);

        // findByChannel: every user's reminders in the channel.
        expect(
            (await repo.findByChannel('discord', 'c1')).map((r) => r.id)
        ).toEqual([first.id, other.id]);
        expect(await repo.findByChannel('fluxer', 'c1')).toEqual([]);

        // findDue: dueAt <= before, soonest first, limited.
        expect((await repo.findDue(new Date(base))).map((r) => r.id)).toEqual([
            second.id,
            third.id,
        ]);
        expect(
            (await repo.findDue(new Date(base), 1)).map((r) => r.id)
        ).toEqual([second.id]);
        expect(
            (await repo.findDue(new Date(base - 1000))).map((r) => r.id)
        ).toEqual([second.id, third.id]);
        expect(
            (await repo.findDue(new Date(base - 1001))).map((r) => r.id)
        ).toEqual([second.id]);
        expect(
            (await repo.findDue(new Date(base + 120_000))).map((r) => r.id)
        ).toEqual([second.id, third.id, first.id, other.id]);

        // incrementAttempts only touches that row.
        await repo.incrementAttempts(second.id);
        await repo.incrementAttempts(second.id);
        expect((await repo.findById(second.id))?.attempts).toBe(2);
        expect((await repo.findById(first.id))?.attempts).toBe(0);

        // deleteById reports whether something was removed.
        expect(await repo.deleteById(third.id)).toBe(true);
        expect(await repo.deleteById(third.id)).toBe(false);
        expect(await repo.findById(third.id)).toBeNull();
        expect(await repo.count()).toBe(3);

        // deleteByUser is scoped by platform and user.
        expect(await repo.deleteByUser('fluxer', 'u2')).toBe(0);
        expect(await repo.deleteByUser('discord', 'u1')).toBe(1);
        expect(await repo.findByUser('discord', 'u1')).toEqual([]);
        expect(await repo.findById(second.id)).toMatchObject({
            platform: 'fluxer',
        });
        expect(await repo.findById(other.id)).toMatchObject({ userId: 'u2' });
        expect(await repo.count()).toBe(2);

        // Roll back: the table is gone and nothing else was touched.
        await umzug.down({ to: '00009-reminders.js' });
        expect(await executed()).toEqual([
            '00001-baseline.js',
            '00002-add-channel-link-indexes.js',
            '00003-add-thread-links.js',
            '00004-location-links.js',
            '00005-category-links.js',
            '00006-voice-links.js',
            '00007-message-link-authors.js',
            '00008-user-links.js',
        ]);
        expect(await qi.tableExists('reminders')).toBe(false);
        expect(await qi.tableExists('user_links')).toBe(true);
        expect(await qi.tableExists('message_links')).toBe(true);

        await umzug.up();
        expect(await executed()).toContain('00009-reminders.js');
        expect(await qi.tableExists('reminders')).toBe(true);
        expect(await repo.count()).toBe(0);
    });
});

describe('migration 00010-history-messages', () => {
    const EXECUTED_THROUGH_00009 = [
        '00001-baseline.js',
        '00002-add-channel-link-indexes.js',
        '00003-add-thread-links.js',
        '00004-location-links.js',
        '00005-category-links.js',
        '00006-voice-links.js',
        '00007-message-link-authors.js',
        '00008-user-links.js',
        '00009-reminders.js',
    ];

    it('adds history_messages with its indexes, works with the repository, and rolls back cleanly', async () => {
        // Start from a deployment that ran 00009: links exist, no history yet.
        await umzug.down({ to: '00010-history-messages.js' });
        expect(await executed()).toEqual(EXECUTED_THROUGH_00009);
        expect(await qi.tableExists('history_messages')).toBe(false);
        await qi.bulkInsert('guild_links', [
            {
                id: 'g-hist',
                discordGuildId: 'dg-hist',
                fluxerGuildId: 'fg-hist',
                createdAt: now,
            },
        ]);
        await qi.bulkInsert('channel_links', [
            {
                id: 'c-hist',
                guildLinkId: 'g-hist',
                discordChannelId: 'dc-hist',
                fluxerChannelId: 'fc-hist',
                discordWebhookId: 'dw-hist',
                discordWebhookToken: 't',
                fluxerWebhookId: 'fw-hist',
                fluxerWebhookToken: 't',
                linkId: 'hist1',
                autoSyncThreads: false,
                createdAt: now,
            },
        ]);

        await umzug.up({ to: '00010-history-messages.js' });
        expect(await executed()).toEqual([
            ...EXECUTED_THROUGH_00009,
            '00010-history-messages.js',
        ]);
        expect(await qi.tableExists('history_messages')).toBe(true);

        const cols = await qi.describeTable('history_messages');
        expect(cols.id).toMatchObject({ primaryKey: true });
        expect(cols.guildLinkId).toMatchObject({ allowNull: false });
        expect(cols.channelLinkId).toMatchObject({ allowNull: false });
        expect(cols.sourcePlatform).toMatchObject({ allowNull: false });
        expect(cols.sourceMessageId).toMatchObject({ allowNull: false });
        expect(cols.targetMessageId).toMatchObject({ allowNull: false });
        expect(cols.createdAt).toMatchObject({ allowNull: false });

        const indexes = await showIndexes('history_messages');
        const byName = (name: string) => indexes.find((i) => i.name === name);
        expect(byName('history_messages_source')).toMatchObject({
            unique: true,
            fields: [
                { attribute: 'sourcePlatform' },
                { attribute: 'sourceMessageId' },
            ],
        });
        expect(byName('history_messages_channel_link')).toMatchObject({
            unique: false,
            fields: [{ attribute: 'channelLinkId' }],
        });
        expect(byName('history_messages_guild_link')).toMatchObject({
            unique: false,
            fields: [{ attribute: 'guildLinkId' }],
        });
        expect(byName('history_messages_target')).toMatchObject({
            unique: false,
            fields: [{ attribute: 'targetMessageId' }],
        });

        // The repository works against the new schema.
        const repo = new SequelizeHistoryMessageRepository();
        expect(await repo.count()).toBe(0);
        await repo.createMany([]);
        expect(await repo.count()).toBe(0);

        // Digest mode: several source messages share one target message.
        const digest = { guildLinkId: 'g-hist', channelLinkId: 'c-hist' };
        await repo.createMany([
            {
                ...digest,
                sourcePlatform: 'discord',
                sourceMessageId: 'dm-h1',
                targetMessageId: 'fm-digest',
            },
            {
                ...digest,
                sourcePlatform: 'discord',
                sourceMessageId: 'dm-h2',
                targetMessageId: 'fm-digest',
            },
        ]);
        expect(await repo.count()).toBe(2);

        // Re-running the transfer: the already recorded row is ignored, the
        // new ones are added, and nothing throws.
        await repo.createMany([
            {
                ...digest,
                sourcePlatform: 'discord',
                sourceMessageId: 'dm-h2',
                targetMessageId: 'fm-digest-again',
            },
            {
                ...digest,
                sourcePlatform: 'discord',
                sourceMessageId: 'dm-h3',
                targetMessageId: 'fm-h3',
            },
            {
                guildLinkId: 'g1',
                channelLinkId: 'c1',
                sourcePlatform: 'fluxer',
                sourceMessageId: 'fm-h1',
                targetMessageId: 'dm-h1',
            },
        ]);
        expect(await repo.count()).toBe(4);
        const [kept] = await select<{ targetMessageId: string }>(
            "SELECT targetMessageId FROM history_messages WHERE sourceMessageId = 'dm-h2'"
        );
        expect(kept.targetMessageId).toBe('fm-digest');
        const created = await select<{ createdAt: string | Date }>(
            'SELECT createdAt FROM history_messages'
        );
        expect(created.every((r) => r.createdAt)).toBe(true);

        // findTransferredIds: only recorded ids, scoped by platform.
        expect(
            await repo.findTransferredIds('discord', [
                'dm-h1',
                'dm-h2',
                'dm-h3',
                'dm-new',
            ])
        ).toEqual(new Set(['dm-h1', 'dm-h2', 'dm-h3']));
        // The same id on the other platform is a different message.
        expect(await repo.findTransferredIds('fluxer', ['dm-h1'])).toEqual(
            new Set()
        );
        expect(await repo.findTransferredIds('fluxer', ['fm-h1'])).toEqual(
            new Set(['fm-h1'])
        );
        expect(await repo.findTransferredIds('discord', [])).toEqual(new Set());
        // Long lists are chunked into several IN queries.
        const many = Array.from({ length: 1203 }, (_, i) => `dm-bulk-${i}`);
        expect(
            await repo.findTransferredIds('discord', [...many, 'dm-h3'])
        ).toEqual(new Set(['dm-h3']));

        // Deleting by channel link leaves other channels alone.
        await repo.deleteByChannelLinkId('c-hist');
        expect(await repo.count()).toBe(1);
        expect(await repo.findTransferredIds('discord', ['dm-h1'])).toEqual(
            new Set()
        );
        expect(await repo.findTransferredIds('fluxer', ['fm-h1'])).toEqual(
            new Set(['fm-h1'])
        );
        await repo.deleteByChannelLinkId('c-hist');
        expect(await repo.count()).toBe(1);

        // Deleting by guild link.
        await repo.deleteByGuildLinkId('g-hist');
        expect(await repo.count()).toBe(1);
        await repo.deleteByGuildLinkId('g1');
        expect(await repo.count()).toBe(0);

        // Roll back: the table is gone and nothing else was touched.
        await repo.createMany([
            {
                ...digest,
                sourcePlatform: 'discord',
                sourceMessageId: 'dm-h4',
                targetMessageId: 'fm-h4',
            },
        ]);
        await umzug.down({ to: '00010-history-messages.js' });
        expect(await executed()).toEqual(EXECUTED_THROUGH_00009);
        expect(await qi.tableExists('history_messages')).toBe(false);
        expect(await qi.tableExists('reminders')).toBe(true);
        expect(await qi.tableExists('message_links')).toBe(true);
        expect(
            (
                await select<{ id: string }>(
                    "SELECT id FROM channel_links WHERE id = 'c-hist'"
                )
            ).length
        ).toBe(1);

        await umzug.up();
        expect(await executed()).toContain('00010-history-messages.js');
        expect(await qi.tableExists('history_messages')).toBe(true);
        expect(await repo.count()).toBe(0);
    });
});

describe('migration 00011-claude-requests', () => {
    it('adds claude_requests with its index, works with the repository, and rolls back cleanly', async () => {
        await umzug.up();
        expect(await executed()).toContain('00011-claude-requests.js');
        expect(await qi.tableExists('claude_requests')).toBe(true);

        const cols = await qi.describeTable('claude_requests');
        expect(cols.id).toMatchObject({ primaryKey: true, type: 'INTEGER' });
        expect(cols.platform).toMatchObject({ allowNull: false });
        expect(cols.issueNumber).toMatchObject({
            allowNull: false,
            type: 'INTEGER',
        });
        expect(cols.issueUrl).toMatchObject({ allowNull: false });
        expect(cols.title).toMatchObject({ allowNull: false });
        expect(cols.userId).toMatchObject({ allowNull: false });
        expect(cols.guildId).toMatchObject({ allowNull: false });
        expect(cols.channelId).toMatchObject({ allowNull: false });
        expect(cols.messageId).toMatchObject({ allowNull: true });
        expect(cols.attempts).toMatchObject({ allowNull: false });
        expect(Number(cols.attempts.defaultValue)).toBe(0);
        expect(cols.createdAt).toMatchObject({ allowNull: false });

        const indexes = await showIndexes('claude_requests');
        expect(
            indexes.find((i) => i.name === 'claude_requests_issue_number')
        ).toMatchObject({
            unique: false,
            fields: [{ attribute: 'issueNumber' }],
        });

        const repo = new SequelizeClaudeRequestRepository();
        expect(await repo.count()).toBe(0);
        const base = {
            issueUrl: 'https://github.com/o/r/issues/26',
            title: 'Notify on completion',
            guildId: 'g1',
            channelId: 'c1',
        };
        const first = await repo.create({
            ...base,
            platform: 'discord',
            issueNumber: 26,
            userId: 'u1',
            messageId: 'm1',
        });
        // The same issue may be tracked twice (no unique index).
        const second = await repo.create({
            ...base,
            platform: 'fluxer',
            issueNumber: 26,
            userId: 'u2',
            messageId: null,
        });
        const third = await repo.create({
            ...base,
            platform: 'discord',
            issueNumber: 27,
            userId: 'u1',
            messageId: 'm3',
        });
        expect(first.id).toBe(1);
        expect(second.id).toBe(first.id + 1);
        expect(third.id).toBe(second.id + 1);
        expect(first).toMatchObject({
            platform: 'discord',
            issueNumber: 26,
            userId: 'u1',
            messageId: 'm1',
            attempts: 0,
        });
        expect(second.messageId).toBeNull();
        expect(first.createdAt).toBeInstanceOf(Date);

        // findAll: oldest first, optionally limited.
        expect((await repo.findAll()).map((r) => r.id)).toEqual([
            first.id,
            second.id,
            third.id,
        ]);
        expect((await repo.findAll(2)).map((r) => r.id)).toEqual([
            first.id,
            second.id,
        ]);
        expect((await repo.findById(second.id))?.messageId).toBeNull();
        expect(await repo.findById(9999)).toBeNull();

        await repo.incrementAttempts(third.id);
        await repo.incrementAttempts(third.id);
        expect((await repo.findById(third.id))?.attempts).toBe(2);
        expect((await repo.findById(first.id))?.attempts).toBe(0);

        expect(await repo.deleteById(first.id)).toBe(true);
        expect(await repo.deleteById(first.id)).toBe(false);
        expect(await repo.count()).toBe(2);

        // Roll back: the table is gone and nothing else was touched.
        await umzug.down({ to: '00011-claude-requests.js' });
        expect(await executed()).not.toContain('00011-claude-requests.js');
        expect(await executed()).toContain('00010-history-messages.js');
        expect(await qi.tableExists('claude_requests')).toBe(false);
        expect(await qi.tableExists('history_messages')).toBe(true);
        expect(await qi.tableExists('reminders')).toBe(true);

        await umzug.up();
        expect(await executed()).toContain('00011-claude-requests.js');
        expect(await repo.count()).toBe(0);
    });
});

describe('migration 00012-user-timezones', () => {
    it('adds user_timezones, works with the repository, and rolls back cleanly', async () => {
        await umzug.up();
        expect(await executed()).toContain('00012-user-timezones.js');
        expect(await qi.tableExists('user_timezones')).toBe(true);

        const cols = await qi.describeTable('user_timezones');
        expect(cols.platform).toMatchObject({
            allowNull: false,
            primaryKey: true,
        });
        expect(cols.userId).toMatchObject({
            allowNull: false,
            primaryKey: true,
        });
        expect(cols.timeZone).toMatchObject({ allowNull: false });
        expect(cols.createdAt).toMatchObject({ allowNull: false });
        expect(cols.updatedAt).toMatchObject({ allowNull: false });

        const repo = new SequelizeUserTimezoneRepository();
        expect(await repo.get('discord', 'u1')).toBeNull();

        await repo.set('discord', 'u1', 'America/New_York');
        await repo.set('fluxer', 'u1', 'UTC+05:30');
        expect(await repo.get('discord', 'u1')).toBe('America/New_York');
        expect(await repo.get('fluxer', 'u1')).toBe('UTC+05:30');
        expect(await repo.get('discord', 'u2')).toBeNull();

        // set replaces rather than duplicating.
        await repo.set('discord', 'u1', 'Europe/Berlin');
        expect(await repo.get('discord', 'u1')).toBe('Europe/Berlin');
        expect(await repo.get('fluxer', 'u1')).toBe('UTC+05:30');
        const rows = await select<{ userId: string }>(
            'SELECT userId FROM user_timezones'
        );
        expect(rows).toHaveLength(2);

        expect(await repo.delete('discord', 'u1')).toBe(true);
        expect(await repo.delete('discord', 'u1')).toBe(false);
        expect(await repo.get('discord', 'u1')).toBeNull();
        expect(await repo.get('fluxer', 'u1')).toBe('UTC+05:30');

        // Roll back: the table is gone and nothing else was touched.
        await umzug.down({ to: '00012-user-timezones.js' });
        expect(await executed()).not.toContain('00012-user-timezones.js');
        expect(await executed()).toContain('00011-claude-requests.js');
        expect(await qi.tableExists('user_timezones')).toBe(false);
        expect(await qi.tableExists('claude_requests')).toBe(true);

        await umzug.up();
        expect(await executed()).toContain('00012-user-timezones.js');
        expect(await repo.get('fluxer', 'u1')).toBeNull();
    });
});

describe('migration 00013-claude-request-notices', () => {
    it('adds claude_request_notices with its indexes, works with the repository, and rolls back cleanly', async () => {
        await umzug.up();
        expect(await executed()).toContain('00013-claude-request-notices.js');
        expect(await qi.tableExists('claude_request_notices')).toBe(true);

        const cols = await qi.describeTable('claude_request_notices');
        expect(cols.id).toMatchObject({ primaryKey: true, type: 'INTEGER' });
        expect(cols.platform).toMatchObject({ allowNull: false });
        expect(cols.issueNumber).toMatchObject({
            allowNull: false,
            type: 'INTEGER',
        });
        expect(cols.issueUrl).toMatchObject({ allowNull: false });
        expect(cols.title).toMatchObject({ allowNull: false });
        expect(cols.userId).toMatchObject({ allowNull: false });
        expect(cols.guildId).toMatchObject({ allowNull: false });
        expect(cols.channelId).toMatchObject({ allowNull: false });
        expect(cols.noticeMessageId).toMatchObject({ allowNull: false });
        expect(cols.createdAt).toMatchObject({ allowNull: false });

        const indexes = await showIndexes('claude_request_notices');
        expect(
            indexes.find(
                (i) =>
                    i.name ===
                    'claude_request_notices_platform_notice_message_id'
            )
        ).toMatchObject({
            unique: true,
            fields: [
                { attribute: 'platform' },
                { attribute: 'noticeMessageId' },
            ],
        });
        expect(
            indexes.find((i) => i.name === 'claude_request_notices_created_at')
        ).toMatchObject({
            unique: false,
            fields: [{ attribute: 'createdAt' }],
        });

        const repo = new SequelizeClaudeRequestNoticeRepository();
        const base = {
            issueNumber: 35,
            issueUrl: 'https://github.com/o/r/issues/35',
            title: 'Reply to reopen',
            userId: 'u1',
            guildId: 'g1',
            channelId: 'c1',
        };
        const first = await repo.create({
            ...base,
            platform: 'discord',
            noticeMessageId: 'n1',
        });
        // The same message ID on the other platform is a different notice.
        const second = await repo.create({
            ...base,
            platform: 'fluxer',
            noticeMessageId: 'n1',
        });
        expect(second.id).toBe(first.id + 1);
        expect(first).toMatchObject({ ...base, platform: 'discord' });
        expect(first.createdAt).toBeInstanceOf(Date);
        await expect(
            repo.create({ ...base, platform: 'discord', noticeMessageId: 'n1' })
        ).rejects.toThrow();

        expect(await repo.findByNoticeMessage('discord', 'n1')).toMatchObject({
            id: first.id,
            issueNumber: 35,
            noticeMessageId: 'n1',
        });
        expect((await repo.findByNoticeMessage('fluxer', 'n1'))?.id).toBe(
            second.id
        );
        expect(await repo.findByNoticeMessage('discord', 'n2')).toBeNull();

        // deleteOlderThan removes only rows created before the cutoff.
        await sequelize.query(
            "UPDATE claude_request_notices SET createdAt = '2020-01-01 00:00:00.000 +00:00' WHERE id = ?",
            { replacements: [first.id] }
        );
        expect(await repo.deleteOlderThan(new Date('2021-01-01'))).toBe(1);
        expect(await repo.findByNoticeMessage('discord', 'n1')).toBeNull();
        expect(await repo.findByNoticeMessage('fluxer', 'n1')).not.toBeNull();
        expect(await repo.deleteOlderThan(new Date('2021-01-01'))).toBe(0);

        // Roll back: the table is gone and nothing else was touched.
        await umzug.down({ to: '00013-claude-request-notices.js' });
        expect(await executed()).not.toContain(
            '00013-claude-request-notices.js'
        );
        expect(await executed()).toContain('00012-user-timezones.js');
        expect(await qi.tableExists('claude_request_notices')).toBe(false);
        expect(await qi.tableExists('claude_requests')).toBe(true);

        await umzug.up();
        expect(await executed()).toContain('00013-claude-request-notices.js');
        expect(await repo.findByNoticeMessage('fluxer', 'n1')).toBeNull();
    });
});
