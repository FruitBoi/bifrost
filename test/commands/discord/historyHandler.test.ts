import type { RoleIdsResolver } from '../../../src/services/commandRoles/CommandRoleService';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import HistoryDiscordCommandHandler from '../../../src/commands/discord/handlers/HistoryDiscordCommandHandler';
import { DiscordCommandHandlerMessage } from '../../../src/commands/discord/DiscordCommandHandler';
import {
    HISTORY_CONFIRM_TTL_MS,
    HISTORY_STATUS_EDIT_INTERVAL_MS,
} from '../../../src/commands/historyCommand';
import DiscordHistorySource from '../../../src/services/history/DiscordHistorySource';
import { HistoryTransferError } from '../../../src/services/history/HistoryTransferService';
import type {
    HistoryJob,
    HistoryOptions,
    HistorySource,
} from '../../../src/services/history/HistorySource';
import type HistoryTransferService from '../../../src/services/history/HistoryTransferService';
import type DiscordToFluxerMessageRelay from '../../../src/services/messageRelay/DiscordToFluxerMessageRelay';
import type ThreadSyncService from '../../../src/services/threadSync/ThreadSyncService';
import { EmbedColors } from '../../../src/utils/embeds';
import { FakeLinkService, makeChannelLink } from '../../helpers/fakes';

const MOD_ROLE = '1561105750388908139';
const NOW = new Date('2026-10-20T12:00:00Z');
const LIMITS = { defaultCount: 100, maxCount: 1000 };
const DELAY_MS = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

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

    /** Mutates the job in place (like the real service) and reports it. */
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

function makeMember(roleIds: string[] = [MOD_ROLE]) {
    return { roles: { cache: new Set(roleIds) } };
}

function makeBotMember(
    permissions: bigint[] = [PermissionFlagsBits.ReadMessageHistory]
) {
    const bits = new PermissionsBitField(permissions);
    return { permissionsIn: vi.fn().mockReturnValue(bits) };
}

function makeChannel(overrides: Partial<Record<string, unknown>> = {}) {
    return {
        id: 'chan-1',
        isTextBased: () => true,
        isVoiceBased: () => false,
        isThread: () => false,
        isSendable: () => true,
        messages: { fetch: vi.fn().mockResolvedValue(new Map()) },
        ...overrides,
    };
}

interface FakeMessageOptions {
    content: string;
    inGuild?: boolean;
    bot?: boolean;
    authorId?: string;
    member?: ReturnType<typeof makeMember> | null;
    botMember?: ReturnType<typeof makeBotMember> | null;
    channel?: ReturnType<typeof makeChannel>;
    /** What `message.reply` resolves to for the status embed. */
    replyFails?: boolean;
}

function makeMessage({
    content,
    inGuild = true,
    bot = false,
    authorId = 'author',
    member = makeMember(),
    botMember = makeBotMember(),
    channel = makeChannel(),
    replyFails = false,
}: FakeMessageOptions) {
    const edit = vi.fn().mockResolvedValue(undefined);
    const reply = replyFails
        ? vi.fn().mockRejectedValue(new Error('Unknown Message'))
        : vi.fn().mockResolvedValue({ edit });
    const message = {
        id: '2000000000000000000',
        content,
        channelId: channel.id,
        guildId: inGuild ? 'guild-1' : null,
        inGuild: () => inGuild,
        author: {
            id: authorId,
            bot,
            username: authorId,
            displayAvatarURL: () => 'https://example.invalid/a.png',
        },
        channel,
        guild: inGuild
            ? {
                  members: {
                      me: botMember,
                      fetchMe: vi.fn().mockResolvedValue(botMember),
                      fetch: vi.fn(async (id: string) => {
                          if (id !== authorId || !member) {
                              throw new Error('Unknown Member');
                          }
                          return member;
                      }),
                  },
              }
            : null,
        reply,
    };
    return {
        message: message as unknown as DiscordCommandHandlerMessage,
        reply,
        edit,
        channel,
    };
}

type Embed = { data: { description?: string; title?: string; color?: number } };

function embedsOf(call: unknown[]): Embed[] {
    return (call[0] as { embeds?: Embed[] }).embeds ?? [];
}

/** Descriptions of every embed sent in the first reply. */
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

const client = {
    user: {
        id: 'bot',
        username: 'Bifröst',
        displayAvatarURL: () => 'https://example.invalid/bot.png',
    },
} as unknown as Client;

describe('HistoryDiscordCommandHandler', () => {
    let handler: HistoryDiscordCommandHandler;
    let buildHandler: (
        moderatorRoleIds: RoleIdsResolver
    ) => HistoryDiscordCommandHandler;
    let linkService: FakeLinkService;
    let historyService: FakeHistoryService;
    let threadSyncService: { resolveDiscordThread: ReturnType<typeof vi.fn> };
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
            discordChannelId: 'chan-1',
            fluxerChannelId: 'fchan-1',
        });
        linkService.links.push(link);
        historyService = new FakeHistoryService();
        threadSyncService = {
            resolveDiscordThread: vi.fn().mockResolvedValue(null),
        };
        messageRelay = { buildPayload: vi.fn(), sendPayload: vi.fn() };
        buildHandler = (moderatorRoleIds) =>
            new HistoryDiscordCommandHandler(client, {
                linkService: linkService.asLinkService(),
                threadSyncService:
                    threadSyncService as unknown as ThreadSyncService,
                messageRelay:
                    messageRelay as unknown as DiscordToFluxerMessageRelay,
                historyService: historyService.asService(),
                moderatorRoleIds,
                limits: LIMITS,
                delayMs: DELAY_MS,
            });
        handler = buildHandler(async () => [MOD_ROLE]);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    const run = (message: DiscordCommandHandlerMessage, ...args: string[]) =>
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

    it('refuses bots', async () => {
        const { message, reply } = makeMessage({
            content: '!b history',
            bot: true,
        });
        await run(message);
        expect(replied(reply)).toEqual(['Bots cannot use this command.']);
        expect(historyService.startCalls).toHaveLength(0);
    });

    it('resolves the roles for the message guild (issue #43)', async () => {
        const resolver = vi.fn(async (guildId: string) =>
            guildId === 'guild-1' ? ['guild-1-mod'] : [MOD_ROLE]
        );
        handler = buildHandler(resolver);
        const { message, reply } = makeMessage({
            content: '!b history',
            member: makeMember([MOD_ROLE]),
        });
        await run(message);
        expect(resolver).toHaveBeenCalledWith('guild-1');
        expect(replied(reply)).toEqual([
            'You do not have a role that is allowed to use this command.',
        ]);
        expect(historyService.startCalls).toHaveLength(0);
    });

    it('rejects members without a moderator role', async () => {
        const { message, reply } = makeMessage({
            content: '!b history',
            member: makeMember(['some-other-role']),
        });
        await run(message);
        expect(replied(reply)).toEqual([
            'You do not have a role that is allowed to use this command.',
        ]);
        expect(historyService.startCalls).toHaveLength(0);
    });

    it('explains parse failures and shows the usage', async () => {
        const { message, reply } = makeMessage({
            content: '!b history lots',
        });
        await run(message, 'lots');
        expect(replied(reply)[0]).toBe(
            '`lots` is not a valid number of messages; give a whole number from 1 to 1000, or `all`.'
        );
        expect(titles(reply)[1]).toBe('Command Usage');
        expect(historyService.startCalls).toHaveLength(0);
    });

    it('reads the switches from the raw content, not the split args', async () => {
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
            channel: makeChannel({ isVoiceBased: () => true }),
        });
        await run(message);
        expect(replied(reply)).toEqual([
            'History can only be transferred from text channels and threads.',
        ]);
    });

    it('refuses unlinked channels', async () => {
        linkService.links = [];
        const { message, reply } = makeMessage({ content: '!b history' });
        await run(message);
        expect(replied(reply)).toEqual([
            'This channel is not linked to a Fluxer channel or thread. Use `!b link` first.',
        ]);
        expect(historyService.startCalls).toHaveLength(0);
    });

    it('resolves unlinked threads through the thread sync service', async () => {
        linkService.links = [];
        const threadLink = makeChannelLink({
            discordChannelId: 'parent',
            discordThreadId: 'thread-1',
        });
        threadSyncService.resolveDiscordThread.mockResolvedValue(threadLink);
        const channel = makeChannel({
            id: 'thread-1',
            isThread: () => true,
        });
        const { message } = makeMessage({ content: '!b history', channel });
        await run(message);
        expect(threadSyncService.resolveDiscordThread).toHaveBeenCalledWith(
            channel
        );
        expect(historyService.startCalls).toHaveLength(1);
        expect(historyService.startCalls[0].source.link).toBe(threadLink);
    });

    it('requires Read Message History for the bot', async () => {
        const { message, reply } = makeMessage({
            content: '!b history',
            botMember: makeBotMember([PermissionFlagsBits.ViewChannel]),
        });
        await run(message);
        expect(replied(reply)).toEqual([
            'I need the `Read Message History` permission in this channel to transfer its history.',
        ]);
        expect(historyService.startCalls).toHaveLength(0);
    });

    it('fetches the bot member when it is not cached', async () => {
        const { message } = makeMessage({
            content: '!b history',
            botMember: null,
        });
        (
            message.guild!.members.fetchMe as unknown as ReturnType<
                typeof vi.fn
            >
        ).mockResolvedValue(makeBotMember());
        await run(message);
        expect(message.guild!.members.fetchMe).toHaveBeenCalled();
        expect(historyService.startCalls).toHaveLength(1);
    });

    it('starts with the default count and builds a Discord source for the link', async () => {
        const { message, reply } = makeMessage({ content: '!b history' });
        await run(message);

        expect(historyService.startCalls).toHaveLength(1);
        const { source, options, requestedBy } = historyService.startCalls[0];
        expect(source).toBeInstanceOf(DiscordHistorySource);
        expect(source.platform).toBe('discord');
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
            '📜 **History transfer** → Fluxer channel `fchan-1`'
        );
        expect(description).toContain('⏳ Queued');
        expect(description).toContain('the last 100 message(s)');
        expect(description).toContain('one post per message');
        expect(colorOf(reply)).toBe(EmbedColors.Info);
    });

    it('still runs the job when the status reply cannot be posted', async () => {
        const { message, reply } = makeMessage({
            content: '!b history 5',
            replyFails: true,
        });
        await expect(run(message, '5')).resolves.toBeUndefined();
        expect(reply).toHaveBeenCalledTimes(1);
        expect(historyService.startCalls).toHaveLength(1);
        // Progress after the failed reply must not throw either.
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
            const { message, reply } = makeMessage({
                content: '!b history status',
            });
            await run(message, 'status');
            expect(replied(reply)).toEqual([
                'No history transfer is running or queued for this channel.',
            ]);

            historyService.activeCount = 2;
            const second = makeMessage({ content: '!b history status' });
            await run(second.message, 'status');
            expect(replied(second.reply)).toEqual([
                'No history transfer is running or queued for this channel.\n2 transfer(s) are running or queued in other channels.',
            ]);
            expect(historyService.startCalls).toHaveLength(0);
        });

        it('shows the running job of this channel', async () => {
            const start = makeMessage({ content: '!b history 20' });
            await run(start.message, '20');
            historyService.report({
                status: 'running',
                startedAt: new Date(NOW.getTime() - 90_000),
                scanned: 40,
                eligible: 30,
                transferred: 12,
                posts: 12,
                skippedBridged: 7,
                skippedOther: 3,
                failed: 1,
                lastMessageId: '555',
            });

            const { message, reply } = makeMessage({
                content: '!b history status',
            });
            await run(message, 'status');
            const [description] = replied(reply);
            expect(description).toContain('▶️ Running');
            expect(description).toContain(
                '**Transferred:** 12 message(s) in 12 post(s)'
            );
            expect(description).toContain(
                '**Skipped:** 7 already bridged, 3 other'
            );
            expect(description).toContain('**Failed:** 1');
            expect(description).toContain('**Scanned:** 40 (30 eligible)');
            expect(description).toContain('**Last message:** `555`');
            expect(description).toContain('**Elapsed:** 1m 30s');
            expect(description).toContain('the last 20 message(s)');
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
                content: '!b history cancel',
            });
            await run(message, 'cancel');
            expect(historyService.stopCalls).toEqual([link.id]);
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
                'copy **the whole history** of this channel to Fluxer channel `fchan-1`'
            );
            expect(description).toContain('one every 1s');
            expect(description).toContain('1000 messages take about 16m 40s');
            expect(description).toContain('`-digest`');
            expect(description).toContain(
                'Run `!b history confirm` within 2 minutes to start.'
            );
            expect(colorOf(reply)).toBe(EmbedColors.Warning);
        });

        it('does not suggest -digest when it is already given', async () => {
            const { message, reply } = makeMessage({
                content: '!b history all -digest -notime',
            });
            await run(message, 'all', '-digest', '-notime');
            const [description] = replied(reply);
            expect(description).not.toContain('Tip:');
            expect(description).toContain('without timestamps');
        });

        it('starts the pending transfer on confirm', async () => {
            const ask = makeMessage({
                content: '!b history all -ma 30d -digest',
            });
            await run(ask.message, 'all', '-ma', '30d', '-digest');

            const { message } = makeMessage({
                content: '!b history confirm',
            });
            await run(message, 'confirm');
            expect(historyService.startCalls).toHaveLength(1);
            expect(historyService.startCalls[0].options).toEqual({
                count: null,
                maxAgeMs: 30 * DAY_MS,
                afterId: null,
                beforeId: null,
                mode: 'digest',
                timestamps: true,
            });

            // The confirmation is used up.
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
            expect(replied(reply)).toEqual([
                'Nothing to confirm. Run `!b history all` first; a confirmation is valid for 2 minutes.',
            ]);
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

        it('is per user', async () => {
            const ask = makeMessage({ content: '!b history all' });
            await run(ask.message, 'all');

            const other = makeMessage({
                content: '!b history confirm',
                authorId: 'someone-else',
            });
            await run(other.message, 'confirm');
            expect(replied(other.reply)[0]).toContain('Nothing to confirm.');
            expect(historyService.startCalls).toHaveLength(0);
        });

        it('must be confirmed in the channel it was requested in', async () => {
            const ask = makeMessage({ content: '!b history all' });
            await run(ask.message, 'all');

            const otherLink = makeChannelLink({
                discordChannelId: 'chan-2',
                fluxerChannelId: 'fchan-2',
            });
            linkService.links.push(otherLink);
            const { message, reply } = makeMessage({
                content: '!b history confirm',
                channel: makeChannel({ id: 'chan-2' }),
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

            // queued → running: shown at once.
            historyService.report({ status: 'running', startedAt: NOW });
            await vi.advanceTimersByTimeAsync(0);
            expect(edit).toHaveBeenCalledTimes(1);
            expect(embedsOf(edit.mock.calls[0])[0].data.description).toContain(
                '▶️ Running'
            );

            // Progress within the throttle window is held back...
            historyService.report({ transferred: 1, posts: 1 });
            await vi.advanceTimersByTimeAsync(1000);
            historyService.report({ transferred: 2, posts: 2 });
            await vi.advanceTimersByTimeAsync(1000);
            expect(edit).toHaveBeenCalledTimes(1);

            // ...and the latest state lands once the window is over.
            await vi.advanceTimersByTimeAsync(HISTORY_STATUS_EDIT_INTERVAL_MS);
            expect(edit).toHaveBeenCalledTimes(2);
            expect(embedsOf(edit.mock.calls[1])[0].data.description).toContain(
                '**Transferred:** 2 message(s) in 2 post(s)'
            );

            // Finishing is shown at once, in the success colour.
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
            expect(final.description).toContain(
                '**Transferred:** 3 message(s) in 3 post(s)'
            );
            expect(final.description).not.toContain('history stop');
            expect(final.color).toBe(EmbedColors.Success);

            // No stale trailing edit after the final one.
            await vi.advanceTimersByTimeAsync(HISTORY_STATUS_EDIT_INTERVAL_MS);
            expect(edit).toHaveBeenCalledTimes(3);
        });

        it('shows failures and stops in their colours', async () => {
            const failed = makeMessage({ content: '!b history 10' });
            await run(failed.message, '10');
            historyService.report({
                status: 'failed',
                error: 'Webhook gone',
            });
            await vi.advanceTimersByTimeAsync(0);
            const failedEmbed = embedsOf(failed.edit.mock.calls[0])[0].data;
            expect(failedEmbed.description).toContain(
                '❌ Failed: Webhook gone'
            );
            expect(failedEmbed.color).toBe(EmbedColors.Error);

            historyService.jobs.clear();
            const stopped = makeMessage({ content: '!b history 10' });
            await run(stopped.message, '10');
            historyService.report({ status: 'stopped' });
            await vi.advanceTimersByTimeAsync(0);
            const stoppedEmbed = embedsOf(stopped.edit.mock.calls[0])[0].data;
            expect(stoppedEmbed.description).toContain('⏹️ Stopped');
            expect(stoppedEmbed.color).toBe(EmbedColors.Warning);
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
