import { Guild as DiscordGuild, Role as DiscordRole } from 'discord.js';
import {
    Guild as FluxerGuild,
    GuildMember as FluxerGuildMember,
    PermissionFlags,
    Routes as FluxerRoutes,
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
    DownloadedImage,
    ImageDownloader,
    RATE_LIMIT_MAX_ATTEMPTS,
    rateLimitWaitMs,
} from '../expressionTransfer/ExpressionTransferService';
import { toDataUrl } from '../expressionTransfer/expressionAssets';

export type { DownloadedImage, ImageDownloader };

/** One Fluxer role that did not receive an icon, with a human-readable reason. */
export interface RoleIconOutcome {
    name: string;
    reason: string;
}

export interface RoleIconTransferReport {
    /** Fluxer role names that received an icon, in order. */
    copied: string[];
    /**
     * Roles deliberately left alone: no Fluxer role with the name, the
     * Fluxer role already has (that or another) icon, or Discord roles of
     * the same name carry different icons.
     */
    skipped: RoleIconOutcome[];
    /** Downloads or updates that failed, with the error message. */
    failed: RoleIconOutcome[];
}

/** How many Fluxer roles are about to be updated, after skipping. */
export interface RoleIconTransferPlan {
    roles: number;
}

export interface RoleIconTransferOptions {
    /** Replace icons that Fluxer roles already have (default false: skip them). */
    overwrite?: boolean;
    /**
     * Called once, after both guilds' roles were listed and before the first
     * update, with the number of Fluxer roles that are about to be updated.
     */
    onPlanned?: (plan: RoleIconTransferPlan) => void | Promise<void>;
}

/** Thrown when a role icon transfer into the same Fluxer guild is still running. */
export class RoleIconTransferInProgressError extends Error {
    constructor(fluxerGuildId: string) {
        super(
            'A role icon transfer into this Fluxer server is already running; wait for it to finish.'
        );
        this.name = 'RoleIconTransferInProgressError';
        this.fluxerGuildId = fluxerGuildId;
    }

    readonly fluxerGuildId: string;
}

/** Fluxer's `role_icon` upload limit. */
export const ROLE_ICON_MAX_BYTES = 256 * 1024;
/** The size requested from Discord's CDN (Fluxer accepts 32–1024 px). */
const ROLE_ICON_SIZE = 256;

/** Message shown when the Fluxer API cooldown prevents updating. */
const API_BLOCKED_MESSAGE =
    'The Fluxer API is temporarily blocked; try again later.';
const API_BLOCKED_ITEM_REASON = 'Fluxer API temporarily blocked';
const MISSING_PERMISSION_MESSAGE =
    'I need the `Manage Roles` permission in the Fluxer server to set role icons.';

export const SKIP_NO_FLUXER_ROLE = 'no Fluxer role with this name';
export const SKIP_ALREADY_SET = 'already set';
export const SKIP_HAS_ICON = 'already has an icon (use `overwrite`)';
export const SKIP_AMBIGUOUS =
    'Discord roles with this name have different icons';

/** A Discord role icon: an uploaded image or a Unicode emoji. */
type SourceIcon =
    | { kind: 'emoji'; emoji: string }
    | {
          kind: 'image';
          hash: string;
          /** CDN URLs to try in order (PNG first, then the smaller WebP). */
          urls: string[];
      };

/** A Discord role with an icon, reduced to what the transfer needs. */
interface SourceRole {
    id: string;
    name: string;
    icon: SourceIcon;
}

/** The fields of Fluxer's raw role object the transfer reads. */
interface FluxerRawRole {
    id: string;
    name: string;
    icon?: string | null;
    unicode_emoji?: string | null;
}

/** The PATCH body that sets one role icon; exactly one field is sent. */
type RoleIconBody = { unicode_emoji: string } | { icon: string };

/** One Fluxer role to update, with the Discord icon it receives. */
interface PlannedUpdate {
    source: SourceRole;
    target: FluxerRawRole;
}

function emptyReport(): RoleIconTransferReport {
    return { copied: [], skipped: [], failed: [] };
}

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

const defaultSleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * A user-facing error wrapping the failure of one transfer step. Carries the
 * original error as `cause` (declared here because tsconfig targets ES6).
 */
class RoleIconTransferStepError extends Error {
    readonly cause?: unknown;

    constructor(message: string, options?: { cause?: unknown }) {
        super(message);
        this.name = 'RoleIconTransferStepError';
        this.cause = options?.cause;
    }
}

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

function sameIcon(a: SourceIcon, b: SourceIcon): boolean {
    if (a.kind === 'emoji' && b.kind === 'emoji') return a.emoji === b.emoji;
    if (a.kind === 'image' && b.kind === 'image') return a.hash === b.hash;
    return false;
}

function compareStrings(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

function formatKiB(bytes: number): string {
    return `${Math.ceil(bytes / 1024)} KiB`;
}

/**
 * Copies Discord role icons (uploaded images and Unicode emojis) onto the
 * Fluxer roles with the same name (issue #54).
 *
 * Only the Discord → Fluxer direction exists. Fluxer roles that already have
 * an icon are left alone unless `overwrite` is set, so the transfer can be
 * re-run safely. At most one transfer per Fluxer guild runs at a time.
 */
export default class RoleIconTransferService {
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
        /** Waits before a rate-limited update is retried; injectable for tests. */
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
     * Lists the roles of both guilds, sets every Discord role icon on the
     * Fluxer roles of the same name, and reports what happened to each.
     *
     * Rejects with {@link RoleIconTransferInProgressError} when a transfer
     * into `fluxerGuildId` is already running, and with a plain `Error` whose
     * message is fit to show to the user when a guild cannot be fetched, the
     * Fluxer API is currently blocked, or the bot lacks Manage Roles in the
     * Fluxer guild. Per-role problems never reject; they are reported.
     */
    public async transfer(
        discordGuildId: string,
        fluxerGuildId: string,
        options: RoleIconTransferOptions = {}
    ): Promise<RoleIconTransferReport> {
        if (this.isRunning(fluxerGuildId)) {
            throw new RoleIconTransferInProgressError(fluxerGuildId);
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
        options: RoleIconTransferOptions
    ): Promise<RoleIconTransferReport> {
        if (isFluxerApiBlocked()) throw new Error(API_BLOCKED_MESSAGE);

        const discordGuild =
            await this.discordEntityResolver.fetchGuild(discordGuildId);
        if (!discordGuild) throw new Error('Discord server not found');

        const fluxerGuild =
            await this.fluxerEntityResolver.fetchGuild(fluxerGuildId);
        if (!fluxerGuild) throw new Error('Fluxer server not found');

        await this.ensureCanManageRoles(fluxerGuild);

        // Fresh fetches on both sides; the Fluxer roles come raw because the
        // SDK's Role does not expose the image `icon` hash yet.
        const sources = await this.listDiscordRoles(discordGuild);
        const targets = await this.listFluxerRoles(fluxerGuild);

        const report = emptyReport();
        const updates = planUpdates(
            sources,
            targets,
            fluxerGuild.id,
            options.overwrite ?? false,
            report
        );

        await options.onPlanned?.({ roles: updates.length });

        await this.apply(fluxerGuild, updates, report);

        logger.info(
            `🎭 Role icon transfer Discord ${discordGuildId} → Fluxer ${fluxerGuildId}: ` +
                `${report.copied.length} copied, ${report.skipped.length} skipped, ${report.failed.length} failed`
        );
        return report;
    }

    /**
     * Rejects when the bot's member is known to lack Manage Roles. An
     * unfetchable member is only logged: the API is the final judge anyway.
     */
    private async ensureCanManageRoles(guild: FluxerGuild): Promise<void> {
        const me = await this.fetchOwnMember(guild);
        if (!me) return;
        if (!me.permissions.has(PermissionFlags.ManageRoles)) {
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

    /** Discord roles with an icon, except @everyone. */
    private async listDiscordRoles(guild: DiscordGuild): Promise<SourceRole[]> {
        let roles: DiscordRole[];
        try {
            roles = [...(await guild.roles.fetch()).values()];
        } catch (err) {
            throw new RoleIconTransferStepError(
                `Could not list the Discord server's roles: ${errorMessage(err)}`,
                { cause: err }
            );
        }
        const sources: SourceRole[] = [];
        for (const role of roles) {
            if (role.id === guild.id) continue;
            const icon = sourceIconOf(role);
            if (icon) sources.push({ id: role.id, name: role.name, icon });
        }
        return sources;
    }

    private async listFluxerRoles(
        guild: FluxerGuild
    ): Promise<FluxerRawRole[]> {
        try {
            return await guild.client.rest.get<FluxerRawRole[]>(
                FluxerRoutes.guildRoles(guild.id)
            );
        } catch (err) {
            if (isFluxerApiBlockError(err)) {
                markFluxerApiBlocked();
                throw new RoleIconTransferStepError(API_BLOCKED_MESSAGE, {
                    cause: err,
                });
            }
            throw new RoleIconTransferStepError(
                `Could not list the Fluxer server's roles: ${errorMessage(err)}`,
                { cause: err }
            );
        }
    }

    /**
     * Updates the planned roles one by one. The image of a Discord role is
     * downloaded once and reused for every Fluxer role of that name. A failed
     * download or PATCH only fails that role; once the Fluxer API block is
     * hit, the rest is failed without further requests.
     */
    private async apply(
        guild: FluxerGuild,
        updates: PlannedUpdate[],
        report: RoleIconTransferReport
    ): Promise<void> {
        const bodies = new Map<string, RoleIconBody | { error: string }>();
        for (let index = 0; index < updates.length; index++) {
            const { source, target } = updates[index];
            if (isFluxerApiBlocked()) {
                for (const rest of updates.slice(index)) {
                    report.failed.push({
                        name: rest.target.name,
                        reason: API_BLOCKED_ITEM_REASON,
                    });
                }
                return;
            }

            let body = bodies.get(source.id);
            if (!body) {
                body = await this.bodyFor(source);
                bodies.set(source.id, body);
            }
            if ('error' in body) {
                report.failed.push({ name: target.name, reason: body.error });
                continue;
            }

            try {
                const payload = body;
                await this.withRateLimitRetry(() =>
                    guild.client.rest.patch(
                        FluxerRoutes.guildRole(guild.id, target.id),
                        { body: payload }
                    )
                );
                report.copied.push(target.name);
            } catch (err) {
                const blocked = isFluxerApiBlockError(err);
                if (blocked) markFluxerApiBlocked();
                logger.warn(
                    `⚠️ Setting the icon of Fluxer role ${target.name} (${target.id}) failed:`,
                    err
                );
                report.failed.push({
                    name: target.name,
                    reason: blocked
                        ? API_BLOCKED_ITEM_REASON
                        : errorMessage(err),
                });
            }
        }
    }

    /** The PATCH body for one Discord icon, or why it could not be built. */
    private async bodyFor(
        source: SourceRole
    ): Promise<RoleIconBody | { error: string }> {
        if (source.icon.kind === 'emoji') {
            return { unicode_emoji: source.icon.emoji };
        }
        try {
            return { icon: await this.downloadIcon(source.icon.urls) };
        } catch (err) {
            return { error: errorMessage(err) };
        }
    }

    /**
     * Downloads the first of `urls` that fits Fluxer's role icon limit and
     * returns it as a data URL; throws when none does.
     */
    private async downloadIcon(urls: string[]): Promise<string> {
        let smallest: number | null = null;
        for (const url of urls) {
            const image = await this.downloadImage(url);
            if (image.bytes.length <= ROLE_ICON_MAX_BYTES) {
                return toDataUrl(image.bytes, image.contentType, url);
            }
            smallest =
                smallest === null
                    ? image.bytes.length
                    : Math.min(smallest, image.bytes.length);
        }
        throw new Error(
            `image too large for Fluxer (${formatKiB(smallest ?? 0)}, max ${formatKiB(ROLE_ICON_MAX_BYTES)})`
        );
    }

    /**
     * Runs one request, waiting and retrying when Fluxer rate-limits it (up
     * to {@link RATE_LIMIT_MAX_ATTEMPTS} attempts). Any other rejection, and
     * the last rate limit, propagate to the caller.
     */
    private async withRateLimitRetry<T>(request: () => Promise<T>): Promise<T> {
        for (let attempt = 1; ; attempt++) {
            try {
                return await request();
            } catch (err) {
                const waitMs = rateLimitWaitMs(err);
                if (waitMs === null || attempt >= RATE_LIMIT_MAX_ATTEMPTS) {
                    throw err;
                }
                logger.info(
                    `⏳ Fluxer rate-limited a role icon update; retrying in ${Math.ceil(waitMs / 1000)} s (attempt ${attempt}/${RATE_LIMIT_MAX_ATTEMPTS})`
                );
                await this.sleep(waitMs);
            }
        }
    }
}

/** The icon of a Discord role, or null when it has none. */
function sourceIconOf(role: DiscordRole): SourceIcon | null {
    // Discord shows the image when a role has both.
    if (role.icon) {
        const urls = (['png', 'webp'] as const)
            .map((extension) =>
                role.iconURL({ extension, size: ROLE_ICON_SIZE })
            )
            .filter((url): url is string => !!url);
        if (urls.length > 0) {
            return { kind: 'image', hash: role.icon, urls };
        }
    }
    if (role.unicodeEmoji) {
        return { kind: 'emoji', emoji: role.unicodeEmoji };
    }
    return null;
}

/**
 * Decides which Fluxer roles to update, appending everything that is not
 * updated to `report.skipped`. Roles are visited by name then id so re-runs
 * and reports are deterministic. Names match exactly (case-sensitive), like
 * the expression transfer; every Fluxer role of a matching name is updated.
 */
function planUpdates(
    sources: readonly SourceRole[],
    targets: readonly FluxerRawRole[],
    fluxerGuildId: string,
    overwrite: boolean,
    report: RoleIconTransferReport
): PlannedUpdate[] {
    const byName = new Map<string, SourceRole[]>();
    const ordered = [...sources].sort(
        (a, b) => compareStrings(a.name, b.name) || compareStrings(a.id, b.id)
    );
    for (const source of ordered) {
        const group = byName.get(source.name);
        if (group) group.push(source);
        else byName.set(source.name, [source]);
    }

    const targetsByName = new Map<string, FluxerRawRole[]>();
    for (const target of [...targets].sort((a, b) =>
        compareStrings(a.id, b.id)
    )) {
        if (target.id === fluxerGuildId) continue; // @everyone
        const group = targetsByName.get(target.name);
        if (group) group.push(target);
        else targetsByName.set(target.name, [target]);
    }

    const updates: PlannedUpdate[] = [];
    for (const [name, group] of byName) {
        const source = group[0];
        if (group.some((other) => !sameIcon(other.icon, source.icon))) {
            report.skipped.push({ name, reason: SKIP_AMBIGUOUS });
            continue;
        }
        const matches = targetsByName.get(name);
        if (!matches) {
            report.skipped.push({ name, reason: SKIP_NO_FLUXER_ROLE });
            continue;
        }
        for (const target of matches) {
            const reason = skipReason(source.icon, target, overwrite);
            if (reason) report.skipped.push({ name: target.name, reason });
            else updates.push({ source, target });
        }
    }
    return updates;
}

/** Why `target` keeps its current icon, or null when it gets `icon`. */
function skipReason(
    icon: SourceIcon,
    target: FluxerRawRole,
    overwrite: boolean
): string | null {
    if (icon.kind === 'emoji' && target.unicode_emoji === icon.emoji) {
        return SKIP_ALREADY_SET;
    }
    const hasIcon = !!target.icon || !!target.unicode_emoji;
    if (hasIcon && !overwrite) return SKIP_HAS_ICON;
    return null;
}
