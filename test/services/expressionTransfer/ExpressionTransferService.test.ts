import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Collection, StickerFormatType } from 'discord.js';
import { PermissionFlags } from '@fluxerjs/core';
import ExpressionTransferService, {
    ExpressionTransferInProgressError,
    ImageDownloader,
    RATE_LIMIT_MAX_ATTEMPTS,
    rateLimitWaitMs,
} from '../../../src/services/expressionTransfer/ExpressionTransferService';
import DiscordEntityResolver from '../../../src/services/entityResolver/DiscordEntityResolver';
import FluxerEntityResolver from '../../../src/services/entityResolver/FluxerEntityResolver';
import {
    markFluxerApiBlocked,
    markFluxerApiOk,
} from '../../../src/utils/fluxerApiGuard';

const DISCORD_GUILD = 'dguild';
const FLUXER_GUILD = 'fguild';
const BOT_ID = 'fluxer-bot';

interface FakeDiscordEmoji {
    id: string;
    name: string;
    animated?: boolean;
    available?: boolean;
    managed?: boolean;
}

interface FakeDiscordSticker {
    id: string;
    name: string;
    description?: string | null;
    tags?: string | null;
    format?: StickerFormatType;
    available?: boolean;
}

function discordEmoji({
    id,
    name,
    animated = false,
    available = true,
    managed = false,
}: FakeDiscordEmoji) {
    return {
        id,
        name,
        animated,
        available,
        managed,
        imageURL: vi.fn(
            ({ extension }: { extension: string }) =>
                `https://cdn.discordapp.com/emojis/${id}.${extension}`
        ),
    };
}

function discordSticker({
    id,
    name,
    description = null,
    tags = null,
    format = StickerFormatType.PNG,
    available = true,
}: FakeDiscordSticker) {
    const extension =
        format === StickerFormatType.Lottie
            ? 'json'
            : format === StickerFormatType.GIF
              ? 'gif'
              : 'png';
    return {
        id,
        name,
        description,
        tags,
        format,
        available,
        url: `https://cdn.discordapp.com/stickers/${id}.${extension}`,
    };
}

function makeDiscordGuild(
    emojis: FakeDiscordEmoji[] = [],
    stickers: FakeDiscordSticker[] = []
) {
    return {
        id: DISCORD_GUILD,
        emojis: {
            fetch: vi.fn(async () => {
                const coll = new Collection<string, unknown>();
                for (const e of emojis) coll.set(e.id, discordEmoji(e));
                return coll;
            }),
        },
        stickers: {
            fetch: vi.fn(async () => {
                const coll = new Collection<string, unknown>();
                for (const s of stickers) coll.set(s.id, discordSticker(s));
                return coll;
            }),
        },
    };
}

type BulkInput = { name: string; image: string }[];
type BulkOutput = {
    success: { name: string }[];
    failed: { name: string; error: string }[];
};

const allSucceed = async (list: BulkInput): Promise<BulkOutput> => ({
    success: list.map((item) => ({ name: item.name })),
    failed: [],
});

interface FluxerGuildOptions {
    emojis?: string[];
    stickers?: string[];
    /** Permission bits of the bot member; Create Expressions by default. */
    permissions?: bigint;
    /** Whether `members.me` is cached; otherwise `fetchMember` is used. */
    meCached?: boolean;
    /** Whether `fetchMember` can find the bot. */
    meFetchable?: boolean;
}

function makeFluxerGuild({
    emojis = [],
    stickers = [],
    permissions = PermissionFlags.CreateExpressions,
    meCached = true,
    meFetchable = true,
}: FluxerGuildOptions = {}) {
    const me = {
        id: BOT_ID,
        permissions: {
            has: (flag: bigint) => (permissions & flag) === flag,
        },
    };
    const fetchMember = vi.fn(async (id: string) => {
        if (id === BOT_ID && meFetchable) return me;
        throw new Error('Unknown Member');
    });
    return {
        id: FLUXER_GUILD,
        client: { user: { id: BOT_ID } },
        members: { me: meCached ? me : null },
        fetchMember,
        fetchEmojis: vi.fn(async () =>
            emojis.map((name, i) => ({ id: `fe${i}`, name, animated: false }))
        ),
        fetchStickers: vi.fn(async () =>
            stickers.map((name, i) => ({ id: `fs${i}`, name }))
        ),
        createEmojisBulk: vi.fn(allSucceed),
        createStickersBulk: vi.fn(allSucceed),
    };
}

type FakeDiscordGuild = ReturnType<typeof makeDiscordGuild>;
type FakeFluxerGuild = ReturnType<typeof makeFluxerGuild>;

const downloadOk: ImageDownloader = async (url) => ({
    bytes: Buffer.from(`bytes of ${url}`),
    contentType: 'image/png',
});

function makeService({
    discordGuild = makeDiscordGuild() as FakeDiscordGuild | null,
    fluxerGuild = makeFluxerGuild() as FakeFluxerGuild | null,
    downloadImage = vi.fn(downloadOk) as ImageDownloader,
    sleep = vi.fn(async () => {}),
} = {}) {
    const invalidateEmojis = vi.fn();
    const discordEntityResolver = {
        fetchGuild: vi.fn(async (id: string) =>
            id === DISCORD_GUILD ? discordGuild : null
        ),
    } as unknown as DiscordEntityResolver;
    const fluxerEntityResolver = {
        fetchGuild: vi.fn(async (id: string) =>
            id === FLUXER_GUILD ? fluxerGuild : null
        ),
        invalidateEmojis,
    } as unknown as FluxerEntityResolver;
    const service = new ExpressionTransferService({
        discordEntityResolver,
        fluxerEntityResolver,
        downloadImage,
        sleep,
    });
    return { service, invalidateEmojis, downloadImage, sleep };
}

/** What `@fluxerjs/rest` throws on a 429 for a non-GET request. */
function rateLimitError(retryAfter?: number) {
    return Object.assign(new Error('You are being rate limited.'), {
        statusCode: 429,
        retryAfter,
    });
}

function dataUrlOf(url: string): string {
    return `data:image/png;base64,${Buffer.from(`bytes of ${url}`).toString('base64')}`;
}

beforeEach(() => {
    markFluxerApiOk();
});

afterEach(() => {
    markFluxerApiOk();
    vi.restoreAllMocks();
});

describe('ExpressionTransferService.transfer', () => {
    it('uploads every Discord emoji and sticker the Fluxer guild lacks', async () => {
        const discordGuild = makeDiscordGuild(
            [
                { id: 'e2', name: 'party', animated: true },
                { id: 'e1', name: 'pepe' },
            ],
            [
                {
                    id: 's1',
                    name: 'wave',
                    description: ' a wave ',
                    tags: 'wave, hello',
                },
            ]
        );
        const fluxerGuild = makeFluxerGuild();
        const { service, invalidateEmojis } = makeService({
            discordGuild,
            fluxerGuild,
        });

        const report = await service.transfer(DISCORD_GUILD, FLUXER_GUILD);

        expect(report).toEqual({
            emojis: { created: ['party', 'pepe'], skipped: [], failed: [] },
            stickers: { created: ['wave'], skipped: [], failed: [] },
        });
        expect(fluxerGuild.createEmojisBulk).toHaveBeenCalledTimes(1);
        expect(fluxerGuild.createEmojisBulk).toHaveBeenCalledWith([
            {
                name: 'party',
                image: dataUrlOf('https://cdn.discordapp.com/emojis/e2.gif'),
            },
            {
                name: 'pepe',
                image: dataUrlOf('https://cdn.discordapp.com/emojis/e1.png'),
            },
        ]);
        expect(fluxerGuild.createStickersBulk).toHaveBeenCalledWith([
            {
                name: 'wave',
                image: dataUrlOf('https://cdn.discordapp.com/stickers/s1.png'),
                description: 'a wave',
                tags: ['wave', 'hello'],
            },
        ]);
        expect(invalidateEmojis).toHaveBeenCalledWith(FLUXER_GUILD);
    });

    it('requests the original emoji image (no size) as gif/png', async () => {
        const discordGuild = makeDiscordGuild([
            { id: 'e1', name: 'still' },
            { id: 'e2', name: 'moving', animated: true },
        ]);
        const { service } = makeService({ discordGuild });

        await service.transfer(DISCORD_GUILD, FLUXER_GUILD);

        const fetched = await discordGuild.emojis.fetch.mock.results[0].value;
        expect(fetched.get('e1').imageURL).toHaveBeenCalledWith({
            extension: 'png',
        });
        expect(fetched.get('e2').imageURL).toHaveBeenCalledWith({
            extension: 'gif',
        });
    });

    it('omits empty sticker description and tags from the payload', async () => {
        const discordGuild = makeDiscordGuild(
            [],
            [{ id: 's1', name: 'plain', description: '', tags: null }]
        );
        const fluxerGuild = makeFluxerGuild();
        const { service } = makeService({ discordGuild, fluxerGuild });

        await service.transfer(DISCORD_GUILD, FLUXER_GUILD);

        expect(fluxerGuild.createStickersBulk).toHaveBeenCalledWith([
            {
                name: 'plain',
                image: dataUrlOf('https://cdn.discordapp.com/stickers/s1.png'),
            },
        ]);
    });

    it('skips names the Fluxer guild already has and duplicates on Discord', async () => {
        const discordGuild = makeDiscordGuild(
            [
                { id: 'e1', name: 'pepe' },
                { id: 'e3', name: 'twin' },
                { id: 'e2', name: 'twin' },
                { id: 'e4', name: 'fresh' },
            ],
            [
                { id: 's1', name: 'wave' },
                { id: 's2', name: 'new' },
            ]
        );
        const fluxerGuild = makeFluxerGuild({
            emojis: ['pepe'],
            stickers: ['wave'],
        });
        const { service } = makeService({ discordGuild, fluxerGuild });

        const report = await service.transfer(DISCORD_GUILD, FLUXER_GUILD);

        expect(report.emojis.created).toEqual(['fresh', 'twin']);
        expect(report.emojis.skipped).toEqual([
            { name: 'pepe', reason: 'already exists on Fluxer' },
            { name: 'twin', reason: 'duplicate name on Discord' },
        ]);
        expect(report.stickers.created).toEqual(['new']);
        expect(report.stickers.skipped).toEqual([
            { name: 'wave', reason: 'already exists on Fluxer' },
        ]);
        // The duplicate that was uploaded is the one with the lower id.
        const uploaded = fluxerGuild.createEmojisBulk.mock.calls[0][0];
        expect(uploaded.map((e) => e.image)).toContain(
            dataUrlOf('https://cdn.discordapp.com/emojis/e2.png')
        );
    });

    it('skips Lottie stickers, unavailable expressions and invalid names', async () => {
        const discordGuild = makeDiscordGuild(
            [
                { id: 'e1', name: 'gone', available: false },
                { id: 'e2', name: 'bad-name' },
                { id: 'e3', name: 'managed_ok', managed: true },
            ],
            [
                { id: 's1', name: 'anim', format: StickerFormatType.Lottie },
                { id: 's2', name: 'x' },
                { id: 's3', name: 'missing', available: false },
                { id: 's4', name: 'gif', format: StickerFormatType.GIF },
            ]
        );
        const { service } = makeService({ discordGuild });

        const report = await service.transfer(DISCORD_GUILD, FLUXER_GUILD);

        expect(report.emojis.created).toEqual(['managed_ok']);
        expect(report.emojis.skipped).toEqual([
            {
                name: 'bad-name',
                reason: 'invalid name for Fluxer: may only contain ASCII letters, digits and underscores',
            },
            { name: 'gone', reason: 'not available on Discord' },
        ]);
        expect(report.stickers.created).toEqual(['gif']);
        expect(report.stickers.skipped).toEqual([
            { name: 'anim', reason: 'Lottie stickers cannot be transferred' },
            { name: 'missing', reason: 'not available on Discord' },
            {
                name: 'x',
                reason: 'invalid name for Fluxer: must be 2–30 characters',
            },
        ]);
    });

    it('only touches the requested kinds', async () => {
        const discordGuild = makeDiscordGuild(
            [{ id: 'e1', name: 'pepe' }],
            [{ id: 's1', name: 'wave' }]
        );
        const fluxerGuild = makeFluxerGuild();
        const { service, invalidateEmojis } = makeService({
            discordGuild,
            fluxerGuild,
        });

        const report = await service.transfer(DISCORD_GUILD, FLUXER_GUILD, {
            kinds: ['stickers'],
        });

        expect(report.emojis).toEqual({ created: [], skipped: [], failed: [] });
        expect(report.stickers.created).toEqual(['wave']);
        expect(discordGuild.emojis.fetch).not.toHaveBeenCalled();
        expect(fluxerGuild.fetchEmojis).not.toHaveBeenCalled();
        expect(fluxerGuild.createEmojisBulk).not.toHaveBeenCalled();
        expect(invalidateEmojis).not.toHaveBeenCalled();
    });

    it('reports the plan before downloading anything', async () => {
        const discordGuild = makeDiscordGuild(
            [
                { id: 'e1', name: 'pepe' },
                { id: 'e2', name: 'have' },
            ],
            [{ id: 's1', name: 'wave' }]
        );
        const fluxerGuild = makeFluxerGuild({ emojis: ['have'] });
        const downloadImage = vi.fn(downloadOk);
        const { service } = makeService({
            discordGuild,
            fluxerGuild,
            downloadImage,
        });
        const onPlanned = vi.fn(async () => {
            expect(downloadImage).not.toHaveBeenCalled();
        });

        await service.transfer(DISCORD_GUILD, FLUXER_GUILD, { onPlanned });

        expect(onPlanned).toHaveBeenCalledTimes(1);
        expect(onPlanned).toHaveBeenCalledWith({ emojis: 1, stickers: 1 });
        expect(downloadImage).toHaveBeenCalledTimes(2);
    });

    it('reports a zero plan when there is nothing to upload', async () => {
        const { service } = makeService();
        const onPlanned = vi.fn();

        const report = await service.transfer(DISCORD_GUILD, FLUXER_GUILD, {
            onPlanned,
        });

        expect(onPlanned).toHaveBeenCalledWith({ emojis: 0, stickers: 0 });
        expect(report.emojis.created).toEqual([]);
    });

    it('uploads in chunks of at most 10', async () => {
        const emojis = Array.from({ length: 23 }, (_, i) => ({
            id: `e${String(i).padStart(2, '0')}`,
            name: `emoji_${String(i).padStart(2, '0')}`,
        }));
        const discordGuild = makeDiscordGuild(emojis);
        const fluxerGuild = makeFluxerGuild();
        const { service } = makeService({ discordGuild, fluxerGuild });

        const report = await service.transfer(DISCORD_GUILD, FLUXER_GUILD, {
            kinds: ['emojis'],
        });

        const calls = fluxerGuild.createEmojisBulk.mock.calls;
        expect(calls.map((c) => c[0].length)).toEqual([10, 10, 3]);
        expect(calls[0][0][0].name).toBe('emoji_00');
        expect(calls[2][0][2].name).toBe('emoji_22');
        expect(report.emojis.created).toHaveLength(23);
    });

    it('reports per-item failures returned by the bulk endpoint', async () => {
        const discordGuild = makeDiscordGuild([
            { id: 'e1', name: 'big' },
            { id: 'e2', name: 'fine' },
            { id: 'e3', name: 'lost' },
        ]);
        const fluxerGuild = makeFluxerGuild();
        fluxerGuild.createEmojisBulk.mockResolvedValueOnce({
            success: [{ name: 'fine' }],
            failed: [{ name: 'big', error: 'Image too large' }],
        });
        const { service, invalidateEmojis } = makeService({
            discordGuild,
            fluxerGuild,
        });

        const report = await service.transfer(DISCORD_GUILD, FLUXER_GUILD);

        expect(report.emojis.created).toEqual(['fine']);
        expect(report.emojis.failed).toEqual([
            { name: 'big', reason: 'Image too large' },
            { name: 'lost', reason: 'no result reported by Fluxer' },
        ]);
        expect(invalidateEmojis).toHaveBeenCalledTimes(1);
    });

    it('does not invalidate the emoji cache when nothing was created', async () => {
        const discordGuild = makeDiscordGuild([{ id: 'e1', name: 'big' }]);
        const fluxerGuild = makeFluxerGuild();
        fluxerGuild.createEmojisBulk.mockResolvedValueOnce({
            success: [],
            failed: [{ name: 'big', error: 'Image too large' }],
        });
        const { service, invalidateEmojis } = makeService({
            discordGuild,
            fluxerGuild,
        });

        await service.transfer(DISCORD_GUILD, FLUXER_GUILD);

        expect(invalidateEmojis).not.toHaveBeenCalled();
    });

    it('fails a chunk whose bulk call rejects and continues with the next', async () => {
        const emojis = Array.from({ length: 12 }, (_, i) => ({
            id: `e${String(i).padStart(2, '0')}`,
            name: `emoji_${String(i).padStart(2, '0')}`,
        }));
        const discordGuild = makeDiscordGuild(emojis);
        const fluxerGuild = makeFluxerGuild();
        fluxerGuild.createEmojisBulk.mockRejectedValueOnce(
            new Error('Invalid form body')
        );
        const { service } = makeService({ discordGuild, fluxerGuild });

        const report = await service.transfer(DISCORD_GUILD, FLUXER_GUILD, {
            kinds: ['emojis'],
        });

        expect(fluxerGuild.createEmojisBulk).toHaveBeenCalledTimes(2);
        expect(report.emojis.failed).toHaveLength(10);
        expect(report.emojis.failed[0]).toEqual({
            name: 'emoji_00',
            reason: 'Invalid form body',
        });
        expect(report.emojis.created).toEqual(['emoji_10', 'emoji_11']);
    });

    it('stops uploading once the Fluxer API blocks the bot', async () => {
        const emojis = Array.from({ length: 12 }, (_, i) => ({
            id: `e${String(i).padStart(2, '0')}`,
            name: `emoji_${String(i).padStart(2, '0')}`,
        }));
        const discordGuild = makeDiscordGuild(emojis, [
            { id: 's1', name: 'wave' },
        ]);
        const fluxerGuild = makeFluxerGuild();
        fluxerGuild.createEmojisBulk.mockRejectedValueOnce({
            code: 'IP_BANNED',
            message: 'banned',
        });
        const downloadImage = vi.fn(downloadOk);
        const { service } = makeService({
            discordGuild,
            fluxerGuild,
            downloadImage,
        });

        const report = await service.transfer(DISCORD_GUILD, FLUXER_GUILD);

        expect(fluxerGuild.createEmojisBulk).toHaveBeenCalledTimes(1);
        expect(fluxerGuild.createStickersBulk).not.toHaveBeenCalled();
        expect(report.emojis.created).toEqual([]);
        expect(report.emojis.failed).toHaveLength(12);
        expect(new Set(report.emojis.failed.map((f) => f.reason))).toEqual(
            new Set(['Fluxer API temporarily blocked'])
        );
        expect(report.stickers.failed).toEqual([
            { name: 'wave', reason: 'Fluxer API temporarily blocked' },
        ]);
        // Only the first chunk was downloaded; nothing more after the block.
        expect(downloadImage).toHaveBeenCalledTimes(10);
    });

    it('reports download failures per item and still uploads the rest', async () => {
        const discordGuild = makeDiscordGuild([
            { id: 'e1', name: 'broken' },
            { id: 'e2', name: 'fine' },
        ]);
        const fluxerGuild = makeFluxerGuild();
        const downloadImage = vi.fn(async (url: string) => {
            if (url.includes('e1')) {
                throw new Error('download failed: HTTP 404');
            }
            return downloadOk(url);
        });
        const { service } = makeService({
            discordGuild,
            fluxerGuild,
            downloadImage,
        });

        const report = await service.transfer(DISCORD_GUILD, FLUXER_GUILD);

        expect(report.emojis.failed).toEqual([
            { name: 'broken', reason: 'download failed: HTTP 404' },
        ]);
        expect(report.emojis.created).toEqual(['fine']);
        expect(fluxerGuild.createEmojisBulk).toHaveBeenCalledTimes(1);
        expect(fluxerGuild.createEmojisBulk.mock.calls[0][0]).toHaveLength(1);
    });

    it('skips the bulk call when every download of a chunk failed', async () => {
        const discordGuild = makeDiscordGuild([{ id: 'e1', name: 'broken' }]);
        const fluxerGuild = makeFluxerGuild();
        const { service } = makeService({
            discordGuild,
            fluxerGuild,
            downloadImage: vi.fn(async () => {
                throw new Error('download failed: HTTP 500');
            }),
        });

        const report = await service.transfer(DISCORD_GUILD, FLUXER_GUILD);

        expect(fluxerGuild.createEmojisBulk).not.toHaveBeenCalled();
        expect(report.emojis.failed).toEqual([
            { name: 'broken', reason: 'download failed: HTTP 500' },
        ]);
    });

    it('builds the data URL from the downloaded content type, else the URL', async () => {
        const discordGuild = makeDiscordGuild([
            { id: 'e1', name: 'webp_served' },
            { id: 'e2', name: 'unknown_type', animated: true },
        ]);
        const fluxerGuild = makeFluxerGuild();
        const { service } = makeService({
            discordGuild,
            fluxerGuild,
            downloadImage: vi.fn(async (url: string) => ({
                bytes: Buffer.from('x'),
                contentType: url.includes('e1') ? 'image/webp' : null,
            })),
        });

        await service.transfer(DISCORD_GUILD, FLUXER_GUILD);

        const payloads = fluxerGuild.createEmojisBulk.mock.calls[0][0];
        expect(payloads.map((p) => p.image.split(',')[0])).toEqual([
            'data:image/gif;base64',
            'data:image/webp;base64',
        ]);
    });
});

describe('ExpressionTransferService guards', () => {
    it('rejects a second transfer into the same Fluxer guild while one runs', async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const discordGuild = makeDiscordGuild([{ id: 'e1', name: 'pepe' }]);
        const { service } = makeService({
            discordGuild,
            downloadImage: vi.fn(async (url: string) => {
                await gate;
                return downloadOk(url);
            }),
        });

        const first = service.transfer(DISCORD_GUILD, FLUXER_GUILD);
        await Promise.resolve();
        expect(service.isRunning(FLUXER_GUILD)).toBe(true);
        await expect(
            service.transfer(DISCORD_GUILD, FLUXER_GUILD)
        ).rejects.toBeInstanceOf(ExpressionTransferInProgressError);

        release();
        await first;
        expect(service.isRunning(FLUXER_GUILD)).toBe(false);
        await expect(
            service.transfer(DISCORD_GUILD, FLUXER_GUILD)
        ).resolves.toBeDefined();
    });

    it('clears the running flag when the transfer rejects', async () => {
        const { service } = makeService({ discordGuild: null });

        await expect(
            service.transfer(DISCORD_GUILD, FLUXER_GUILD)
        ).rejects.toThrow('Discord server not found');
        expect(service.isRunning(FLUXER_GUILD)).toBe(false);
    });

    it('rejects when the Fluxer guild cannot be fetched', async () => {
        const { service } = makeService({ fluxerGuild: null });

        await expect(
            service.transfer(DISCORD_GUILD, FLUXER_GUILD)
        ).rejects.toThrow('Fluxer server not found');
    });

    it('rejects up front while the Fluxer API is blocked', async () => {
        markFluxerApiBlocked();
        const fluxerGuild = makeFluxerGuild();
        const { service } = makeService({ fluxerGuild });

        await expect(
            service.transfer(DISCORD_GUILD, FLUXER_GUILD)
        ).rejects.toThrow('temporarily blocked');
        expect(fluxerGuild.fetchEmojis).not.toHaveBeenCalled();
    });

    it('rejects when the bot lacks Create Expressions', async () => {
        const fluxerGuild = makeFluxerGuild({
            permissions: PermissionFlags.ManageMessages,
        });
        const discordGuild = makeDiscordGuild([{ id: 'e1', name: 'pepe' }]);
        const { service } = makeService({ discordGuild, fluxerGuild });

        await expect(
            service.transfer(DISCORD_GUILD, FLUXER_GUILD)
        ).rejects.toThrow('`Create Expressions` permission');
        expect(fluxerGuild.createEmojisBulk).not.toHaveBeenCalled();
    });

    it('fetches the bot member when it is not cached', async () => {
        const fluxerGuild = makeFluxerGuild({
            meCached: false,
            permissions: 0n,
        });
        const { service } = makeService({ fluxerGuild });

        await expect(
            service.transfer(DISCORD_GUILD, FLUXER_GUILD)
        ).rejects.toThrow('`Create Expressions` permission');
        expect(fluxerGuild.fetchMember).toHaveBeenCalledWith(BOT_ID);
    });

    it('lets the API decide when the bot member cannot be fetched', async () => {
        const fluxerGuild = makeFluxerGuild({
            meCached: false,
            meFetchable: false,
        });
        const discordGuild = makeDiscordGuild([{ id: 'e1', name: 'pepe' }]);
        const { service } = makeService({ discordGuild, fluxerGuild });

        const report = await service.transfer(DISCORD_GUILD, FLUXER_GUILD);

        expect(report.emojis.created).toEqual(['pepe']);
    });
});

describe('ExpressionTransferService rate limits', () => {
    const emojis = Array.from({ length: 12 }, (_, i) => ({
        id: `e${String(i).padStart(2, '0')}`,
        name: `emoji_${String(i).padStart(2, '0')}`,
    }));

    it('waits for retryAfter and retries a rate-limited bulk upload', async () => {
        const discordGuild = makeDiscordGuild(emojis);
        const fluxerGuild = makeFluxerGuild();
        fluxerGuild.createEmojisBulk
            .mockRejectedValueOnce(rateLimitError(2))
            .mockRejectedValueOnce(rateLimitError(0.5));
        const { service, sleep } = makeService({ discordGuild, fluxerGuild });

        const report = await service.transfer(DISCORD_GUILD, FLUXER_GUILD, {
            kinds: ['emojis'],
        });

        // Chunk one: two 429s, then success; chunk two: success at once.
        expect(fluxerGuild.createEmojisBulk).toHaveBeenCalledTimes(4);
        expect(sleep.mock.calls).toEqual([[2000], [500]]);
        expect(report.emojis.created).toHaveLength(12);
        expect(report.emojis.failed).toEqual([]);
    });

    it('fails the chunk after the last rate-limited attempt and continues', async () => {
        const discordGuild = makeDiscordGuild(emojis);
        const fluxerGuild = makeFluxerGuild();
        for (let i = 0; i < RATE_LIMIT_MAX_ATTEMPTS; i++) {
            fluxerGuild.createEmojisBulk.mockRejectedValueOnce(
                rateLimitError()
            );
        }
        const { service, sleep } = makeService({ discordGuild, fluxerGuild });

        const report = await service.transfer(DISCORD_GUILD, FLUXER_GUILD, {
            kinds: ['emojis'],
        });

        expect(fluxerGuild.createEmojisBulk).toHaveBeenCalledTimes(
            RATE_LIMIT_MAX_ATTEMPTS + 1
        );
        // No retryAfter: the fallback wait, once per retry.
        expect(sleep).toHaveBeenCalledTimes(RATE_LIMIT_MAX_ATTEMPTS - 1);
        expect(sleep).toHaveBeenCalledWith(5000);
        expect(report.emojis.failed).toHaveLength(10);
        expect(report.emojis.failed[0].reason).toBe(
            'You are being rate limited.'
        );
        expect(report.emojis.created).toEqual(['emoji_10', 'emoji_11']);
    });

    it('does not retry other rejections', async () => {
        const discordGuild = makeDiscordGuild(emojis.slice(0, 3));
        const fluxerGuild = makeFluxerGuild();
        fluxerGuild.createEmojisBulk.mockRejectedValueOnce(
            Object.assign(new Error('Forbidden'), { statusCode: 403 })
        );
        const { service, sleep } = makeService({ discordGuild, fluxerGuild });

        const report = await service.transfer(DISCORD_GUILD, FLUXER_GUILD, {
            kinds: ['emojis'],
        });

        expect(fluxerGuild.createEmojisBulk).toHaveBeenCalledTimes(1);
        expect(sleep).not.toHaveBeenCalled();
        expect(report.emojis.failed).toHaveLength(3);
    });
});

describe('rateLimitWaitMs', () => {
    it('is null for anything but a 429', () => {
        expect(rateLimitWaitMs(null)).toBeNull();
        expect(rateLimitWaitMs(new Error('x'))).toBeNull();
        expect(rateLimitWaitMs({ statusCode: 500, retryAfter: 3 })).toBeNull();
    });

    it('uses retryAfter seconds, a fallback without it, and a cap', () => {
        expect(rateLimitWaitMs({ statusCode: 429, retryAfter: 1.5 })).toBe(
            1500
        );
        expect(rateLimitWaitMs({ status: 429 })).toBe(5000);
        expect(rateLimitWaitMs({ statusCode: 429, retryAfter: 600 })).toBe(
            60_000
        );
        expect(rateLimitWaitMs({ statusCode: 429, retryAfter: -1 })).toBe(0);
    });
});
