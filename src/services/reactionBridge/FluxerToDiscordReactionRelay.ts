import type {
    Client,
    Message as FluxerMessage,
    MessageReactionAddManyPayload,
    MessageReactionPayload,
    MessageReactionRemoveAllPayload,
    MessageReactionRemoveEmojiPayload,
} from '@fluxerjs/core';
import type { Message as DiscordMessage } from 'discord.js';
import { LinkService } from '../LinkService';
import DiscordEntityResolver from '../entityResolver/DiscordEntityResolver';
import FluxerEntityResolver from '../entityResolver/FluxerEntityResolver';
import MetricsService from '../MetricsService';
import {
    ChannelLink,
    discordLocationId,
    fluxerLocationId,
} from '../../db/entities/ChannelLink';
import { GuildLink } from '../../db/entities/GuildLink';
import { MessageLink } from '../../db/entities/MessageLink';
import logger from '../../utils/logging/logger';
import {
    isFluxerApiBlockError,
    isFluxerApiBlocked,
    markFluxerApiBlocked,
} from '../../utils/fluxerApiGuard';
import {
    ReactionEmoji,
    mapReactionEmoji,
    reactionEmojiKey,
    toReactionEmoji,
} from './reactionEmoji';

const DIRECTION = { direction: 'fluxer_to_discord' } as const;

/** The bridged Discord counterpart of a Fluxer message, as far as the DB knows. */
interface Counterpart {
    messageLink: MessageLink;
    channelLink: ChannelLink;
    guildLink: GuildLink;
}

/**
 * Mirrors reactions placed on bridged Fluxer messages onto their Discord
 * counterparts.
 *
 * Webhooks cannot react, so the Discord bot account reacts instead. That
 * makes per-user mirroring impossible: the bot's reaction with emoji E on
 * the Discord copy means "at least one person on Fluxer reacted with E".
 * It is added when the first Fluxer user reacts and removed only once no
 * Fluxer user (other than the bot itself, whose reaction stands in for
 * Discord-side reactors) still has E on the Fluxer message.
 *
 * The bot's own reactions are ignored on the way in, which also keeps the
 * two directions from ping-ponging.
 */
export default class FluxerToDiscordReactionRelay {
    private readonly linkService: LinkService;
    private readonly discordEntityResolver: DiscordEntityResolver;
    private readonly fluxerEntityResolver: FluxerEntityResolver;
    private readonly metricsService?: MetricsService;
    private fluxerClient: Client | null = null;

    constructor({
        linkService,
        discordEntityResolver,
        fluxerEntityResolver,
        metricsService,
    }: {
        linkService: LinkService;
        discordEntityResolver: DiscordEntityResolver;
        fluxerEntityResolver: FluxerEntityResolver;
        metricsService?: MetricsService;
    }) {
        this.linkService = linkService;
        this.discordEntityResolver = discordEntityResolver;
        this.fluxerEntityResolver = fluxerEntityResolver;
        this.metricsService = metricsService;
    }

    setFluxerClient(client: Client): void {
        this.fluxerClient = client;
    }

    /** A Fluxer user reacted; mirror the emoji onto the Discord counterpart. */
    async handleReactionAdd(payload: MessageReactionPayload): Promise<void> {
        try {
            if (this.isOwnFluxerUser(payload.userId)) return;
            const emoji = toReactionEmoji(payload.emoji);
            if (!emoji) return;
            await this.addReactions(payload.messageId, [emoji]);
        } catch (error) {
            this.fail(
                `❌ Error mirroring Fluxer reaction on message ${payload.messageId} to Discord:`,
                error
            );
        }
    }

    /** Several reactions arrived at once (e.g. after a gateway resume). */
    async handleReactionAddMany(
        payload: MessageReactionAddManyPayload
    ): Promise<void> {
        try {
            if (!payload.guildId) return;
            const emojis = new Map<string, ReactionEmoji>();
            for (const entry of payload.reactions) {
                if (this.isOwnFluxerUser(entry.userId)) continue;
                const emoji = toReactionEmoji(entry.emoji);
                if (!emoji) continue;
                emojis.set(reactionEmojiKey(emoji), emoji);
            }
            if (emojis.size === 0) return;
            await this.addReactions(payload.messageId, [...emojis.values()]);
        } catch (error) {
            this.fail(
                `❌ Error mirroring Fluxer reactions on message ${payload.messageId} to Discord:`,
                error
            );
        }
    }

    /**
     * A Fluxer user removed their reaction. The Discord mirror only goes
     * away once no other Fluxer user still has that emoji on the message.
     */
    async handleReactionRemove(payload: MessageReactionPayload): Promise<void> {
        try {
            if (this.isOwnFluxerUser(payload.userId)) return;
            const emoji = toReactionEmoji(payload.emoji);
            if (!emoji) return;

            const counterpart = await this.resolveCounterpart(
                payload.messageId
            );
            if (!counterpart) return;

            if (isFluxerApiBlocked()) {
                logger.debug(
                    `⏸️ Fluxer API blocked; not checking remaining reactors on message ${payload.messageId}`
                );
                return;
            }
            if (await this.fluxerReactorsRemain(payload, counterpart, emoji)) {
                return;
            }

            const discordMessage = await this.fetchDiscordMessage(counterpart);
            await this.removeOwnDiscordReactions(
                discordMessage,
                counterpart.guildLink.discordGuildId,
                [emoji]
            );
        } catch (error) {
            this.fail(
                `❌ Error mirroring Fluxer reaction removal on message ${payload.messageId} to Discord:`,
                error
            );
        }
    }

    /** All reactions were cleared on Fluxer; drop every mirror the bot placed. */
    async handleReactionRemoveAll(
        payload: MessageReactionRemoveAllPayload
    ): Promise<void> {
        try {
            if (!payload.guildId) return;
            const counterpart = await this.resolveCounterpart(
                payload.messageId
            );
            if (!counterpart) return;

            const discordMessage = await this.fetchDiscordMessage(counterpart);
            for (const reaction of discordMessage.reactions.cache.values()) {
                if (!reaction.me) continue;
                await reaction.users.remove();
                this.metricsService?.reactionsRelayed.inc(DIRECTION);
            }
        } catch (error) {
            this.fail(
                `❌ Error mirroring Fluxer reaction clear on message ${payload.messageId} to Discord:`,
                error
            );
        }
    }

    /** A moderator cleared one emoji on Fluxer; drop the bot's mirror of it. */
    async handleReactionRemoveEmoji(
        payload: MessageReactionRemoveEmojiPayload
    ): Promise<void> {
        try {
            if (!payload.guildId) return;
            const emoji = toReactionEmoji(payload.emoji);
            if (!emoji) return;

            const counterpart = await this.resolveCounterpart(
                payload.messageId
            );
            if (!counterpart) return;

            const discordMessage = await this.fetchDiscordMessage(counterpart);
            await this.removeOwnDiscordReactions(
                discordMessage,
                counterpart.guildLink.discordGuildId,
                [emoji]
            );
        } catch (error) {
            this.fail(
                `❌ Error mirroring Fluxer emoji clear on message ${payload.messageId} to Discord:`,
                error
            );
        }
    }

    private isOwnFluxerUser(userId: string): boolean {
        const ownId = this.fluxerClient?.user?.id;
        return ownId !== undefined && userId === ownId;
    }

    private fail(message: string, error: unknown): void {
        logger.error(message, error);
        this.metricsService?.reactionRelayErrors.inc(DIRECTION);
    }

    /**
     * Looks up the bridged counterpart. Returns null when the message is not
     * bridged, which is the common case and stays quiet.
     */
    private async resolveCounterpart(
        fluxerMessageId: string
    ): Promise<Counterpart | null> {
        const messageLink =
            await this.linkService.getMessageLinkByFluxerMessageId(
                fluxerMessageId
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

        return { messageLink, channelLink, guildLink };
    }

    private async fetchDiscordMessage({
        messageLink,
        channelLink,
        guildLink,
    }: Counterpart): Promise<DiscordMessage> {
        return this.discordEntityResolver.fetchMessage(
            guildLink.discordGuildId,
            discordLocationId(channelLink),
            messageLink.discordMessageId
        );
    }

    private async addReactions(
        fluxerMessageId: string,
        emojis: ReactionEmoji[]
    ): Promise<void> {
        const counterpart = await this.resolveCounterpart(fluxerMessageId);
        if (!counterpart) return;

        const [discordMessage, discordEmojis] = await Promise.all([
            this.fetchDiscordMessage(counterpart),
            this.discordEntityResolver.fetchEmojis(
                counterpart.guildLink.discordGuildId
            ),
        ]);

        for (const emoji of emojis) {
            const mapped = mapReactionEmoji(emoji, discordEmojis);
            if (!mapped) {
                logger.debug(
                    `🙈 Not mirroring Fluxer reaction :${emoji.name}: to Discord; the Discord guild has no such emoji`
                );
                continue;
            }
            await discordMessage.react(toDiscordReactable(mapped));
            this.metricsService?.reactionsRelayed.inc(DIRECTION);
        }
    }

    /**
     * Whether any Fluxer user other than the bot still has `emoji` on the
     * message. Asks the API rather than the cache: gateway reaction events
     * do not update cached messages' reaction lists.
     */
    private async fluxerReactorsRemain(
        payload: MessageReactionPayload,
        { channelLink, guildLink }: Counterpart,
        emoji: ReactionEmoji
    ): Promise<boolean> {
        try {
            const message: FluxerMessage =
                payload.message ??
                (await this.fluxerEntityResolver.fetchMessage(
                    guildLink.fluxerGuildId,
                    fluxerLocationId(channelLink),
                    payload.messageId
                ));
            // At most one of the reactors is the bot, so two users suffice to
            // tell whether a human is still among them.
            const users = await message.fetchReactionUsers(
                toFluxerEmojiInput(emoji),
                { limit: 2 }
            );
            return users.some((user) => !this.isOwnFluxerUser(user.id));
        } catch (error) {
            if (isFluxerApiBlockError(error)) markFluxerApiBlocked();
            throw error;
        }
    }

    /**
     * Removes the bot's own reactions for `emojis` from the Discord message,
     * mapping each to the Discord guild's emoji first. Emojis the bot never
     * placed (or that do not exist on Discord) are skipped.
     */
    private async removeOwnDiscordReactions(
        discordMessage: DiscordMessage,
        discordGuildId: string,
        emojis: ReactionEmoji[]
    ): Promise<void> {
        const discordEmojis = emojis.some((e) => e.id)
            ? await this.discordEntityResolver.fetchEmojis(discordGuildId)
            : [];

        for (const emoji of emojis) {
            const mapped = mapReactionEmoji(emoji, discordEmojis);
            if (!mapped) continue;
            const reaction = discordMessage.reactions.resolve(
                mapped.id ?? mapped.name
            );
            if (!reaction?.me) continue;
            await reaction.users.remove();
            this.metricsService?.reactionsRelayed.inc(DIRECTION);
        }
    }
}

/** discord.js `Message.react()` input: the character, or `<a:name:id>`. */
function toDiscordReactable(emoji: ReactionEmoji): string {
    if (!emoji.id) return emoji.name;
    return `<${emoji.animated ? 'a' : ''}:${emoji.name}:${emoji.id}>`;
}

/** @fluxerjs/core `EmojiInput`. */
function toFluxerEmojiInput(
    emoji: ReactionEmoji
): string | { name: string; id: string; animated: boolean } {
    if (!emoji.id) return emoji.name;
    return { name: emoji.name, id: emoji.id, animated: emoji.animated };
}
