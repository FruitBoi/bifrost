import { afterEach, describe, expect, it } from 'vitest';
import type {
    CreateHistoryMessageData,
    HistoryMessageRepository,
} from '../../../src/db/repositories/HistoryMessageRepository';
import { ChannelLink } from '../../../src/db/entities/ChannelLink';
import { MessagePlatform } from '../../../src/db/entities/MessageLink';
import { compareSnowflakes } from '../../../src/services/clean/cleanFilter';
import HistoryTransferService, {
    FLUXER_BLOCKED_MESSAGE,
    HistoryTransferError,
    HistoryTransferSettings,
    isHistoryEligible,
    rateLimitWaitMs,
    withTimestampPrefix,
} from '../../../src/services/history/HistoryTransferService';
import {
    HistoryItem,
    HistoryJob,
    HistoryOptions,
    HistorySource,
} from '../../../src/services/history/HistorySource';
import { WebhookMessageData } from '../../../src/services/WebhookService';
import {
    isFluxerApiBlocked,
    markFluxerApiBlocked,
    markFluxerApiOk,
} from '../../../src/utils/fluxerApiGuard';
import { flush, guildLink, makeChannelLink } from '../../helpers/fakes';

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
const MINUTE_MS = 60_000;
/** Well beyond Number's 2^53 precision, like real snowflakes. */
const BASE = BigInt('1561105750388908000');
/** Messages are one minute apart; index 0 is the oldest. */
const SPAN = 1000;

/** ID of the i-th oldest message in the fake channel. */
function idAt(i: number): string {
    return (BASE + BigInt(i)).toString();
}

/** The i-th oldest message, `SPAN - i` minutes old. */
function item(
    i: number,
    overrides: Partial<HistoryItem<null>> = {}
): HistoryItem<null> {
    return {
        id: idAt(i),
        createdAt: new Date(NOW - (SPAN - i) * MINUTE_MS),
        authorId: 'alice',
        authorName: 'Alice',
        authorIsBot: false,
        webhookId: null,
        isSystem: false,
        isEmpty: false,
        isCommand: false,
        raw: null,
        ...overrides,
    };
}

/** `n` messages oldest first, each customised by index. */
function history(
    n: number,
    customise: (i: number) => Partial<HistoryItem<null>> = () => ({})
): HistoryItem<null>[] {
    return Array.from({ length: n }, (_, i) => item(i, customise(i)));
}

function opts(overrides: Partial<HistoryOptions> = {}): HistoryOptions {
    return {
        count: 100,
        maxAgeMs: null,
        afterId: null,
        beforeId: null,
        mode: 'messages',
        timestamps: true,
        ...overrides,
    };
}

/** Pages are returned in the "wrong" order to exercise the sorting. */
class FakeSource implements HistorySource<null> {
    readonly guildLink = guildLink;
    readonly botUserId: string | null = 'bot';
    bridged = new Set<string>();
    sent: WebhookMessageData[] = [];
    messageLinks: { sourceId: string; targetId: string }[] = [];
    fetchBeforeCalls: { beforeId: string | undefined; limit: number }[] = [];
    fetchAfterCalls: { afterId: string; limit: number }[] = [];
    sendImpl:
        | ((payload: WebhookMessageData) => Promise<{ messageId: string }>)
        | null = null;
    buildImpl:
        | ((item: HistoryItem<null>) => Promise<WebhookMessageData>)
        | null = null;
    contentFor: (item: HistoryItem<null>) => string = (item) =>
        `msg ${item.id}`;
    onFetchBefore: (() => void) | null = null;

    constructor(
        readonly platform: MessagePlatform,
        public items: HistoryItem<null>[],
        readonly link: ChannelLink = makeChannelLink()
    ) {}

    async fetchBefore(beforeId: string | undefined, limit: number) {
        this.fetchBeforeCalls.push({ beforeId, limit });
        this.onFetchBefore?.();
        return this.items
            .filter(
                (i) =>
                    beforeId === undefined ||
                    compareSnowflakes(i.id, beforeId) < 0
            )
            .sort((a, b) => compareSnowflakes(b.id, a.id))
            .slice(0, limit)
            .reverse();
    }

    async fetchAfter(afterId: string, limit: number) {
        this.fetchAfterCalls.push({ afterId, limit });
        return this.items
            .filter((i) => compareSnowflakes(i.id, afterId) > 0)
            .sort((a, b) => compareSnowflakes(a.id, b.id))
            .slice(0, limit)
            .reverse();
    }

    async buildPayload(item: HistoryItem<null>): Promise<WebhookMessageData> {
        if (this.buildImpl) return this.buildImpl(item);
        return {
            content: this.contentFor(item),
            username: item.authorName,
            avatarURL: 'https://alice.png',
            mentionUserIds: ['u1'],
        };
    }

    async send(payload: WebhookMessageData) {
        if (this.sendImpl) return this.sendImpl(payload);
        this.sent.push(payload);
        return { messageId: `t-${this.sent.length}` };
    }

    async isBridged(messageId: string) {
        return this.bridged.has(messageId);
    }

    async createMessageLink(item: HistoryItem<null>, targetMessageId: string) {
        this.messageLinks.push({
            sourceId: item.id,
            targetId: targetMessageId,
        });
    }

    digestIdentity() {
        return { username: 'Bifröst', avatarURL: 'https://bot.png' };
    }
}

class FakeRepo implements HistoryMessageRepository {
    rows: CreateHistoryMessageData[] = [];

    async createMany(rows: CreateHistoryMessageData[]) {
        for (const row of rows) {
            const exists = this.rows.some(
                (r) =>
                    r.sourcePlatform === row.sourcePlatform &&
                    r.sourceMessageId === row.sourceMessageId
            );
            if (!exists) this.rows.push({ ...row });
        }
    }

    async findTransferredIds(
        sourcePlatform: MessagePlatform,
        sourceMessageIds: readonly string[]
    ) {
        return new Set(
            sourceMessageIds.filter((id) =>
                this.rows.some(
                    (r) =>
                        r.sourcePlatform === sourcePlatform &&
                        r.sourceMessageId === id
                )
            )
        );
    }

    async deleteByChannelLinkId(channelLinkId: string) {
        this.rows = this.rows.filter((r) => r.channelLinkId !== channelLinkId);
    }

    async deleteByGuildLinkId(guildLinkId: string) {
        this.rows = this.rows.filter((r) => r.guildLinkId !== guildLinkId);
    }

    async count() {
        return this.rows.length;
    }
}

function makeService(
    repo: HistoryMessageRepository = new FakeRepo(),
    overrides: Partial<HistoryTransferSettings> = {}
) {
    const sleeps: number[] = [];
    const service = new HistoryTransferService(repo, {
        delayMs: 1000,
        pageSize: 10,
        sleep: async (ms) => {
            sleeps.push(ms);
        },
        now: () => NOW,
        ...overrides,
    });
    return { service, sleeps };
}

function isFinished(job: HistoryJob): boolean {
    return ['done', 'stopped', 'failed'].includes(job.progress.status);
}

async function waitFor(predicate: () => boolean): Promise<void> {
    for (let i = 0; i < 1000 && !predicate(); i++) await flush();
    if (!predicate()) throw new Error('condition never became true');
}

async function run(
    service: HistoryTransferService,
    source: FakeSource,
    options: HistoryOptions,
    onProgress?: (job: HistoryJob) => void
): Promise<HistoryJob> {
    const job = service.start(source, options, 'mod', onProgress);
    await waitFor(() => isFinished(job));
    return job;
}

/** A promise that resolves when `release` is called. */
function gate() {
    let release!: () => void;
    const opened = new Promise<void>((resolve) => {
        release = resolve;
    });
    return { opened, release };
}

/** Content of the sent copies in order, timestamp lines stripped. */
function sentBodies(source: FakeSource): string[] {
    return source.sent.map((p) => p.content.replace(/^-# <t:\d+:f>\n?/, ''));
}

function unix(date: Date): number {
    return Math.floor(date.getTime() / 1000);
}

afterEach(() => {
    markFluxerApiOk();
});

describe('helpers', () => {
    it('isHistoryEligible excludes system, empty, command and the bot itself', () => {
        expect(isHistoryEligible(item(0), 'bot')).toBe(true);
        expect(isHistoryEligible(item(0, { isSystem: true }), 'bot')).toBe(
            false
        );
        expect(isHistoryEligible(item(0, { isEmpty: true }), 'bot')).toBe(
            false
        );
        expect(isHistoryEligible(item(0, { isCommand: true }), 'bot')).toBe(
            false
        );
        expect(isHistoryEligible(item(0, { authorId: 'bot' }), 'bot')).toBe(
            false
        );
        expect(isHistoryEligible(item(0, { authorId: 'bot' }), null)).toBe(
            true
        );
        // Bridged copies and other bots count as eligible.
        expect(isHistoryEligible(item(0, { webhookId: 'dwh' }), 'bot')).toBe(
            true
        );
        expect(isHistoryEligible(item(0, { authorIsBot: true }), 'bot')).toBe(
            true
        );
    });

    it('withTimestampPrefix prepends the time line and keeps the total under the limit', () => {
        const when = new Date(NOW);
        expect(withTimestampPrefix('hello', when)).toBe(
            `-# <t:${unix(when)}:f>\nhello`
        );
        expect(withTimestampPrefix('', when)).toBe(`-# <t:${unix(when)}:f>`);
        const long = withTimestampPrefix('x'.repeat(3000), when);
        expect(long).toHaveLength(2000);
        expect(long.endsWith('…')).toBe(true);
        expect(withTimestampPrefix('x'.repeat(1980), when)).toHaveLength(2000);
    });

    it('rateLimitWaitMs recognises the usual rate-limit shapes', () => {
        expect(rateLimitWaitMs(new Error('boom'))).toBeNull();
        expect(rateLimitWaitMs(null)).toBeNull();
        expect(rateLimitWaitMs({ statusCode: 500 })).toBeNull();
        expect(rateLimitWaitMs({ statusCode: 429 })).toBe(5000);
        expect(rateLimitWaitMs({ status: 429, retry_after: 2.5 })).toBe(2500);
        expect(rateLimitWaitMs({ name: 'RateLimitError', retryAfter: 3 })).toBe(
            3000
        );
        expect(rateLimitWaitMs({ retryAfter: 120 })).toBe(60_000);
        expect(rateLimitWaitMs({ statusCode: 429, retryAfter: 0 })).toBe(5000);
    });
});

describe('HistoryTransferService scoping', () => {
    it('transfers the last N eligible messages, oldest first', async () => {
        const source = new FakeSource('discord', history(25));
        const { service } = makeService();
        const job = await run(service, source, opts({ count: 10 }));

        expect(job.progress.status).toBe('done');
        expect(sentBodies(source)).toEqual(
            Array.from({ length: 10 }, (_, i) => `msg ${idAt(15 + i)}`)
        );
        expect(job.progress).toMatchObject({
            scanned: 10,
            eligible: 10,
            transferred: 10,
            posts: 10,
            skippedBridged: 0,
            skippedOther: 0,
            failed: 0,
            lastMessageId: idAt(24),
            error: null,
        });
        expect(job.progress.startedAt).toEqual(new Date(NOW));
        expect(job.progress.finishedAt).toEqual(new Date(NOW));
        // The backward scan pages newest first from the top of the channel.
        expect(source.fetchBeforeCalls[0]).toEqual({
            beforeId: undefined,
            limit: 10,
        });
        expect(source.fetchAfterCalls[0].afterId).toBe(
            (BigInt(idAt(15)) - BigInt(1)).toString()
        );
    });

    it('transfers everything when the count exceeds the history', async () => {
        const source = new FakeSource('fluxer', history(5));
        const { service } = makeService();
        const job = await run(service, source, opts({ count: 100 }));
        expect(job.progress.transferred).toBe(5);
        expect(sentBodies(source)[0]).toBe(`msg ${idAt(0)}`);
    });

    it('does nothing for an empty history', async () => {
        const source = new FakeSource('discord', []);
        const { service } = makeService();
        const job = await run(service, source, opts());
        expect(job.progress.status).toBe('done');
        expect(job.progress.scanned).toBe(0);
        expect(source.sent).toEqual([]);
    });

    it('scans forward from the start for all', async () => {
        const source = new FakeSource('discord', history(25));
        const { service } = makeService();
        const job = await run(service, source, opts({ count: null }));
        expect(job.progress.transferred).toBe(25);
        expect(source.fetchBeforeCalls).toEqual([]);
        expect(source.fetchAfterCalls[0].afterId).toBe('0');
        expect(sentBodies(source)[24]).toBe(`msg ${idAt(24)}`);
    });

    it('limits by max age', async () => {
        const source = new FakeSource('discord', history(25));
        const { service } = makeService();
        // Messages 20..24 are 980..976 minutes old.
        const job = await run(
            service,
            source,
            opts({ count: 100, maxAgeMs: 980.5 * MINUTE_MS })
        );
        expect(sentBodies(source)).toEqual(
            [20, 21, 22, 23, 24].map((i) => `msg ${idAt(i)}`)
        );
        expect(job.progress.skippedOther).toBe(0);
    });

    it('limits all by max age', async () => {
        const source = new FakeSource('discord', history(25));
        const { service } = makeService();
        const job = await run(
            service,
            source,
            opts({ count: null, maxAgeMs: 978.5 * MINUTE_MS })
        );
        expect(job.progress.transferred).toBe(3);
        expect(sentBodies(source)[0]).toBe(`msg ${idAt(22)}`);
    });

    it('combines count with max age', async () => {
        const source = new FakeSource('discord', history(25));
        const { service } = makeService();
        const job = await run(
            service,
            source,
            opts({ count: 2, maxAgeMs: 980.5 * MINUTE_MS })
        );
        expect(sentBodies(source)).toEqual(
            [23, 24].map((i) => `msg ${idAt(i)}`)
        );
        expect(job.progress.transferred).toBe(2);
    });

    it('limits by -after and -before', async () => {
        const source = new FakeSource('discord', history(25));
        const { service } = makeService();
        const job = await run(
            service,
            source,
            opts({ count: null, afterId: idAt(5), beforeId: idAt(10) })
        );
        expect(sentBodies(source)).toEqual(
            [6, 7, 8, 9].map((i) => `msg ${idAt(i)}`)
        );
        expect(job.progress.scanned).toBe(4);
    });

    it('counts back from -before', async () => {
        const source = new FakeSource('discord', history(25));
        const { service } = makeService();
        await run(service, source, opts({ count: 2, beforeId: idAt(10) }));
        expect(sentBodies(source)).toEqual([8, 9].map((i) => `msg ${idAt(i)}`));
        expect(source.fetchBeforeCalls[0].beforeId).toBe(idAt(10));
    });

    it('never goes past -after when counting back', async () => {
        const source = new FakeSource('discord', history(25));
        const { service } = makeService();
        await run(service, source, opts({ count: 100, afterId: idAt(20) }));
        expect(sentBodies(source)).toEqual(
            [21, 22, 23, 24].map((i) => `msg ${idAt(i)}`)
        );
    });

    it('does nothing when -after is the newest message', async () => {
        const source = new FakeSource('discord', history(5));
        const { service } = makeService();
        const job = await run(service, source, opts({ afterId: idAt(4) }));
        expect(job.progress.status).toBe('done');
        expect(source.sent).toEqual([]);
        expect(source.fetchAfterCalls).toEqual([]);
    });
});

describe('HistoryTransferService skipping', () => {
    it('skips system, empty, command, bot, own-webhook, bridged and transferred messages', async () => {
        const link = makeChannelLink();
        const source = new FakeSource(
            'discord',
            history(12, (i) => {
                if (i === 3) return { isSystem: true };
                if (i === 4) return { isEmpty: true };
                if (i === 5) return { isCommand: true };
                if (i === 6) return { authorId: 'bot' };
                if (i === 7) return { webhookId: link.discordWebhookId };
                if (i === 8) return { webhookId: 'some-other-webhook' };
                return {};
            }),
            link
        );
        source.bridged.add(idAt(9));
        const repo = new FakeRepo();
        repo.rows.push({
            guildLinkId: link.guildLinkId,
            channelLinkId: link.id,
            sourcePlatform: 'discord',
            sourceMessageId: idAt(10),
            targetMessageId: 'old',
        });
        // A row of the other platform does not count.
        repo.rows.push({
            guildLinkId: link.guildLinkId,
            channelLinkId: link.id,
            sourcePlatform: 'fluxer',
            sourceMessageId: idAt(11),
            targetMessageId: 'old',
        });
        const { service } = makeService(repo);
        const job = await run(service, source, opts());

        expect(sentBodies(source)).toEqual(
            [0, 1, 2, 8, 11].map((i) => `msg ${idAt(i)}`)
        );
        expect(job.progress).toMatchObject({
            scanned: 12,
            eligible: 8,
            transferred: 5,
            posts: 5,
            skippedBridged: 3,
            skippedOther: 4,
            failed: 0,
        });
    });

    it('skips the Fluxer webhook copies when the source is Fluxer', async () => {
        const link = makeChannelLink();
        const source = new FakeSource(
            'fluxer',
            history(3, (i) =>
                i === 1
                    ? { webhookId: link.fluxerWebhookId }
                    : i === 2
                      ? { webhookId: link.discordWebhookId }
                      : {}
            ),
            link
        );
        const { service } = makeService();
        const job = await run(service, source, opts());
        expect(sentBodies(source)).toEqual([0, 2].map((i) => `msg ${idAt(i)}`));
        expect(job.progress.skippedBridged).toBe(1);
    });

    it('counts bridged messages towards the last N', async () => {
        const source = new FakeSource('discord', history(10));
        for (const i of [5, 6, 7, 8, 9]) source.bridged.add(idAt(i));
        const { service } = makeService();

        const job = await run(service, source, opts({ count: 5 }));
        expect(source.sent).toEqual([]);
        expect(job.progress).toMatchObject({
            eligible: 5,
            transferred: 0,
            skippedBridged: 5,
        });

        const again = await run(service, source, opts({ count: 7 }));
        expect(sentBodies(source)).toEqual([3, 4].map((i) => `msg ${idAt(i)}`));
        expect(again.progress.skippedBridged).toBe(5);
    });

    it('is idempotent: a second run transfers nothing new', async () => {
        const source = new FakeSource('discord', history(7));
        const repo = new FakeRepo();
        const { service } = makeService(repo);
        await run(service, source, opts());
        expect(source.sent).toHaveLength(7);
        const again = await run(service, source, opts());
        expect(source.sent).toHaveLength(7);
        expect(again.progress).toMatchObject({
            transferred: 0,
            skippedBridged: 7,
        });
        expect(repo.rows).toHaveLength(7);
    });
});

describe('HistoryTransferService messages mode', () => {
    it('posts bridged-style copies with a time line, no pings, links and rows', async () => {
        const link = makeChannelLink();
        const items = history(2);
        const source = new FakeSource('fluxer', items, link);
        const repo = new FakeRepo();
        const { service } = makeService(repo);
        const job = await run(service, source, opts());

        expect(source.sent).toHaveLength(2);
        expect(source.sent[0]).toEqual({
            content: `-# <t:${unix(items[0].createdAt)}:f>\nmsg ${idAt(0)}`,
            username: 'Alice',
            avatarURL: 'https://alice.png',
            mentionUserIds: ['u1'],
            suppressMentions: true,
        });
        expect(source.messageLinks).toEqual([
            { sourceId: idAt(0), targetId: 't-1' },
            { sourceId: idAt(1), targetId: 't-2' },
        ]);
        expect(repo.rows).toEqual([
            {
                guildLinkId: link.guildLinkId,
                channelLinkId: link.id,
                sourcePlatform: 'fluxer',
                sourceMessageId: idAt(0),
                targetMessageId: 't-1',
            },
            {
                guildLinkId: link.guildLinkId,
                channelLinkId: link.id,
                sourcePlatform: 'fluxer',
                sourceMessageId: idAt(1),
                targetMessageId: 't-2',
            },
        ]);
        expect(job.progress.posts).toBe(2);
        expect(job.progress.transferred).toBe(2);
    });

    it('leaves the content alone without timestamps', async () => {
        const source = new FakeSource('discord', history(1));
        const { service } = makeService();
        await run(service, source, opts({ timestamps: false }));
        expect(source.sent[0].content).toBe(`msg ${idAt(0)}`);
        expect(source.sent[0].suppressMentions).toBe(true);
    });

    it('keeps the time line on an empty copy and truncates long content', async () => {
        const source = new FakeSource('discord', history(2));
        source.contentFor = (item) =>
            item.id === idAt(0) ? '' : 'x'.repeat(2500);
        const { service } = makeService();
        await run(service, source, opts());
        expect(source.sent[0].content).toMatch(/^-# <t:\d+:f>$/);
        expect(source.sent[1].content).toHaveLength(2000);
        expect(source.sent[1].content.endsWith('…')).toBe(true);
    });

    it('pauses between posts but not after the last one', async () => {
        const source = new FakeSource('discord', history(5));
        const { service, sleeps } = makeService();
        await run(service, source, opts());
        expect(sleeps).toEqual([1000, 1000, 1000, 1000]);
    });

    it('does not sleep at all with a zero delay', async () => {
        const source = new FakeSource('discord', history(3));
        const { service, sleeps } = makeService(new FakeRepo(), { delayMs: 0 });
        await run(service, source, opts());
        expect(sleeps).toEqual([]);
    });

    it('pages through the history', async () => {
        const source = new FakeSource('discord', history(35));
        const { service } = makeService(new FakeRepo(), { pageSize: 10 });
        const job = await run(service, source, opts({ count: 25 }));
        expect(job.progress.transferred).toBe(25);
        expect(source.fetchBeforeCalls).toHaveLength(3);
        expect(source.fetchAfterCalls.map((c) => c.limit)).toEqual([
            10, 10, 10,
        ]);
        expect(sentBodies(source)).toEqual(
            Array.from({ length: 25 }, (_, i) => `msg ${idAt(10 + i)}`)
        );
    });
});

describe('HistoryTransferService digest mode', () => {
    it('packs messages into far fewer posts and records every source id', async () => {
        const link = makeChannelLink();
        const source = new FakeSource('discord', history(25), link);
        source.contentFor = () => 'x'.repeat(400);
        const repo = new FakeRepo();
        const { service, sleeps } = makeService(repo);
        const job = await run(
            service,
            source,
            opts({ count: null, mode: 'digest', timestamps: false })
        );

        // Four 413-char entries per post; posts fill up across the 10-item pages.
        expect(source.sent).toHaveLength(7);
        expect(job.progress).toMatchObject({
            transferred: 25,
            posts: 7,
            scanned: 25,
        });
        expect(source.messageLinks).toEqual([]);
        expect(repo.rows.map((r) => r.sourceMessageId)).toEqual(
            Array.from({ length: 25 }, (_, i) => idAt(i))
        );
        // The third post spans the first page boundary (items 8..11).
        expect(
            repo.rows
                .filter((r) => r.targetMessageId === 't-3')
                .map((r) => r.sourceMessageId)
        ).toEqual([8, 9, 10, 11].map(idAt));
        expect(
            repo.rows.filter((r) => r.targetMessageId === 't-7')
        ).toHaveLength(1);
        for (const post of source.sent) {
            expect(post.username).toBe('Bifröst');
            expect(post.avatarURL).toBe('https://bot.png');
            expect(post.suppressMentions).toBe(true);
            expect(post.content.length).toBeLessThanOrEqual(2000);
            expect(post).not.toHaveProperty('mentionUserIds');
        }
        expect(source.sent[0].content.startsWith('-# **Alice**\nxxx')).toBe(
            true
        );
        expect(sleeps).toEqual(Array(6).fill(1000));
    });

    it('includes the original time in the digest headers', async () => {
        const items = history(2);
        const source = new FakeSource('discord', items);
        const { service } = makeService();
        await run(service, source, opts({ mode: 'digest' }));
        expect(source.sent).toHaveLength(1);
        expect(source.sent[0].content).toBe(
            `-# **Alice** · <t:${unix(items[0].createdAt)}:f>\nmsg ${idAt(0)}\n\n` +
                `-# **Alice** · <t:${unix(items[1].createdAt)}:f>\nmsg ${idAt(1)}`
        );
    });

    it('skips bridged messages in digest mode too', async () => {
        const source = new FakeSource('discord', history(4));
        source.bridged.add(idAt(1));
        const { service } = makeService();
        const job = await run(
            service,
            source,
            opts({ mode: 'digest', timestamps: false })
        );
        expect(source.sent[0].content).not.toContain(idAt(1));
        expect(job.progress).toMatchObject({
            transferred: 3,
            posts: 1,
            skippedBridged: 1,
        });
    });
});

describe('HistoryTransferService queue', () => {
    it('runs one job at a time in FIFO order', async () => {
        const first = new FakeSource('discord', history(2));
        const second = new FakeSource('fluxer', history(2));
        // Distinct ids: the repository is keyed by platform and message id.
        const third = new FakeSource('discord', [item(50)]);
        const order: string[] = [];
        const firstSend = gate();
        const release = gate();
        first.sendImpl = async (payload) => {
            firstSend.release();
            await release.opened;
            order.push('first');
            first.sent.push(payload);
            return { messageId: `t-${first.sent.length}` };
        };
        second.sendImpl = async () => {
            order.push('second');
            return { messageId: 'x' };
        };
        third.sendImpl = async () => {
            order.push('third');
            return { messageId: 'y' };
        };
        const { service } = makeService();

        const job1 = service.start(first, opts(), 'mod');
        expect(job1.progress.status).toBe('queued');
        const job2 = service.start(second, opts(), 'mod');
        const job3 = service.start(third, opts(), 'mod');
        await firstSend.opened;

        expect(job1.progress.status).toBe('running');
        expect(job2.progress.status).toBe('queued');
        expect(job3.progress.status).toBe('queued');
        expect(service.activeCount).toBe(3);
        expect(service.queuePosition(first.link.id)).toBe(0);
        expect(service.queuePosition(second.link.id)).toBe(0);
        expect(service.queuePosition(third.link.id)).toBe(1);
        expect(service.queuePosition('nope')).toBe(0);
        expect(service.getJob(second.link.id)).toBe(job2);
        expect(service.getJob('nope')).toBeNull();
        expect(() => service.start(second, opts(), 'mod')).toThrow(
            HistoryTransferError
        );
        try {
            service.start(first, opts(), 'mod');
        } catch (err) {
            expect((err as HistoryTransferError).reason).toBe(
                'already_running'
            );
        }

        release.release();
        await waitFor(() => isFinished(job3));
        expect(order).toEqual(['first', 'first', 'second', 'second', 'third']);
        expect([job1, job2, job3].map((j) => j.progress.status)).toEqual([
            'done',
            'done',
            'done',
        ]);
        expect(service.activeCount).toBe(0);
        expect(service.getJob(first.link.id)).toBeNull();
    });

    it('allows a new job for a link once the previous one finished', async () => {
        const source = new FakeSource('discord', history(1));
        const { service } = makeService();
        await run(service, source, opts());
        const again = await run(service, source, opts());
        expect(again.progress.status).toBe('done');
    });

    it('stops a queued job at once', async () => {
        const first = new FakeSource('discord', history(1));
        const second = new FakeSource('discord', history(1));
        const started = gate();
        const release = gate();
        first.sendImpl = async () => {
            started.release();
            await release.opened;
            return { messageId: 'x' };
        };
        const { service } = makeService();
        const statuses: string[] = [];
        service.start(first, opts(), 'mod');
        const job2 = service.start(second, opts(), 'mod', (job) =>
            statuses.push(job.progress.status)
        );
        await started.opened;

        expect(service.stop(second.link.id)).toBe(true);
        expect(job2.progress.status).toBe('stopped');
        expect(job2.progress.finishedAt).toEqual(new Date(NOW));
        expect(statuses).toEqual(['stopped']);
        expect(service.getJob(second.link.id)).toBeNull();
        expect(service.activeCount).toBe(1);
        expect(service.stop(second.link.id)).toBe(false);
        expect(service.stop('nope')).toBe(false);

        release.release();
        await waitFor(() => service.activeCount === 0);
        expect(second.sent).toEqual([]);
    });

    it('stops a running job after the current post', async () => {
        const source = new FakeSource('discord', history(3));
        const started = gate();
        const release = gate();
        let calls = 0;
        source.sendImpl = async (payload) => {
            calls++;
            if (calls === 1) {
                started.release();
                await release.opened;
            }
            source.sent.push(payload);
            return { messageId: `t-${source.sent.length}` };
        };
        const { service } = makeService();
        const job = service.start(source, opts(), 'mod');
        await started.opened;

        expect(service.stop(source.link.id)).toBe(true);
        expect(job.progress.status).toBe('running');
        release.release();
        await waitFor(() => isFinished(job));

        expect(job.progress.status).toBe('stopped');
        expect(job.progress).toMatchObject({ transferred: 1, posts: 1 });
        expect(source.sent).toHaveLength(1);
        expect(service.getJob(source.link.id)).toBeNull();
    });

    it('stops during the backward scan without posting', async () => {
        const source = new FakeSource('discord', history(30));
        const { service } = makeService();
        source.onFetchBefore = () => {
            service.stop(source.link.id);
        };
        const job = await run(service, source, opts({ count: 25 }));
        expect(job.progress.status).toBe('stopped');
        expect(source.sent).toEqual([]);
        expect(source.fetchAfterCalls).toEqual([]);
    });

    it('discards an unposted digest when stopped', async () => {
        const source = new FakeSource('discord', history(3));
        const { service } = makeService();
        source.onFetchBefore = () => {
            service.stop(source.link.id);
        };
        const job = await run(service, source, opts({ mode: 'digest' }));
        expect(job.progress.status).toBe('stopped');
        expect(source.sent).toEqual([]);
    });
});

describe('HistoryTransferService errors', () => {
    it('retries a rate-limited post after the advertised wait', async () => {
        const source = new FakeSource('discord', history(2));
        let attempts = 0;
        source.sendImpl = async (payload) => {
            attempts++;
            if (attempts <= 2) {
                throw Object.assign(new Error('rate limited'), {
                    name: 'RateLimitError',
                    statusCode: 429,
                    retryAfter: 2,
                });
            }
            source.sent.push(payload);
            return { messageId: `t-${source.sent.length}` };
        };
        const { service, sleeps } = makeService();
        const job = await run(service, source, opts());

        expect(job.progress).toMatchObject({
            status: 'done',
            transferred: 2,
            failed: 0,
        });
        expect(source.sent).toHaveLength(2);
        // Two rate-limit waits, then the regular pause before the second post.
        expect(sleeps).toEqual([2000, 2000, 1000]);
    });

    it('counts a post as failed after too many rate limits', async () => {
        const source = new FakeSource('discord', history(2));
        let attempts = 0;
        source.sendImpl = async (payload) => {
            attempts++;
            if (attempts <= 6) throw { status: 429, retry_after: 2 };
            source.sent.push(payload);
            return { messageId: `t-${source.sent.length}` };
        };
        const { service, sleeps } = makeService();
        const job = await run(service, source, opts());

        expect(job.progress).toMatchObject({
            status: 'done',
            transferred: 1,
            failed: 1,
        });
        expect(attempts).toBe(7);
        // Five rate-limit waits, then the regular pause before the next post.
        expect(sleeps).toEqual([2000, 2000, 2000, 2000, 2000, 1000]);
        expect(sentBodies(source)).toEqual([`msg ${idAt(1)}`]);
    });

    it('fails the job when Fluxer blocks the bot', async () => {
        const source = new FakeSource('discord', history(3));
        let attempts = 0;
        source.sendImpl = async (payload) => {
            attempts++;
            if (attempts === 2) throw { code: 'IP_BANNED', message: 'banned' };
            source.sent.push(payload);
            return { messageId: `t-${source.sent.length}` };
        };
        const { service } = makeService();
        const job = await run(service, source, opts());

        expect(job.progress.status).toBe('failed');
        expect(job.progress.error).toBe(FLUXER_BLOCKED_MESSAGE);
        expect(job.progress.transferred).toBe(1);
        expect(attempts).toBe(2);
        expect(isFluxerApiBlocked()).toBe(true);

        // No new Discord→Fluxer job while the block lasts.
        try {
            service.start(source, opts(), 'mod');
            throw new Error('expected start to throw');
        } catch (err) {
            expect(err).toBeInstanceOf(HistoryTransferError);
            expect((err as HistoryTransferError).reason).toBe('fluxer_blocked');
        }
        // Fluxer→Discord is unaffected.
        const other = new FakeSource('fluxer', history(1));
        const otherJob = await run(service, other, opts());
        expect(otherJob.progress.status).toBe('done');
    });

    it('fails a Discord→Fluxer job that is running when the block starts', async () => {
        const source = new FakeSource('discord', history(3));
        let attempts = 0;
        source.sendImpl = async (payload) => {
            attempts++;
            if (attempts === 1) markFluxerApiBlocked();
            source.sent.push(payload);
            return { messageId: `t-${source.sent.length}` };
        };
        const { service } = makeService();
        const job = await run(service, source, opts());
        expect(job.progress.status).toBe('failed');
        expect(job.progress.error).toBe(FLUXER_BLOCKED_MESSAGE);
        expect(attempts).toBe(1);
    });

    it('carries on after a failed post and gives up after five in a row', async () => {
        const source = new FakeSource('discord', history(10));
        let attempts = 0;
        source.sendImpl = async (payload) => {
            attempts++;
            if (attempts === 1 || attempts >= 4)
                throw new Error(`boom ${attempts}`);
            source.sent.push(payload);
            return { messageId: `t-${source.sent.length}` };
        };
        const { service } = makeService();
        const job = await run(service, source, opts());

        expect(job.progress.status).toBe('failed');
        expect(job.progress.error).toContain('boom 8');
        expect(job.progress).toMatchObject({ transferred: 2, failed: 6 });
        expect(attempts).toBe(8);
    });

    it('counts a payload that cannot be built as failed', async () => {
        const source = new FakeSource('discord', history(3));
        source.buildImpl = async (item) => {
            if (item.id === idAt(1)) throw new Error('no transform');
            return { content: `msg ${item.id}`, username: 'A', avatarURL: '' };
        };
        const { service } = makeService();
        const job = await run(service, source, opts());
        expect(job.progress).toMatchObject({
            status: 'done',
            transferred: 2,
            failed: 1,
        });
        expect(sentBodies(source)).toEqual([0, 2].map((i) => `msg ${idAt(i)}`));
    });

    it('fails the job when the history cannot be read', async () => {
        const source = new FakeSource('discord', history(3));
        source.fetchAfter = async () => {
            throw new Error('fetch exploded');
        };
        const { service } = makeService();
        const job = await run(service, source, opts());
        expect(job.progress.status).toBe('failed');
        expect(job.progress.error).toBe('fetch exploded');
        // The next job still runs.
        const next = await run(
            service,
            new FakeSource('discord', history(1)),
            opts()
        );
        expect(next.progress.status).toBe('done');
    });
});

describe('HistoryTransferService progress', () => {
    it('reports every status change and every post', async () => {
        const source = new FakeSource('discord', history(3));
        const { service } = makeService();
        const seen: { status: string; posts: number }[] = [];
        const job = await run(service, source, opts(), (j) =>
            seen.push({ status: j.progress.status, posts: j.progress.posts })
        );
        expect(seen[0]).toEqual({ status: 'running', posts: 0 });
        expect(seen[seen.length - 1]).toEqual({ status: 'done', posts: 3 });
        expect(seen.map((s) => s.posts)).toContain(1);
        expect(seen.map((s) => s.posts)).toContain(2);
        expect(job.id).toMatch(/^[0-9a-f-]{36}$/);
        expect(job).toMatchObject({
            channelLinkId: source.link.id,
            sourcePlatform: 'discord',
            requestedBy: 'mod',
        });
        expect(job.progress.queuedAt).toEqual(new Date(NOW));
    });

    it('survives a progress callback that throws', async () => {
        const source = new FakeSource('discord', history(2));
        const { service } = makeService();
        const job = await run(service, source, opts(), () => {
            throw new Error('handler bug');
        });
        expect(job.progress.status).toBe('done');
        expect(job.progress.transferred).toBe(2);
    });
});
