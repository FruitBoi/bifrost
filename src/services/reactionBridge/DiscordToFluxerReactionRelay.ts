import {
    Message,
    MessageReaction,
    PartialMessage,
    PartialMessageReaction,
    PartialUser,
    User,
} from 'discord.js';
import { Message as FluxerMessage } from '@fluxerjs/core';
import logger from '../../utils/logging/logger';
import {
    isFluxerApiBlockError,
    isFluxerApiBlocked,
    markFluxerApiBlocked,
} from '../../utils/fluxerApiGuard';
import { fluxerLocationId } from '../../db/entities/ChannelLink';
import FluxerEntityResolver from '../entityResolver/FluxerEntityResolver';
import { LinkService } from '../LinkService';
import MetricsService from '../MetricsService';
import {
    mapReactionEmoji,
    ReactionEmoji,
    reactionEmojiKey,
    toReactionEmoji,
} from './reactionEmoji';

const DIRECTION = 'discord_to_fluxer';

/** The emoji shape `@fluxerjs/core`'s `Message.react` / `removeReaction` take. */
function toFluxerEmojiInput(emoji: ReactionEmoji): {
    name: string;
    id?: string;
    animated?: boolean;
} {
    return {
        name: emoji.name,
        id: emoji.id ?? undefined,
        animated: emoji.animated,
    };
}

/** Reacting twice with the same emoji is rejected by some APIs with a 409. */
function isConflictError(err: unknown): boolean {
    if (typeof err !== 'object' || err === null) return false;
    const { status, statusCode } = err as {
        status?: unknown;
        statusCode?: unknown;
    };
    return status === 409 || statusCode === 409;
}

/**
 * Mirrors Discord reactions onto the Fluxer counterpart of bridged messages.
 *
 * Webhooks cannot react, so the bot account reacts on the Fluxer copy. The
 * bot's reaction with emoji E therefore means "at least one Discord user
 * reacted with E"; it is added on the first Discord reaction and removed
 * once no Discord user (other than the bot itself, whose own reactions
 * represent Fluxer-side reactors) still has E on the Discord message.
 */
export default class DiscordToFluxerReactionRelay {
    private readonly linkService: LinkService;
    private readonly fluxerEntityResolver: FluxerEntityResolver;
    private readonly metricsService?: MetricsService;

    constructor({
        linkService,
        fluxerEntityResolver,
        metricsService,
    }: {
        linkService: LinkService;
        fluxerEntityResolver: FluxerEntityResolver;
        metricsService?: MetricsService;
    }) {
        this.linkService = linkService;
        this.fluxerEntityResolver = fluxerEntityResolver;
        this.metricsService = metricsService;
    }

    /** A Discord user added a reaction: add the same emoji on the Fluxer copy. */
    public async handleReactionAdd(
        reaction: MessageReaction | PartialMessageReaction,
        user: User | PartialUser
    ): Promise<void> {
        if (!this.isRelevant(reaction, user)) return;

        await this.run('adding', async () => {
            const counterpart = await this.resolveCounterpart(
                reaction.message.id
            );
            if (!counterpart) return;

            const emoji = await this.mapToFluxer(
                reaction,
                counterpart.fluxerGuildId
            );
            if (!emoji) return;

            try {
                await counterpart.message.react(toFluxerEmojiInput(emoji));
            } catch (error) {
                if (!isConflictError(error)) throw error;
                logger.debug(
                    `🔁 Fluxer message ${counterpart.message.id} already carries reaction ${reactionEmojiKey(emoji)}`
                );
            }
            this.metricsService?.reactionsRelayed.inc({ direction: DIRECTION });
        });
    }

    /**
     * A Discord user removed a reaction: once no other Discord user still has
     * that emoji on the message, remove the bot's own from the Fluxer copy.
     */
    public async handleReactionRemove(
        reaction: MessageReaction | PartialMessageReaction,
        user: User | PartialUser
    ): Promise<void> {
        if (!this.isRelevant(reaction, user)) return;

        await this.run('removing', async () => {
            const counterpart = await this.resolveCounterpart(
                reaction.message.id
            );
            if (!counterpart) return;

            if (reaction.partial) await reaction.fetch();
            if (await this.hasRemainingDiscordReactor(reaction)) return;

            const emoji = await this.mapToFluxer(
                reaction,
                counterpart.fluxerGuildId
            );
            if (!emoji) return;

            await counterpart.message.removeReaction(toFluxerEmojiInput(emoji));
            this.metricsService?.reactionsRelayed.inc({ direction: DIRECTION });
        });
    }

    /**
     * All reactions were cleared from a Discord message: every reaction the
     * bot holds on the Fluxer copy represented Discord users, so drop them.
     */
    public async handleReactionRemoveAll(
        message: Message | PartialMessage
    ): Promise<void> {
        if (!message.inGuild()) return;

        await this.run('clearing', async () => {
            const counterpart = await this.resolveCounterpart(message.id);
            if (!counterpart) return;

            const mine = [
                ...counterpart.message.reactions.cache.values(),
            ].filter((r) => r.me);
            for (const r of mine) {
                await counterpart.message.removeReaction(r.emoji);
            }
            if (mine.length > 0) {
                this.metricsService?.reactionsRelayed.inc({
                    direction: DIRECTION,
                });
            }
        });
    }

    /** A moderator cleared one emoji from a Discord message. */
    public async handleReactionRemoveEmoji(
        reaction: MessageReaction | PartialMessageReaction
    ): Promise<void> {
        if (!reaction.message.guildId) return;

        await this.run('clearing', async () => {
            const counterpart = await this.resolveCounterpart(
                reaction.message.id
            );
            if (!counterpart) return;

            const emoji = await this.mapToFluxer(
                reaction,
                counterpart.fluxerGuildId
            );
            if (!emoji) return;

            await counterpart.message.removeReaction(toFluxerEmojiInput(emoji));
            this.metricsService?.reactionsRelayed.inc({ direction: DIRECTION });
        });
    }

    /**
     * Guild reactions by anyone but the bot. The bot's own reactions mirror
     * Fluxer reactors and firing on them would bounce reactions back and
     * forth between the platforms.
     */
    private isRelevant(
        reaction: MessageReaction | PartialMessageReaction,
        user: User | PartialUser
    ): boolean {
        if (!reaction.message.guildId) return false;
        return user.id !== reaction.client.user?.id;
    }

    /**
     * Whether a Discord user other than the bot still has this reaction.
     * Asks the API instead of trusting cached counts: with partials the cache
     * is often empty, and the bot's own reaction (which stands for Fluxer
     * reactors) must not count as a Discord reactor. Two users suffice: at
     * most one of them can be the bot.
     */
    private async hasRemainingDiscordReactor(
        reaction: MessageReaction | PartialMessageReaction
    ): Promise<boolean> {
        const botId = reaction.client.user?.id;
        const users = await reaction.users.fetch({ limit: 2 });
        return users.some((u) => u.id !== botId);
    }

    /**
     * Translates the reaction's emoji into one that exists on the Fluxer
     * guild, or null when it cannot be mirrored (deleted custom emoji, or a
     * custom emoji the Fluxer guild lacks).
     */
    private async mapToFluxer(
        reaction: MessageReaction | PartialMessageReaction,
        fluxerGuildId: string
    ): Promise<ReactionEmoji | null> {
        const emoji = toReactionEmoji(reaction.emoji);
        if (!emoji) return null;

        const fluxerEmojis =
            await this.fluxerEntityResolver.fetchEmojis(fluxerGuildId);
        const mapped = mapReactionEmoji(emoji, fluxerEmojis);
        if (!mapped) {
            logger.debug(
                `🔁 No Fluxer emoji for Discord reaction ${reactionEmojiKey(emoji)}, not mirroring`
            );
        }
        return mapped;
    }

    /**
     * Finds the Fluxer copy of a Discord message. Null when the message is
     * not bridged (the common case) or the Fluxer API is blocked.
     */
    private async resolveCounterpart(
        discordMessageId: string
    ): Promise<{ message: FluxerMessage; fluxerGuildId: string } | null> {
        const messageLink =
            await this.linkService.getMessageLinkByDiscordMessageId(
                discordMessageId
            );
        if (!messageLink) return null;

        const channelLink = await this.linkService.getChannelLinkById(
            messageLink.channelLinkId
        );
        if (!channelLink) return null;

        const guildLink = await this.linkService.getGuildLinkById(
            channelLink.guildLinkId
        );
        if (!guildLink) return null;

        if (isFluxerApiBlocked()) return null;

        const message = await this.fluxerEntityResolver.fetchMessage(
            guildLink.fluxerGuildId,
            fluxerLocationId(channelLink),
            messageLink.fluxerMessageId
        );
        return { message, fluxerGuildId: guildLink.fluxerGuildId };
    }

    private async run(what: string, fn: () => Promise<void>): Promise<void> {
        try {
            await fn();
        } catch (error) {
            if (isFluxerApiBlockError(error)) markFluxerApiBlocked();
            logger.error(
                `❌ Error ${what} Discord reaction on Fluxer message:`,
                error
            );
            this.metricsService?.reactionRelayErrors.inc({
                direction: DIRECTION,
            });
        }
    }
}
