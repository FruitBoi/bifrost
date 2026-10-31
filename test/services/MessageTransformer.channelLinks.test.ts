import { beforeEach, describe, expect, it } from 'vitest';
import DiscordMessageTransformer from '../../src/services/messageTransformer/DiscordMessageTransformer';
import FluxerMessageTransformer from '../../src/services/messageTransformer/FluxerMessageTransformer';
import ChannelLinkBridge from '../../src/services/channelLinkBridge/ChannelLinkBridge';
import { FakeLinkService, makeChannelLink } from '../helpers/fakes';

const D_CHAN = '111111111111111111';
const F_CHAN = '222222222222222222';
const D_THREAD = '333333333333333333';
const F_THREAD = '444444444444444444';
const D_PARENT = '555555555555555555';
const F_PARENT = '666666666666666666';
const D_UNBRIDGED = '123456789012345678';
const F_UNBRIDGED = '876543210987654321';
// URLs need numeric guild ids, unlike the shared fakes' guild link.
const D_GUILD = '800000000000000001';
const F_GUILD = '900000000000000001';

function discordMessage(
    content: string,
    channels: Record<string, string> = {}
) {
    return {
        id: 'dmsg',
        content,
        author: { id: 'duser', username: 'dave', avatarURL: () => 'av' },
        client: {
            users: { cache: new Map() },
            channels: {
                cache: new Map(
                    Object.entries(channels).map(([id, name]) => [
                        id,
                        { id, name },
                    ])
                ),
            },
            guilds: { cache: new Map() },
        },
        guild: null,
        attachments: [],
        stickers: [],
        embeds: [],
        poll: null,
        reference: null,
        flags: { has: () => false },
        messageSnapshots: { first: () => undefined },
        mentions: { users: new Map() },
        fetchReference: async () => {
            throw new Error('no reference');
        },
    };
}

function fluxerMessage(content: string, channels: Record<string, string> = {}) {
    const byId = new Map(
        Object.entries(channels).map(([id, name]) => [id, { id, name }])
    );
    return {
        id: 'fmsg',
        content,
        author: { id: 'fuser', username: 'fran', avatarURL: () => 'av' },
        client: {
            users: { get: () => null },
            channels: { get: (id: string) => byId.get(id) ?? null },
        },
        guild: null,
        attachments: [],
        stickers: [],
        embeds: [],
        referencedMessage: null,
        mentions: [],
        webhookId: null,
    };
}

describe('channel links in transformed messages', () => {
    let links: FakeLinkService;
    let bridge: ChannelLinkBridge;

    beforeEach(() => {
        links = new FakeLinkService();
        links.guildLinks[0] = {
            ...links.guildLinks[0],
            discordGuildId: D_GUILD,
            fluxerGuildId: F_GUILD,
        };
        links.links.push(
            makeChannelLink({
                discordChannelId: D_CHAN,
                fluxerChannelId: F_CHAN,
            }),
            makeChannelLink({
                discordChannelId: D_PARENT,
                discordThreadId: D_THREAD,
                fluxerChannelId: F_PARENT,
                fluxerThreadId: F_THREAD,
            })
        );
        bridge = new ChannelLinkBridge(links.asLinkService());
    });

    describe('Discord to Fluxer', () => {
        it('renders a bridged channel and thread mention as the Fluxer counterpart', async () => {
            const transformer = new DiscordMessageTransformer(
                undefined,
                undefined,
                bridge
            );
            const result = await transformer.transformMessage(
                discordMessage(`see <#${D_CHAN}> and <#${D_THREAD}>`, {
                    [D_CHAN]: 'general',
                    [D_THREAD]: 'a-thread',
                }) as never
            );
            expect(result.content).toBe(`see <#${F_CHAN}> and <#${F_THREAD}>`);
        });

        it('keeps #name for an unbridged channel mention', async () => {
            const transformer = new DiscordMessageTransformer(
                undefined,
                undefined,
                bridge
            );
            const result = await transformer.transformMessage(
                discordMessage(
                    `<#${D_CHAN}> <#${D_UNBRIDGED}> <#999999999999999999>`,
                    { [D_UNBRIDGED]: 'random' }
                ) as never
            );
            expect(result.content).toBe(
                `<#${F_CHAN}> #random #unknown-channel`
            );
        });

        it('uses a thread name for an unbridged thread mention', async () => {
            const transformer = new DiscordMessageTransformer();
            const result = await transformer.transformMessage(
                discordMessage(`<#${D_THREAD}>`, {
                    [D_THREAD]: 'a-thread',
                }) as never
            );
            expect(result.content).toBe('#a-thread');
        });

        it('rewrites links to bridged channels and leaves others alone', async () => {
            const transformer = new DiscordMessageTransformer(
                undefined,
                undefined,
                bridge
            );
            const other = `https://discord.com/channels/${D_GUILD}/${D_UNBRIDGED}`;
            const result = await transformer.transformMessage(
                discordMessage(
                    `https://discord.com/channels/${D_GUILD}/${D_CHAN} ${other}`
                ) as never
            );
            expect(result.content).toBe(
                `https://fluxer.app/channels/${F_GUILD}/${F_CHAN} ${other}`
            );
        });

        it('keeps the old behaviour without a bridge', async () => {
            const transformer = new DiscordMessageTransformer();
            const url = `https://discord.com/channels/${D_GUILD}/${D_CHAN}`;
            const result = await transformer.transformMessage(
                discordMessage(`<#${D_CHAN}> ${url}`, {
                    [D_CHAN]: 'general',
                }) as never
            );
            expect(result.content).toBe(`#general ${url}`);
        });
    });

    describe('Fluxer to Discord', () => {
        it('renders a bridged channel and thread mention as the Discord counterpart', async () => {
            const transformer = new FluxerMessageTransformer(
                undefined,
                undefined,
                bridge
            );
            const result = await transformer.transformMessage(
                fluxerMessage(`see <#${F_CHAN}> and <#${F_THREAD}>`, {
                    [F_CHAN]: 'general',
                }) as never
            );
            expect(result.content).toBe(`see <#${D_CHAN}> and <#${D_THREAD}>`);
        });

        it('keeps #name for an unbridged channel mention', async () => {
            const transformer = new FluxerMessageTransformer(
                undefined,
                undefined,
                bridge
            );
            const result = await transformer.transformMessage(
                fluxerMessage(
                    `<#${F_CHAN}> <#${F_UNBRIDGED}> <#999999999999999999>`,
                    {
                        [F_UNBRIDGED]: 'random',
                    }
                ) as never
            );
            expect(result.content).toBe(
                `<#${D_CHAN}> #random #unknown-channel`
            );
        });

        it('rewrites links to bridged channels and leaves others alone', async () => {
            const transformer = new FluxerMessageTransformer(
                undefined,
                undefined,
                bridge
            );
            const other = `https://fluxer.app/channels/${F_GUILD}/${F_UNBRIDGED}`;
            const result = await transformer.transformMessage(
                fluxerMessage(
                    `https://fluxer.app/channels/${F_GUILD}/${F_THREAD} ${other}`
                ) as never
            );
            expect(result.content).toBe(
                `https://discord.com/channels/${D_GUILD}/${D_THREAD} ${other}`
            );
        });

        it('keeps the old behaviour without a bridge', async () => {
            const transformer = new FluxerMessageTransformer();
            const url = `https://fluxer.app/channels/${F_GUILD}/${F_CHAN}`;
            const result = await transformer.transformMessage(
                fluxerMessage(`<#${F_CHAN}> ${url}`, {
                    [F_CHAN]: 'general',
                }) as never
            );
            expect(result.content).toBe(`#general ${url}`);
        });
    });
});
