import { describe, expect, it, vi } from 'vitest';
import type { Client } from '@fluxerjs/core';
import FluxerToDiscordReactionRelay from '../../../src/services/reactionBridge/FluxerToDiscordReactionRelay';
import DiscordEntityResolver from '../../../src/services/entityResolver/DiscordEntityResolver';
import FluxerEntityResolver from '../../../src/services/entityResolver/FluxerEntityResolver';
import MetricsService from '../../../src/services/MetricsService';
import {
    FakeLinkService,
    guildLink,
    makeChannelLink,
} from '../../helpers/fakes';

const BOT_ID = 'fluxer-bot';
const FLUXER_MSG = 'fmsg-1';
const DISCORD_MSG = 'dmsg-1';

const thumbsUp = { name: '👍' };
const customEmoji = { name: 'blob', id: 'f-blob', animated: false };
const discordBlob = { name: 'blob', id: 'd-blob', animated: true };

function fakeDiscordReaction(emoji: { name: string; id?: string }, me = true) {
    return {
        emoji,
        me,
        users: { remove: vi.fn(async () => undefined) },
    };
}

/** Minimal discord.js Message: `react`, and a reaction cache resolvable by key. */
function fakeDiscordMessage(
    reactions: ReturnType<typeof fakeDiscordReaction>[] = []
) {
    const cache = new Map(
        reactions.map((r) => [r.emoji.id ?? r.emoji.name, r] as const)
    );
    return {
        id: DISCORD_MSG,
        guildId: guildLink.discordGuildId,
        react: vi.fn(async () => undefined),
        reactions: {
            cache,
            resolve: (key: string) => cache.get(key) ?? null,
        },
    };
}

function setup(
    opts: { reactions?: ReturnType<typeof fakeDiscordReaction>[] } = {}
) {
    const links = new FakeLinkService();
    const channelLink = makeChannelLink();
    links.links.push(channelLink);
    links.messageLinks.push({
        id: 'ml-1',
        guildLinkId: guildLink.id,
        channelLinkId: channelLink.id,
        discordMessageId: DISCORD_MSG,
        fluxerMessageId: FLUXER_MSG,
        sourcePlatform: 'discord',
        sourceAuthorId: null,
        createdAt: new Date(),
    });

    const discordMessage = fakeDiscordMessage(opts.reactions);
    const discordResolver = {
        fetchMessage: vi.fn(async () => discordMessage),
        fetchEmojis: vi.fn(async () => [discordBlob]),
    };
    const fluxerMessage = {
        id: FLUXER_MSG,
        fetchReactionUsers: vi.fn(async () => [] as { id: string }[]),
    };
    const fluxerResolver = {
        fetchMessage: vi.fn(async () => fluxerMessage),
    };
    const metrics = {
        reactionsRelayed: { inc: vi.fn() },
        reactionRelayErrors: { inc: vi.fn() },
    };

    const relay = new FluxerToDiscordReactionRelay({
        linkService: links.asLinkService(),
        discordEntityResolver:
            discordResolver as unknown as DiscordEntityResolver,
        fluxerEntityResolver: fluxerResolver as unknown as FluxerEntityResolver,
        metricsService: metrics as unknown as MetricsService,
    });
    relay.setFluxerClient({ user: { id: BOT_ID } } as unknown as Client);

    return {
        relay,
        links,
        channelLink,
        discordMessage,
        discordResolver,
        fluxerMessage,
        fluxerResolver,
        metrics,
    };
}

function reactionPayload(
    emoji: { name: string; id?: string; animated?: boolean },
    userId = 'fuser-1',
    messageId = FLUXER_MSG
) {
    return {
        reaction: {},
        user: { id: userId },
        message: null,
        channel: null,
        member: null,
        messageId,
        channelId: 'fchan',
        emoji,
        userId,
    } as never;
}

describe('reaction add', () => {
    it('mirrors a unicode reaction onto the Discord counterpart', async () => {
        const t = setup();

        await t.relay.handleReactionAdd(reactionPayload(thumbsUp));

        expect(t.discordResolver.fetchMessage).toHaveBeenCalledWith(
            guildLink.discordGuildId,
            t.channelLink.discordChannelId,
            DISCORD_MSG
        );
        expect(t.discordMessage.react).toHaveBeenCalledWith('👍');
        expect(t.metrics.reactionsRelayed.inc).toHaveBeenCalledWith({
            direction: 'fluxer_to_discord',
        });
    });

    it('maps a custom emoji to the Discord emoji with the same name', async () => {
        const t = setup();

        await t.relay.handleReactionAdd(reactionPayload(customEmoji));

        expect(t.discordMessage.react).toHaveBeenCalledWith('<a:blob:d-blob>');
    });

    it('skips a custom emoji the Discord guild does not have', async () => {
        const t = setup();

        await t.relay.handleReactionAdd(
            reactionPayload({ name: 'nope', id: 'f-nope' })
        );

        expect(t.discordMessage.react).not.toHaveBeenCalled();
        expect(t.metrics.reactionsRelayed.inc).not.toHaveBeenCalled();
    });

    it("ignores the bot's own reactions", async () => {
        const t = setup();

        await t.relay.handleReactionAdd(reactionPayload(thumbsUp, BOT_ID));

        expect(t.discordResolver.fetchMessage).not.toHaveBeenCalled();
        expect(t.discordMessage.react).not.toHaveBeenCalled();
    });

    it('does nothing for an unbridged message', async () => {
        const t = setup();

        await t.relay.handleReactionAdd(
            reactionPayload(thumbsUp, 'fuser-1', 'not-bridged')
        );

        expect(t.discordResolver.fetchMessage).not.toHaveBeenCalled();
        expect(t.discordMessage.react).not.toHaveBeenCalled();
    });

    it('logs and counts resolver failures without throwing', async () => {
        const t = setup();
        t.discordResolver.fetchMessage.mockRejectedValueOnce(new Error('boom'));

        await expect(
            t.relay.handleReactionAdd(reactionPayload(thumbsUp))
        ).resolves.toBeUndefined();

        expect(t.metrics.reactionRelayErrors.inc).toHaveBeenCalledWith({
            direction: 'fluxer_to_discord',
        });
        expect(t.metrics.reactionsRelayed.inc).not.toHaveBeenCalled();
    });
});

describe('reaction add many', () => {
    it('reacts once per distinct emoji and skips the bot', async () => {
        const t = setup();

        await t.relay.handleReactionAddMany({
            channelId: 'fchan',
            messageId: FLUXER_MSG,
            guildId: guildLink.fluxerGuildId,
            message: null,
            channel: null,
            reactions: [
                { userId: 'u1', emoji: thumbsUp, member: null },
                { userId: 'u2', emoji: thumbsUp, member: null },
                { userId: BOT_ID, emoji: { name: '🎉' }, member: null },
                { userId: 'u3', emoji: customEmoji, member: null },
            ],
        } as never);

        expect(t.discordMessage.react.mock.calls).toEqual([
            ['👍'],
            ['<a:blob:d-blob>'],
        ]);
    });

    it('ignores DM payloads', async () => {
        const t = setup();

        await t.relay.handleReactionAddMany({
            channelId: 'dm',
            messageId: FLUXER_MSG,
            guildId: null,
            message: null,
            channel: null,
            reactions: [{ userId: 'u1', emoji: thumbsUp, member: null }],
        } as never);

        expect(t.discordResolver.fetchMessage).not.toHaveBeenCalled();
    });
});

describe('reaction remove', () => {
    it('keeps the Discord reaction while another Fluxer user still has it', async () => {
        const reaction = fakeDiscordReaction(thumbsUp);
        const t = setup({ reactions: [reaction] });
        t.fluxerMessage.fetchReactionUsers.mockResolvedValueOnce([
            { id: BOT_ID },
            { id: 'fuser-2' },
        ]);

        await t.relay.handleReactionRemove(reactionPayload(thumbsUp));

        expect(t.fluxerMessage.fetchReactionUsers).toHaveBeenCalledWith('👍', {
            limit: 2,
        });
        expect(reaction.users.remove).not.toHaveBeenCalled();
    });

    it('removes the Discord reaction when only the bot remains on Fluxer', async () => {
        const reaction = fakeDiscordReaction(thumbsUp);
        const t = setup({ reactions: [reaction] });
        t.fluxerMessage.fetchReactionUsers.mockResolvedValueOnce([
            { id: BOT_ID },
        ]);

        await t.relay.handleReactionRemove(reactionPayload(thumbsUp));

        expect(t.fluxerResolver.fetchMessage).toHaveBeenCalledWith(
            guildLink.fluxerGuildId,
            t.channelLink.fluxerChannelId,
            FLUXER_MSG
        );
        expect(reaction.users.remove).toHaveBeenCalledTimes(1);
        expect(t.metrics.reactionsRelayed.inc).toHaveBeenCalledWith({
            direction: 'fluxer_to_discord',
        });
    });

    it('removes a mapped custom emoji when nobody on Fluxer has it any more', async () => {
        const reaction = fakeDiscordReaction(discordBlob);
        const t = setup({ reactions: [reaction] });
        t.fluxerMessage.fetchReactionUsers.mockResolvedValueOnce([]);

        await t.relay.handleReactionRemove(reactionPayload(customEmoji));

        expect(t.fluxerMessage.fetchReactionUsers).toHaveBeenCalledWith(
            { name: 'blob', id: 'f-blob', animated: false },
            { limit: 2 }
        );
        expect(reaction.users.remove).toHaveBeenCalledTimes(1);
    });

    it('uses the cached message from the payload when present', async () => {
        const t = setup({ reactions: [fakeDiscordReaction(thumbsUp)] });
        const cached = {
            fetchReactionUsers: vi.fn(async () => [{ id: 'fuser-9' }]),
        };

        await t.relay.handleReactionRemove({
            ...(reactionPayload(thumbsUp) as object),
            message: cached,
        } as never);

        expect(cached.fetchReactionUsers).toHaveBeenCalled();
        expect(t.fluxerResolver.fetchMessage).not.toHaveBeenCalled();
    });

    it('leaves reactions the bot did not place alone', async () => {
        const reaction = fakeDiscordReaction(thumbsUp, false);
        const t = setup({ reactions: [reaction] });

        await t.relay.handleReactionRemove(reactionPayload(thumbsUp));

        expect(reaction.users.remove).not.toHaveBeenCalled();
    });

    it("ignores the bot's own reaction removals", async () => {
        const t = setup();

        await t.relay.handleReactionRemove(reactionPayload(thumbsUp, BOT_ID));

        expect(t.fluxerResolver.fetchMessage).not.toHaveBeenCalled();
        expect(t.discordResolver.fetchMessage).not.toHaveBeenCalled();
    });

    it('logs and counts failures without throwing', async () => {
        const t = setup();
        t.fluxerResolver.fetchMessage.mockRejectedValueOnce(new Error('boom'));

        await expect(
            t.relay.handleReactionRemove(reactionPayload(thumbsUp))
        ).resolves.toBeUndefined();

        expect(t.metrics.reactionRelayErrors.inc).toHaveBeenCalledWith({
            direction: 'fluxer_to_discord',
        });
    });
});

describe('reaction remove all', () => {
    it("removes only the bot's own reactions from the counterpart", async () => {
        const mine = fakeDiscordReaction(thumbsUp, true);
        const theirs = fakeDiscordReaction({ name: '🎉' }, false);
        const t = setup({ reactions: [mine, theirs] });

        await t.relay.handleReactionRemoveAll({
            messageId: FLUXER_MSG,
            channelId: 'fchan',
            guildId: guildLink.fluxerGuildId,
            message: null,
            channel: null,
        } as never);

        expect(mine.users.remove).toHaveBeenCalledTimes(1);
        expect(theirs.users.remove).not.toHaveBeenCalled();
    });

    it('does nothing for an unbridged message', async () => {
        const t = setup();

        await t.relay.handleReactionRemoveAll({
            messageId: 'not-bridged',
            channelId: 'fchan',
            guildId: guildLink.fluxerGuildId,
            message: null,
            channel: null,
        } as never);

        expect(t.discordResolver.fetchMessage).not.toHaveBeenCalled();
    });
});

describe('reaction remove emoji', () => {
    it("removes the bot's reaction for the cleared emoji only", async () => {
        const cleared = fakeDiscordReaction(thumbsUp, true);
        const other = fakeDiscordReaction({ name: '🎉' }, true);
        const t = setup({ reactions: [cleared, other] });

        await t.relay.handleReactionRemoveEmoji({
            messageId: FLUXER_MSG,
            channelId: 'fchan',
            guildId: guildLink.fluxerGuildId,
            emoji: thumbsUp,
            message: null,
            channel: null,
        } as never);

        expect(cleared.users.remove).toHaveBeenCalledTimes(1);
        expect(other.users.remove).not.toHaveBeenCalled();
    });

    it('logs and counts failures without throwing', async () => {
        const t = setup();
        t.discordResolver.fetchMessage.mockRejectedValueOnce(new Error('boom'));

        await expect(
            t.relay.handleReactionRemoveEmoji({
                messageId: FLUXER_MSG,
                channelId: 'fchan',
                guildId: guildLink.fluxerGuildId,
                emoji: thumbsUp,
                message: null,
                channel: null,
            } as never)
        ).resolves.toBeUndefined();

        expect(t.metrics.reactionRelayErrors.inc).toHaveBeenCalledWith({
            direction: 'fluxer_to_discord',
        });
    });
});
