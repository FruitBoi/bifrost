import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    Client,
    Message,
    PermissionFlags,
    PermissionsBitField,
} from '@fluxerjs/core';
import HistoryFluxerCommandHandler from '../../../src/commands/fluxer/handlers/HistoryFluxerCommandHandler';
import {
    HISTORY_CONFIRM_TTL_MS,
    HISTORY_STATUS_EDIT_INTERVAL_MS,
} from '../../../src/commands/historyCommand';
import FluxerHistorySource from '../../../src/services/history/FluxerHistorySource';
import { HistoryTransferError } from '../../../src/services/history/HistoryTransferService';
import type {
    HistoryJob,
    HistoryOptions,
    HistorySource,
} from '../../../src/services/history/HistorySource';
import type HistoryTransferService from '../../../src/services/history/HistoryTransferService';
import type FluxerToDiscordMessageRelay from '../../../src/services/messageRelay/FluxerToDiscordMessageRelay';
import type ThreadSyncService from '../../../src/services/threadSync/ThreadSyncService';
import { EmbedColors } from '../../../src/utils/embeds';
import { FakeLinkService, makeChannelLink } from '../../helpers/fakes';

const MODERATOR_ROLE = '1561105750388908139';
const NOW = new Date('2026-10-20T12:00:00Z');
const LIMITS = { defaultCount: 100, maxCount: 1000 };
const DELAY_MS = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const client = {
    user: {
        id: 'bot',
        username: 'Bifröst',
        displayAvatarURL: () => 'https://example.invalid/bot.png',
    },
} as unknown as Client;

/** Records calls and hands out jobs the tests drive through `onProgress`. */
class FakeHistoryService {
    startCalls: {
        source: HistorySource<unknown>;
        options: HistoryOptions;
        requestedBy: string;
    }[] = [];
    stopCalls: string[] = [];
    jobs = new Map<string, HistoryJob>();
    onProgress: ((job: HistoryJob) => void) | null = null;
    failWith: HistoryTransferError | null = null;
    activeCount = 0;
    position = 0;

    start<M>(
        source: HistorySource<M>,
        options: HistoryOptions,
        requestedBy: string,
        onProgress?: (job: HistoryJob) => void
    ): HistoryJob {
        this.startCalls.push({ source, options, requestedBy });
        if (this.failWith) throw this.failWith;
        const job: HistoryJob = {
            id: `job-${this.startCalls.length}`,
            channelLinkId: source.link.id,
            sourcePlatform: source.platform,
            options,
            requestedBy,
            progress: {
                status: 'queued',
                scanned: 0,
                eligible: 0,
                transferred: 0,
                posts: 0,
                skippedBridged: 0,
                skippedOther: 0,
                failed: 0,
                lastMessageId: null,
                error: null,
                queuedAt: new Date(),
                startedAt: null,
                finishedAt: null,
            },
        };
        this.jobs.set(source.link.id, job);
        this.onProgress = onProgress ?? null;
        return job;
    }

    stop(channelLinkId: string): boolean {
        this.stopCalls.push(channelLinkId);
        return this.jobs.has(channelLinkId);
    }

    getJob(channelLinkId: string): HistoryJob | null {
        return this.jobs.get(channelLinkId) ?? null;
    }

    queuePosition(): number {
        return this.position;
    }

    report(patch: Partial<HistoryJob['progress']>): HistoryJob {
        const job = [...this.jobs.values()][0];
        Object.assign(job.progress, patch);
        this.onProgress?.(job);
        return job;
    }

    asService(): HistoryTransferService {
        return this as unknown as HistoryTransferService;
    }
}

interface FakeMessageOptions {
    content: string;
    inGuild?: boolean;
    bot?: boolean;
    webhookId?: string | null;
    authorId?: string;
    /** Role IDs of the author; a moderator by default. */
    roles?: string[];
    /** The bot's own permissions in the channel. */
    botPermissions?: bigint[];
    /** Whether the author member can be fetched. */
    memberFound?: boolean;
    /** Channel kind and id: a guild text channel by default. */
    channel?: Partial<Record<string, unknown>>;
    /** Whether `message.channel` is cached (else `resolveChannel` is used). */
    channelCached?: boolean;
    replyFails?: boolean;
}

function makeMessage({
    content,
    inGuild = true,
    bot = false,
    webhookId = null,
    authorId = 'author',
    roles = [MODERATOR_ROLE],
    botPermissions = [PermissionFlags.ReadMessageHistory],
    memberFound = true,
    channel: channelOverrides = {},
    channelCached = true,
    replyFails = false,
}: FakeMessageOptions) {
    const channel = {
        id: 'chan-1',
        isGuild: () => true,
        isText: () => true,
        isThread: () => false,
        messages: { fetch: vi.fn().mockResolvedValue(new Map()) },
        ...channelOverrides,
    };

    const botBits = new PermissionsBitField(botPermissions);
    const botMember = {
        id: 'bot',
        permissions: botBits,
        permissionsIn: vi.fn().mockReturnValue(botBits),
    };
    const author = {
        id: authorId,
        roles: { has: (id: string) => roles.includes(id) },
    };
    const guild = {
        id: 'guild-1',
        members: { me: botMember },
        fetchMember: vi.fn(async (id: string) => {
            if (id === authorId && memberFound) return author;
            throw new Error('Unknown Member');
        }),
    };

    const edit = vi.fn().mockResolvedValue(undefined);
    const reply = replyFails
        ? vi.fn().mockRejectedValue(new Error('Unknown Message'))
        : vi.fn().mockResolvedValue({ edit });
    const message = {
        id: '2000',
        content,
        channelId: channel.id,
        guildId: inGuild ? 'guild-1' : null,
        author: { id: authorId, bot, username: authorId },
        webhookId,
        channel: channelCached ? channel : null,
        guild: inGuild ? guild : null,
        resolveChannel: vi.fn().mockResolvedValue(channel),
        resolveGuild: vi.fn().mockResolvedValue(inGuild ? guild : null),
        reply,
    };
    return {
        message: message as unknown as Message,
        reply,
        edit,
        channel,
    };
}

type Embed = { data: { description?: string; title?: string; color?: number } };

function embedsOf(call: unknown[]): Embed[] {
    return (call[0] as { embeds?: Embed[] }).embeds ?? [];
}

function replied(reply: ReturnType<typeof vi.fn>): string[] {
    expect(reply).toHaveBeenCalled();
    return embedsOf(reply.mock.calls[0]).map((e) => e.data.description ?? '');
}

function titles(reply: ReturnType<typeof vi.fn>): (string | undefined)[] {
    return embedsOf(reply.mock.calls[0]).map((e) => e.data.title);
}

function colorOf(fn: ReturnType<typeof vi.fn>, call = 0): number | undefined {
    return embedsOf(fn.mock.calls[call])[0]?.data.color;
}

describe('HistoryFluxerCommandHandler', () => {
    let handler: HistoryFluxerCommandHandler;
    let linkService: FakeLinkService;
    let historyService: FakeHistoryService;
    let threadSyncService: { resolveFluxerThread: ReturnType<typeof vi.fn> };
    let messageRelay: {
        buildPayload: ReturnType<typeof vi.fn>;
        sendPayload: ReturnType<typeof vi.fn>;
    };
    let link: ReturnType<typeof makeChannelLink>;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
        linkService = new FakeLinkService();
        link = makeChannelLink({
            discordChannelId: 'dchan-1',
            fluxerChannelId: 'chan-1',
        });
        linkService.links.push(link);
        historyService = new FakeHistoryService();
        threadSyncService = {
            resolveFluxerThread: vi.fn().mockResolvedValue(null),
        };
        messageRelay = { buildPayload: vi.fn(), sendPayload: vi.fn() };
        handler = new HistoryFluxerCommandHandler(client, {
            linkService: linkService.asLinkService(),
            threadSyncService:
                threadSyncService as unknown as ThreadSyncService,
            messageRelay:
                messageRelay as unknown as FluxerToDiscordMessageRelay,
            historyService: historyService.asService(),
            moderatorRoleIds: [MODERATOR_ROLE],
            limits: LIMITS,
            delayMs: DELAY_MS,
        });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    const run = (message: Message, ...args: string[]) =>
        handler.handleCommand(message, 'history', ...args);

    it('refuses outside servers', async () => {
        const { message, reply } = makeMessage({
            content: '!b history',
            inGuild: false,
        });
        await run(message);
        expect(replied(reply)).toEqual([
            'This command must be used in a server.',
        ]);
        expect(historyService.startCalls).toHaveLength(0);
    });

    it('refuses bots and webhooks', async () => {
        const asBot = makeMessage({ content: '!b history', bot: true });
        await run(asBot.message);
        expect(replied(asBot.reply)).toEqual(['Bots cannot use this command.']);

        const asWebhook = makeMessage({
            content: '!b history',
            webhookId: 'wh-1',
        });
        await run(asWebhook.message);
        expect(replied(asWebhook.reply)).toEqual([
            'Bots cannot use this command.',
        ]);
        expect(historyService.startCalls).toHaveLength(0);
    });

    it('refuses members without a moderator role', async () => {
        const { message, reply } = makeMessage({
            content: '!b history',
            roles: ['some-other-role'],
        });
        await run(message);
        expect(replied(reply)).toEqual([
            'You do not have a role that is allowed to use this command.',
        ]);
        expect(historyService.startCalls).toHaveLength(0);
    });

    it('reports when the author member cannot be fetched', async () => {
        const { message, reply } = makeMessage({
            content: '!b history',
            memberFound: false,
        });
        await run(message);
        expect(replied(reply)).toEqual([
            'Could not fetch your member information.',
        ]);
    });

    it('explains parse failures and shows the usage', async () => {
        const { message, reply } = makeMessage({
            content: '!b history 10 -bogus',
        });
        await run(message, '10', '-bogus');
        expect(replied(reply)[0]).toBe('Unknown switch `-bogus`.');
        expect(titles(reply)[1]).toBe('Command Usage');
        expect(historyService.startCalls).toHaveLength(0);
    });

    it('reads the switches from the raw content', async () => {
        const { message } = makeMessage({
            content: '!b backfill 50 -digest -ma 7d',
        });
        await handler.handleCommand(
            message,
            'backfill',
            '50',
            '-digest',
            '-ma',
            '7d'
        );
        expect(historyService.startCalls).toHaveLength(1);
        expect(historyService.startCalls[0].options).toEqual({
            count: 50,
            maxAgeMs: 7 * DAY_MS,
            afterId: null,
            beforeId: null,
            mode: 'digest',
            timestamps: true,
        });
    });

    it('only works in text channels and threads', async () => {
        const { message, reply } = makeMessage({
            content: '!b history',
            channel: { isText: () => false, isThread: () => false },
        });
        await run(message);
        expect(replied(reply)).toEqual([
            'History can only be transferred from text channels and threads.',
        ]);
    });

    it('resolves the channel when it is not cached', async () => {
        const { message } = makeMessage({
            content: '!b history',
            channelCached: false,
        });
        await run(message);
        expect(message.resolveChannel).toHaveBeenCalled();
        expect(historyService.startCalls).toHaveLength(1);
    });

    it('refuses unlinked channels', async () => {
        linkService.links = [];
        const { message, reply } = makeMessage({ content: '!b history' });
        await run(message);
        expect(replied(reply)).toEqual([
            'This channel is not linked to a Discord channel or thread. Use `!b link` first.',
        ]);
        expect(historyService.startCalls).toHaveLength(0);
    });

    it('resolves unlinked threads through the thread sync service', async () => {
        linkService.links = [];
        const threadLink = makeChannelLink({
            fluxerChannelId: 'parent',
            fluxerThreadId: 'thread-1',
        });
        threadSyncService.resolveFluxerThread.mockResolvedValue(threadLink);
        const { message, channel } = makeMessage({
            content: '!b history',
            channel: {
                id: 'thread-1',
                isText: () => false,
                isThread: () => true,
            },
        });
        await run(message);
        expect(threadSyncService.resolveFluxerThread).toHaveBeenCalledWith(
            channel
        );
        expect(historyService.startCalls).toHaveLength(1);
        expect(historyService.startCalls[0].source.link).toBe(threadLink);
    });

    it('requires Read Message History for the bot', async () => {
        const { message, reply } = makeMessage({
            content: '!b history',
            botPermissions: [PermissionFlags.ViewChannel],
        });
        await run(message);
        expect(replied(reply)).toEqual([
            'I need the `Read Message History` permission in this channel to transfer its history.',
        ]);
        expect(historyService.startCalls).toHaveLength(0);
    });

    it('starts with the default count and builds a Fluxer source for the link', async () => {
        const { message, reply } = makeMessage({ content: '!b history' });
        await run(message);

        expect(historyService.startCalls).toHaveLength(1);
        const { source, options, requestedBy } = historyService.startCalls[0];
        expect(source).toBeInstanceOf(FluxerHistorySource);
        expect(source.platform).toBe('fluxer');
        expect(source.link).toBe(link);
        expect(source.guildLink.id).toBe(link.guildLinkId);
        expect(source.botUserId).toBe('bot');
        expect(requestedBy).toBe('author');
        expect(options).toEqual({
            count: 100,
            maxAgeMs: null,
            afterId: null,
            beforeId: null,
            mode: 'messages',
            timestamps: true,
        });

        const [description] = replied(reply);
        expect(description).toContain(
            '📜 **History transfer** → Discord channel `dchan-1`'
        );
        expect(description).toContain('⏳ Queued');
        expect(colorOf(reply)).toBe(EmbedColors.Info);
    });

    it('names the Discord thread when the link targets one', async () => {
        link.discordThreadId = 'dthread-9';
        const { message, reply } = makeMessage({ content: '!b history 3' });
        await run(message, '3');
        expect(replied(reply)[0]).toContain('→ Discord thread `dthread-9`');
    });

    it('still runs the job when the status reply cannot be posted', async () => {
        const { message } = makeMessage({
            content: '!b history 5',
            replyFails: true,
        });
        await expect(run(message, '5')).resolves.toBeUndefined();
        expect(historyService.startCalls).toHaveLength(1);
        historyService.report({ status: 'running', startedAt: NOW });
        await vi.advanceTimersByTimeAsync(HISTORY_STATUS_EDIT_INTERVAL_MS);
    });

    it('reports a transfer that is already running or queued', async () => {
        historyService.failWith = new HistoryTransferError(
            'already_running',
            'busy'
        );
        const { message, reply } = makeMessage({ content: '!b history' });
        await run(message);
        expect(replied(reply)).toEqual([
            'A history transfer is already running or queued for this channel. `!b history status` shows it, `!b history stop` cancels it.',
        ]);
        expect(colorOf(reply)).toBe(EmbedColors.Error);
    });

    it('relays the service message when Fluxer blocks the bot', async () => {
        historyService.failWith = new HistoryTransferError(
            'fluxer_blocked',
            'Fluxer API blocked the bot; try later'
        );
        const { message, reply } = makeMessage({ content: '!b history' });
        await run(message);
        expect(replied(reply)).toEqual([
            'Fluxer API blocked the bot; try later',
        ]);
    });

    describe('status and stop', () => {
        it('says when nothing runs here, counting transfers elsewhere', async () => {
            historyService.activeCount = 1;
            const { message, reply } = makeMessage({
                content: '!b history status',
            });
            await run(message, 'status');
            expect(replied(reply)).toEqual([
                'No history transfer is running or queued for this channel.\n1 transfer(s) are running or queued in other channels.',
            ]);
            expect(colorOf(reply)).toBe(EmbedColors.Info);
        });

        it('shows the queued job of this channel with its position', async () => {
            const start = makeMessage({ content: '!b history 20' });
            await run(start.message, '20');
            historyService.position = 2;

            const { message, reply } = makeMessage({
                content: '!b history status',
            });
            await run(message, 'status');
            const [description] = replied(reply);
            expect(description).toContain('⏳ Queued (position 2');
            expect(description).toContain('the last 20 message(s)');
            expect(description).toContain('`!b history stop` cancels');
        });

        it('stops the job of this channel', async () => {
            const start = makeMessage({ content: '!b history' });
            await run(start.message);

            const { message, reply } = makeMessage({
                content: '!b history stop',
            });
            await run(message, 'stop');
            expect(historyService.stopCalls).toEqual([link.id]);
            expect(replied(reply)[0]).toContain(
                'Stopping the history transfer for this channel.'
            );
            expect(colorOf(reply)).toBe(EmbedColors.Warning);
        });

        it('says so when there is nothing to stop', async () => {
            const { message, reply } = makeMessage({
                content: '!b history stop',
            });
            await run(message, 'stop');
            expect(replied(reply)).toEqual([
                'No history transfer is running or queued for this channel.',
            ]);
        });
    });

    describe('all + confirm', () => {
        it('asks for a confirmation instead of starting', async () => {
            const { message, reply } = makeMessage({
                content: '!b history all',
            });
            await run(message, 'all');
            expect(historyService.startCalls).toHaveLength(0);
            const [description] = replied(reply);
            expect(description).toContain(
                'copy **the whole history** of this channel to Discord channel `dchan-1`'
            );
            expect(description).toContain(
                'Run `!b history confirm` within 2 minutes to start.'
            );
            expect(colorOf(reply)).toBe(EmbedColors.Warning);
        });

        it('starts the pending transfer on confirm, once', async () => {
            const ask = makeMessage({ content: '!b history all -notime' });
            await run(ask.message, 'all', '-notime');

            const { message } = makeMessage({
                content: '!b history confirm',
            });
            await run(message, 'confirm');
            expect(historyService.startCalls).toHaveLength(1);
            expect(historyService.startCalls[0].options).toEqual({
                count: null,
                maxAgeMs: null,
                afterId: null,
                beforeId: null,
                mode: 'messages',
                timestamps: false,
            });

            const again = makeMessage({ content: '!b history confirm' });
            await run(again.message, 'confirm');
            expect(replied(again.reply)).toEqual([
                'Nothing to confirm. Run `!b history all` first; a confirmation is valid for 2 minutes.',
            ]);
            expect(historyService.startCalls).toHaveLength(1);
        });

        it('rejects a confirm without a pending request', async () => {
            const { message, reply } = makeMessage({
                content: '!b history confirm',
            });
            await run(message, 'confirm');
            expect(replied(reply)[0]).toContain('Nothing to confirm.');
            expect(colorOf(reply)).toBe(EmbedColors.Error);
        });

        it('forgets the request after two minutes', async () => {
            const ask = makeMessage({ content: '!b history all' });
            await run(ask.message, 'all');
            await vi.advanceTimersByTimeAsync(HISTORY_CONFIRM_TTL_MS);

            const { message, reply } = makeMessage({
                content: '!b history confirm',
            });
            await run(message, 'confirm');
            expect(replied(reply)[0]).toContain('Nothing to confirm.');
            expect(historyService.startCalls).toHaveLength(0);
        });

        it('must be confirmed in the channel it was requested in', async () => {
            const ask = makeMessage({ content: '!b history all' });
            await run(ask.message, 'all');

            linkService.links.push(
                makeChannelLink({
                    discordChannelId: 'dchan-2',
                    fluxerChannelId: 'chan-2',
                })
            );
            const { message, reply } = makeMessage({
                content: '!b history confirm',
                channel: { id: 'chan-2' },
            });
            await run(message, 'confirm');
            expect(replied(reply)).toEqual([
                'Your pending history transfer was requested in another channel; run `history confirm` there.',
            ]);
            expect(historyService.startCalls).toHaveLength(0);
        });
    });

    describe('status reply updates', () => {
        it('edits immediately on status changes and throttles progress in between', async () => {
            const { message, reply, edit } = makeMessage({
                content: '!b history 10',
            });
            await run(message, '10');
            expect(reply).toHaveBeenCalledTimes(1);
            expect(edit).not.toHaveBeenCalled();

            historyService.report({ status: 'running', startedAt: NOW });
            await vi.advanceTimersByTimeAsync(0);
            expect(edit).toHaveBeenCalledTimes(1);
            expect(embedsOf(edit.mock.calls[0])[0].data.description).toContain(
                '▶️ Running'
            );

            historyService.report({ transferred: 1, posts: 1 });
            await vi.advanceTimersByTimeAsync(1000);
            historyService.report({ transferred: 2, posts: 2 });
            await vi.advanceTimersByTimeAsync(1000);
            expect(edit).toHaveBeenCalledTimes(1);

            await vi.advanceTimersByTimeAsync(HISTORY_STATUS_EDIT_INTERVAL_MS);
            expect(edit).toHaveBeenCalledTimes(2);
            expect(embedsOf(edit.mock.calls[1])[0].data.description).toContain(
                '**Transferred:** 2 message(s) in 2 post(s)'
            );

            historyService.report({
                status: 'done',
                transferred: 3,
                posts: 3,
                finishedAt: new Date(NOW.getTime() + 20_000),
            });
            await vi.advanceTimersByTimeAsync(0);
            expect(edit).toHaveBeenCalledTimes(3);
            const final = embedsOf(edit.mock.calls[2])[0].data;
            expect(final.description).toContain('✅ Done');
            expect(final.description).toContain('**Elapsed:** 20s');
            expect(final.color).toBe(EmbedColors.Success);

            await vi.advanceTimersByTimeAsync(HISTORY_STATUS_EDIT_INTERVAL_MS);
            expect(edit).toHaveBeenCalledTimes(3);
        });

        it('shows failures in the error colour', async () => {
            const { message, edit } = makeMessage({
                content: '!b history 10',
            });
            await run(message, '10');
            historyService.report({ status: 'failed', error: 'Webhook gone' });
            await vi.advanceTimersByTimeAsync(0);
            const embed = embedsOf(edit.mock.calls[0])[0].data;
            expect(embed.description).toContain('❌ Failed: Webhook gone');
            expect(embed.color).toBe(EmbedColors.Error);
        });

        it('keeps going when an edit fails', async () => {
            const { message, edit } = makeMessage({
                content: '!b history 10',
            });
            edit.mockRejectedValueOnce(new Error('Unknown Message'));
            await run(message, '10');
            historyService.report({ status: 'running', startedAt: NOW });
            await vi.advanceTimersByTimeAsync(0);
            historyService.report({ status: 'done', finishedAt: NOW });
            await vi.advanceTimersByTimeAsync(0);
            expect(edit).toHaveBeenCalledTimes(2);
        });
    });
});
