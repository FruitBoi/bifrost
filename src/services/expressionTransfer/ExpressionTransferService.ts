import {
    Guild as DiscordGuild,
    GuildEmoji as DiscordGuildEmoji,
    Sticker as DiscordSticker,
    StickerFormatType,
} from 'discord.js';
import {
    Guild as FluxerGuild,
    GuildMember as FluxerGuildMember,
    PermissionFlags,
} from '@fluxerjs/core';
import logger from '../../utils/logging/logger';
import {
    isFluxerApiBlockError,
    isFluxerApiBlocked,
    markFluxerApiBlocked,
} from '../../utils/fluxerApiGuard';
import DiscordEntityResolver from '../entityResolver/DiscordEntityResolver';
import FluxerEntityResolver from '../entityResolver/FluxerEntityResolver';
import {
    BULK_CHUNK_SIZE,
    chunk,
    emojiNameProblem,
    normalizeStickerDescription,
    normalizeStickerTags,
    planTransfer,
    stickerNameProblem,
    toDataUrl,
} from './expressionAssets';

/** The two kinds of guild expressions a transfer can copy. */
export type ExpressionKind = 'emojis' | 'stickers';

export const ALL_EXPRESSION_KINDS: readonly ExpressionKind[] = [
    'emojis',
    'stickers',
];

/** One expression that was not created, with a human-readable reason. */
export interface ExpressionOutcome {
    name: string;
    reason: string;
}

export interface ExpressionKindReport {
    /** Names created on Fluxer, in the order they were created. */
    created: string[];
    /**
     * Expressions deliberately not uploaded: the Fluxer guild already has one
     * with that name, a duplicate name within the Discord guild, a format
     * Fluxer cannot store (Lottie stickers), or an invalid name.
     */
    skipped: ExpressionOutcome[];
    /** Downloads or uploads that failed, with the error message. */
    failed: ExpressionOutcome[];
}

export interface ExpressionTransferReport {
    /** Empty (all lists empty) when the kind was not requested. */
    emojis: ExpressionKindReport;
    /** Empty (all lists empty) when the kind was not requested. */
    stickers: ExpressionKindReport;
}

/** How many of each kind will be uploaded, after skipping existing ones. */
export interface ExpressionTransferPlan {
    emojis: number;
    stickers: number;
}

export interface ExpressionTransferOptions {
    /** Which kinds to copy; both by default. */
    kinds?: readonly ExpressionKind[];
    /**
     * Called once, after both guilds were listed and before the first upload,
     * with the number of expressions that are about to be uploaded. Lets a
     * command post a "working on it" notice for big transfers.
     */
    onPlanned?: (plan: ExpressionTransferPlan) => void | Promise<void>;
}

/** Thrown when a transfer into the same Fluxer guild is still running. */
export class ExpressionTransferInProgressError extends Error {
    constructor(fluxerGuildId: string) {
        super(
            'An emoji/sticker transfer into this Fluxer server is already running; wait for it to finish.'
        );
        this.name = 'ExpressionTransferInProgressError';
        this.fluxerGuildId = fluxerGuildId;
    }

    readonly fluxerGuildId: string;
}

/** A downloaded image, ready to be sent to Fluxer as a data URL. */
export interface DownloadedImage {
    bytes: Buffer;
    /** The `Content-Type` of the response, or null when missing/not an image. */
    contentType: string | null;
}

export type ImageDownloader = (url: string) => Promise<DownloadedImage>;

/**
 * How often one bulk upload is attempted when Fluxer answers 429. The REST
 * client only retries rate limits on GET-like requests, so bulk POSTs
 * surface them as `RateLimitError`s (`statusCode` 429, `retryAfter` in
 * seconds) and the transfer has to wait and retry itself.
 */
export const RATE_LIMIT_MAX_ATTEMPTS = 5;
const RATE_LIMIT_FALLBACK_WAIT_MS = 5_000;
const RATE_LIMIT_MAX_WAIT_MS = 60_000;

/** Message shown when the Fluxer API cooldown prevents uploading. */
const API_BLOCKED_MESSAGE =
    'The Fluxer API is temporarily blocked; try again later.';
const API_BLOCKED_ITEM_REASON = 'Fluxer API temporarily blocked';
const MISSING_PERMISSION_MESSAGE =
    'I need the `Create Expressions` permission in the Fluxer server to upload emojis and stickers.';

/** A Discord expression reduced to what the transfer needs. */
interface SourceExpression {
    id: string;
    name: string;
    url: string;
    /** Why it cannot be transferred at all, or null when it can. */
    untransferable: string | null;
    description?: string | null;
    tags?: string[];
}

/** What the bulk create endpoints return. */
interface BulkResult {
    success: { name: string }[];
    failed: { name: string; error: string }[];
}

type BulkCreate<P extends { name: string }> = (
    payloads: P[]
) => Promise<BulkResult>;

function emptyReport(): ExpressionKindReport {
    return { created: [], skipped: [], failed: [] };
}

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/**
 * How long to wait before retrying after `err`, or null when `err` is not a
 * rate limit. Honours `retryAfter` (seconds) when present, within a cap.
 */
export function rateLimitWaitMs(err: unknown): number | null {
    if (typeof err !== 'object' || err === null) return null;
    const { status, statusCode, retryAfter } = err as {
        status?: unknown;
        statusCode?: unknown;
        retryAfter?: unknown;
    };
    if (status !== 429 && statusCode !== 429) return null;
    const seconds =
        typeof retryAfter === 'number' && Number.isFinite(retryAfter)
            ? retryAfter
            : null;
    const ms =
        seconds === null
            ? RATE_LIMIT_FALLBACK_WAIT_MS
            : Math.max(0, seconds * 1000);
    return Math.min(ms, RATE_LIMIT_MAX_WAIT_MS);
}

const defaultSleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * A user-facing error wrapping the failure of one transfer step. Carries the
 * original error as `cause` (declared here because tsconfig targets ES6).
 */
class ExpressionTransferStepError extends Error {
    readonly cause?: unknown;

    constructor(message: string, options?: { cause?: unknown }) {
        super(message);
        this.name = 'ExpressionTransferStepError';
        this.cause = options?.cause;
    }
}

/** The outcome of downloading one expression's image. */
type Download<P> =
    | { item: SourceExpression; payload: P }
    | { item: SourceExpression; error: string };

/** Downloads with the global `fetch`; a non-2xx status is a failure. */
const fetchImage: ImageDownloader = async (url) => {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`download failed: HTTP ${response.status}`);
    }
    const contentType = response.headers.get('content-type');
    return {
        bytes: Buffer.from(await response.arrayBuffer()),
        contentType:
            contentType && contentType.toLowerCase().startsWith('image/')
                ? contentType
                : null,
    };
};

/**
 * Copies the custom emojis and stickers of a Discord guild into the linked
 * Fluxer guild under the same names (issue #17), so that message and
 * reaction bridging (which match custom emojis by name) can relay them.
 *
 * Only the Discord → Fluxer direction exists. Expressions whose name already
 * exists on the Fluxer side are skipped, so the transfer is idempotent and
 * can be re-run after new emojis were added on Discord. At most one transfer
 * per Fluxer guild runs at a time.
 */
export default class ExpressionTransferService {
    private readonly discordEntityResolver: DiscordEntityResolver;
    private readonly fluxerEntityResolver: FluxerEntityResolver;
    private readonly downloadImage: ImageDownloader;
    private readonly sleep: (ms: number) => Promise<void>;
    /** Fluxer guild IDs with a transfer in flight. */
    private readonly running = new Set<string>();

    constructor(deps: {
        discordEntityResolver: DiscordEntityResolver;
        fluxerEntityResolver: FluxerEntityResolver;
        /** Defaults to the global `fetch`; injectable for tests. */
        downloadImage?: ImageDownloader;
        /** Waits before a rate-limited upload is retried; injectable for tests. */
        sleep?: (ms: number) => Promise<void>;
    }) {
        this.discordEntityResolver = deps.discordEntityResolver;
        this.fluxerEntityResolver = deps.fluxerEntityResolver;
        this.downloadImage = deps.downloadImage ?? fetchImage;
        this.sleep = deps.sleep ?? defaultSleep;
    }

    /** Whether a transfer into the given Fluxer guild is currently running. */
    public isRunning(fluxerGuildId: string): boolean {
        return this.running.has(fluxerGuildId);
    }

    /**
     * Lists both guilds, uploads every Discord expression the Fluxer guild
     * lacks, and reports what happened to each one.
     *
     * Rejects with {@link ExpressionTransferInProgressError} when a transfer
     * into `fluxerGuildId` is already running, and with a plain `Error` whose
     * message is fit to show to the user when a guild cannot be fetched, the
     * Fluxer API is currently blocked, or the bot lacks Create Expressions
     * in the Fluxer guild. Per-item problems never reject; they are reported.
     */
    public async transfer(
        discordGuildId: string,
        fluxerGuildId: string,
        options: ExpressionTransferOptions = {}
    ): Promise<ExpressionTransferReport> {
        if (this.isRunning(fluxerGuildId)) {
            throw new ExpressionTransferInProgressError(fluxerGuildId);
        }
        this.running.add(fluxerGuildId);
        try {
            return await this.run(discordGuildId, fluxerGuildId, options);
        } finally {
            this.running.delete(fluxerGuildId);
        }
    }

    private async run(
        discordGuildId: string,
        fluxerGuildId: string,
        options: ExpressionTransferOptions
    ): Promise<ExpressionTransferReport> {
        if (isFluxerApiBlocked()) throw new Error(API_BLOCKED_MESSAGE);

        const kinds = new Set(options.kinds ?? ALL_EXPRESSION_KINDS);
        const wantEmojis = kinds.has('emojis');
        const wantStickers = kinds.has('stickers');

        const discordGuild =
            await this.discordEntityResolver.fetchGuild(discordGuildId);
        if (!discordGuild) throw new Error('Discord server not found');

        const fluxerGuild =
            await this.fluxerEntityResolver.fetchGuild(fluxerGuildId);
        if (!fluxerGuild) throw new Error('Fluxer server not found');

        await this.ensureCanCreateExpressions(fluxerGuild);

        // Fresh fetches on both sides (not the resolvers' minute-long caches)
        // so a re-run sees exactly what exists right now.
        const emojiPlan = wantEmojis
            ? planTransfer(
                  await this.listDiscordEmojis(discordGuild),
                  await this.listFluxerNames(fluxerGuild, 'emojis'),
                  {
                      untransferableReason: (item) => item.untransferable,
                      nameProblem: emojiNameProblem,
                  }
              )
            : null;
        const stickerPlan = wantStickers
            ? planTransfer(
                  await this.listDiscordStickers(discordGuild),
                  await this.listFluxerNames(fluxerGuild, 'stickers'),
                  {
                      untransferableReason: (item) => item.untransferable,
                      nameProblem: stickerNameProblem,
                  }
              )
            : null;

        await options.onPlanned?.({
            emojis: emojiPlan?.upload.length ?? 0,
            stickers: stickerPlan?.upload.length ?? 0,
        });

        const report: ExpressionTransferReport = {
            emojis: emptyReport(),
            stickers: emptyReport(),
        };

        if (emojiPlan) {
            report.emojis.skipped = emojiPlan.skipped;
            await this.upload(
                emojiPlan.upload,
                (item, image) => ({ name: item.name.trim(), image }),
                (payloads) => fluxerGuild.createEmojisBulk(payloads),
                report.emojis
            );
            if (report.emojis.created.length > 0) {
                this.fluxerEntityResolver.invalidateEmojis(fluxerGuildId);
            }
        }

        if (stickerPlan) {
            report.stickers.skipped = stickerPlan.skipped;
            await this.upload(
                stickerPlan.upload,
                (item, image) => ({
                    name: item.name.trim(),
                    image,
                    ...(item.description
                        ? { description: item.description }
                        : {}),
                    ...(item.tags && item.tags.length > 0
                        ? { tags: item.tags }
                        : {}),
                }),
                (payloads) => fluxerGuild.createStickersBulk(payloads),
                report.stickers
            );
        }

        logger.info(
            `🎨 Expression transfer Discord ${discordGuildId} → Fluxer ${fluxerGuildId}: ` +
                `emojis ${summarize(report.emojis)}; stickers ${summarize(report.stickers)}`
        );
        return report;
    }

    /**
     * Rejects when the bot's member is known to lack Create Expressions. An
     * unfetchable member is only logged: the API is the final judge anyway.
     */
    private async ensureCanCreateExpressions(
        guild: FluxerGuild
    ): Promise<void> {
        const me = await this.fetchOwnMember(guild);
        if (!me) return;
        if (!me.permissions.has(PermissionFlags.CreateExpressions)) {
            throw new Error(MISSING_PERMISSION_MESSAGE);
        }
    }

    /** The bot's own member in `guild`: from the cache, else fetched. */
    private async fetchOwnMember(
        guild: FluxerGuild
    ): Promise<FluxerGuildMember | null> {
        if (guild.members.me) return guild.members.me;
        const userId = guild.client.user?.id;
        if (!userId) return null;
        try {
            return await guild.fetchMember(userId);
        } catch (err) {
            logger.warn(
                `⚠️ Could not fetch the bot's own member in Fluxer guild ${guild.id}; letting the API decide about permissions:`,
                err
            );
            return null;
        }
    }

    private async listDiscordEmojis(
        guild: DiscordGuild
    ): Promise<SourceExpression[]> {
        let emojis: DiscordGuildEmoji[];
        try {
            emojis = [...(await guild.emojis.fetch()).values()];
        } catch (err) {
            throw new ExpressionTransferStepError(
                `Could not list the Discord server's emojis: ${errorMessage(err)}`,
                { cause: err }
            );
        }
        return emojis.map((emoji) => ({
            id: emoji.id,
            name: emoji.name ?? '',
            // No `size`: the CDN then serves the original upload.
            url: emoji.imageURL({ extension: emoji.animated ? 'gif' : 'png' }),
            untransferable:
                emoji.available === false ? 'not available on Discord' : null,
        }));
    }

    private async listDiscordStickers(
        guild: DiscordGuild
    ): Promise<SourceExpression[]> {
        let stickers: DiscordSticker[];
        try {
            stickers = [...(await guild.stickers.fetch()).values()];
        } catch (err) {
            throw new ExpressionTransferStepError(
                `Could not list the Discord server's stickers: ${errorMessage(err)}`,
                { cause: err }
            );
        }
        return stickers.map((sticker) => ({
            id: sticker.id,
            name: sticker.name,
            url: sticker.url,
            untransferable:
                sticker.format === StickerFormatType.Lottie
                    ? 'Lottie stickers cannot be transferred'
                    : sticker.available === false
                      ? 'not available on Discord'
                      : null,
            description: normalizeStickerDescription(sticker.description),
            tags: normalizeStickerTags(sticker.tags),
        }));
    }

    private async listFluxerNames(
        guild: FluxerGuild,
        kind: ExpressionKind
    ): Promise<string[]> {
        try {
            const items =
                kind === 'emojis'
                    ? await guild.fetchEmojis()
                    : await guild.fetchStickers();
            return items.map((item) => item.name);
        } catch (err) {
            if (isFluxerApiBlockError(err)) {
                markFluxerApiBlocked();
                throw new ExpressionTransferStepError(API_BLOCKED_MESSAGE, {
                    cause: err,
                });
            }
            throw new ExpressionTransferStepError(
                `Could not list the Fluxer server's ${kind}: ${errorMessage(err)}`,
                { cause: err }
            );
        }
    }

    /**
     * Downloads and uploads `items` in order, in chunks of at most
     * {@link BULK_CHUNK_SIZE}. A failed download or a per-item API failure
     * only fails that item; a rejected bulk call fails its whole chunk and
     * the next chunk is still tried, unless the rejection was the Fluxer API
     * block, after which the rest is failed without further requests.
     */
    private async upload<P extends { name: string }>(
        items: SourceExpression[],
        toPayload: (item: SourceExpression, image: string) => P,
        create: BulkCreate<P>,
        report: ExpressionKindReport
    ): Promise<void> {
        const chunks = chunk(items, BULK_CHUNK_SIZE);
        for (let index = 0; index < chunks.length; index++) {
            const group = chunks[index];
            if (isFluxerApiBlocked()) {
                for (const item of chunks.slice(index).flat()) {
                    report.failed.push({
                        name: item.name,
                        reason: API_BLOCKED_ITEM_REASON,
                    });
                }
                return;
            }

            const payloads = await this.downloadChunk(group, toPayload, report);
            if (payloads.length === 0) continue;

            let result: BulkResult;
            try {
                result = await this.createWithRateLimitRetry(create, payloads);
            } catch (err) {
                const blocked = isFluxerApiBlockError(err);
                if (blocked) markFluxerApiBlocked();
                logger.warn(
                    `⚠️ Bulk expression upload of ${payloads.length} item(s) failed:`,
                    err
                );
                const reason = blocked
                    ? API_BLOCKED_ITEM_REASON
                    : errorMessage(err);
                for (const payload of payloads) {
                    report.failed.push({ name: payload.name, reason });
                }
                continue;
            }

            const seen = new Set<string>();
            for (const created of result.success) {
                report.created.push(created.name);
                seen.add(created.name);
            }
            for (const failure of result.failed) {
                report.failed.push({
                    name: failure.name,
                    reason: failure.error,
                });
                seen.add(failure.name);
            }
            // The API answers for every item; anything unaccounted for is
            // reported rather than silently dropped.
            for (const payload of payloads) {
                if (seen.has(payload.name)) continue;
                report.failed.push({
                    name: payload.name,
                    reason: 'no result reported by Fluxer',
                });
            }
        }
    }

    /**
     * Runs one bulk create, waiting and retrying when Fluxer rate-limits it
     * (up to {@link RATE_LIMIT_MAX_ATTEMPTS} attempts). Any other rejection,
     * and the last rate limit, propagate to the caller.
     */
    private async createWithRateLimitRetry<P extends { name: string }>(
        create: BulkCreate<P>,
        payloads: P[]
    ): Promise<BulkResult> {
        for (let attempt = 1; ; attempt++) {
            try {
                return await create(payloads);
            } catch (err) {
                const waitMs = rateLimitWaitMs(err);
                if (waitMs === null || attempt >= RATE_LIMIT_MAX_ATTEMPTS) {
                    throw err;
                }
                logger.info(
                    `⏳ Fluxer rate-limited a bulk expression upload; retrying in ${Math.ceil(waitMs / 1000)} s (attempt ${attempt}/${RATE_LIMIT_MAX_ATTEMPTS})`
                );
                await this.sleep(waitMs);
            }
        }
    }

    /** Downloads one chunk; items whose download fails go to `report.failed`. */
    private async downloadChunk<P extends { name: string }>(
        group: SourceExpression[],
        toPayload: (item: SourceExpression, image: string) => P,
        report: ExpressionKindReport
    ): Promise<P[]> {
        const downloads = await Promise.all(
            group.map(async (item): Promise<Download<P>> => {
                try {
                    const image = await this.downloadImage(item.url);
                    return {
                        item,
                        payload: toPayload(
                            item,
                            toDataUrl(image.bytes, image.contentType, item.url)
                        ),
                    };
                } catch (err) {
                    return { item, error: errorMessage(err) };
                }
            })
        );

        const payloads: P[] = [];
        for (const download of downloads) {
            if ('payload' in download) {
                payloads.push(download.payload);
            } else {
                report.failed.push({
                    name: download.item.name,
                    reason: download.error,
                });
            }
        }
        return payloads;
    }
}

function summarize(report: ExpressionKindReport): string {
    return `${report.created.length} created, ${report.skipped.length} skipped, ${report.failed.length} failed`;
}
