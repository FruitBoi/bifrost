import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ThreadDirectoryService, {
    DEFAULT_DIRECTORY_TITLE,
    DIRECTORY_DESCRIPTION_MAX,
    DIRECTORY_MESSAGES_MAX,
    DIRECTORY_TITLE_MAX,
    DirectoryChannel,
    directoryLine,
    DirectoryPage,
    directoryPages,
    DirectoryRole,
    DirectoryThread,
    EMPTY_DIRECTORY_LINE,
    isUnsafeRole,
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

const GUILD = '900000000000000000';
const CHANNEL = '100';
/** A thread ID long enough for links and mentions. */
const CARS = '300000000000000000';
const OTHER_CHANNEL = '150';

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
            platform: data.platform,
            guildId: data.guildId,
            channelId: data.channelId,
            messageId: data.messageIds[0],
            messageIds: [...data.messageIds],
            title: data.title,
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

    async listRoleEntries(platform: ThreadDirectoryPlatform, guildId: string) {
        return [...this.entries.values()].filter(
            (e) =>
                e.platform === platform &&
                e.guildId === guildId &&
                e.roleId !== null
        );
    }

    async saveEntry(data: SaveThreadDirectoryEntryData) {
        const key = `${data.platform}:${data.channelId}:${data.threadId}`;
        const existing = this.entries.get(key);
        const now = new Date();
        const keep = <T>(value: T | undefined, stored: T): T =>
            value !== undefined ? value : stored;
        const row: ThreadDirectoryEntry = {
            id: existing?.id ?? this.nextId++,
            platform: data.platform,
            channelId: data.channelId,
            threadId: data.threadId,
            guildId: keep(data.guildId, existing?.guildId ?? null),
            description: keep(data.description, existing?.description ?? null),
            hidden: data.hidden ?? existing?.hidden ?? false,
            roleId: keep(data.roleId, existing?.roleId ?? null),
            added: data.added ?? existing?.added ?? false,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
        };
        this.entries.set(key, row);
        return row;
    }

    async deleteEntry(
        platform: ThreadDirectoryPlatform,
        channelId: string,
        threadId: string
    ) {
        return this.entries.delete(`${platform}:${channelId}:${threadId}`);
    }

    async deleteEntriesForThread(
        platform: ThreadDirectoryPlatform,
        threadId: string
    ) {
        const channels: string[] = [];
        for (const [key, e] of this.entries) {
            if (e.platform === platform && e.threadId === threadId) {
                channels.push(e.channelId);
                this.entries.delete(key);
            }
        }
        return channels;
    }
}

class FakeAdapter implements ThreadDirectoryPlatformAdapter {
    readonly platform = 'fluxer' as const;
    /** Native threads by directory channel. */
    threadsByChannel = new Map<string, DirectoryThread[]>();
    /** Every other channel/thread of GUILD. */
    channels = new Map<string, DirectoryChannel>();
    roles: DirectoryRole[] = [];
    memberRoles = new Map<string, Set<string>>();
    messageTexts = new Map<string, string>();
    /** Live messages by ID. */
    messages = new Map<string, DirectoryPage>();
    private nextMessage = 1;

    get threads(): DirectoryThread[] {
        return this.threadsByChannel.get(CHANNEL) ?? [];
    }
    set threads(threads: DirectoryThread[]) {
        this.threadsByChannel.set(CHANNEL, threads);
    }

    listThreads = vi.fn(
        async (_g: string, channelId: string): Promise<DirectoryThread[]> => [
            ...(this.threadsByChannel.get(channelId) ?? []),
        ]
    );
    sendDirectoryMessage = vi.fn(async (_c: string, page: DirectoryPage) => {
        const id = `msg-${this.nextMessage++}`;
        this.messages.set(id, page);
        return id;
    });
    editDirectoryMessage = vi.fn(
        async (_c: string, messageId: string, page: DirectoryPage) => {
            if (!this.messages.has(messageId)) return false;
            this.messages.set(messageId, page);
            return true;
        }
    );
    deleteDirectoryMessage = vi.fn(async (_c: string, messageId: string) => {
        this.messages.delete(messageId);
    });
    messageUrl(guildId: string, channelId: string, messageId: string) {
        return `https://example/${guildId}/${channelId}/${messageId}`;
    }
    resolveChannel = vi.fn(async (guildId: string, id: string) => {
        if (guildId !== GUILD) return null;
        const thread = [...this.threadsByChannel.entries()]
            .flatMap(([parentId, threads]) =>
                threads.map((t) => ({ ...t, parentId }))
            )
            .find((t) => t.id === id);
        return thread ?? this.channels.get(id) ?? null;
    });
    listRoles = vi.fn(async () => [...this.roles]);
    memberRoleIds = vi.fn(async (_g: string, userId: string) => [
        ...(this.memberRoles.get(userId) ?? []),
    ]);
    addMemberRole = vi.fn(
        async (_g: string, userId: string, roleId: string) => {
            const roles = this.memberRoles.get(userId) ?? new Set<string>();
            roles.add(roleId);
            this.memberRoles.set(userId, roles);
        }
    );
    removeMemberRole = vi.fn(
        async (_g: string, userId: string, roleId: string) => {
            this.memberRoles.get(userId)?.delete(roleId);
        }
    );
    fetchMessageText = vi.fn(
        async (channelId: string, messageId: string) =>
            this.messageTexts.get(`${channelId}/${messageId}`) ?? null
    );

    /** Descriptions of a live message. */
    descriptions(messageId: string) {
        return this.messages.get(messageId)?.descriptions;
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

const SAFE_ROLE: DirectoryRole = {
    id: '700000000000000000',
    name: 'Techies',
    managed: false,
    permissions: '0',
};
const OTHER_ROLE: DirectoryRole = {
    id: '701000000000000000',
    name: 'Car People',
    managed: false,
    permissions: BigInt(1) << BigInt(10),
};

/** Snowflake-ish IDs in ascending order. */
function ids(count: number): string[] {
    return Array.from({ length: count }, (_, i) =>
        String(BigInt('1000000000000000000') + BigInt(i))
    );
}

/** Characters one message counts towards the embed total. */
function pageChars(page: string[], title = '') {
    return title.length + page.reduce((sum, d) => sum + d.length, 0);
}

describe('directoryLine', () => {
    it('formats description, thread and role, leaving out absent parts', () => {
        expect(directoryLine('1', 'Computer\nTech', '2')).toBe(
            'Computer Tech: <#1> - <@&2>'
        );
        expect(directoryLine('1', null, '2')).toBe('<#1> - <@&2>');
        expect(directoryLine('1', 'Cars')).toBe('Cars: <#1>');
        expect(directoryLine('1', null, null)).toBe('<#1>');
    });
});

describe('isUnsafeRole', () => {
    it('refuses @everyone, managed and moderator roles', () => {
        expect(isUnsafeRole(SAFE_ROLE, GUILD)).toBe(false);
        expect(isUnsafeRole(OTHER_ROLE, GUILD)).toBe(false);
        expect(isUnsafeRole({ ...SAFE_ROLE, id: GUILD }, GUILD)).toBe(true);
        expect(isUnsafeRole({ ...SAFE_ROLE, managed: true }, GUILD)).toBe(true);
        for (const bit of [1, 2, 3, 4, 5, 13, 28, 40]) {
            expect(
                isUnsafeRole(
                    {
                        ...SAFE_ROLE,
                        permissions: String(BigInt(1) << BigInt(bit)),
                    },
                    GUILD
                )
            ).toBe(true);
        }
        expect(
            isUnsafeRole({ ...SAFE_ROLE, permissions: 'garbage' }, GUILD)
        ).toBe(true);
    });
});

describe('renderDirectory', () => {
    it('sorts by snowflake, omits hidden threads and lists added entries', () => {
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
                    roleId: '7',
                    added: false,
                },
                {
                    threadId: '5000',
                    description: 'nope',
                    hidden: true,
                    roleId: null,
                    added: false,
                },
                {
                    threadId: '1500',
                    description: 'Outside',
                    hidden: false,
                    roleId: null,
                    added: true,
                },
                {
                    threadId: '1600',
                    description: null,
                    hidden: true,
                    roleId: null,
                    added: true,
                },
                // Not native, not added: a stale row, not listed.
                {
                    threadId: '1700',
                    description: 'stale',
                    hidden: false,
                    roleId: null,
                    added: false,
                },
            ]
        );

        expect(render).toEqual({
            title: 'Threads Directory',
            pages: [
                ['Computer Tech: <#999> - <@&7>\n<#1000>\nOutside: <#1500>'],
            ],
        });
    });

    it('shows a placeholder when there are no visible threads', () => {
        expect(renderDirectory('T', [], []).pages).toEqual([
            [EMPTY_DIRECTORY_LINE],
        ]);
        expect(
            renderDirectory(
                'T',
                [{ id: '1', name: 'a' }],
                [
                    {
                        threadId: '1',
                        description: null,
                        hidden: true,
                        roleId: null,
                        added: false,
                    },
                ]
            ).pages
        ).toEqual([[EMPTY_DIRECTORY_LINE]]);
    });

    it('splits a long directory over several messages at line boundaries', () => {
        const threads = ids(200).map((id) => ({ id, name: id }));
        const entries = threads.map((t) => ({
            threadId: t.id,
            description: 'x'.repeat(100),
            hidden: false,
            roleId: null,
            added: false,
        }));
        const expected = threads.map((t) =>
            directoryLine(t.id, 'x'.repeat(100))
        );

        const render = renderDirectory('Title', threads, entries);

        // 126 chars per line: about 47 per message, so 5 messages.
        expect(render.pages.length).toBe(5);
        render.pages.forEach((page, i) => {
            expect(page.length).toBeLessThanOrEqual(EMBEDS_PER_MESSAGE_MAX);
            page.forEach((d) => expect(d.length).toBeLessThanOrEqual(4096));
            expect(
                pageChars(page, i === 0 ? render.title : '')
            ).toBeLessThanOrEqual(EMBED_TOTAL_CHARS_MAX);
        });
        // Every line, in order, nothing dropped or cut.
        expect(render.pages.flat().join('\n').split('\n')).toEqual(expected);

        const pages = directoryPages(render);
        expect(pages[0].title).toBe('Title');
        expect(pages.slice(1).every((p) => p.title === undefined)).toBe(true);
        expect(pages.map((p) => p.timestamp)).toEqual([
            false,
            false,
            false,
            false,
            true,
        ]);
    });

    it('falls back to "…and N more" past the message cap', () => {
        const threads = ids(1000).map((id) => ({ id, name: id }));
        const entries = threads.map((t) => ({
            threadId: t.id,
            description: 'x'.repeat(100),
            hidden: false,
            roleId: null,
            added: false,
        }));

        const render = renderDirectory('Title', threads, entries);
        const lines = render.pages.flat().join('\n').split('\n');
        const shown = lines.length - 1;

        expect(render.pages.length).toBe(DIRECTORY_MESSAGES_MAX);
        expect(lines[lines.length - 1]).toBe(`…and ${1000 - shown} more`);
        expect(shown).toBeGreaterThanOrEqual(450);
        render.pages.forEach((page, i) =>
            expect(
                pageChars(page, i === 0 ? render.title : '')
            ).toBeLessThanOrEqual(EMBED_TOTAL_CHARS_MAX)
        );
    });
});

describe('ThreadDirectoryService', () => {
    beforeEach(() => {
        vi.useRealTimers();
    });

    it('posts a directory with the default title', async () => {
        const { repo, adapter, service } = setup();
        adapter.threads = [{ id: '200', name: 'Cars 2' }];

        const directory = await service.post('fluxer', GUILD, CHANNEL);

        expect(directory).toMatchObject({
            channelId: CHANNEL,
            guildId: GUILD,
            title: DEFAULT_DIRECTORY_TITLE,
            messageId: 'msg-1',
            messageIds: ['msg-1'],
        });
        expect(adapter.messages.get('msg-1')).toEqual({
            title: DEFAULT_DIRECTORY_TITLE,
            descriptions: ['<#200>'],
            timestamp: true,
        });
        expect(await repo.findDirectory('fluxer', CHANNEL)).toEqual(directory);
        expect(service.messageUrl(directory)).toBe(
            `https://example/${GUILD}/${CHANNEL}/msg-1`
        );
    });

    it('replaces the previous messages and keeps its title', async () => {
        const { adapter, service } = setup();
        await service.post('fluxer', GUILD, CHANNEL, 'My Threads');

        const second = await service.post('fluxer', GUILD, CHANNEL, '   ');

        expect(second.title).toBe('My Threads');
        expect(second.messageIds).toEqual(['msg-2']);
        expect(adapter.deleteDirectoryMessage).toHaveBeenCalledWith(
            CHANNEL,
            'msg-1'
        );
        expect([...adapter.messages.keys()]).toEqual(['msg-2']);
    });

    it('still posts when deleting the old message fails', async () => {
        const { adapter, service } = setup();
        await service.post('fluxer', GUILD, CHANNEL);
        adapter.deleteDirectoryMessage.mockRejectedValueOnce(new Error('nope'));

        await expect(
            service.post('fluxer', GUILD, CHANNEL)
        ).resolves.toMatchObject({ messageId: 'msg-2' });
    });

    it('posts a long directory as several messages in order', async () => {
        const { adapter, service } = setup();
        adapter.threads = ids(120).map((id) => ({ id, name: id }));
        for (const t of adapter.threads) {
            await service.setDescription(
                'fluxer',
                GUILD,
                CHANNEL,
                t.id,
                'd'.repeat(100)
            );
        }

        const directory = await service.post('fluxer', GUILD, CHANNEL, 'T');

        expect(directory.messageIds).toEqual(['msg-1', 'msg-2', 'msg-3']);
        expect(adapter.messages.get('msg-1')?.title).toBe('T');
        expect(adapter.messages.get('msg-2')?.title).toBeUndefined();
        expect(adapter.messages.get('msg-3')?.timestamp).toBe(true);
        expect(adapter.messages.get('msg-1')?.timestamp).toBe(false);
    });

    it('cleans up sent messages when posting fails midway', async () => {
        const { repo, adapter, service } = setup();
        adapter.threads = ids(120).map((id) => ({ id, name: id }));
        for (const t of adapter.threads) {
            await service.setDescription(
                'fluxer',
                GUILD,
                CHANNEL,
                t.id,
                'd'.repeat(100)
            );
        }
        adapter.sendDirectoryMessage
            .mockImplementationOnce(async (_c, page) => {
                adapter.messages.set('first', page);
                return 'first';
            })
            .mockRejectedValueOnce(new Error('boom'));

        await expect(service.post('fluxer', GUILD, CHANNEL)).rejects.toThrow(
            'boom'
        );
        expect(adapter.messages.size).toBe(0);
        expect(await repo.findDirectory('fluxer', CHANNEL)).toBeNull();
    });

    it('re-posts when the directory grows past its messages, and deletes surplus when it shrinks', async () => {
        const { repo, adapter, service } = setup();
        adapter.threads = [{ id: '200', name: 'a' }];
        await service.post('fluxer', GUILD, CHANNEL);

        // Grow: more pages than messages → fresh contiguous messages.
        adapter.threads = ids(120).map((id) => ({ id, name: id }));
        for (const t of adapter.threads) {
            await repo.saveEntry({
                platform: 'fluxer',
                channelId: CHANNEL,
                threadId: t.id,
                description: 'd'.repeat(100),
            });
        }
        const grown = await service.refresh('fluxer', CHANNEL);
        expect(grown.messageIds).toEqual(['msg-2', 'msg-3', 'msg-4']);
        expect([...adapter.messages.keys()]).toEqual([
            'msg-2',
            'msg-3',
            'msg-4',
        ]);
        expect(
            (await repo.findDirectory('fluxer', CHANNEL))?.messageIds
        ).toEqual(['msg-2', 'msg-3', 'msg-4']);

        // Same size: edited in place.
        adapter.sendDirectoryMessage.mockClear();
        await service.refresh('fluxer', CHANNEL);
        expect(adapter.sendDirectoryMessage).not.toHaveBeenCalled();

        // Shrink: edit the first, delete the surplus trailing messages.
        adapter.threads = [{ id: '200', name: 'a' }];
        const shrunk = await service.refresh('fluxer', CHANNEL);
        expect(shrunk.messageIds).toEqual(['msg-2']);
        expect([...adapter.messages.keys()]).toEqual(['msg-2']);
        expect(adapter.messages.get('msg-2')).toEqual({
            title: DEFAULT_DIRECTORY_TITLE,
            descriptions: ['<#200>'],
            timestamp: true,
        });
        expect(adapter.sendDirectoryMessage).not.toHaveBeenCalled();
    });

    it('re-posts when a later message is gone', async () => {
        const { repo, adapter, service } = setup();
        adapter.threads = ids(120).map((id) => ({ id, name: id }));
        for (const t of adapter.threads) {
            await repo.saveEntry({
                platform: 'fluxer',
                channelId: CHANNEL,
                threadId: t.id,
                description: 'd'.repeat(100),
            });
        }
        await service.post('fluxer', GUILD, CHANNEL);
        adapter.messages.delete('msg-2');

        const refreshed = await service.refresh('fluxer', CHANNEL);
        expect(refreshed.messageIds).toEqual(['msg-4', 'msg-5', 'msg-6']);
        expect([...adapter.messages.keys()]).toEqual([
            'msg-4',
            'msg-5',
            'msg-6',
        ]);
    });

    it('rejects overly long titles', async () => {
        const { service } = setup();
        await expectReason(
            service.post(
                'fluxer',
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
            service.post('discord', GUILD, CHANNEL),
            'unavailable'
        );
    });

    it('refresh fails with no_directory or message_missing (keeping the row)', async () => {
        const { repo, adapter, service } = setup();
        await expectReason(service.refresh('fluxer', CHANNEL), 'no_directory');

        await service.post('fluxer', GUILD, CHANNEL);
        adapter.messages.clear();
        await expectReason(
            service.refresh('fluxer', CHANNEL),
            'message_missing'
        );
        expect(await repo.findDirectory('fluxer', CHANNEL)).not.toBeNull();
        expect(adapter.sendDirectoryMessage).toHaveBeenCalledTimes(1);
    });

    it('sets, clears and validates descriptions', async () => {
        const { repo, adapter, service } = setup();
        adapter.threads = [{ id: '200', name: 'Data Mine' }];
        await service.post('fluxer', GUILD, CHANNEL);

        await service.setDescription(
            'fluxer',
            GUILD,
            CHANNEL,
            '200',
            '  Computer Tech '
        );
        expect(adapter.descriptions('msg-1')).toEqual([
            'Computer Tech: <#200>',
        ]);
        expect((await repo.listEntries('fluxer', CHANNEL))[0].guildId).toBe(
            GUILD
        );

        await service.setDescription('fluxer', GUILD, CHANNEL, '200', '  ');
        expect(
            (await repo.listEntries('fluxer', CHANNEL))[0].description
        ).toBeNull();
        expect(adapter.descriptions('msg-1')).toEqual(['<#200>']);

        await expectReason(
            service.setDescription('fluxer', GUILD, CHANNEL, '999', 'x'),
            'unknown_thread'
        );
        await expectReason(
            service.setDescription(
                'fluxer',
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

        await service.setDescription('fluxer', GUILD, CHANNEL, '200', 'd');
        expect(adapter.editDirectoryMessage).not.toHaveBeenCalled();
        expect(await repo.listEntries('fluxer', CHANNEL)).toHaveLength(1);

        await service.post('fluxer', GUILD, CHANNEL);
        adapter.messages.clear();
        await expectReason(
            service.setHidden('fluxer', GUILD, CHANNEL, '200', true),
            'message_missing'
        );
        expect((await repo.listEntries('fluxer', CHANNEL))[0].hidden).toBe(
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
            service.setTitle('fluxer', CHANNEL, 'New'),
            'no_directory'
        );
        await service.post('fluxer', GUILD, CHANNEL);

        await service.setHidden('fluxer', GUILD, CHANNEL, '200', true);
        const renamed = await service.setTitle('fluxer', CHANNEL, 'New');

        expect(renamed.title).toBe('New');
        expect(adapter.messages.get('msg-1')).toEqual({
            title: 'New',
            descriptions: ['<#300>'],
            timestamp: true,
        });

        const status = await service.getStatus('fluxer', GUILD, CHANNEL);
        expect(status.directory?.title).toBe('New');
        expect(status.threads).toEqual([
            {
                id: '200',
                name: 'a',
                description: null,
                hidden: true,
                roleId: null,
                added: false,
            },
            {
                id: '300',
                name: 'b',
                description: null,
                hidden: false,
                roleId: null,
                added: false,
            },
        ]);
    });

    it('removes every directory message but keeps descriptions', async () => {
        const { repo, adapter, service } = setup();
        adapter.threads = ids(120).map((id) => ({ id, name: id }));
        for (const t of adapter.threads) {
            await service.setDescription(
                'fluxer',
                GUILD,
                CHANNEL,
                t.id,
                'd'.repeat(100)
            );
        }
        await service.post('fluxer', GUILD, CHANNEL);
        adapter.deleteDirectoryMessage.mockRejectedValueOnce(new Error('perm'));

        expect(await service.remove('fluxer', CHANNEL)).toBe(true);
        expect(adapter.deleteDirectoryMessage).toHaveBeenCalledTimes(3);
        expect(await repo.findDirectory('fluxer', CHANNEL)).toBeNull();
        expect(await repo.listEntries('fluxer', CHANNEL)).toHaveLength(120);
        expect(await service.remove('fluxer', CHANNEL)).toBe(false);
    });

    describe('added entries', () => {
        it('adds and unlists channels and threads from outside the directory channel', async () => {
            const { repo, adapter, service } = setup();
            adapter.threads = [{ id: '300', name: 'native' }];
            adapter.threadsByChannel.set(OTHER_CHANNEL, [
                { id: '250', name: 'outside thread' },
            ]);
            adapter.channels.set('260', {
                id: '260',
                name: 'general',
                parentId: null,
            });
            await service.post('fluxer', GUILD, CHANNEL);

            expect(
                await service.addEntry(
                    'fluxer',
                    GUILD,
                    CHANNEL,
                    '250',
                    'Elsewhere'
                )
            ).toEqual({ alreadyListed: false });
            await service.addEntry('fluxer', GUILD, CHANNEL, '260', null);
            expect(adapter.descriptions('msg-1')).toEqual([
                'Elsewhere: <#250>\n<#260>\n<#300>',
            ]);
            expect(
                (await repo.listEntries('fluxer', CHANNEL)).find(
                    (e) => e.threadId === '250'
                )
            ).toMatchObject({ added: true, guildId: GUILD });

            // Already listed: native thread, or added before; description still set.
            expect(
                await service.addEntry('fluxer', GUILD, CHANNEL, '300', 'N')
            ).toEqual({ alreadyListed: true });
            expect(
                await service.addEntry('fluxer', GUILD, CHANNEL, '260', null)
            ).toEqual({ alreadyListed: true });
            const native = (await repo.listEntries('fluxer', CHANNEL)).find(
                (e) => e.threadId === '300'
            );
            expect(native).toMatchObject({ added: false, description: 'N' });

            // Unknown targets and the directory channel itself.
            await expectReason(
                service.addEntry('fluxer', GUILD, CHANNEL, '999', null),
                'unknown_channel'
            );
            await expectReason(
                service.addEntry('fluxer', GUILD, CHANNEL, CHANNEL, null),
                'unknown_channel'
            );

            // Added entries accept descriptions, hiding and roles.
            adapter.roles = [SAFE_ROLE];
            await service.setDescription(
                'fluxer',
                GUILD,
                CHANNEL,
                '260',
                'Chat'
            );
            await service.setRole('fluxer', GUILD, CHANNEL, '260', 'techies');
            await service.setHidden('fluxer', GUILD, CHANNEL, '250', true);
            expect(adapter.descriptions('msg-1')).toEqual([
                'Chat: <#260> - <@&700000000000000000>\nN: <#300>',
            ]);

            const status = await service.getStatus('fluxer', GUILD, CHANNEL);
            expect(status.threads.map((t) => [t.id, t.name, t.added])).toEqual([
                ['250', 'outside thread', true],
                ['260', 'general', true],
                ['300', 'native', false],
            ]);

            // Unlist: only added entries.
            expect(await service.unlistEntry('fluxer', CHANNEL, '300')).toBe(
                false
            );
            expect(await service.unlistEntry('fluxer', CHANNEL, '260')).toBe(
                true
            );
            expect(await service.unlistEntry('fluxer', CHANNEL, '260')).toBe(
                false
            );
            expect(adapter.descriptions('msg-1')).toEqual(['N: <#300>']);
        });

        it('lets an outside thread be listed by several directories', async () => {
            const { repo, adapter, service } = setup();
            adapter.threadsByChannel.set(OTHER_CHANNEL, [
                { id: '250', name: 'shared' },
            ]);
            adapter.threadsByChannel.set('160', []);

            await service.addEntry('fluxer', GUILD, CHANNEL, '250', 'One');
            await service.addEntry('fluxer', GUILD, '160', '250', 'Two');

            expect(
                (await repo.listEntries('fluxer', CHANNEL))[0].description
            ).toBe('One');
            expect(
                (await repo.listEntries('fluxer', '160'))[0].description
            ).toBe('Two');
        });
    });

    describe('roles', () => {
        it('links, shows and clears roles by ID, mention or name', async () => {
            const { repo, adapter, service } = setup();
            adapter.threads = [{ id: '200', name: 'Data Mine' }];
            adapter.roles = [SAFE_ROLE, OTHER_ROLE];
            await service.post('fluxer', GUILD, CHANNEL);

            expect(
                await service.setRole(
                    'fluxer',
                    GUILD,
                    CHANNEL,
                    '200',
                    '700000000000000000'
                )
            ).toEqual({ id: '700000000000000000', name: 'Techies' });
            expect(adapter.descriptions('msg-1')).toEqual([
                '<#200> - <@&700000000000000000>',
            ]);
            expect(
                await service.setRole(
                    'fluxer',
                    GUILD,
                    CHANNEL,
                    '200',
                    '<@&701000000000000000>'
                )
            ).toEqual({ id: '701000000000000000', name: 'Car People' });
            expect(
                await service.setRole(
                    'fluxer',
                    GUILD,
                    CHANNEL,
                    '200',
                    '@car people'
                )
            ).toEqual({ id: '701000000000000000', name: 'Car People' });

            expect(
                await service.setRole('fluxer', GUILD, CHANNEL, '200', null)
            ).toBeNull();
            expect(
                (await repo.listEntries('fluxer', CHANNEL))[0].roleId
            ).toBeNull();
            expect(adapter.descriptions('msg-1')).toEqual(['<#200>']);
        });

        it('refuses unknown and unsafe roles and unknown threads', async () => {
            const { adapter, service } = setup();
            adapter.threads = [{ id: '200', name: 'a' }];
            adapter.roles = [
                SAFE_ROLE,
                {
                    id: GUILD,
                    name: '@everyone',
                    managed: false,
                    permissions: '0',
                },
                { id: '702', name: 'Bot', managed: true, permissions: '0' },
                {
                    id: '703',
                    name: 'Mods',
                    managed: false,
                    permissions: String(BigInt(1) << BigInt(13)),
                },
            ];

            await expectReason(
                service.setRole('fluxer', GUILD, CHANNEL, '200', 'nobody'),
                'unknown_role'
            );
            for (const role of [GUILD, '702', 'mods']) {
                await expectReason(
                    service.setRole('fluxer', GUILD, CHANNEL, '200', role),
                    'unsafe_role'
                );
            }
            await expectReason(
                service.setRole(
                    'fluxer',
                    GUILD,
                    CHANNEL,
                    '999',
                    '700000000000000000'
                ),
                'unknown_thread'
            );
        });
    });

    describe('lfg', () => {
        async function lfgSetup() {
            const ctx = setup();
            const { adapter, service } = ctx;
            adapter.threads = [
                { id: '200', name: 'Data Mine' },
                { id: CARS, name: 'Cars 2' },
                { id: '400', name: 'No role' },
            ];
            adapter.threadsByChannel.set('160', [
                { id: '500', name: 'Other dir' },
            ]);
            adapter.roles = [SAFE_ROLE, OTHER_ROLE];
            await service.setRole(
                'fluxer',
                GUILD,
                CHANNEL,
                '200',
                '700000000000000000'
            );
            await service.setDescription(
                'fluxer',
                GUILD,
                CHANNEL,
                CARS,
                'Cars'
            );
            await service.setRole(
                'fluxer',
                GUILD,
                CHANNEL,
                CARS,
                '701000000000000000'
            );
            // The same role on another directory's thread is listed once.
            await service.setRole(
                'fluxer',
                GUILD,
                '160',
                '500',
                '700000000000000000'
            );
            return ctx;
        }

        it('lists linked roles deduped and sorted by name, with the member’s', async () => {
            const { adapter, service } = await lfgSetup();

            expect(await service.listLfgRoles('fluxer', GUILD)).toEqual([
                {
                    roleId: '701000000000000000',
                    roleName: 'Car People',
                    channelId: CHANNEL,
                    threadId: CARS,
                    description: 'Cars',
                },
                {
                    roleId: '700000000000000000',
                    roleName: 'Techies',
                    channelId: CHANNEL,
                    threadId: '200',
                    description: null,
                },
            ]);

            adapter.memberRoles.set(
                'u1',
                new Set(['700000000000000000', '999'])
            );
            expect(
                await service.memberLfgRoleIds('fluxer', GUILD, 'u1')
            ).toEqual(['700000000000000000']);
        });

        it('toggles roles by role, entry ID/link, role name, entry name or description', async () => {
            const { adapter, service } = await lfgSetup();

            expect(
                await service.toggleLfgRole(
                    'fluxer',
                    GUILD,
                    'u1',
                    '<@&700000000000000000>'
                )
            ).toEqual({
                role: { id: '700000000000000000', name: 'Techies' },
                added: true,
            });
            expect(
                adapter.memberRoles.get('u1')?.has('700000000000000000')
            ).toBe(true);
            expect(
                await service.toggleLfgRole('fluxer', GUILD, 'u1', '200')
            ).toEqual({
                role: { id: '700000000000000000', name: 'Techies' },
                added: false,
            });
            expect(
                await service.toggleLfgRole(
                    'fluxer',
                    GUILD,
                    'u1',
                    `https://fluxer.app/channels/${GUILD}/${CARS}`
                )
            ).toMatchObject({
                role: { id: '701000000000000000' },
                added: true,
            });
            expect(
                await service.toggleLfgRole('fluxer', GUILD, 'u1', 'techies')
            ).toMatchObject({
                role: { id: '700000000000000000' },
                added: true,
            });
            expect(
                await service.toggleLfgRole('fluxer', GUILD, 'u1', 'cars')
            ).toMatchObject({
                role: { id: '701000000000000000' },
                added: false,
            });
            expect(
                await service.toggleLfgRole('fluxer', GUILD, 'u1', '#data mine')
            ).toMatchObject({
                role: { id: '700000000000000000' },
                added: false,
            });

            for (const target of ['400', 'No role', '999', '', 'nobody']) {
                await expectReason(
                    service.toggleLfgRole('fluxer', GUILD, 'u1', target),
                    'not_lfg_role'
                );
            }
        });

        it('re-checks that the role still exists and is safe', async () => {
            const { adapter, service } = await lfgSetup();
            adapter.roles = [
                { ...SAFE_ROLE, permissions: String(BigInt(1) << BigInt(3)) },
            ];

            await expectReason(
                service.toggleLfgRole(
                    'fluxer',
                    GUILD,
                    'u1',
                    '700000000000000000'
                ),
                'not_lfg_role'
            );
            await expectReason(
                service.toggleLfgRole(
                    'fluxer',
                    GUILD,
                    'u1',
                    '701000000000000000'
                ),
                'not_lfg_role'
            );
            expect(await service.listLfgRoles('fluxer', GUILD)).toEqual([]);
            expect(adapter.addMemberRole).not.toHaveBeenCalled();
        });

        it('propagates role_forbidden from the adapter', async () => {
            const { adapter, service } = await lfgSetup();
            adapter.addMemberRole.mockRejectedValueOnce(
                new ThreadDirectoryError('role_forbidden', 'no')
            );
            await expectReason(
                service.toggleLfgRole(
                    'fluxer',
                    GUILD,
                    'u1',
                    '700000000000000000'
                ),
                'role_forbidden'
            );
        });
    });

    describe('import', () => {
        it('matches by ID and by name, adds outside entries, applies safe roles and refreshes once', async () => {
            const { repo, adapter, service } = setup();
            adapter.threads = [
                { id: '200', name: 'The Data Mine' },
                { id: '300', name: 'Cars 2' },
                { id: '350', name: 'Already added elsewhere' },
            ];
            adapter.threadsByChannel.set(OTHER_CHANNEL, [
                { id: '250', name: 'ATF no dogs here' },
            ]);
            adapter.roles = [
                SAFE_ROLE,
                { id: '703', name: 'Mods', managed: false, permissions: '8' },
            ];
            await service.post('fluxer', GUILD, CHANNEL);
            adapter.editDirectoryMessage.mockClear();

            const result = await service.importEntries(
                'fluxer',
                GUILD,
                CHANNEL,
                [
                    // Native thread by ID, with a safe role.
                    {
                        channelId: '200',
                        name: 'The Data Mine',
                        description: 'Computer Tech',
                        roleId: '700000000000000000',
                    },
                    // Foreign ID (e.g. copied from elsewhere), matched by name; unsafe role ignored.
                    {
                        channelId: '888',
                        name: 'cars 2',
                        description: 'Cars',
                        roleId: '703',
                    },
                    // Outside thread of the guild → added; unknown role ignored.
                    {
                        channelId: '250',
                        name: 'ATF no dogs here',
                        description: 'Firearms',
                        roleId: '999',
                    },
                    // Name only, no description: matched, nothing changed but listed as updated.
                    {
                        channelId: null,
                        name: 'Already added elsewhere',
                        description: null,
                        roleId: null,
                    },
                    // Unmatched lines.
                    {
                        channelId: null,
                        name: 'Gone',
                        description: 'x',
                        roleId: null,
                    },
                    {
                        channelId: '777',
                        name: null,
                        description: 'x',
                        roleId: null,
                    },
                    {
                        channelId: null,
                        name: null,
                        description: 'x',
                        roleId: null,
                    },
                    // The directory channel itself is never listed.
                    {
                        channelId: CHANNEL,
                        name: null,
                        description: 'x',
                        roleId: null,
                    },
                ]
            );

            expect(result).toEqual({
                updated: ['200', '300', '350'],
                added: ['250'],
                skipped: ['Gone', '777', '?', CHANNEL],
            });
            expect(adapter.editDirectoryMessage).toHaveBeenCalledTimes(1);
            expect(adapter.descriptions('msg-1')).toEqual([
                'Computer Tech: <#200> - <@&700000000000000000>\nFirearms: <#250>\nCars: <#300>\n<#350>',
            ]);
            const entries = await repo.listEntries('fluxer', CHANNEL);
            expect(entries.find((e) => e.threadId === '250')).toMatchObject({
                added: true,
                guildId: GUILD,
                roleId: null,
            });
            expect(entries.find((e) => e.threadId === '300')?.roleId).toBe(
                null
            );
        });

        it('updates already added entries instead of re-adding, and truncates long descriptions', async () => {
            const { repo, adapter, service } = setup();
            adapter.threadsByChannel.set(OTHER_CHANNEL, [
                { id: '250', name: 'outside' },
            ]);
            await service.addEntry('fluxer', GUILD, CHANNEL, '250', null);

            const result = await service.importEntries(
                'fluxer',
                GUILD,
                CHANNEL,
                [
                    {
                        channelId: '250',
                        name: null,
                        description: 'y'.repeat(DIRECTORY_DESCRIPTION_MAX + 50),
                        roleId: null,
                    },
                ]
            );

            expect(result).toEqual({
                updated: ['250'],
                added: [],
                skipped: [],
            });
            const [entry] = await repo.listEntries('fluxer', CHANNEL);
            expect(entry.description?.length).toBe(DIRECTORY_DESCRIPTION_MAX);
            expect(entry.added).toBe(true);
        });

        it('fetches message text or reports message_not_found', async () => {
            const { adapter, service } = setup();
            adapter.channels.set(CHANNEL, {
                id: CHANNEL,
                name: 'threads',
                parentId: null,
            });
            adapter.messageTexts.set(`${CHANNEL}/6`, 'Threads Directory\nline');

            expect(
                await service.fetchMessageText('fluxer', GUILD, CHANNEL, '6')
            ).toBe('Threads Directory\nline');
            await expectReason(
                service.fetchMessageText('fluxer', GUILD, CHANNEL, '7'),
                'message_not_found'
            );
        });

        it('refuses to read messages of another server', async () => {
            const { adapter, service } = setup();
            adapter.messageTexts.set(`${CHANNEL}/6`, 'secret');

            await expectReason(
                service.fetchMessageText('fluxer', '999', CHANNEL, '6'),
                'message_not_found'
            );
            expect(adapter.fetchMessageText).not.toHaveBeenCalled();
        });
    });

    describe('thread events', () => {
        afterEach(() => {
            vi.useRealTimers();
        });

        it('coalesces a burst of thread events into one edit', async () => {
            const { adapter, service } = setup(1000);
            await service.post('fluxer', GUILD, CHANNEL);
            vi.useFakeTimers();

            adapter.threads = [{ id: '200', name: 'a' }];
            service.handleThreadCreated('fluxer', CHANNEL);
            await vi.advanceTimersByTimeAsync(500);
            adapter.threads.push({ id: '300', name: 'b' });
            service.handleThreadCreated('fluxer', CHANNEL);
            service.handleThreadCreated('fluxer', null);
            service.handleThreadCreated('fluxer', undefined);
            await vi.advanceTimersByTimeAsync(999);
            expect(adapter.editDirectoryMessage).not.toHaveBeenCalled();

            await vi.advanceTimersByTimeAsync(1);
            expect(adapter.editDirectoryMessage).toHaveBeenCalledTimes(1);
            expect(adapter.descriptions('msg-1')).toEqual(['<#200>\n<#300>']);
        });

        it('does nothing without a directory and never throws', async () => {
            const { adapter, service } = setup(10);
            vi.useFakeTimers();

            service.handleThreadCreated('fluxer', CHANNEL);
            service.handleThreadCreated('discord', CHANNEL);
            await vi.advanceTimersByTimeAsync(10);
            expect(adapter.listThreads).not.toHaveBeenCalled();

            vi.useRealTimers();
            await service.post('fluxer', GUILD, CHANNEL);
            adapter.messages.clear();
            vi.useFakeTimers();
            service.handleThreadCreated('fluxer', CHANNEL);
            await vi.advanceTimersByTimeAsync(10);
            expect(adapter.editDirectoryMessage).toHaveBeenCalledTimes(1);
        });

        it('forgets deleted threads in every directory and refreshes each', async () => {
            const { repo, adapter, service } = setup(10);
            adapter.threads = [
                { id: '200', name: 'a' },
                { id: '300', name: 'b' },
            ];
            adapter.threadsByChannel.set('160', []);
            await service.post('fluxer', GUILD, CHANNEL);
            await service.post('fluxer', GUILD, '160');
            await service.setDescription('fluxer', GUILD, CHANNEL, '200', 'd');
            await service.addEntry('fluxer', GUILD, '160', '200', 'shared');
            expect(adapter.descriptions('msg-2')).toEqual(['shared: <#200>']);
            vi.useFakeTimers();

            adapter.threads = [{ id: '300', name: 'b' }];
            service.handleThreadDeleted('fluxer', CHANNEL, '200');
            await vi.advanceTimersByTimeAsync(10);

            expect(await repo.listEntries('fluxer', CHANNEL)).toEqual([]);
            expect(await repo.listEntries('fluxer', '160')).toEqual([]);
            expect(adapter.descriptions('msg-1')).toEqual(['<#300>']);
            expect(adapter.descriptions('msg-2')).toEqual([
                EMPTY_DIRECTORY_LINE,
            ]);
        });
    });

    it('serialises operations on one channel', async () => {
        const { adapter, service } = setup();
        let release!: () => void;
        adapter.sendDirectoryMessage.mockImplementationOnce(
            () =>
                new Promise<string>((resolve) => {
                    release = () => resolve('slow');
                    adapter.messages.set('slow', {
                        descriptions: [],
                        timestamp: true,
                    });
                })
        );

        const posting = service.post('fluxer', GUILD, CHANNEL);
        const refreshing = service.refresh('fluxer', CHANNEL);
        await new Promise((r) => setTimeout(r, 0));
        release();

        await posting;
        await expect(refreshing).resolves.toMatchObject({ messageId: 'slow' });
    });
});
