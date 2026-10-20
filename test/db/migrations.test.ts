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
import { MessageLinkModel } from '../../src/db/models';
import { SequelizeCategoryLinkRepository } from '../../src/db/sequelizerepos/SequelizeCategoryLinkRepository';
import { SequelizeChannelLinkRepository } from '../../src/db/sequelizerepos/SequelizeChannelLinkRepository';
import { SequelizeMessageLinkRepository } from '../../src/db/sequelizerepos/SequelizeMessageLinkRepository';
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
        expect(
            (
                await new SequelizeChannelLinkRepository().findByDiscordLocation(
                    'dt0'
                )
            )?.fluxerThreadId
        ).toBe('ft0');
        expect(await qi.tableExists('category_links')).toBe(true);
        expect(await qi.tableExists('voice_links')).toBe(true);
    });
});
