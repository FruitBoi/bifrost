import { describe, expect, it, vi } from 'vitest';
import ChannelLinkBridge from '../../src/services/channelLinkBridge/ChannelLinkBridge';
import { sanitizeMentions } from '../../src/utils/sanitizeMentions';

const D_GUILD = '800000000000000001';
const F_GUILD = '900000000000000001';
const D_CHAN = '111111111111111111';
const F_CHAN = '222222222222222222';
const D_THREAD = '333333333333333333';
const F_THREAD = '444444444444444444';
const D_OTHER = '555555555555555555';
const F_OTHER = '666666666666666666';
const D_MSG = '777777777777777771';
const F_MSG = '888888888888888881';

type Link = {
    guildLinkId: string;
    discordChannelId: string;
    discordThreadId: string | null;
    fluxerChannelId: string;
    fluxerThreadId: string | null;
};

const channelLink: Link = {
    guildLinkId: 'gl1',
    discordChannelId: D_CHAN,
    discordThreadId: null,
    fluxerChannelId: F_CHAN,
    fluxerThreadId: null,
};
// A thread under D_OTHER/F_OTHER.
const threadLink: Link = {
    guildLinkId: 'gl1',
    discordChannelId: D_OTHER,
    discordThreadId: D_THREAD,
    fluxerChannelId: F_OTHER,
    fluxerThreadId: F_THREAD,
};

function fakeLinkService(links: Link[] = [channelLink, threadLink]) {
    return {
        getChannelLinkByDiscordLocation: vi.fn(async (id: string) => {
            return (
                links.find(
                    (l) =>
                        l.discordThreadId === id ||
                        (l.discordChannelId === id &&
                            l.discordThreadId === null)
                ) ?? null
            );
        }),
        getChannelLinkByFluxerLocation: vi.fn(async (id: string) => {
            return (
                links.find(
                    (l) =>
                        l.fluxerThreadId === id ||
                        (l.fluxerChannelId === id && l.fluxerThreadId === null)
                ) ?? null
            );
        }),
        getGuildLinkById: vi.fn(async (id: string) =>
            id === 'gl1'
                ? { id, discordGuildId: D_GUILD, fluxerGuildId: F_GUILD }
                : null
        ),
    };
}

function makeBridge(
    service = fakeLinkService(),
    resolver?: { resolveCounterpartUrl: ReturnType<typeof vi.fn> }
) {
    return new ChannelLinkBridge(service as never, resolver as never);
}

describe('ChannelLinkBridge.extractChannelMentionIds', () => {
    it('returns the distinct channel mention ids in order', () => {
        const ids = ChannelLinkBridge.extractChannelMentionIds(
            `see <#${D_CHAN}> and <#${D_THREAD}> and again <#${D_CHAN}>`
        );
        expect(ids).toEqual([D_CHAN, D_THREAD]);
    });

    it('ignores user and role mentions and text without mentions', () => {
        expect(
            ChannelLinkBridge.extractChannelMentionIds(
                `<@${D_CHAN}> <@&${D_CHAN}> #general`
            )
        ).toEqual([]);
    });
});

describe('ChannelLinkBridge.resolveChannelMentions', () => {
    it('maps Discord channels and threads to their Fluxer counterparts', async () => {
        const map = await makeBridge().resolveChannelMentions('discord', [
            D_CHAN,
            D_THREAD,
        ]);
        expect(map.get(D_CHAN)).toBe(F_CHAN);
        // The thread id is preferred over its parent channel.
        expect(map.get(D_THREAD)).toBe(F_THREAD);
    });

    it('maps Fluxer channels and threads to their Discord counterparts', async () => {
        const map = await makeBridge().resolveChannelMentions('fluxer', [
            F_CHAN,
            F_THREAD,
        ]);
        expect(map.get(F_CHAN)).toBe(D_CHAN);
        expect(map.get(F_THREAD)).toBe(D_THREAD);
    });

    it('prefers the thread id of a mixed channel-to-thread link', async () => {
        const mixed: Link = {
            ...channelLink,
            discordThreadId: null,
            fluxerChannelId: F_OTHER,
            fluxerThreadId: F_THREAD,
        };
        const bridge = makeBridge(fakeLinkService([mixed]));
        const map = await bridge.resolveChannelMentions('discord', [D_CHAN]);
        expect(map.get(D_CHAN)).toBe(F_THREAD);
    });

    it('omits ids that are not bridged', async () => {
        const map = await makeBridge().resolveChannelMentions('discord', [
            D_CHAN,
            '999999999999999999',
        ]);
        expect([...map.keys()]).toEqual([D_CHAN]);
    });

    it('treats a lookup that throws as unbridged', async () => {
        const service = fakeLinkService();
        service.getChannelLinkByDiscordLocation.mockRejectedValue(
            new Error('db down')
        );
        const map = await makeBridge(service).resolveChannelMentions(
            'discord',
            [D_CHAN]
        );
        expect(map.size).toBe(0);
    });
});

describe('ChannelLinkBridge.rewriteChannelUrls', () => {
    it('rewrites a Discord channel link to the Fluxer one', async () => {
        const out = await makeBridge().rewriteChannelUrls(
            'discord',
            `go to https://discord.com/channels/${D_GUILD}/${D_CHAN} now`
        );
        expect(out).toBe(
            `go to https://fluxer.app/channels/${F_GUILD}/${F_CHAN} now`
        );
    });

    it('rewrites a Fluxer channel link to the Discord one', async () => {
        const out = await makeBridge().rewriteChannelUrls(
            'fluxer',
            `https://fluxer.app/channels/${F_GUILD}/${F_CHAN}`
        );
        expect(out).toBe(`https://discord.com/channels/${D_GUILD}/${D_CHAN}`);
    });

    it('handles ptb, canary, discordapp and web.fluxer.app hosts', async () => {
        const bridge = makeBridge();
        expect(
            await bridge.rewriteChannelUrls(
                'discord',
                `https://ptb.discord.com/channels/${D_GUILD}/${D_CHAN}`
            )
        ).toBe(`https://fluxer.app/channels/${F_GUILD}/${F_CHAN}`);
        expect(
            await bridge.rewriteChannelUrls(
                'discord',
                `https://canary.discord.com/channels/${D_GUILD}/${D_CHAN}`
            )
        ).toBe(`https://fluxer.app/channels/${F_GUILD}/${F_CHAN}`);
        expect(
            await bridge.rewriteChannelUrls(
                'discord',
                `https://discordapp.com/channels/${D_GUILD}/${D_CHAN}`
            )
        ).toBe(`https://fluxer.app/channels/${F_GUILD}/${F_CHAN}`);
        expect(
            await bridge.rewriteChannelUrls(
                'fluxer',
                `https://web.fluxer.app/channels/${F_GUILD}/${F_CHAN}`
            )
        ).toBe(`https://discord.com/channels/${D_GUILD}/${D_CHAN}`);
    });

    it('rewrites a thread link to the counterpart thread', async () => {
        const bridge = makeBridge();
        expect(
            await bridge.rewriteChannelUrls(
                'discord',
                `https://discord.com/channels/${D_GUILD}/${D_THREAD}`
            )
        ).toBe(`https://fluxer.app/channels/${F_GUILD}/${F_THREAD}`);
        expect(
            await bridge.rewriteChannelUrls(
                'fluxer',
                `https://fluxer.app/channels/${F_GUILD}/${F_THREAD}`
            )
        ).toBe(`https://discord.com/channels/${D_GUILD}/${D_THREAD}`);
    });

    it('rewrites every occurrence, including repeated links', async () => {
        const url = `https://discord.com/channels/${D_GUILD}/${D_CHAN}`;
        const out = await makeBridge().rewriteChannelUrls(
            'discord',
            `${url} and ${url}`
        );
        const target = `https://fluxer.app/channels/${F_GUILD}/${F_CHAN}`;
        expect(out).toBe(`${target} and ${target}`);
    });

    it('leaves an unbridged channel link untouched', async () => {
        const content = `https://discord.com/channels/${D_GUILD}/999999999999999999`;
        expect(await makeBridge().rewriteChannelUrls('discord', content)).toBe(
            content
        );
    });

    it('leaves content without links untouched', async () => {
        expect(await makeBridge().rewriteChannelUrls('discord', 'hi')).toBe(
            'hi'
        );
    });

    it('leaves the link untouched when the guild link is missing', async () => {
        const service = fakeLinkService([
            { ...channelLink, guildLinkId: 'missing' },
        ]);
        const content = `https://discord.com/channels/${D_GUILD}/${D_CHAN}`;
        expect(
            await makeBridge(service).rewriteChannelUrls('discord', content)
        ).toBe(content);
    });

    it('treats a lookup that throws as unbridged', async () => {
        const service = fakeLinkService();
        service.getChannelLinkByDiscordLocation.mockRejectedValue(
            new Error('db down')
        );
        const content = `https://discord.com/channels/${D_GUILD}/${D_CHAN}`;
        expect(
            await makeBridge(service).rewriteChannelUrls('discord', content)
        ).toBe(content);
    });

    it('does not partially match a longer id', async () => {
        const longer = `${D_CHAN}9`;
        const content = `https://discord.com/channels/${D_GUILD}/${longer}`;
        const service = fakeLinkService();
        expect(
            await makeBridge(service).rewriteChannelUrls('discord', content)
        ).toBe(content);
        expect(
            service.getChannelLinkByDiscordLocation
        ).not.toHaveBeenCalledWith(D_CHAN);
    });

    it('rewrites a message link through the reply link resolver', async () => {
        const resolver = {
            resolveCounterpartUrl: vi.fn(
                async () =>
                    `https://fluxer.app/channels/${F_GUILD}/${F_CHAN}/${F_MSG}`
            ),
        };
        const out = await makeBridge(
            fakeLinkService(),
            resolver
        ).rewriteChannelUrls(
            'discord',
            `look: https://discord.com/channels/${D_GUILD}/${D_CHAN}/${D_MSG}!`
        );
        expect(out).toBe(
            `look: https://fluxer.app/channels/${F_GUILD}/${F_CHAN}/${F_MSG}!`
        );
        expect(resolver.resolveCounterpartUrl).toHaveBeenCalledWith(
            'discord',
            D_MSG
        );
    });

    it('leaves a message link untouched when the message was never bridged', async () => {
        const resolver = {
            resolveCounterpartUrl: vi.fn(async () => null),
        };
        const content = `https://discord.com/channels/${D_GUILD}/${D_CHAN}/${D_MSG}`;
        expect(
            await makeBridge(fakeLinkService(), resolver).rewriteChannelUrls(
                'discord',
                content
            )
        ).toBe(content);
    });
});

describe('sanitizeMentions renderChannelMention', () => {
    const base = {
        resolveUser: () => null,
        resolveRole: () => null,
        resolveChannel: (id: string) => (id === '1' ? 'general' : null),
    };

    it('uses the rendered mention instead of #name when it returns a string', () => {
        const out = sanitizeMentions('see <#1> and <#2>', {
            ...base,
            renderChannelMention: (id) => (id === '1' ? '<#42>' : null),
        });
        expect(out).toBe('see <#42> and #unknown-channel');
    });

    it('falls back to #name when the renderer returns null or is absent', () => {
        expect(
            sanitizeMentions('<#1>', {
                ...base,
                renderChannelMention: () => null,
            })
        ).toBe('#general');
        expect(sanitizeMentions('<#1>', base)).toBe('#general');
    });
});
