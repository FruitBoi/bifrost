/**
 * Daily bot avatar (issue #44): once a day, at `hourUtc:00` UTC, the bot's
 * profile picture is changed to a random custom emoji from its Fluxer
 * servers.
 *
 * The emoji is picked uniformly from the custom emojis of the configured
 * Fluxer guilds (every guild the bot is in when none are configured), static
 * ones only unless animated emojis are allowed, and never the one picked
 * last time when there is a choice. Its image is downloaded from the Fluxer
 * CDN and set as the avatar of the Fluxer bot and, optionally, of the
 * Discord bot. The two platforms are updated independently: a failure on one
 * is logged and does not stop the other, and nothing is ever thrown out of
 * the timer.
 *
 * Fluxer does not let a bot change its own profile: `PATCH /users/@me` and
 * `PATCH /oauth2/applications/:id/bot` both answer a bot token with 403
 * ACCESS_DENIED. The Fluxer avatar is therefore set through
 * `PATCH /oauth2/applications/<application id>/bot` (a data URI) with the
 * user token of the account that owns the bot application
 * (`BF_FLUXER_AVATAR_TOKEN`). Without that token only Discord is updated.
 *
 * Nothing happens on startup (a restart would otherwise reshuffle the
 * avatar); the first change is at the next `hourUtc` boundary. Nothing is
 * stored either: the last pick is only remembered in memory.
 */
import logger from '../../utils/logging/logger';

const DAY_MS = 24 * 60 * 60 * 1000;

/** A custom Fluxer emoji, as far as this service needs it. */
export interface AvatarEmoji {
    id: string;
    name: string;
    animated: boolean;
    /** CDN URL of the image (png for static emojis, gif for animated ones). */
    url: string;
}

/** The parts of a Fluxer guild this service uses. */
export interface AvatarFluxerGuild {
    id: string;
    fetchEmojis(): Promise<AvatarEmoji[]>;
}

/** The parts of the Fluxer client this service uses. */
export interface AvatarFluxerClient {
    guilds: {
        values(): Iterable<AvatarFluxerGuild>;
        fetch(guildId: string): Promise<AvatarFluxerGuild>;
    };
    rest: {
        patch(
            route: string,
            options: {
                body: unknown;
                auth: false;
                headers: Record<string, string>;
            }
        ): Promise<unknown>;
    };
}

/** The parts of the Discord client this service uses. */
export interface AvatarDiscordClient {
    user: { setAvatar(avatar: Buffer): Promise<unknown> } | null;
}

/** A downloaded image; `contentType` is null when the server sent none usable. */
export interface AvatarImage {
    bytes: Buffer;
    contentType: string | null;
}

export type AvatarImageDownloader = (url: string) => Promise<AvatarImage>;

export interface BotAvatarConfig {
    hourUtc: number;
    guildIds: string[];
    discord: boolean;
    includeAnimated: boolean;
}

/** Timer functions; tests replace them to run the schedule by hand. */
export interface AvatarScheduler {
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
}

export interface BotAvatarServiceOptions {
    config: BotAvatarConfig;
    /** The current Fluxer client; it is replaced when the client restarts. */
    getFluxerClient: () => AvatarFluxerClient | null;
    /**
     * User token (session or OAuth2) of the account that owns the Fluxer bot
     * application. Empty: the Fluxer avatar is not changed, since a bot
     * token is not allowed to. A `Bearer ` prefix is kept as given.
     */
    fluxerOwnerToken?: string;
    /** ID of the Fluxer bot application (the part of the bot token before the dot). */
    fluxerApplicationId?: string;
    /** The Discord client, or null when only Fluxer should be updated. */
    getDiscordClient?: () => AvatarDiscordClient | null;
    /** Clock. Default `Date.now`. */
    now?: () => number;
    /** Random source in [0, 1). Default `Math.random`. */
    random?: () => number;
    /** Defaults to the global `fetch`. */
    downloadImage?: AvatarImageDownloader;
    /** Default: the global `setTimeout` / `clearTimeout`. */
    scheduler?: AvatarScheduler;
}

/** What a run did on each platform. */
export interface BotAvatarRunResult {
    emoji: AvatarEmoji | null;
    fluxer: 'updated' | 'failed' | 'skipped';
    discord: 'updated' | 'failed' | 'skipped';
}

/**
 * The first `hourUtc:00:00.000` UTC strictly after `now` (ms). A run exactly
 * at the boundary is scheduled for the next day.
 */
export function nextRunAt(now: number, hourUtc: number): number {
    const date = new Date(now);
    const today = Date.UTC(
        date.getUTCFullYear(),
        date.getUTCMonth(),
        date.getUTCDate(),
        hourUtc
    );
    return today > now ? today : today + DAY_MS;
}

/**
 * Picks a uniformly random emoji, never `lastId` unless it is the only one.
 * Returns null for an empty list.
 */
export function pickEmoji<T extends { id: string }>(
    emojis: T[],
    lastId: string | null,
    random: () => number = Math.random
): T | null {
    const candidates =
        emojis.length > 1
            ? emojis.filter((emoji) => emoji.id !== lastId)
            : emojis;
    if (candidates.length === 0) return null;
    const index = Math.min(
        Math.floor(random() * candidates.length),
        candidates.length - 1
    );
    return candidates[index];
}

/** The MIME type of an emoji image: the server's, else from the URL extension. */
export function avatarMimeType(image: AvatarImage, url: string): string {
    if (image.contentType) {
        return image.contentType.split(';')[0].trim().toLowerCase();
    }
    const ext = /\.(\w+)(?:\?|#|$)/.exec(url)?.[1]?.toLowerCase();
    if (ext === 'gif') return 'image/gif';
    if (ext === 'webp') return 'image/webp';
    if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
    return 'image/png';
}

/** `data:<mime>;base64,<bytes>`, the form Fluxer's avatar field accepts. */
export function toDataUri(bytes: Buffer, mimeType: string): string {
    return `data:${mimeType};base64,${bytes.toString('base64')}`;
}

/** The Fluxer bot application ID: the part of a bot token before the first dot. */
export function applicationIdFromBotToken(token: string): string {
    const id = token
        .trim()
        .replace(/^Bot\s+/, '')
        .split('.')[0];
    return /^\d+$/.test(id) ? id : '';
}

/** Downloads with the global `fetch`; a non-2xx status is a failure. */
const fetchImage: AvatarImageDownloader = async (url) => {
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

const defaultScheduler: AvatarScheduler = {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) =>
        clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export default class BotAvatarService {
    private readonly config: BotAvatarConfig;
    private readonly getFluxerClient: () => AvatarFluxerClient | null;
    private readonly getDiscordClient: () => AvatarDiscordClient | null;
    private readonly fluxerOwnerToken: string;
    private readonly fluxerApplicationId: string;
    private readonly now: () => number;
    private readonly random: () => number;
    private readonly downloadImage: AvatarImageDownloader;
    private readonly scheduler: AvatarScheduler;
    private timer: unknown = null;
    /** When the pending timer is due (ms), or null when stopped. */
    private nextAt: number | null = null;
    private lastEmojiId: string | null = null;
    private running = false;

    constructor(options: BotAvatarServiceOptions) {
        this.config = options.config;
        this.getFluxerClient = options.getFluxerClient;
        this.getDiscordClient = options.getDiscordClient ?? (() => null);
        this.fluxerOwnerToken = options.fluxerOwnerToken?.trim() ?? '';
        this.fluxerApplicationId = options.fluxerApplicationId?.trim() ?? '';
        this.now = options.now ?? Date.now;
        this.random = options.random ?? Math.random;
        this.downloadImage = options.downloadImage ?? fetchImage;
        this.scheduler = options.scheduler ?? defaultScheduler;
    }

    /** Schedules the first change at the next `hourUtc` boundary. */
    start(): void {
        if (this.nextAt !== null) return;
        if (!this.canUpdateFluxer()) {
            logger.warn(
                '[BotAvatar] ⚠️ Fluxer does not let bots change their own avatar; set BF_FLUXER_AVATAR_TOKEN to a user token of the bot application owner to update it. ' +
                    (this.config.discord
                        ? 'Only the Discord avatar will change.'
                        : 'Nothing will change until then.')
            );
        }
        this.schedule(nextRunAt(this.now(), this.config.hourUtc));
    }

    stop(): void {
        if (this.timer !== null) this.scheduler.clearTimeout(this.timer);
        this.timer = null;
        this.nextAt = null;
    }

    /** Whether the Fluxer avatar can be set (owner token and application ID known). */
    canUpdateFluxer(): boolean {
        return this.fluxerOwnerToken !== '' && this.fluxerApplicationId !== '';
    }

    /** When the next change is due (ms since the epoch), or null when stopped. */
    nextRunTime(): number | null {
        return this.nextAt;
    }

    private schedule(at: number): void {
        this.nextAt = at;
        this.timer = this.scheduler.setTimeout(
            () => {
                void this.onTimer(at);
            },
            Math.max(0, at - this.now())
        );
    }

    private async onTimer(scheduledAt: number): Promise<void> {
        this.timer = null;
        try {
            await this.runOnce();
        } catch (err) {
            logger.error('[BotAvatar] ❌ Avatar change failed:', err);
        }
        if (this.nextAt !== scheduledAt) return; // stopped meanwhile
        // Computed from the boundary just served (or later, if the run took
        // long), so a timer firing a little early never runs twice a day.
        this.schedule(
            nextRunAt(Math.max(this.now(), scheduledAt), this.config.hourUtc)
        );
    }

    /**
     * Picks an emoji and sets it as the avatar now. Never throws; returns
     * what happened on each platform.
     */
    async runOnce(): Promise<BotAvatarRunResult> {
        const skipped: BotAvatarRunResult = {
            emoji: null,
            fluxer: 'skipped',
            discord: 'skipped',
        };
        if (this.running) return skipped;
        this.running = true;
        try {
            return await this.run();
        } catch (err) {
            logger.error('[BotAvatar] ❌ Avatar change failed:', err);
            return skipped;
        } finally {
            this.running = false;
        }
    }

    private async run(): Promise<BotAvatarRunResult> {
        const result: BotAvatarRunResult = {
            emoji: null,
            fluxer: 'skipped',
            discord: 'skipped',
        };
        const fluxer = this.getFluxerClient();
        if (!fluxer) {
            logger.warn(
                '[BotAvatar] ⚠️ Fluxer client is not connected; avatar not changed'
            );
            return result;
        }
        if (!this.canUpdateFluxer() && !this.config.discord) return result;

        const emojis = await this.collectEmojis(fluxer);
        const emoji = pickEmoji(emojis, this.lastEmojiId, this.random);
        if (!emoji) {
            logger.info(
                '[BotAvatar] No usable custom emojis found; avatar not changed'
            );
            return result;
        }
        result.emoji = emoji;

        let image: AvatarImage;
        try {
            image = await this.downloadImage(emoji.url);
        } catch (err) {
            logger.error(
                `[BotAvatar] ❌ Could not download emoji :${emoji.name}: (${emoji.id}):`,
                err
            );
            return {
                ...result,
                fluxer: this.canUpdateFluxer() ? 'failed' : 'skipped',
                discord: this.config.discord ? 'failed' : 'skipped',
            };
        }
        this.lastEmojiId = emoji.id;
        const mimeType = avatarMimeType(image, emoji.url);

        if (this.canUpdateFluxer()) {
            try {
                await fluxer.rest.patch(
                    `/oauth2/applications/${this.fluxerApplicationId}/bot`,
                    {
                        body: { avatar: toDataUri(image.bytes, mimeType) },
                        // The bot token is not allowed here; send the owner's.
                        auth: false,
                        headers: { Authorization: this.fluxerOwnerToken },
                    }
                );
                result.fluxer = 'updated';
                logger.info(
                    `[BotAvatar] 🖼️ Fluxer avatar set to :${emoji.name}: (${emoji.id})`
                );
            } catch (err) {
                result.fluxer = 'failed';
                const status = (err as { statusCode?: unknown }).statusCode;
                logger.error(
                    status === 401 || status === 403
                        ? '[BotAvatar] ❌ Could not set the Fluxer avatar: BF_FLUXER_AVATAR_TOKEN was rejected; it must be a valid user token of the account that owns the bot application:'
                        : '[BotAvatar] ❌ Could not set the Fluxer avatar:',
                    err
                );
            }
        }

        if (this.config.discord) {
            const user = this.getDiscordClient()?.user;
            if (!user) {
                logger.warn(
                    '[BotAvatar] ⚠️ Discord client is not ready; Discord avatar not changed'
                );
            } else {
                try {
                    await user.setAvatar(image.bytes);
                    result.discord = 'updated';
                    logger.info(
                        `[BotAvatar] 🖼️ Discord avatar set to :${emoji.name}: (${emoji.id})`
                    );
                } catch (err) {
                    result.discord = 'failed';
                    logger.error(
                        '[BotAvatar] ❌ Could not set the Discord avatar:',
                        err
                    );
                }
            }
        }
        return result;
    }

    /** Custom emojis of the configured guilds (all guilds when none are). */
    private async collectEmojis(
        fluxer: AvatarFluxerClient
    ): Promise<AvatarEmoji[]> {
        const guilds: AvatarFluxerGuild[] = [];
        if (this.config.guildIds.length > 0) {
            for (const guildId of this.config.guildIds) {
                try {
                    guilds.push(await fluxer.guilds.fetch(guildId));
                } catch (err) {
                    logger.warn(
                        `[BotAvatar] ⚠️ Could not fetch Fluxer guild ${guildId}:`,
                        err
                    );
                }
            }
        } else {
            guilds.push(...fluxer.guilds.values());
        }

        const emojis: AvatarEmoji[] = [];
        for (const guild of guilds) {
            try {
                for (const emoji of await guild.fetchEmojis()) {
                    if (emoji.animated && !this.config.includeAnimated)
                        continue;
                    emojis.push(emoji);
                }
            } catch (err) {
                logger.warn(
                    `[BotAvatar] ⚠️ Could not list the emojis of Fluxer guild ${guild.id}:`,
                    err
                );
            }
        }
        return emojis;
    }
}
