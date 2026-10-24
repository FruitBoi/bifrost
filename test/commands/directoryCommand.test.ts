import { describe, expect, it, vi } from 'vitest';
import { Client } from 'discord.js';
import {
    parseDirectoryCommand,
    parseThreadRef,
    runDirectoryAction,
} from '../../src/commands/directoryCommand';
import DirectoryDiscordCommandHandler from '../../src/commands/discord/handlers/DirectoryDiscordCommandHandler';
import { DiscordCommandHandlerMessage } from '../../src/commands/discord/DiscordCommandHandler';
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

function parse(text: string, currentThreadId: string | null = null) {
    const words = text.trim().split(/\s+/);
    return parseDirectoryCommand({
        content: `${COMMAND_PREFIX}${text}`,
        prefix: COMMAND_PREFIX,
        args: words.slice(1),
        currentThreadId,
    });
}

describe('parseThreadRef', () => {
    it('accepts mentions and IDs only', () => {
        expect(parseThreadRef(`<#${T1}>`)).toBe(T1);
        expect(parseThreadRef(T1)).toBe(T1);
        expect(parseThreadRef('hello')).toBeNull();
        expect(parseThreadRef('42')).toBeNull();
        expect(parseThreadRef(undefined)).toBeNull();
    });
});

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
                    },
                    { id: T2, name: 'b', description: null, hidden: true },
                ],
            }),
            messageUrl: () => 'https://example.test/m',
        });
        const result = await runDirectoryAction(svc, 'discord', 'g', 'chan', {
            kind: 'status',
        });
        expect(result).toMatchObject({
            status: true,
            lines: [`<#${T1}> — about a`, `🙈 <#${T2}>`],
        });
    });
});

describe('DirectoryDiscordCommandHandler', () => {
    function setup(canManage = true, parentId: string | null = null) {
        const reply = vi.fn().mockResolvedValue(undefined);
        const member = {
            permissions: { has: vi.fn().mockReturnValue(canManage) },
        };
        const message = {
            content: `${COMMAND_PREFIX}directory post Hi`,
            channelId: 'thread-or-chan',
            guildId: 'guild',
            author: { id: 'a', username: 'u', displayAvatarURL: () => '' },
            inGuild: () => true,
            channel: {
                isThread: () => parentId !== null,
                parentId,
                isSendable: () => true,
                send: vi.fn(),
            },
            guild: { members: { fetch: vi.fn().mockResolvedValue(member) } },
            reply,
        } as unknown as DiscordCommandHandlerMessage;
        const svc = {
            post: vi.fn().mockResolvedValue({ id: 1 }),
            messageUrl: vi.fn().mockReturnValue('https://example.test/m'),
        };
        const handler = new DirectoryDiscordCommandHandler(
            { user: { id: 'bot' } } as unknown as Client,
            svc as unknown as ThreadDirectoryService
        );
        return { handler, message, reply, svc };
    }

    it('posts in the parent channel when run in a thread', async () => {
        const t = setup(true, 'parent');
        await t.handler.handleCommand(t.message, 'directory', 'post', 'Hi');
        expect(t.svc.post).toHaveBeenCalledWith(
            'discord',
            'guild',
            'parent',
            'Hi'
        );
        expect(
            t.reply.mock.calls[0][0].embeds[0].toJSON().description
        ).toContain('https://example.test/m');
    });

    it('requires Manage Channels', async () => {
        const t = setup(false);
        await t.handler.handleCommand(t.message, 'directory', 'post');
        expect(t.svc.post).not.toHaveBeenCalled();
    });

    it('replies with usage for an unknown subcommand', async () => {
        const t = setup();
        await t.handler.handleCommand(t.message, 'directory', 'bogus');
        expect(t.svc.post).not.toHaveBeenCalled();
        expect(t.reply).toHaveBeenCalledTimes(1);
    });
});
