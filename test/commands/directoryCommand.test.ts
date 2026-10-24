import { describe, expect, it, vi } from 'vitest';
import { Client, Message, PermissionsBitField } from '@fluxerjs/core';
import {
    directoryStatusLine,
    parseDirectoryCommand,
    runDirectoryAction,
} from '../../src/commands/directoryCommand';
import DirectoryFluxerCommandHandler from '../../src/commands/fluxer/handlers/DirectoryFluxerCommandHandler';
import ThreadDirectoryService, {
    ThreadDirectoryError,
} from '../../src/services/threadDirectory/ThreadDirectoryService';
import { COMMAND_PREFIX } from '../../src/utils/env';
import { EmbedColors } from '../../src/utils/embeds';

vi.mock('../../src/utils/logging/logger', () => ({
    default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const T1 = '111111111111111111';
const T2 = '222222222222222222';
const R1 = '333333333333333333';
const M1 = '444444444444444444';
const LINK = `https://fluxer.app/channels/555555555555555555/${T1}`;

function parse(text: string, currentThreadId: string | null = null) {
    const words = text.trim().split(/\s+/);
    return parseDirectoryCommand({
        content: `${COMMAND_PREFIX}${text}`,
        prefix: COMMAND_PREFIX,
        args: words.slice(1),
        currentThreadId,
    });
}

describe('parseDirectoryCommand', () => {
    it('parses status, refresh, remove and unknown subcommands', () => {
        expect(parse('directory')).toEqual({ kind: 'status' });
        expect(parse('directory REFRESH')).toEqual({ kind: 'refresh' });
        expect(parse('directory update')).toEqual({ kind: 'refresh' });
        expect(parse('directory remove')).toEqual({ kind: 'remove' });
        expect(parse('directory bogus')).toEqual({ kind: 'usage' });
    });

    it('parses post with and without a title', () => {
        expect(parse('directory post')).toEqual({
            kind: 'post',
            title: undefined,
        });
        expect(parse('directory post  My   Threads')).toEqual({
            kind: 'post',
            title: 'My   Threads',
        });
    });

    it('parses title', () => {
        expect(parse('directory title Hello there')).toEqual({
            kind: 'title',
            title: 'Hello there',
        });
        expect(parse('directory title')).toEqual({ kind: 'usage' });
    });

    it('parses describe with a mention or ID and keeps newlines', () => {
        expect(parse(`directory describe <#${T1}> a b`)).toEqual({
            kind: 'describe',
            threadId: T1,
            description: 'a b',
        });
        expect(parse(`directory describe ${T1} line1\nline2`)).toEqual({
            kind: 'describe',
            threadId: T1,
            description: 'line1\nline2',
        });
        expect(parse(`directory describe ${T1}`)).toEqual({
            kind: 'describe',
            threadId: T1,
            description: null,
        });
    });

    it('describes the current thread when the first arg is not a thread', () => {
        expect(parse('directory describe Some  text', T2)).toEqual({
            kind: 'describe',
            threadId: T2,
            description: 'Some  text',
        });
        expect(parse('directory describe Some text')).toEqual({
            kind: 'usage',
        });
        expect(parse('directory describe')).toEqual({ kind: 'usage' });
    });

    it('parses hide and show', () => {
        expect(parse(`directory hide <#${T1}>`)).toEqual({
            kind: 'hide',
            threadId: T1,
            hidden: true,
        });
        expect(parse('directory show', T2)).toEqual({
            kind: 'hide',
            threadId: T2,
            hidden: false,
        });
        expect(parse('directory hide')).toEqual({ kind: 'usage' });
        expect(parse('directory hide nope', T2)).toEqual({ kind: 'usage' });
    });

    it('accepts thread links wherever a thread is expected', () => {
        expect(parse(`directory hide ${LINK}`)).toEqual({
            kind: 'hide',
            threadId: T1,
            hidden: true,
        });
        expect(parse(`directory describe <${LINK}> text`)).toEqual({
            kind: 'describe',
            threadId: T1,
            description: 'text',
        });
    });

    it('parses add with an optional description', () => {
        expect(parse(`directory add ${LINK} Computer  Tech`)).toEqual({
            kind: 'add',
            targetId: T1,
            description: 'Computer  Tech',
        });
        expect(parse(`directory add <#${T1}>`)).toEqual({
            kind: 'add',
            targetId: T1,
            description: null,
        });
        expect(parse('directory add')).toEqual({ kind: 'usage' });
        expect(parse('directory add nope')).toEqual({ kind: 'usage' });
    });

    it('parses unlist and drop', () => {
        expect(parse(`directory unlist ${T1}`)).toEqual({
            kind: 'unlist',
            targetId: T1,
        });
        expect(parse(`directory DROP ${LINK}`)).toEqual({
            kind: 'unlist',
            targetId: T1,
        });
        expect(parse('directory unlist')).toEqual({ kind: 'usage' });
        expect(parse(`directory unlist ${T1} extra`)).toEqual({
            kind: 'usage',
        });
    });

    it('parses role with a thread and a mention, ID, name or none', () => {
        expect(parse(`directory role <#${T1}> <@&${R1}>`)).toEqual({
            kind: 'role',
            threadId: T1,
            role: R1,
        });
        expect(parse(`directory role ${LINK} Data  Miners`)).toEqual({
            kind: 'role',
            threadId: T1,
            role: 'Data  Miners',
        });
        expect(parse(`directory role ${T1} ${R1}`)).toEqual({
            kind: 'role',
            threadId: T1,
            role: R1,
        });
        expect(parse(`directory role ${T1} None`)).toEqual({
            kind: 'role',
            threadId: T1,
            role: null,
        });
    });

    it('parses role for the current thread', () => {
        expect(parse('directory role Gamers Club', T2)).toEqual({
            kind: 'role',
            threadId: T2,
            role: 'Gamers Club',
        });
        expect(parse(`directory role ${R1}`, T2)).toEqual({
            kind: 'role',
            threadId: T2,
            role: R1,
        });
        expect(parse(`directory role <@&${R1}>`, T2)).toEqual({
            kind: 'role',
            threadId: T2,
            role: R1,
        });
        expect(parse('directory role off', T2)).toEqual({
            kind: 'role',
            threadId: T2,
            role: null,
        });
        expect(parse(`directory role <#${T1}>`, T2)).toEqual({
            kind: 'usage',
        });
        expect(parse('directory role Gamers')).toEqual({ kind: 'usage' });
        expect(parse('directory role', T2)).toEqual({ kind: 'usage' });
    });

    it('parses import from a message link, a message ID or pasted text', () => {
        expect(
            parse(
                `directory import https://fluxer.app/channels/9${M1}/${T1}/${M1}`
            )
        ).toEqual({
            kind: 'import',
            source: { kind: 'message', channelId: T1, messageId: M1 },
        });
        expect(parse(`directory import ${M1}`)).toEqual({
            kind: 'import',
            source: { kind: 'message', channelId: null, messageId: M1 },
        });
        const text = `Threads Directory\n***[Cars 2](${LINK})*** - Cars`;
        expect(parse(`directory import ${text}`)).toEqual({
            kind: 'import',
            source: { kind: 'text', text },
        });
        expect(parse('directory import')).toEqual({ kind: 'usage' });
    });
});

describe('directoryStatusLine', () => {
    const thread = {
        id: T1,
        name: 'a',
        description: null,
        hidden: false,
        roleId: null,
        added: false,
    };

    it('uses the description: thread - role format', () => {
        expect(directoryStatusLine(thread)).toBe(`<#${T1}>`);
        expect(
            directoryStatusLine({
                ...thread,
                description: 'Computer\nTech',
                roleId: R1,
            })
        ).toBe(`Computer Tech: <#${T1}> - <@&${R1}>`);
        expect(
            directoryStatusLine({ ...thread, hidden: true, added: true })
        ).toBe(`🙈 ➕ <#${T1}>`);
    });
});

describe('runDirectoryAction', () => {
    const service = (overrides: Record<string, unknown>) =>
        overrides as unknown as ThreadDirectoryService;

    it.each([
        ['no_directory', 'directory post'],
        ['message_missing', 'deleted'],
        ['unknown_thread', `<#${T1}> is not a thread of <#chan>`],
        ['unsupported_channel', 'text channels'],
        ['too_long', '300'],
        ['unavailable', 'not available'],
        ['unknown_channel', 'not a channel or thread of this server'],
        ['unknown_role', 'does not exist'],
        ['unsafe_role', 'moderator permissions'],
        ['not_lfg_role', 'not an LFG role'],
        ['role_forbidden', 'Manage Roles'],
        ['message_not_found', 'could not fetch that message'],
    ] as const)('maps %s', async (reason, text) => {
        const svc = service({
            setDescription: vi
                .fn()
                .mockRejectedValue(new ThreadDirectoryError(reason, 'x')),
        });
        const result = await runDirectoryAction(svc, 'discord', 'g', 'chan', {
            kind: 'describe',
            threadId: T1,
            description: 'd',
        });
        expect(result).toMatchObject({ color: EmbedColors.Error });
        expect((result as { description: string }).description).toContain(text);
    });

    it('replies generically to other errors', async () => {
        const svc = service({
            refresh: vi.fn().mockRejectedValue(new Error('boom')),
        });
        const result = await runDirectoryAction(svc, 'fluxer', 'g', 'chan', {
            kind: 'refresh',
        });
        expect((result as { description: string }).description).toContain(
            'Something went wrong'
        );
    });

    it('lists threads in the status, marking hidden ones', async () => {
        const svc = service({
            getStatus: vi.fn().mockResolvedValue({
                directory: { title: 'T' },
                threads: [
                    {
                        id: T1,
                        name: 'a',
                        description: 'about a',
                        hidden: false,
                        roleId: R1,
                        added: false,
                    },
                    {
                        id: T2,
                        name: 'b',
                        description: null,
                        hidden: true,
                        roleId: null,
                        added: true,
                    },
                ],
            }),
            messageUrl: () => 'https://example.test/m',
        });
        const result = await runDirectoryAction(svc, 'discord', 'g', 'chan', {
            kind: 'status',
        });
        expect(result).toMatchObject({
            status: true,
            lines: [`about a: <#${T1}> - <@&${R1}>`, `🙈 ➕ <#${T2}>`],
        });
    });

    it('adds entries and reports already listed ones', async () => {
        const addEntry = vi
            .fn()
            .mockResolvedValueOnce({ alreadyListed: false })
            .mockResolvedValueOnce({ alreadyListed: true });
        const svc = service({ addEntry });
        const action = {
            kind: 'add',
            targetId: T1,
            description: 'd',
        } as const;
        const first = await runDirectoryAction(
            svc,
            'fluxer',
            'g',
            'chan',
            action
        );
        expect(addEntry).toHaveBeenCalledWith('fluxer', 'g', 'chan', T1, 'd');
        expect((first as { description: string }).description).toContain(
            'Added'
        );
        const second = await runDirectoryAction(
            svc,
            'fluxer',
            'g',
            'chan',
            action
        );
        expect((second as { description: string }).description).toContain(
            'already listed'
        );
    });

    it('unlists added entries and suggests hide for the others', async () => {
        const unlistEntry = vi
            .fn()
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(false);
        const svc = service({ unlistEntry });
        const action = { kind: 'unlist', targetId: T1 } as const;
        const ok = await runDirectoryAction(svc, 'fluxer', 'g', 'chan', action);
        expect(unlistEntry).toHaveBeenCalledWith('fluxer', 'chan', T1);
        expect(ok).toMatchObject({ color: EmbedColors.Success });
        const no = await runDirectoryAction(svc, 'fluxer', 'g', 'chan', action);
        expect(no).toMatchObject({ color: EmbedColors.Error });
        expect((no as { description: string }).description).toContain(
            'directory hide'
        );
    });

    it('links and clears roles', async () => {
        const setRole = vi
            .fn()
            .mockResolvedValueOnce({ id: R1, name: 'Miners' })
            .mockResolvedValueOnce(null);
        const svc = service({ setRole });
        const linked = await runDirectoryAction(svc, 'fluxer', 'g', 'chan', {
            kind: 'role',
            threadId: T1,
            role: 'Miners',
        });
        expect(setRole).toHaveBeenCalledWith(
            'fluxer',
            'g',
            'chan',
            T1,
            'Miners'
        );
        expect((linked as { description: string }).description).toContain(
            `<@&${R1}>`
        );
        const cleared = await runDirectoryAction(svc, 'fluxer', 'g', 'chan', {
            kind: 'role',
            threadId: T1,
            role: null,
        });
        expect((cleared as { description: string }).description).toContain(
            'Cleared'
        );
    });

    it('imports pasted text and reports the counts', async () => {
        const importEntries = vi.fn().mockResolvedValue({
            updated: [T1],
            added: [T2],
            skipped: ['Lost Thread'],
        });
        const svc = service({ importEntries });
        const text = `Threads Directory\n***[The Data Mine](${LINK})*** - Computer Tech\n***[Cars 2](https://fluxer.app/channels/555555555555555555/${T2})*** - Cars\nLost Thread - Gone`;
        const result = await runDirectoryAction(svc, 'fluxer', 'g', 'chan', {
            kind: 'import',
            source: { kind: 'text', text },
        });
        const items = importEntries.mock.calls[0][3];
        expect(items.length).toBe(3);
        expect(items[0]).toMatchObject({
            channelId: T1,
            description: 'Computer Tech',
        });
        expect(result).toMatchObject({ color: EmbedColors.Warning });
        const description = (result as { description: string }).description;
        expect(description).toContain('1 updated, 1 added, 1 skipped');
        expect(description).toContain('`Lost Thread`');
    });

    it('imports a message, by ID from the current channel', async () => {
        const fetchMessageText = vi
            .fn()
            .mockResolvedValue(`***[Cars 2](${LINK})*** - Cars`);
        const importEntries = vi
            .fn()
            .mockResolvedValue({ updated: [T1], added: [], skipped: [] });
        const svc = service({ fetchMessageText, importEntries });
        const result = await runDirectoryAction(
            svc,
            'fluxer',
            'g',
            'chan',
            {
                kind: 'import',
                source: { kind: 'message', channelId: null, messageId: M1 },
            },
            'here'
        );
        expect(fetchMessageText).toHaveBeenCalledWith(
            'fluxer',
            'g',
            'here',
            M1
        );
        expect(result).toMatchObject({ color: EmbedColors.Success });
    });

    it('explains the format when nothing can be imported', async () => {
        const importEntries = vi.fn();
        const svc = service({ importEntries });
        const result = await runDirectoryAction(svc, 'fluxer', 'g', 'chan', {
            kind: 'import',
            source: { kind: 'text', text: 'just some words' },
        });
        expect(importEntries).not.toHaveBeenCalled();
        expect(result).toMatchObject({ color: EmbedColors.Error });
        expect((result as { description: string }).description).toContain(
            'no directory lines'
        );
    });

    it('truncates long skipped lists', async () => {
        const skipped = Array.from({ length: 40 }, (_, i) => `t${i}`);
        const svc = service({
            importEntries: vi
                .fn()
                .mockResolvedValue({ updated: [], added: [], skipped }),
        });
        const result = await runDirectoryAction(svc, 'fluxer', 'g', 'chan', {
            kind: 'import',
            source: { kind: 'text', text: 'a - b' },
        });
        expect((result as { description: string }).description).toContain(
            '…and 25 more'
        );
    });
});

describe('DirectoryFluxerCommandHandler', () => {
    function setup(
        perms: { channels?: boolean; roles?: boolean } = {},
        parentId: string | null = null
    ) {
        const { channels = true, roles = true } = perms;
        const reply = vi.fn().mockResolvedValue(undefined);
        const member = {
            permissions: {
                has: vi.fn((flag: unknown) =>
                    flag === PermissionsBitField.Flags.ManageRoles
                        ? roles
                        : channels
                ),
            },
        };
        const message = {
            content: `${COMMAND_PREFIX}directory post Hi`,
            channelId: 'thread-or-chan',
            guildId: 'guild',
            author: { id: 'a', username: 'u' },
            channel: { isThread: () => parentId !== null, parentId },
            guild: { fetchMember: vi.fn().mockResolvedValue(member) },
            reply,
            send: vi.fn(),
        } as unknown as Message;
        const svc = {
            post: vi.fn().mockResolvedValue({ id: 1 }),
            setRole: vi.fn().mockResolvedValue({ id: R1, name: 'r' }),
            messageUrl: vi.fn().mockReturnValue('https://example.test/m'),
        };
        const handler = new DirectoryFluxerCommandHandler(
            { user: { id: 'bot' } } as unknown as Client,
            svc as unknown as ThreadDirectoryService
        );
        return { handler, message, reply, svc };
    }

    it('posts in the parent channel when run in a thread', async () => {
        const t = setup({}, 'parent');
        await t.handler.handleCommand(t.message, 'directory', 'post', 'Hi');
        expect(t.svc.post).toHaveBeenCalledWith(
            'fluxer',
            'guild',
            'parent',
            'Hi'
        );
        expect(
            t.reply.mock.calls[0][0].embeds[0].toJSON().description
        ).toContain('https://example.test/m');
    });

    it('requires Manage Channels', async () => {
        const t = setup({ channels: false });
        await t.handler.handleCommand(t.message, 'directory', 'post');
        expect(t.svc.post).not.toHaveBeenCalled();
    });

    it('requires Manage Roles for role only', async () => {
        const t = setup({ roles: false }, 'parent');
        t.message.content = `${COMMAND_PREFIX}directory role Gamers`;
        await t.handler.handleCommand(t.message, 'directory', 'role', 'Gamers');
        expect(t.svc.setRole).not.toHaveBeenCalled();
        expect(
            t.reply.mock.calls[0][0].embeds[0].toJSON().description
        ).toContain('Manage Roles');

        const ok = setup({}, 'parent');
        ok.message.content = `${COMMAND_PREFIX}directory role Gamers`;
        await ok.handler.handleCommand(
            ok.message,
            'directory',
            'role',
            'Gamers'
        );
        expect(ok.svc.setRole).toHaveBeenCalledWith(
            'fluxer',
            'guild',
            'parent',
            'thread-or-chan',
            'Gamers'
        );
    });

    it('replies with usage for an unknown subcommand', async () => {
        const t = setup();
        await t.handler.handleCommand(t.message, 'directory', 'bogus');
        expect(t.svc.post).not.toHaveBeenCalled();
        expect(t.reply).toHaveBeenCalledTimes(1);
    });
});
