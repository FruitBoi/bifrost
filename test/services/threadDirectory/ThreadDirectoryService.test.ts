import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ThreadDirectoryService, {
    DEFAULT_DIRECTORY_TITLE,
    DIRECTORY_DESCRIPTION_MAX,
    DIRECTORY_TITLE_MAX,
    DirectoryRender,
    DirectoryThread,
    EMPTY_DIRECTORY_LINE,
    renderDirectory,
    ThreadDirectoryError,
    ThreadDirectoryPlatformAdapter,
} from '../../../src/services/threadDirectory/ThreadDirectoryService';
import {
    ThreadDirectory,
    ThreadDirectoryEntry,
    ThreadDirectoryPlatform,
} from '../../../src/db/entities/ThreadDirectory';
import {
    SaveThreadDirectoryData,
    SaveThreadDirectoryEntryData,
    ThreadDirectoryRepository,
} from '../../../src/db/repositories/ThreadDirectoryRepository';
import {
    EMBED_TOTAL_CHARS_MAX,
    EMBEDS_PER_MESSAGE_MAX,
} from '../../../src/utils/embeds';

vi.mock('../../../src/utils/logging/logger', () => ({
    default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const GUILD = 'guild-1';
const CHANNEL = '100';

class FakeRepo implements ThreadDirectoryRepository {
    directories = new Map<string, ThreadDirectory>();
    entries = new Map<string, ThreadDirectoryEntry>();
    private nextId = 1;

    async findDirectory(platform: ThreadDirectoryPlatform, channelId: string) {
        return this.directories.get(`${platform}:${channelId}`) ?? null;
    }

    async saveDirectory(data: SaveThreadDirectoryData) {
        const key = `${data.platform}:${data.channelId}`;
        const existing = this.directories.get(key);
        const now = new Date();
        const row: ThreadDirectory = {
            id: existing?.id ?? this.nextId++,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
            ...data,
        };
        this.directories.set(key, row);
        return row;
    }

    async deleteDirectory(
        platform: ThreadDirectoryPlatform,
        channelId: string
    ) {
        return this.directories.delete(`${platform}:${channelId}`);
    }

    async listEntries(platform: ThreadDirectoryPlatform, channelId: string) {
        return [...this.entries.values()].filter(
            (e) => e.platform === platform && e.channelId === channelId
        );
    }

    async saveEntry(data: SaveThreadDirectoryEntryData) {
        const key = `${data.platform}:${data.threadId}`;
        const existing = this.entries.get(key);
        const now = new Date();
        const row: ThreadDirectoryEntry = {
            id: existing?.id ?? this.nextId++,
            platform: data.platform,
            channelId: data.channelId,
            threadId: data.threadId,
            description:
                data.description !== undefined
                    ? data.description
                    : (existing?.description ?? null),
            hidden: data.hidden ?? existing?.hidden ?? false,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
        };
        this.entries.set(key, row);
        return row;
    }

    async deleteEntry(platform: ThreadDirectoryPlatform, threadId: string) {
        this.entries.delete(`${platform}:${threadId}`);
    }
}

class FakeAdapter implements ThreadDirectoryPlatformAdapter {
    readonly platform = 'discord' as const;
    threads: DirectoryThread[] = [];
    /** Live messages by ID. */
    messages = new Map<string, DirectoryRender>();
    private nextMessage = 1;

    listThreads = vi.fn(
        async (): Promise<DirectoryThread[]> => [...this.threads]
    );
    sendDirectory = vi.fn(async (_c: string, render: DirectoryRender) => {
        const id = `msg-${this.nextMessage++}`;
        this.messages.set(id, render);
        return id;
    });
    editDirectory = vi.fn(
        async (_c: string, messageId: string, render: DirectoryRender) => {
            if (!this.messages.has(messageId)) return false;
            this.messages.set(messageId, render);
            return true;
        }
    );
    deleteDirectory = vi.fn(async (_c: string, messageId: string) => {
        this.messages.delete(messageId);
    });
    messageUrl(guildId: string, channelId: string, messageId: string) {
        return `https://example/${guildId}/${channelId}/${messageId}`;
    }
}

function setup(debounceMs = 1000) {
    const repo = new FakeRepo();
    const adapter = new FakeAdapter();
    const service = new ThreadDirectoryService(repo, {
        refreshDebounceMs: debounceMs,
    });
    service.registerAdapter(adapter);
    return { repo, adapter, service };
}

async function expectReason(promise: Promise<unknown>, reason: string) {
    await expect(promise).rejects.toBeInstanceOf(ThreadDirectoryError);
    await expect(promise).rejects.toMatchObject({ reason });
}

describe('renderDirectory', () => {
    it('sorts by snowflake, omits hidden threads and appends descriptions', () => {
        const render = renderDirectory(
            'Threads Directory',
            [
                { id: '1000', name: 'later' },
                { id: '999', name: 'earlier' },
                { id: '5000', name: 'hidden' },
            ],
            [
                {
                    threadId: '999',
                    description: 'Computer\nTech',
                    hidden: false,
                },
                { threadId: '5000', description: 'nope', hidden: true },
            ]
        );

        expect(render).toEqual({
            title: 'Threads Directory',
            descriptions: ['<#999> — Computer Tech\n<#1000>'],
        });
    });

    it('shows a placeholder when there are no visible threads', () => {
        expect(renderDirectory('T', [], []).descriptions).toEqual([
            EMPTY_DIRECTORY_LINE,
        ]);
        expect(
            renderDirectory(
                'T',
                [{ id: '1', name: 'a' }],
                [{ threadId: '1', description: null, hidden: true }]
            ).descriptions
        ).toEqual([EMPTY_DIRECTORY_LINE]);
    });

    it('drops trailing lines with "…and N more" when the list overflows one message', () => {
        const threads = Array.from({ length: 200 }, (_, i) => ({
            id: String(1_000_000_000_000_000_000n + BigInt(i)),
            name: `t${i}`,
        }));
        const entries = threads.map((t) => ({
            threadId: t.id,
            description: 'x'.repeat(100),
            hidden: false,
        }));

        const render = renderDirectory('Title', threads, entries);
        const total =
            render.title.length +
            render.descriptions.reduce((sum, d) => sum + d.length, 0);
        const lines = render.descriptions.join('\n').split('\n');
        const last = lines[lines.length - 1];
        const shown = lines.length - 1;

        expect(total).toBeLessThanOrEqual(EMBED_TOTAL_CHARS_MAX);
        expect(render.descriptions.length).toBeLessThanOrEqual(
            EMBEDS_PER_MESSAGE_MAX
        );
        expect(last).toBe(`…and ${200 - shown} more`);
        expect(lines[0]).toContain(`<#${threads[0].id}>`);
        // 126 chars per line: about 47 fit in 6000, so the space is used.
        expect(shown).toBeGreaterThanOrEqual(45);
    });
});

describe('ThreadDirectoryService', () => {
    beforeEach(() => {
        vi.useRealTimers();
    });

    it('posts a directory with the default title', async () => {
        const { repo, adapter, service } = setup();
        adapter.threads = [{ id: '200', name: 'Cars 2' }];

        const directory = await service.post('discord', GUILD, CHANNEL);

        expect(directory).toMatchObject({
            channelId: CHANNEL,
            guildId: GUILD,
            title: DEFAULT_DIRECTORY_TITLE,
            messageId: 'msg-1',
        });
        expect(adapter.messages.get('msg-1')?.descriptions).toEqual(['<#200>']);
        expect(await repo.findDirectory('discord', CHANNEL)).toEqual(directory);
        expect(service.messageUrl(directory)).toBe(
            `https://example/${GUILD}/${CHANNEL}/msg-1`
        );
    });

    it('replaces the previous message and keeps its title', async () => {
        const { adapter, service } = setup();
        await service.post('discord', GUILD, CHANNEL, 'My Threads');

        const second = await service.post('discord', GUILD, CHANNEL, '   ');

        expect(second.title).toBe('My Threads');
        expect(second.messageId).toBe('msg-2');
        expect(adapter.deleteDirectory).toHaveBeenCalledWith(CHANNEL, 'msg-1');
        expect([...adapter.messages.keys()]).toEqual(['msg-2']);
    });

    it('still posts when deleting the old message fails', async () => {
        const { adapter, service } = setup();
        await service.post('discord', GUILD, CHANNEL);
        adapter.deleteDirectory.mockRejectedValueOnce(new Error('nope'));

        await expect(
            service.post('discord', GUILD, CHANNEL)
        ).resolves.toMatchObject({ messageId: 'msg-2' });
    });

    it('rejects overly long titles', async () => {
        const { service } = setup();
        await expectReason(
            service.post(
                'discord',
                GUILD,
                CHANNEL,
                'x'.repeat(DIRECTORY_TITLE_MAX + 1)
            ),
            'too_long'
        );
    });

    it('reports unavailable platforms', async () => {
        const { service } = setup();
        await expectReason(
            service.post('fluxer', GUILD, CHANNEL),
            'unavailable'
        );
    });

    it('refresh fails with no_directory or message_missing (keeping the row)', async () => {
        const { repo, adapter, service } = setup();
        await expectReason(service.refresh('discord', CHANNEL), 'no_directory');

        await service.post('discord', GUILD, CHANNEL);
        adapter.messages.clear();
        await expectReason(
            service.refresh('discord', CHANNEL),
            'message_missing'
        );
        expect(await repo.findDirectory('discord', CHANNEL)).not.toBeNull();
    });

    it('sets, clears and validates descriptions', async () => {
        const { repo, adapter, service } = setup();
        adapter.threads = [{ id: '200', name: 'Data Mine' }];
        await service.post('discord', GUILD, CHANNEL);

        await service.setDescription(
            'discord',
            GUILD,
            CHANNEL,
            '200',
            '  Computer Tech '
        );
        expect(adapter.messages.get('msg-1')?.descriptions).toEqual([
            '<#200> — Computer Tech',
        ]);

        await service.setDescription('discord', GUILD, CHANNEL, '200', '  ');
        expect(
            (await repo.listEntries('discord', CHANNEL))[0].description
        ).toBeNull();
        expect(adapter.messages.get('msg-1')?.descriptions).toEqual(['<#200>']);

        await expectReason(
            service.setDescription('discord', GUILD, CHANNEL, '999', 'x'),
            'unknown_thread'
        );
        await expectReason(
            service.setDescription(
                'discord',
                GUILD,
                CHANNEL,
                '200',
                'x'.repeat(DIRECTORY_DESCRIPTION_MAX + 1)
            ),
            'too_long'
        );
    });

    it('saves descriptions without a directory and propagates message_missing', async () => {
        const { repo, adapter, service } = setup();
        adapter.threads = [{ id: '200', name: 'a' }];

        await service.setDescription('discord', GUILD, CHANNEL, '200', 'd');
        expect(adapter.editDirectory).not.toHaveBeenCalled();
        expect(await repo.listEntries('discord', CHANNEL)).toHaveLength(1);

        await service.post('discord', GUILD, CHANNEL);
        adapter.messages.clear();
        await expectReason(
            service.setHidden('discord', GUILD, CHANNEL, '200', true),
            'message_missing'
        );
        expect((await repo.listEntries('discord', CHANNEL))[0].hidden).toBe(
            true
        );
    });

    it('hides threads and renames the directory', async () => {
        const { adapter, service } = setup();
        adapter.threads = [
            { id: '200', name: 'a' },
            { id: '300', name: 'b' },
        ];
        await expectReason(
            service.setTitle('discord', CHANNEL, 'New'),
            'no_directory'
        );
        await service.post('discord', GUILD, CHANNEL);

        await service.setHidden('discord', GUILD, CHANNEL, '200', true);
        const renamed = await service.setTitle('discord', CHANNEL, 'New');

        expect(renamed.title).toBe('New');
        expect(adapter.messages.get('msg-1')).toEqual({
            title: 'New',
            descriptions: ['<#300>'],
        });

        const status = await service.getStatus('discord', GUILD, CHANNEL);
        expect(status.directory?.title).toBe('New');
        expect(status.threads).toEqual([
            { id: '200', name: 'a', description: null, hidden: true },
            { id: '300', name: 'b', description: null, hidden: false },
        ]);
    });

    it('removes the directory but keeps descriptions', async () => {
        const { repo, adapter, service } = setup();
        adapter.threads = [{ id: '200', name: 'a' }];
        await service.post('discord', GUILD, CHANNEL);
        await service.setDescription('discord', GUILD, CHANNEL, '200', 'd');
        adapter.deleteDirectory.mockRejectedValueOnce(new Error('perm'));

        expect(await service.remove('discord', CHANNEL)).toBe(true);
        expect(await repo.findDirectory('discord', CHANNEL)).toBeNull();
        expect(await repo.listEntries('discord', CHANNEL)).toHaveLength(1);
        expect(await service.remove('discord', CHANNEL)).toBe(false);
    });

    describe('thread events', () => {
        afterEach(() => {
            vi.useRealTimers();
        });

        it('coalesces a burst of thread events into one edit', async () => {
            const { adapter, service } = setup(1000);
            await service.post('discord', GUILD, CHANNEL);
            vi.useFakeTimers();

            adapter.threads = [{ id: '200', name: 'a' }];
            service.handleThreadCreated('discord', CHANNEL);
            await vi.advanceTimersByTimeAsync(500);
            adapter.threads.push({ id: '300', name: 'b' });
            service.handleThreadCreated('discord', CHANNEL);
            service.handleThreadCreated('discord', null);
            service.handleThreadCreated('discord', undefined);
            await vi.advanceTimersByTimeAsync(999);
            expect(adapter.editDirectory).not.toHaveBeenCalled();

            await vi.advanceTimersByTimeAsync(1);
            expect(adapter.editDirectory).toHaveBeenCalledTimes(1);
            expect(adapter.messages.get('msg-1')?.descriptions).toEqual([
                '<#200>\n<#300>',
            ]);
        });

        it('does nothing without a directory and never throws', async () => {
            const { adapter, service } = setup(10);
            vi.useFakeTimers();

            service.handleThreadCreated('discord', CHANNEL);
            service.handleThreadCreated('fluxer', CHANNEL);
            await vi.advanceTimersByTimeAsync(10);
            expect(adapter.listThreads).not.toHaveBeenCalled();

            vi.useRealTimers();
            await service.post('discord', GUILD, CHANNEL);
            adapter.messages.clear();
            vi.useFakeTimers();
            service.handleThreadCreated('discord', CHANNEL);
            await vi.advanceTimersByTimeAsync(10);
            expect(adapter.editDirectory).toHaveBeenCalledTimes(1);
        });

        it('forgets deleted threads and refreshes the parent', async () => {
            const { repo, adapter, service } = setup(10);
            adapter.threads = [
                { id: '200', name: 'a' },
                { id: '300', name: 'b' },
            ];
            await service.post('discord', GUILD, CHANNEL);
            await service.setDescription('discord', GUILD, CHANNEL, '200', 'd');
            vi.useFakeTimers();

            adapter.threads = [{ id: '300', name: 'b' }];
            service.handleThreadDeleted('discord', CHANNEL, '200');
            await vi.advanceTimersByTimeAsync(10);

            expect(await repo.listEntries('discord', CHANNEL)).toEqual([]);
            expect(adapter.messages.get('msg-1')?.descriptions).toEqual([
                '<#300>',
            ]);
        });
    });

    it('serialises operations on one channel', async () => {
        const { adapter, service } = setup();
        let release!: () => void;
        adapter.sendDirectory.mockImplementationOnce(
            () =>
                new Promise<string>((resolve) => {
                    release = () => resolve('slow');
                    adapter.messages.set('slow', {
                        title: '',
                        descriptions: [],
                    });
                })
        );

        const posting = service.post('discord', GUILD, CHANNEL);
        const refreshing = service.refresh('discord', CHANNEL);
        await new Promise((r) => setTimeout(r, 0));
        release();

        await posting;
        await expect(refreshing).resolves.toMatchObject({ messageId: 'slow' });
    });
});
