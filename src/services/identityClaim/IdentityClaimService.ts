import {
    ChannelLink,
    discordLocationId,
    fluxerLocationId,
} from '../../db/entities/ChannelLink';
import { GuildLink } from '../../db/entities/GuildLink';
import { MessagePlatform } from '../../db/entities/MessageLink';
import { UserLink } from '../../db/entities/UserLink';
import type { LinkService } from '../LinkService';
import logger from '../../utils/logging/logger';

/**
 * Self-service identity mapping (issue #3): a user replies `iam` to the
 * bridged copy of a message they wrote on the other platform, the bot asks
 * the original author on that platform to confirm with `iam yes`, and only
 * then the two accounts are mapped so pings reach them on both sides.
 *
 * Pending claims live in memory only: they expire after a few minutes and a
 * restart simply drops them.
 */

export type Platform = MessagePlatform;

/** How long a claim waits for confirmation. */
export const IDENTITY_CLAIM_TTL_MS = 10 * 60 * 1000;
/** Minimum time between two claims by the same user (keeps pings in check). */
export const IDENTITY_CLAIM_COOLDOWN_MS = 60 * 1000;

export const PLATFORM_NAMES: Record<Platform, string> = {
    discord: 'Discord',
    fluxer: 'Fluxer',
};

export function otherPlatform(platform: Platform): Platform {
    return platform === 'discord' ? 'fluxer' : 'discord';
}

/** A user on one platform. */
export interface ClaimUser {
    platform: Platform;
    userId: string;
}

export interface PendingIdentityClaim {
    guildLinkId: string;
    claimer: ClaimUser & { displayName: string };
    target: ClaimUser;
    /** Epoch ms after which the claim is ignored. */
    expiresAt: number;
}

/** Where and what to post on the target's platform. */
export interface IdentityClaimPrompt {
    guildLink: GuildLink;
    channelLink: ChannelLink;
    /** Channel or thread id on the target's platform. */
    locationId: string;
    /** The original message (by the target) the prompt replies to. */
    messageId: string;
    /** The only user the prompt may ping. */
    targetUserId: string;
    content: string;
}

/** Posts confirmation prompts on one platform. Throws when it cannot. */
export interface IdentityClaimPromptSender {
    sendPrompt(prompt: IdentityClaimPrompt): Promise<void>;
}

type IdentityClaimLinks = Pick<
    LinkService,
    | 'getMessageLinkByDiscordMessageId'
    | 'getMessageLinkByFluxerMessageId'
    | 'getChannelLinkById'
    | 'getUserLinkForDiscordUser'
    | 'getUserLinkForFluxerUser'
    | 'setUserLink'
    | 'removeUserLink'
>;

export interface IdentityClaimServiceOptions {
    linkService: IdentityClaimLinks;
    /** The bot command prefix, used in the prompt text (e.g. `!b `). */
    commandPrefix: string;
    now?: () => number;
    ttlMs?: number;
    cooldownMs?: number;
}

export type ClaimResult =
    | { kind: 'sent'; claim: PendingIdentityClaim }
    /** The replied message is not a bridged message of this guild link. */
    | { kind: 'not_bridged' }
    /** The replied message is the original on the claimer's own platform. */
    | { kind: 'own_platform' }
    /** Old message link without a recorded source. */
    | { kind: 'unknown_source' }
    /** The original was posted by a webhook or has no known author. */
    | { kind: 'no_author' }
    | { kind: 'already_linked'; target: ClaimUser }
    /** The claimer is already mapped to someone else. */
    | { kind: 'claimer_mapped'; mappedTo: ClaimUser }
    /** The target is already mapped to someone else. */
    | { kind: 'target_mapped'; target: ClaimUser }
    | { kind: 'cooldown'; retryAfterMs: number }
    | { kind: 'prompt_failed'; target: ClaimUser; error: string };

export type ConfirmResult =
    | { kind: 'linked'; claim: PendingIdentityClaim; link: UserLink }
    | { kind: 'no_pending' }
    | { kind: 'already_linked'; claim: PendingIdentityClaim }
    /** One side got mapped to someone else while the claim was pending. */
    | { kind: 'conflict'; claim: PendingIdentityClaim };

export type DenyResult =
    | { kind: 'denied'; claim: PendingIdentityClaim }
    | { kind: 'no_pending' };

export interface StatusResult {
    /** The caller's account on the other platform, when mapped. */
    linkedTo: ClaimUser | null;
    /** An unexpired claim waiting for the caller to confirm. */
    pendingForCaller: PendingIdentityClaim | null;
}

export type RemoveResult =
    | { kind: 'removed'; was: ClaimUser }
    | { kind: 'not_linked' };

/** Escapes markdown and flattens whitespace so a display name renders as text. */
export function escapeDisplayName(name: string): string {
    return name
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/([\\*_~`|])/g, '\\$1')
        .slice(0, 100);
}

export default class IdentityClaimService {
    private readonly linkService: IdentityClaimLinks;
    /** The bot command prefix, for user-facing text. */
    readonly commandPrefix: string;
    private readonly now: () => number;
    private readonly ttlMs: number;
    private readonly cooldownMs: number;
    private readonly senders: Partial<
        Record<Platform, IdentityClaimPromptSender>
    > = {};
    /** Keyed by guild link + target (one pending claim per target). */
    private readonly pending = new Map<string, PendingIdentityClaim>();
    /** Last claim time per claimer (`platform:userId`). */
    private readonly lastClaimAt = new Map<string, number>();

    constructor(options: IdentityClaimServiceOptions) {
        this.linkService = options.linkService;
        this.commandPrefix = options.commandPrefix;
        this.now = options.now ?? Date.now;
        this.ttlMs = options.ttlMs ?? IDENTITY_CLAIM_TTL_MS;
        this.cooldownMs = options.cooldownMs ?? IDENTITY_CLAIM_COOLDOWN_MS;
    }

    /** Registers how prompts are posted on `platform` (set by each client). */
    setPromptSender(
        platform: Platform,
        sender: IdentityClaimPromptSender | null
    ): void {
        if (sender) this.senders[platform] = sender;
        else delete this.senders[platform];
    }

    /** Minutes a claim stays open, for user-facing text. */
    get ttlMinutes(): number {
        return Math.round(this.ttlMs / 60_000);
    }

    private pendingKey(guildLinkId: string, target: ClaimUser): string {
        return `${guildLinkId}:${target.platform}:${target.userId}`;
    }

    private prune(): void {
        const now = this.now();
        for (const [key, claim] of this.pending) {
            if (claim.expiresAt <= now) this.pending.delete(key);
        }
        for (const [key, at] of this.lastClaimAt) {
            if (now - at >= this.cooldownMs) this.lastClaimAt.delete(key);
        }
    }

    private getPending(
        guildLinkId: string,
        target: ClaimUser
    ): PendingIdentityClaim | null {
        this.prune();
        return this.pending.get(this.pendingKey(guildLinkId, target)) ?? null;
    }

    /** The mapping row holding `user` in the guild link, if any. */
    private findUserLink(
        guildLinkId: string,
        user: ClaimUser
    ): Promise<UserLink | null> {
        return user.platform === 'discord'
            ? this.linkService.getUserLinkForDiscordUser(
                  guildLinkId,
                  user.userId
              )
            : this.linkService.getUserLinkForFluxerUser(
                  guildLinkId,
                  user.userId
              );
    }

    /** The account a mapping row pairs `user` with. */
    private counterpart(link: UserLink, user: ClaimUser): ClaimUser {
        return user.platform === 'discord'
            ? { platform: 'fluxer', userId: link.fluxerUserId }
            : { platform: 'discord', userId: link.discordUserId };
    }

    private buildPromptText(claim: PendingIdentityClaim): string {
        const p = this.commandPrefix;
        const claimerPlatform = PLATFORM_NAMES[claim.claimer.platform];
        const targetPlatform = PLATFORM_NAMES[claim.target.platform];
        const name = escapeDisplayName(claim.claimer.displayName) || 'Someone';
        return (
            `<@${claim.target.userId}>, **${name}** on ${claimerPlatform} says this ${targetPlatform} account is theirs. ` +
            `If that's you, run \`${p}iam yes\` within ${this.ttlMinutes} minutes to link the accounts so pings reach you on both sides; ` +
            `\`${p}iam no\` dismisses it.`
        );
    }

    /**
     * `iam` as a reply: the claimer says the author of the replied (bridged)
     * message is their account on the other platform. Validates the message
     * link and existing mappings, then asks the author to confirm.
     */
    async claim(input: {
        guildLink: GuildLink;
        platform: Platform;
        userId: string;
        displayName: string;
        repliedMessageId: string;
    }): Promise<ClaimResult> {
        const { guildLink, platform, userId } = input;
        const messageLink =
            platform === 'discord'
                ? await this.linkService.getMessageLinkByDiscordMessageId(
                      input.repliedMessageId
                  )
                : await this.linkService.getMessageLinkByFluxerMessageId(
                      input.repliedMessageId
                  );
        if (!messageLink || messageLink.guildLinkId !== guildLink.id) {
            return { kind: 'not_bridged' };
        }
        if (!messageLink.sourcePlatform) return { kind: 'unknown_source' };
        if (messageLink.sourcePlatform === platform) {
            return { kind: 'own_platform' };
        }
        if (!messageLink.sourceAuthorId) return { kind: 'no_author' };

        const channelLink = await this.linkService.getChannelLinkById(
            messageLink.channelLinkId
        );
        if (!channelLink) return { kind: 'not_bridged' };

        const claimer: ClaimUser = { platform, userId };
        const target: ClaimUser = {
            platform: messageLink.sourcePlatform,
            userId: messageLink.sourceAuthorId,
        };

        const conflict = await this.checkConflicts(
            guildLink.id,
            claimer,
            target
        );
        if (conflict) return conflict;

        this.prune();
        const cooldownKey = `${platform}:${userId}`;
        const last = this.lastClaimAt.get(cooldownKey);
        const now = this.now();
        if (last !== undefined && now - last < this.cooldownMs) {
            return {
                kind: 'cooldown',
                retryAfterMs: this.cooldownMs - (now - last),
            };
        }

        const claim: PendingIdentityClaim = {
            guildLinkId: guildLink.id,
            claimer: { ...claimer, displayName: input.displayName },
            target,
            expiresAt: now + this.ttlMs,
        };
        const key = this.pendingKey(guildLink.id, target);
        // Set before sending so a concurrent claim cannot slip through.
        this.pending.set(key, claim);
        this.lastClaimAt.set(cooldownKey, now);

        const sender = this.senders[target.platform];
        try {
            if (!sender) {
                throw new Error(
                    `${PLATFORM_NAMES[target.platform]} is not connected`
                );
            }
            await sender.sendPrompt({
                guildLink,
                channelLink,
                locationId:
                    target.platform === 'discord'
                        ? discordLocationId(channelLink)
                        : fluxerLocationId(channelLink),
                messageId:
                    target.platform === 'discord'
                        ? messageLink.discordMessageId
                        : messageLink.fluxerMessageId,
                targetUserId: target.userId,
                content: this.buildPromptText(claim),
            });
        } catch (err) {
            if (this.pending.get(key) === claim) this.pending.delete(key);
            if (this.lastClaimAt.get(cooldownKey) === now) {
                this.lastClaimAt.delete(cooldownKey);
            }
            logger.warn(
                `⚠️ Could not post identity claim prompt for ${target.platform} user ${target.userId} in guild link ${guildLink.id}:`,
                err
            );
            return {
                kind: 'prompt_failed',
                target,
                error: (err as Error)?.message ?? String(err),
            };
        }

        logger.info(
            `👥 Identity claim: ${platform} user ${userId} says they are ${target.platform} user ${target.userId} in guild link ${guildLink.id}; waiting for confirmation`
        );
        return { kind: 'sent', claim };
    }

    /** Refuses a claim that would replace or duplicate a mapping. */
    private async checkConflicts(
        guildLinkId: string,
        claimer: ClaimUser,
        target: ClaimUser
    ): Promise<Extract<
        ClaimResult,
        { kind: 'already_linked' | 'claimer_mapped' | 'target_mapped' }
    > | null> {
        const claimerLink = await this.findUserLink(guildLinkId, claimer);
        if (claimerLink) {
            const mappedTo = this.counterpart(claimerLink, claimer);
            if (mappedTo.userId === target.userId) {
                return { kind: 'already_linked', target };
            }
            return { kind: 'claimer_mapped', mappedTo };
        }
        const targetLink = await this.findUserLink(guildLinkId, target);
        if (targetLink) return { kind: 'target_mapped', target };
        return null;
    }

    /**
     * `iam yes` by the target: maps the accounts of the pending claim, as
     * long as neither got mapped to someone else meanwhile.
     */
    async confirm(input: {
        guildLinkId: string;
        platform: Platform;
        userId: string;
    }): Promise<ConfirmResult> {
        const target: ClaimUser = {
            platform: input.platform,
            userId: input.userId,
        };
        const claim = this.getPending(input.guildLinkId, target);
        if (!claim) return { kind: 'no_pending' };
        this.pending.delete(this.pendingKey(input.guildLinkId, target));

        const conflict = await this.checkConflicts(
            input.guildLinkId,
            claim.claimer,
            target
        );
        if (conflict?.kind === 'already_linked') {
            return { kind: 'already_linked', claim };
        }
        if (conflict) return { kind: 'conflict', claim };

        const discordUserId =
            target.platform === 'discord'
                ? target.userId
                : claim.claimer.userId;
        const fluxerUserId =
            target.platform === 'fluxer' ? target.userId : claim.claimer.userId;
        const { link } = await this.linkService.setUserLink({
            guildLinkId: input.guildLinkId,
            discordUserId,
            fluxerUserId,
        });
        logger.info(
            `👥 Mapped Discord user ${discordUserId} to Fluxer user ${fluxerUserId} in guild link ${input.guildLinkId} (confirmed with iam)`
        );
        return { kind: 'linked', claim, link };
    }

    /** `iam no` by the target: dismisses the pending claim. */
    async deny(input: {
        guildLinkId: string;
        platform: Platform;
        userId: string;
    }): Promise<DenyResult> {
        const target: ClaimUser = {
            platform: input.platform,
            userId: input.userId,
        };
        const claim = this.getPending(input.guildLinkId, target);
        if (!claim) return { kind: 'no_pending' };
        this.pending.delete(this.pendingKey(input.guildLinkId, target));
        logger.info(
            `👥 Identity claim by ${claim.claimer.platform} user ${claim.claimer.userId} dismissed by ${target.platform} user ${target.userId} in guild link ${input.guildLinkId}`
        );
        return { kind: 'denied', claim };
    }

    /** `iam`: the caller's mapping and any claim waiting for them. */
    async status(input: {
        guildLinkId: string;
        platform: Platform;
        userId: string;
    }): Promise<StatusResult> {
        const user: ClaimUser = {
            platform: input.platform,
            userId: input.userId,
        };
        const link = await this.findUserLink(input.guildLinkId, user);
        return {
            linkedTo: link ? this.counterpart(link, user) : null,
            pendingForCaller: this.getPending(input.guildLinkId, user),
        };
    }

    /** `iam remove`: deletes the caller's own mapping. */
    async remove(input: {
        guildLinkId: string;
        platform: Platform;
        userId: string;
    }): Promise<RemoveResult> {
        const user: ClaimUser = {
            platform: input.platform,
            userId: input.userId,
        };
        const link = await this.findUserLink(input.guildLinkId, user);
        if (!link) return { kind: 'not_linked' };
        await this.linkService.removeUserLink(link.id);
        logger.info(
            `👥 Removed mapping of Discord user ${link.discordUserId} and Fluxer user ${link.fluxerUserId} in guild link ${input.guildLinkId} (iam remove by ${user.platform} user ${user.userId})`
        );
        return { kind: 'removed', was: this.counterpart(link, user) };
    }
}
