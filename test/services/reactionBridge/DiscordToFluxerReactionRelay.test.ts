import { describe, expect, it, vi } from 'vitest';
import { Collection } from 'discord.js';
import DiscordToFluxerReactionRelay from '../../../src/services/reactionBridge/DiscordToFluxerReactionRelay';
import FluxerEntityResolver from '../../../src/services/entityResolver/FluxerEntityResolver';
import MetricsService from '../../../src/services/MetricsService';
import {
    FakeLinkService,
    guildLink,
    makeChannelLink,
} from '../../helpers/fakes';

const BOT_ID = 'discord-bot';
const DISCORD_MESSAGE_ID = 'dmsg-1';
const FLUXER_MESSAGE_ID = 'fmsg-1';

const FLUXER_EMOJIS = [
    { name: 'pepe', id: 'f-pepe', animated: false },
    { name: 'party', id: 'f-party', animated: true },
];

type FakeEmoji = { name: string | null; id: string | null; animated?: boolean };

function fakeFluxerMessage(
    reactions: { emoji: { name: string; id?: string }; me: boolean }[] = []
) {
    return {
        id: FLUXER_MESSAGE_ID,
        react: vi.fn(async () => {}),
        removeReaction: vi.fn(async () => {}),
        reactions: {
            cache: new Map(
                reactions.map((r) => [
                    r.emoji.id ? `${r.emoji.name}:${r.emoji.id}` : r.emoji.name,
                    r,
                ])
            ),
        },
    };
}

function fakeReaction({
    emoji,
    messageId = DISCORD_MESSAGE_ID,
    guildId = 'dguild' as string | null,
    partial = false,
    remainingUserIds = [] as string[],
}: {
    emoji: FakeEmoji;
    messageId?: string;
    guildId?: string | null;
    partial?: boolean;
    remainingUserIds?: string[];
}) {
    const reaction = {
        partial,
        emoji,
        message: { id: messageId, guildId },
        client: { user: { id: BOT_ID } },
        users: {
            fetch: vi.fn(
                async () =>
                    new Collection(remainingUserIds.map((id) => [id, { id }]))
            ),
        },
        fetch: vi.fn(async () => {
            reaction.partial = false;
            return reaction;
        }),
    };
    return reaction;
}

const user = (id: string) => ({ id }) as never;

function setup({
    bridged = true,
    fluxerMessage = fakeFluxerMessage(),
}: {
    bridged?: boolean;
    fluxerMessage?: ReturnType<typeof fakeFluxerMessage>;
} = {}) {
    const links = new FakeLinkService();
    const channelLink = makeChannelLink();
    links.links.push(channelLink);
    if (bridged) {
        links.createMessageLink({
            discordMessageId: DISCORD_MESSAGE_ID,
            fluxerMessageId: FLUXER_MESSAGE_ID,
            guildLinkId: guildLink.id,
            channelLinkId: channelLink.id,
            sourcePlatform: 'discord',
        });
    }

    const fluxerResolver = {
        fetchMessage: vi.fn(async () => fluxerMessage),
        fetchEmojis: vi.fn(async () => FLUXER_EMOJIS),
    };
    const metrics = {
        reactionsRelayed: { inc: vi.fn() },
        reactionRelayErrors: { inc: vi.fn() },
    };

    const relay = new DiscordToFluxerReactionRelay({
        linkService: links.asLinkService(),
        fluxerEntityResolver: fluxerResolver as unknown as FluxerEntityResolver,
        metricsService: metrics as unknown as MetricsService,
    });

    return {
        relay,
        links,
        channelLink,
        fluxerResolver,
        fluxerMessage,
        metrics,
    };
}

describe('handleReactionAdd', () => {
    it('reacts on the Fluxer counterpart with a Unicode emoji', async () => {
        const t = setup();

        await t.relay.handleReactionAdd(
            fakeReaction({ emoji: { name: '👍', id: null } }) as never,
            user('alice')
        );

        expect(t.fluxerResolver.fetchMessage).toHaveBeenCalledWith(
            guildLink.fluxerGuildId,
            t.channelLink.fluxerChannelId,
            FLUXER_MESSAGE_ID
        );
        expect(t.fluxerMessage.react).toHaveBeenCalledWith({
            name: '👍',
            id: undefined,
            animated: false,
        });
        expect(t.metrics.reactionsRelayed.inc).toHaveBeenCalledWith({
            direction: 'discord_to_fluxer',
        });
    });

    it('maps a custom emoji to the Fluxer emoji with the same name', async () => {
        const t = setup();

        await t.relay.handleReactionAdd(
            fakeReaction({
                emoji: { name: 'party', id: 'd-party', animated: false },
            }) as never,
            user('alice')
        );

        expect(t.fluxerResolver.fetchEmojis).toHaveBeenCalledWith(
            guildLink.fluxerGuildId
        );
        expect(t.fluxerMessage.react).toHaveBeenCalledWith({
            name: 'party',
            id: 'f-party',
            animated: true,
        });
    });

    it('does nothing for a custom emoji the Fluxer guild lacks', async () => {
        const t = setup();

        await t.relay.handleReactionAdd(
            fakeReaction({ emoji: { name: 'nope', id: 'd-nope' } }) as never,
            user('alice')
        );

        expect(t.fluxerMessage.react).not.toHaveBeenCalled();
        expect(t.metrics.reactionsRelayed.inc).not.toHaveBeenCalled();
        expect(t.metrics.reactionRelayErrors.inc).not.toHaveBeenCalled();
    });

    it("ignores the bot's own reactions", async () => {
        const t = setup();

        await t.relay.handleReactionAdd(
            fakeReaction({ emoji: { name: '👍', id: null } }) as never,
            user(BOT_ID)
        );

        expect(t.fluxerResolver.fetchMessage).not.toHaveBeenCalled();
        expect(t.fluxerMessage.react).not.toHaveBeenCalled();
    });

    it('ignores reactions outside guilds', async () => {
        const t = setup();

        await t.relay.handleReactionAdd(
            fakeReaction({
                emoji: { name: '👍', id: null },
                guildId: null,
            }) as never,
            user('alice')
        );

        expect(t.fluxerResolver.fetchMessage).not.toHaveBeenCalled();
    });

    it('does not touch Fluxer for an unbridged message', async () => {
        const t = setup({ bridged: false });

        await t.relay.handleReactionAdd(
            fakeReaction({ emoji: { name: '👍', id: null } }) as never,
            user('alice')
        );

        expect(t.fluxerResolver.fetchMessage).not.toHaveBeenCalled();
        expect(t.fluxerResolver.fetchEmojis).not.toHaveBeenCalled();
        expect(t.fluxerMessage.react).not.toHaveBeenCalled();
    });

    it('swallows a 409 when the bot already reacted with that emoji', async () => {
        const fluxerMessage = fakeFluxerMessage();
        fluxerMessage.react.mockRejectedValueOnce(
            Object.assign(new Error('Conflict'), { status: 409 })
        );
        const t = setup({ fluxerMessage });

        await t.relay.handleReactionAdd(
            fakeReaction({ emoji: { name: '👍', id: null } }) as never,
            user('alice')
        );

        expect(t.metrics.reactionRelayErrors.inc).not.toHaveBeenCalled();
        expect(t.metrics.reactionsRelayed.inc).toHaveBeenCalled();
    });

    it('logs and counts an error when the resolver throws, without rethrowing', async () => {
        const t = setup();
        t.fluxerResolver.fetchMessage.mockRejectedValueOnce(
            new Error('Fluxer channel not found')
        );

        await expect(
            t.relay.handleReactionAdd(
                fakeReaction({ emoji: { name: '👍', id: null } }) as never,
                user('alice')
            )
        ).resolves.toBeUndefined();

        expect(t.metrics.reactionRelayErrors.inc).toHaveBeenCalledWith({
            direction: 'discord_to_fluxer',
        });
        expect(t.metrics.reactionsRelayed.inc).not.toHaveBeenCalled();
    });
});

describe('handleReactionRemove', () => {
    it('keeps the Fluxer reaction while another non-bot user still reacts', async () => {
        const t = setup();

        await t.relay.handleReactionRemove(
            fakeReaction({
                emoji: { name: '👍', id: null },
                remainingUserIds: [BOT_ID, 'bob'],
            }) as never,
            user('alice')
        );

        expect(t.fluxerMessage.removeReaction).not.toHaveBeenCalled();
    });

    it('removes the Fluxer reaction when only the bot remains', async () => {
        const t = setup();
        const reaction = fakeReaction({
            emoji: { name: '👍', id: null },
            remainingUserIds: [BOT_ID],
        });

        await t.relay.handleReactionRemove(reaction as never, user('alice'));

        expect(reaction.users.fetch).toHaveBeenCalledWith({ limit: 2 });
        expect(t.fluxerMessage.removeReaction).toHaveBeenCalledWith({
            name: '👍',
            id: undefined,
            animated: false,
        });
        expect(t.metrics.reactionsRelayed.inc).toHaveBeenCalledWith({
            direction: 'discord_to_fluxer',
        });
    });

    it('removes the Fluxer reaction when nobody remains', async () => {
        const t = setup();

        await t.relay.handleReactionRemove(
            fakeReaction({
                emoji: { name: 'pepe', id: 'd-pepe' },
                remainingUserIds: [],
            }) as never,
            user('alice')
        );

        expect(t.fluxerMessage.removeReaction).toHaveBeenCalledWith({
            name: 'pepe',
            id: 'f-pepe',
            animated: false,
        });
    });

    it('fetches a partial reaction before checking the remaining users', async () => {
        const t = setup();
        const reaction = fakeReaction({
            emoji: { name: '👍', id: null },
            partial: true,
            remainingUserIds: [],
        });

        await t.relay.handleReactionRemove(reaction as never, user('alice'));

        expect(reaction.fetch).toHaveBeenCalled();
        expect(reaction.fetch.mock.invocationCallOrder[0]).toBeLessThan(
            reaction.users.fetch.mock.invocationCallOrder[0]
        );
        expect(t.fluxerMessage.removeReaction).toHaveBeenCalled();
    });

    it("ignores removals of the bot's own reactions", async () => {
        const t = setup();
        const reaction = fakeReaction({
            emoji: { name: '👍', id: null },
            remainingUserIds: [],
        });

        await t.relay.handleReactionRemove(reaction as never, user(BOT_ID));

        expect(reaction.users.fetch).not.toHaveBeenCalled();
        expect(t.fluxerMessage.removeReaction).not.toHaveBeenCalled();
    });

    it('does not touch Fluxer for an unbridged message', async () => {
        const t = setup({ bridged: false });
        const reaction = fakeReaction({
            emoji: { name: '👍', id: null },
            partial: true,
            remainingUserIds: [],
        });

        await t.relay.handleReactionRemove(reaction as never, user('alice'));

        expect(reaction.fetch).not.toHaveBeenCalled();
        expect(reaction.users.fetch).not.toHaveBeenCalled();
        expect(t.fluxerResolver.fetchMessage).not.toHaveBeenCalled();
    });

    it('logs and counts an error when the user lookup throws', async () => {
        const t = setup();
        const reaction = fakeReaction({ emoji: { name: '👍', id: null } });
        reaction.users.fetch.mockRejectedValueOnce(new Error('boom'));

        await expect(
            t.relay.handleReactionRemove(reaction as never, user('alice'))
        ).resolves.toBeUndefined();

        expect(t.metrics.reactionRelayErrors.inc).toHaveBeenCalledWith({
            direction: 'discord_to_fluxer',
        });
        expect(t.fluxerMessage.removeReaction).not.toHaveBeenCalled();
    });
});

describe('handleReactionRemoveAll', () => {
    const message = (overrides: { inGuild?: boolean } = {}) =>
        ({
            id: DISCORD_MESSAGE_ID,
            inGuild: () => overrides.inGuild ?? true,
        }) as never;

    it("removes only the bot's own reactions from the counterpart", async () => {
        const fluxerMessage = fakeFluxerMessage([
            { emoji: { name: '👍' }, me: true },
            { emoji: { name: '🔥' }, me: false },
            { emoji: { name: 'pepe', id: 'f-pepe' }, me: true },
        ]);
        const t = setup({ fluxerMessage });

        await t.relay.handleReactionRemoveAll(message());

        expect(fluxerMessage.removeReaction).toHaveBeenCalledTimes(2);
        expect(fluxerMessage.removeReaction).toHaveBeenCalledWith({
            name: '👍',
        });
        expect(fluxerMessage.removeReaction).toHaveBeenCalledWith({
            name: 'pepe',
            id: 'f-pepe',
        });
        expect(t.metrics.reactionsRelayed.inc).toHaveBeenCalledTimes(1);
    });

    it('does nothing when the bot holds no reactions there', async () => {
        const fluxerMessage = fakeFluxerMessage([
            { emoji: { name: '🔥' }, me: false },
        ]);
        const t = setup({ fluxerMessage });

        await t.relay.handleReactionRemoveAll(message());

        expect(fluxerMessage.removeReaction).not.toHaveBeenCalled();
        expect(t.metrics.reactionsRelayed.inc).not.toHaveBeenCalled();
    });

    it('ignores messages outside guilds and unbridged messages', async () => {
        const t = setup({ bridged: false });

        await t.relay.handleReactionRemoveAll(message({ inGuild: false }));
        await t.relay.handleReactionRemoveAll(message());

        expect(t.fluxerResolver.fetchMessage).not.toHaveBeenCalled();
    });
});

describe('handleReactionRemoveEmoji', () => {
    it('removes that emoji from the counterpart', async () => {
        const t = setup();

        await t.relay.handleReactionRemoveEmoji(
            fakeReaction({
                emoji: { name: 'pepe', id: 'd-pepe' },
            }) as never
        );

        expect(t.fluxerMessage.removeReaction).toHaveBeenCalledWith({
            name: 'pepe',
            id: 'f-pepe',
            animated: false,
        });
        expect(t.metrics.reactionsRelayed.inc).toHaveBeenCalledWith({
            direction: 'discord_to_fluxer',
        });
    });

    it('does nothing for an unbridged message', async () => {
        const t = setup({ bridged: false });

        await t.relay.handleReactionRemoveEmoji(
            fakeReaction({ emoji: { name: '👍', id: null } }) as never
        );

        expect(t.fluxerResolver.fetchMessage).not.toHaveBeenCalled();
        expect(t.fluxerMessage.removeReaction).not.toHaveBeenCalled();
    });

    it('logs and counts an error when removal throws', async () => {
        const fluxerMessage = fakeFluxerMessage();
        fluxerMessage.removeReaction.mockRejectedValueOnce(new Error('boom'));
        const t = setup({ fluxerMessage });

        await expect(
            t.relay.handleReactionRemoveEmoji(
                fakeReaction({ emoji: { name: '👍', id: null } }) as never
            )
        ).resolves.toBeUndefined();

        expect(t.metrics.reactionRelayErrors.inc).toHaveBeenCalledWith({
            direction: 'discord_to_fluxer',
        });
    });
});
