import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Message } from '@fluxerjs/core';
import FluxerClaudeRequestReplyHandler from '../../../src/services/claudeRequest/FluxerClaudeRequestReplyHandler';
import ClaudeRequestService, {
    ClaudeRequestReplyResult,
} from '../../../src/services/claudeRequest/ClaudeRequestService';
import ClaudeRequestNotifyService from '../../../src/services/claudeRequest/ClaudeRequestNotifyService';
import { ClaudeRequestNotice } from '../../../src/db/entities/ClaudeRequestNotice';
import { EmbedColors } from '../../../src/utils/embeds';

const ALLOWED_ROLE = '1561105750388908139';
const NOTICE_ID = 'notice-1';

const notice: ClaudeRequestNotice = {
    id: 1,
    platform: 'fluxer',
    issueNumber: 42,
    issueUrl: 'https://github.com/o/r/issues/42',
    title: 'do the thing',
    userId: 'requester',
    guildId: 'guild-1',
    channelId: 'chan-1',
    noticeMessageId: NOTICE_ID,
    createdAt: new Date(0),
};

interface FakeMessageOptions {
    content?: string;
    roles?: string[];
    bot?: boolean;
    webhookId?: string | null;
    inGuild?: boolean;
    referencedId?: string | null;
}

function makeMessage({
    content = 'still broken',
    roles = [ALLOWED_ROLE],
    bot = false,
    webhookId = null,
    inGuild = true,
    referencedId = NOTICE_ID,
}: FakeMessageOptions = {}) {
    const member = {
        id: 'author',
        roles: {
            has: (id: string) => roles.includes(id),
            cache: { has: (id: string) => roles.includes(id) },
        },
    };
    const guild = {
        id: 'guild-1',
        name: 'Test Guild',
        fetchMember: vi.fn().mockResolvedValue(member),
        members: { fetch: vi.fn().mockResolvedValue(member) },
    };
    const reply = vi.fn().mockResolvedValue(undefined);
    const message = {
        id: '3000',
        content,
        url: 'https://example.test/msg/3000',
        channelId: 'chan-1',
        guildId: inGuild ? 'guild-1' : null,
        webhookId,
        author: { id: 'author', bot, username: 'author' },
        channel: { name: 'general' },
        guild: inGuild ? guild : null,
        inGuild: () => inGuild,
        resolveGuild: vi.fn().mockResolvedValue(inGuild ? guild : null),
        messageReference: referencedId
            ? {
                  messageId: referencedId,
                  channelId: 'chan-1',
                  guildId: 'guild-1',
              }
            : null,
        reply,
    };
    return { message: message as unknown as Message, reply };
}

const reopened: ClaudeRequestReplyResult = {
    ok: true,
    number: 42,
    url: 'https://github.com/o/r/issues/42',
    title: 'do the thing',
    reopened: true,
};

describe('FluxerClaudeRequestReplyHandler', () => {
    const reopenWithReply = vi.fn();
    const findNotice = vi.fn();
    const track = vi.fn();
    const service = { reopenWithReply } as unknown as ClaudeRequestService;
    const notifyService = {
        findNotice,
        track,
    } as unknown as ClaudeRequestNotifyService;
    const handler = () =>
        new FluxerClaudeRequestReplyHandler(service, notifyService, [
            ALLOWED_ROLE,
        ]);

    beforeEach(() => {
        reopenWithReply.mockReset().mockResolvedValue(reopened);
        findNotice
            .mockReset()
            .mockImplementation(async (_platform: string, id: string) =>
                id === NOTICE_ID ? notice : null
            );
        track.mockReset().mockResolvedValue(undefined);
    });

    it('comments, reopens, tracks and confirms a permitted reply', async () => {
        const { message, reply } = makeMessage();
        expect(await handler().handle(message)).toBe(true);

        expect(findNotice).toHaveBeenCalledWith('fluxer', NOTICE_ID);
        expect(reopenWithReply).toHaveBeenCalledWith(
            expect.objectContaining({
                issueNumber: 42,
                text: 'still broken',
                platform: 'fluxer',
                authorId: 'author',
                authorName: 'author',
                guildName: 'Test Guild',
                channelName: 'general',
            })
        );
        expect(track).toHaveBeenCalledWith({
            platform: 'fluxer',
            issueNumber: 42,
            issueUrl: 'https://github.com/o/r/issues/42',
            title: 'do the thing',
            userId: 'author',
            guildId: 'guild-1',
            channelId: 'chan-1',
            messageId: '3000',
        });
        expect(reply).toHaveBeenCalledTimes(1);
        const payload = reply.mock.calls[0][0];
        expect(payload.allowedMentions).toEqual({
            parse: [],
            repliedUser: false,
        });
        const embed = payload.embeds[0].data;
        expect(embed.color).toBe(EmbedColors.Success);
        expect(embed.description).toContain(
            '[#42](https://github.com/o/r/issues/42) and reopened it'
        );
    });

    it('ignores authors without an allowed role, silently', async () => {
        const { message, reply } = makeMessage({ roles: [] });
        expect(await handler().handle(message)).toBe(false);
        expect(reopenWithReply).not.toHaveBeenCalled();
        expect(reply).not.toHaveBeenCalled();
    });

    it('ignores replies to messages that are not notices', async () => {
        const { message, reply } = makeMessage({ referencedId: 'other' });
        expect(await handler().handle(message)).toBe(false);
        expect(reopenWithReply).not.toHaveBeenCalled();
        expect(reply).not.toHaveBeenCalled();
    });

    it.each([
        ['bots', { bot: true }],
        ['webhooks', { webhookId: 'hook' }],
        ['messages outside a guild', { inGuild: false }],
        ['messages that are not replies', { referencedId: null }],
        ['empty messages', { content: '   ' }],
    ] as [string, FakeMessageOptions][])('ignores %s', async (_, options) => {
        const { message, reply } = makeMessage(options);
        expect(await handler().handle(message)).toBe(false);
        expect(findNotice).not.toHaveBeenCalled();
        expect(reply).not.toHaveBeenCalled();
    });

    it('explains a failure without tracking', async () => {
        reopenWithReply.mockResolvedValue({
            ok: false,
            reason: 'github_error',
            detail: '404 Not Found',
        });
        const { message, reply } = makeMessage();
        expect(await handler().handle(message)).toBe(true);
        expect(track).not.toHaveBeenCalled();
        const embed = reply.mock.calls[0][0].embeds[0].data;
        expect(embed.color).toBe(EmbedColors.Error);
        expect(embed.description).toBe(
            'Could not post your reply on GitHub: 404 Not Found'
        );
    });

    it('asks to wait while on cooldown', async () => {
        reopenWithReply.mockResolvedValue({
            ok: false,
            reason: 'cooldown',
            retryAfterMs: 5_000,
        });
        const { message, reply } = makeMessage();
        expect(await handler().handle(message)).toBe(true);
        expect(reply.mock.calls[0][0].embeds[0].data.description).toBe(
            'Please wait 5 seconds before sending another reply.'
        );
    });

    it('does not track a reply whose issue could not be reopened', async () => {
        reopenWithReply.mockResolvedValue({
            ...reopened,
            reopened: false,
            detail: '403 nope',
        });
        const { message, reply } = makeMessage();
        expect(await handler().handle(message)).toBe(true);
        expect(track).not.toHaveBeenCalled();
        expect(reply.mock.calls[0][0].embeds[0].data.color).toBe(
            EmbedColors.Warning
        );
    });

    it('never throws', async () => {
        reopenWithReply.mockRejectedValue(new Error('boom'));
        const { message } = makeMessage();
        expect(await handler().handle(message)).toBe(false);
    });
});
