import { beforeEach, describe, expect, it, vi } from 'vitest';
import MentionBridgeService from '../../src/services/mentionBridge/MentionBridgeService';
import { MessageLink } from '../../src/db/entities/MessageLink';
import { FakeLinkService, makeUserLink } from '../helpers/fakes';
import logger from '../../src/utils/logging/logger';
import {
    breakMentions,
    sanitizeMentions,
} from '../../src/utils/sanitizeMentions';

function makeMessageLink(overrides: Partial<MessageLink> = {}): MessageLink {
    return {
        id: 'ml-1',
        guildLinkId: 'guild-link-1',
        channelLinkId: 'link-1',
        discordMessageId: 'dmsg',
        fluxerMessageId: 'fmsg',
        sourcePlatform: null,
        sourceAuthorId: null,
        createdAt: new Date(),
        ...overrides,
    } as MessageLink;
}

describe('MentionBridgeService.resolveReplyPing', () => {
    let links: FakeLinkService;
    let service: MentionBridgeService;

    beforeEach(() => {
        links = new FakeLinkService();
        service = new MentionBridgeService(links.asLinkService());
        vi.restoreAllMocks();
    });

    it('returns null without looking anything up when the reply does not ping', async () => {
        const lookup = vi.spyOn(links, 'getMessageLinkByDiscordMessageId');
        const info = vi.spyOn(logger, 'info').mockImplementation(() => logger);
        const debug = vi
            .spyOn(logger, 'debug')
            .mockImplementation(() => logger);

        const result = await service.resolveReplyPing({
            platform: 'discord',
            replierId: 'duser',
            repliedMessageId: 'dmsg',
            repliedAuthorId: 'webhook',
            replyPings: false,
        });

        expect(result).toBeNull();
        expect(lookup).not.toHaveBeenCalled();
        expect(info).not.toHaveBeenCalled();
        expect(debug).not.toHaveBeenCalled();
    });

    it('returns null and logs when the replied-to message was never bridged', async () => {
        const debug = vi
            .spyOn(logger, 'debug')
            .mockImplementation(() => logger);

        const result = await service.resolveReplyPing({
            platform: 'discord',
            replierId: 'duser',
            repliedMessageId: 'unbridged',
            repliedAuthorId: 'someone',
            replyPings: true,
        });

        expect(result).toBeNull();
        expect(debug).toHaveBeenCalledTimes(1);
        expect(String(debug.mock.calls[0][0])).toContain('never bridged');
    });

    it('returns null and logs when the link predates author tracking', async () => {
        links.messageLinks.push(makeMessageLink());
        const debug = vi
            .spyOn(logger, 'debug')
            .mockImplementation(() => logger);

        const result = await service.resolveReplyPing({
            platform: 'fluxer',
            replierId: 'fuser',
            repliedMessageId: 'fmsg',
            repliedAuthorId: 'webhook',
            replyPings: true,
        });

        expect(result).toBeNull();
        expect(debug).toHaveBeenCalledTimes(1);
        expect(String(debug.mock.calls[0][0])).toContain(
            'predates author tracking'
        );
    });

    it('returns null and logs when the original author is on the same platform as the replier and has no account mapped', async () => {
        links.messageLinks.push(
            makeMessageLink({
                sourcePlatform: 'discord',
                sourceAuthorId: 'duser-original',
            })
        );
        const debug = vi
            .spyOn(logger, 'debug')
            .mockImplementation(() => logger);
        const info = vi.spyOn(logger, 'info').mockImplementation(() => logger);

        const result = await service.resolveReplyPing({
            platform: 'discord',
            replierId: 'duser',
            repliedMessageId: 'dmsg',
            repliedAuthorId: 'duser-original',
            replyPings: true,
        });

        expect(result).toBeNull();
        expect(info).not.toHaveBeenCalled();
        expect(debug).toHaveBeenCalledTimes(1);
        expect(String(debug.mock.calls[0][0])).toContain(
            'originally written on discord'
        );
    });

    it('ignores a user link that belongs to another guild link when the original author is on the same platform', async () => {
        links.messageLinks.push(
            makeMessageLink({
                sourcePlatform: 'discord',
                sourceAuthorId: 'duser-original',
            })
        );
        links.userLinks.push(
            makeUserLink({
                guildLinkId: 'guild-link-other',
                discordUserId: 'duser-original',
                fluxerUserId: 'fuser-mapped',
            })
        );
        const debug = vi
            .spyOn(logger, 'debug')
            .mockImplementation(() => logger);

        const result = await service.resolveReplyPing({
            platform: 'discord',
            replierId: 'duser',
            repliedMessageId: 'dmsg',
            repliedAuthorId: 'duser-original',
            replyPings: true,
        });

        expect(result).toBeNull();
        expect(debug).toHaveBeenCalledTimes(1);
        expect(String(debug.mock.calls[0][0])).toContain(
            'originally written on discord'
        );
    });

    it('pings the mapped Fluxer account when a Discord reply targets a message originally written on Discord', async () => {
        links.messageLinks.push(
            makeMessageLink({
                sourcePlatform: 'discord',
                sourceAuthorId: 'duser-original',
            })
        );
        links.userLinks.push(
            makeUserLink({
                discordUserId: 'duser-original',
                fluxerUserId: 'fuser-mapped',
            })
        );
        const lookup = vi.spyOn(links, 'getUserLinkForDiscordUser');
        const info = vi.spyOn(logger, 'info').mockImplementation(() => logger);
        const debug = vi
            .spyOn(logger, 'debug')
            .mockImplementation(() => logger);

        const result = await service.resolveReplyPing({
            platform: 'discord',
            replierId: 'duser',
            repliedMessageId: 'dmsg',
            repliedAuthorId: 'duser-original',
            replyPings: true,
        });

        expect(result).toBe('fuser-mapped');
        expect(lookup).toHaveBeenCalledWith('guild-link-1', 'duser-original');
        expect(debug).not.toHaveBeenCalled();
        expect(info).toHaveBeenCalledTimes(1);
        expect(String(info.mock.calls[0][0])).toContain(
            'Reply ping bridged via identity mapping'
        );
        expect(String(info.mock.calls[0][0])).toContain(
            'fluxer user fuser-mapped'
        );
    });

    it('pings the mapped Discord account when a Fluxer reply targets a message originally written on Fluxer', async () => {
        links.messageLinks.push(
            makeMessageLink({
                sourcePlatform: 'fluxer',
                sourceAuthorId: 'fuser-original',
            })
        );
        links.userLinks.push(
            makeUserLink({
                discordUserId: 'duser-mapped',
                fluxerUserId: 'fuser-original',
            })
        );
        const lookup = vi.spyOn(links, 'getUserLinkForFluxerUser');
        const discordLookup = vi.spyOn(links, 'getUserLinkForDiscordUser');
        const info = vi.spyOn(logger, 'info').mockImplementation(() => logger);

        const result = await service.resolveReplyPing({
            platform: 'fluxer',
            replierId: 'fuser',
            repliedMessageId: 'fmsg',
            repliedAuthorId: 'fuser-original',
            replyPings: true,
        });

        expect(result).toBe('duser-mapped');
        expect(lookup).toHaveBeenCalledWith('guild-link-1', 'fuser-original');
        expect(discordLookup).not.toHaveBeenCalled();
        expect(info).toHaveBeenCalledTimes(1);
        expect(String(info.mock.calls[0][0])).toContain(
            'Reply ping bridged via identity mapping'
        );
        expect(String(info.mock.calls[0][0])).toContain(
            'discord user duser-mapped'
        );
    });

    it('does not consult the identity mapping when the same-platform original was posted by a webhook', async () => {
        links.messageLinks.push(
            makeMessageLink({ sourcePlatform: 'discord', sourceAuthorId: null })
        );
        const lookup = vi.spyOn(links, 'getUserLinkForDiscordUser');
        const debug = vi
            .spyOn(logger, 'debug')
            .mockImplementation(() => logger);

        const result = await service.resolveReplyPing({
            platform: 'discord',
            replierId: 'duser',
            repliedMessageId: 'dmsg',
            repliedAuthorId: 'dwebhook',
            replyPings: true,
        });

        expect(result).toBeNull();
        expect(lookup).not.toHaveBeenCalled();
        expect(debug).toHaveBeenCalledTimes(1);
        expect(String(debug.mock.calls[0][0])).toContain('posted by a webhook');
    });

    it('does not consult the identity mapping when the original is on the other platform', async () => {
        links.messageLinks.push(
            makeMessageLink({
                sourcePlatform: 'fluxer',
                sourceAuthorId: 'fuser-original',
            })
        );
        const fluxerLookup = vi.spyOn(links, 'getUserLinkForFluxerUser');
        const discordLookup = vi.spyOn(links, 'getUserLinkForDiscordUser');

        const result = await service.resolveReplyPing({
            platform: 'discord',
            replierId: 'duser',
            repliedMessageId: 'dmsg',
            repliedAuthorId: 'dwebhook',
            replyPings: true,
        });

        expect(result).toBe('fuser-original');
        expect(fluxerLookup).not.toHaveBeenCalled();
        expect(discordLookup).not.toHaveBeenCalled();
    });

    it('swallows user link lookup errors, warns, and returns null', async () => {
        links.messageLinks.push(
            makeMessageLink({
                sourcePlatform: 'discord',
                sourceAuthorId: 'duser-original',
            })
        );
        vi.spyOn(links, 'getUserLinkForDiscordUser').mockRejectedValue(
            new Error('db down')
        );
        const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);

        const result = await service.resolveReplyPing({
            platform: 'discord',
            replierId: 'duser',
            repliedMessageId: 'dmsg',
            repliedAuthorId: 'duser-original',
            replyPings: true,
        });

        expect(result).toBeNull();
        expect(warn).toHaveBeenCalledTimes(1);
    });

    it('returns null and logs (debug) when the original on the other platform was posted by a webhook', async () => {
        links.messageLinks.push(
            makeMessageLink({ sourcePlatform: 'fluxer', sourceAuthorId: null })
        );
        const debug = vi
            .spyOn(logger, 'debug')
            .mockImplementation(() => logger);
        const info = vi.spyOn(logger, 'info').mockImplementation(() => logger);

        const result = await service.resolveReplyPing({
            platform: 'discord',
            replierId: 'duser',
            repliedMessageId: 'dmsg',
            repliedAuthorId: 'dwebhook',
            replyPings: true,
        });

        expect(result).toBeNull();
        expect(info).not.toHaveBeenCalled();
        expect(debug).toHaveBeenCalledTimes(1);
        expect(String(debug.mock.calls[0][0])).toContain('posted by a webhook');
    });

    it('logs the bridged ping at info level', async () => {
        links.messageLinks.push(
            makeMessageLink({
                sourcePlatform: 'fluxer',
                sourceAuthorId: 'fuser-original',
            })
        );
        const info = vi.spyOn(logger, 'info').mockImplementation(() => logger);

        await service.resolveReplyPing({
            platform: 'discord',
            replierId: 'duser',
            repliedMessageId: 'dmsg',
            repliedAuthorId: 'dwebhook',
            replyPings: true,
        });

        expect(info).toHaveBeenCalledTimes(1);
        expect(String(info.mock.calls[0][0])).toContain('Reply ping bridged');
    });

    it('returns the original author id when the source is on the other platform (discord reply)', async () => {
        links.messageLinks.push(
            makeMessageLink({
                sourcePlatform: 'fluxer',
                sourceAuthorId: 'fuser-original',
            })
        );

        const result = await service.resolveReplyPing({
            platform: 'discord',
            replierId: 'duser',
            repliedMessageId: 'dmsg',
            repliedAuthorId: 'dwebhook',
            replyPings: true,
        });

        expect(result).toBe('fuser-original');
    });

    it('returns the original author id when the source is on the other platform (fluxer reply)', async () => {
        links.messageLinks.push(
            makeMessageLink({
                sourcePlatform: 'discord',
                sourceAuthorId: 'duser-original',
            })
        );
        const discordLookup = vi.spyOn(
            links,
            'getMessageLinkByDiscordMessageId'
        );

        const result = await service.resolveReplyPing({
            platform: 'fluxer',
            replierId: 'fuser',
            repliedMessageId: 'fmsg',
            repliedAuthorId: 'fwebhook',
            replyPings: true,
        });

        expect(result).toBe('duser-original');
        expect(discordLookup).not.toHaveBeenCalled();
    });

    it('swallows lookup errors, warns, and returns null', async () => {
        vi.spyOn(links, 'getMessageLinkByFluxerMessageId').mockRejectedValue(
            new Error('db down')
        );
        const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);

        const result = await service.resolveReplyPing({
            platform: 'fluxer',
            replierId: 'fuser',
            repliedMessageId: 'fmsg',
            repliedAuthorId: 'fwebhook',
            replyPings: true,
        });

        expect(result).toBeNull();
        expect(warn).toHaveBeenCalledTimes(1);
    });
});

describe('MentionBridgeService.resolveUserMentions', () => {
    let links: FakeLinkService;
    let service: MentionBridgeService;

    beforeEach(() => {
        vi.restoreAllMocks();
        links = new FakeLinkService();
        service = new MentionBridgeService(links.asLinkService());
    });

    it('returns nothing and looks nothing up for an empty mention list', async () => {
        const guildLookup = vi.spyOn(links, 'getGuildLinkForDiscordGuild');
        const log = vi.spyOn(service, 'logUnresolvedUserMentions');

        const result = await service.resolveUserMentions({
            platform: 'discord',
            guildId: 'dguild',
            mentions: [],
        });

        expect(result).toEqual([]);
        expect(guildLookup).not.toHaveBeenCalled();
        expect(log).not.toHaveBeenCalled();
    });

    it('resolves a mapped Discord mention to its Fluxer counterpart and logs it', async () => {
        links.userLinks.push(
            makeUserLink({ discordUserId: '42', fluxerUserId: 'fluxer-42' })
        );
        const info = vi.spyOn(logger, 'info').mockImplementation(() => logger);
        const lookup = vi.spyOn(links, 'getUserLinkForDiscordUser');

        const result = await service.resolveUserMentions({
            platform: 'discord',
            guildId: 'dguild',
            mentions: [{ id: '42', username: 'alice' }],
        });

        expect(result).toEqual([{ id: '42', counterpartId: 'fluxer-42' }]);
        expect(lookup).toHaveBeenCalledWith('guild-link-1', '42');
        expect(info).toHaveBeenCalledTimes(1);
        expect(String(info.mock.calls[0][0])).toContain('User mention bridged');
        expect(String(info.mock.calls[0][0])).toContain('discord user 42');
        expect(String(info.mock.calls[0][0])).toContain('@alice');
        expect(String(info.mock.calls[0][0])).toContain(
            'fluxer user fluxer-42'
        );
    });

    it('resolves a mapped Fluxer mention to its Discord counterpart', async () => {
        links.userLinks.push(
            makeUserLink({ discordUserId: 'discord-42', fluxerUserId: '42' })
        );
        const info = vi.spyOn(logger, 'info').mockImplementation(() => logger);
        const guildLookup = vi.spyOn(links, 'getGuildLinkForFluxerGuild');
        const discordGuildLookup = vi.spyOn(
            links,
            'getGuildLinkForDiscordGuild'
        );
        const lookup = vi.spyOn(links, 'getUserLinkForFluxerUser');

        const result = await service.resolveUserMentions({
            platform: 'fluxer',
            guildId: 'fguild',
            mentions: [{ id: '42', username: null }],
        });

        expect(result).toEqual([{ id: '42', counterpartId: 'discord-42' }]);
        expect(guildLookup).toHaveBeenCalledWith('fguild');
        expect(discordGuildLookup).not.toHaveBeenCalled();
        expect(lookup).toHaveBeenCalledWith('guild-link-1', '42');
        expect(String(info.mock.calls[0][0])).toContain('@unknown-user');
        expect(String(info.mock.calls[0][0])).toContain(
            'discord user discord-42'
        );
    });

    it('leaves unmapped mentions out of the result and logs them as unresolved', async () => {
        links.userLinks.push(
            makeUserLink({ discordUserId: '42', fluxerUserId: 'fluxer-42' })
        );
        const info = vi.spyOn(logger, 'info').mockImplementation(() => logger);
        const log = vi.spyOn(service, 'logUnresolvedUserMentions');

        const result = await service.resolveUserMentions({
            platform: 'discord',
            guildId: 'dguild',
            mentions: [
                { id: '42', username: 'alice' },
                { id: '99', username: null },
            ],
        });

        expect(result).toEqual([{ id: '42', counterpartId: 'fluxer-42' }]);
        expect(log).toHaveBeenCalledTimes(1);
        expect(log).toHaveBeenCalledWith('discord', [
            { id: '99', username: null },
        ]);
        const messages = info.mock.calls.map((c) => String(c[0]));
        expect(messages).toHaveLength(2);
        expect(messages[0]).toContain('User mention bridged');
        expect(messages[1]).toContain('relayed as plaintext');
        expect(messages[1]).toContain('discord user 99');
    });

    it('resolves nothing and logs every mention when the guild id is null', async () => {
        links.userLinks.push(
            makeUserLink({ discordUserId: '42', fluxerUserId: 'fluxer-42' })
        );
        const guildLookup = vi.spyOn(links, 'getGuildLinkForDiscordGuild');
        const userLookup = vi.spyOn(links, 'getUserLinkForDiscordUser');
        const log = vi.spyOn(service, 'logUnresolvedUserMentions');

        const result = await service.resolveUserMentions({
            platform: 'discord',
            guildId: null,
            mentions: [{ id: '42', username: 'alice' }],
        });

        expect(result).toEqual([]);
        expect(guildLookup).not.toHaveBeenCalled();
        expect(userLookup).not.toHaveBeenCalled();
        expect(log).toHaveBeenCalledWith('discord', [
            { id: '42', username: 'alice' },
        ]);
    });

    it('resolves nothing and logs every mention when the guild is not linked', async () => {
        links.userLinks.push(
            makeUserLink({ discordUserId: '42', fluxerUserId: 'fluxer-42' })
        );
        const userLookup = vi.spyOn(links, 'getUserLinkForDiscordUser');
        const log = vi.spyOn(service, 'logUnresolvedUserMentions');

        const result = await service.resolveUserMentions({
            platform: 'discord',
            guildId: 'dguild-unlinked',
            mentions: [{ id: '42', username: 'alice' }],
        });

        expect(result).toEqual([]);
        expect(userLookup).not.toHaveBeenCalled();
        expect(log).toHaveBeenCalledWith('discord', [
            { id: '42', username: 'alice' },
        ]);
    });

    it('ignores a user link recorded under another guild link', async () => {
        links.userLinks.push(
            makeUserLink({
                guildLinkId: 'guild-link-other',
                discordUserId: '42',
                fluxerUserId: 'fluxer-42',
            })
        );
        const log = vi.spyOn(service, 'logUnresolvedUserMentions');

        const result = await service.resolveUserMentions({
            platform: 'discord',
            guildId: 'dguild',
            mentions: [{ id: '42', username: 'alice' }],
        });

        expect(result).toEqual([]);
        expect(log).toHaveBeenCalledWith('discord', [
            { id: '42', username: 'alice' },
        ]);
    });

    it('still resolves on edits but suppresses all logging', async () => {
        links.userLinks.push(
            makeUserLink({ discordUserId: '42', fluxerUserId: 'fluxer-42' })
        );
        const info = vi.spyOn(logger, 'info').mockImplementation(() => logger);
        const log = vi.spyOn(service, 'logUnresolvedUserMentions');

        const result = await service.resolveUserMentions({
            platform: 'discord',
            guildId: 'dguild',
            mentions: [
                { id: '42', username: 'alice' },
                { id: '99', username: null },
            ],
            isEdit: true,
        });

        expect(result).toEqual([{ id: '42', counterpartId: 'fluxer-42' }]);
        expect(info).not.toHaveBeenCalled();
        expect(log).not.toHaveBeenCalled();
    });

    it('dedupes repeated ids before looking them up', async () => {
        links.userLinks.push(
            makeUserLink({ discordUserId: '42', fluxerUserId: 'fluxer-42' })
        );
        const info = vi.spyOn(logger, 'info').mockImplementation(() => logger);
        const userLookup = vi.spyOn(links, 'getUserLinkForDiscordUser');
        const log = vi.spyOn(service, 'logUnresolvedUserMentions');

        const result = await service.resolveUserMentions({
            platform: 'discord',
            guildId: 'dguild',
            mentions: [
                { id: '42', username: 'alice' },
                { id: '99', username: null },
                { id: '42', username: 'alice' },
                { id: '99', username: null },
            ],
        });

        expect(result).toEqual([{ id: '42', counterpartId: 'fluxer-42' }]);
        expect(userLookup).toHaveBeenCalledTimes(2);
        expect(log).toHaveBeenCalledTimes(1);
        expect(log).toHaveBeenCalledWith('discord', [
            { id: '99', username: null },
        ]);
        // One "bridged" line for 42 and one "plaintext" line for 99.
        expect(info).toHaveBeenCalledTimes(2);
    });

    it('warns and returns what was resolved so far when a lookup fails', async () => {
        links.userLinks.push(
            makeUserLink({ discordUserId: '42', fluxerUserId: 'fluxer-42' })
        );
        const original = links.getUserLinkForDiscordUser.bind(links);
        vi.spyOn(links, 'getUserLinkForDiscordUser').mockImplementation(
            async (guildLinkId: string, discordUserId: string) => {
                if (discordUserId === '99') throw new Error('db down');
                return original(guildLinkId, discordUserId);
            }
        );
        vi.spyOn(logger, 'info').mockImplementation(() => logger);
        const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
        const log = vi.spyOn(service, 'logUnresolvedUserMentions');

        const result = await service.resolveUserMentions({
            platform: 'discord',
            guildId: 'dguild',
            mentions: [
                { id: '42', username: 'alice' },
                { id: '99', username: null },
                { id: '7', username: 'carol' },
            ],
        });

        expect(result).toEqual([{ id: '42', counterpartId: 'fluxer-42' }]);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0][0])).toContain(
            'User mention lookup failed'
        );
        expect(log).not.toHaveBeenCalled();
    });

    it('warns and returns nothing when the guild link lookup fails', async () => {
        vi.spyOn(links, 'getGuildLinkForFluxerGuild').mockRejectedValue(
            new Error('db down')
        );
        const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);

        const result = await service.resolveUserMentions({
            platform: 'fluxer',
            guildId: 'fguild',
            mentions: [{ id: '42', username: 'alice' }],
        });

        expect(result).toEqual([]);
        expect(warn).toHaveBeenCalledTimes(1);
    });
});

describe('MentionBridgeService mention placeholders', () => {
    const resolver = {
        resolveUser: () => 'someone',
        resolveRole: () => null,
        resolveChannel: () => null,
    };

    it('produces a token that is not itself a mention and restores to <@id>', () => {
        const placeholder = MentionBridgeService.mentionPlaceholder('42');

        expect(placeholder).toContain('42');
        expect(placeholder).not.toContain('<@');
        expect(placeholder).not.toContain('@');
        expect(
            MentionBridgeService.restoreMentionPlaceholders(placeholder)
        ).toBe('<@42>');
    });

    it('survives mention sanitising and @-breaking', () => {
        const content = `hi ${MentionBridgeService.mentionPlaceholder('42')} and <@7>`;

        const sanitized = breakMentions(sanitizeMentions(content, resolver));

        expect(MentionBridgeService.restoreMentionPlaceholders(sanitized)).toBe(
            'hi <@42> and @​someone'
        );
    });

    it('restores every placeholder and leaves other content untouched', () => {
        const content = [
            MentionBridgeService.mentionPlaceholder('1'),
            'x',
            MentionBridgeService.mentionPlaceholder('2'),
            MentionBridgeService.mentionPlaceholder('1'),
        ].join(' ');

        expect(MentionBridgeService.restoreMentionPlaceholders(content)).toBe(
            '<@1> x <@2> <@1>'
        );
        expect(
            MentionBridgeService.restoreMentionPlaceholders('plain <@3> text')
        ).toBe('plain <@3> text');
    });

    it('is not re-prepended by applyMentions once restored', () => {
        const restored = MentionBridgeService.restoreMentionPlaceholders(
            `hi ${MentionBridgeService.mentionPlaceholder('1')}`
        );

        expect(MentionBridgeService.applyMentions(restored, ['1', '2'])).toBe(
            '<@2> hi <@1>'
        );
    });
});

describe('MentionBridgeService.logUnresolvedUserMentions', () => {
    it('logs once per distinct mentioned user', () => {
        const service = new MentionBridgeService(
            new FakeLinkService().asLinkService()
        );
        const info = vi.spyOn(logger, 'info').mockImplementation(() => logger);

        service.logUnresolvedUserMentions('discord', [
            { id: '1', username: 'alice' },
            { id: '1', username: 'alice' },
            { id: '2', username: null },
        ]);

        expect(info).toHaveBeenCalledTimes(2);
        expect(String(info.mock.calls[0][0])).toContain('discord user 1');
        expect(String(info.mock.calls[0][0])).toContain('@alice');
        expect(String(info.mock.calls[1][0])).toContain('@unknown-user');
        info.mockRestore();
    });
});

describe('MentionBridgeService.applyMentions', () => {
    it('returns content unchanged for an empty list', () => {
        expect(MentionBridgeService.applyMentions('hello', [])).toBe('hello');
    });

    it('prepends a mention for each id', () => {
        expect(MentionBridgeService.applyMentions('hello', ['1', '2'])).toBe(
            '<@1> <@2> hello'
        );
    });

    it('deduplicates ids', () => {
        expect(MentionBridgeService.applyMentions('hello', ['1', '1'])).toBe(
            '<@1> hello'
        );
    });

    it('does not add a mention already present in the content', () => {
        expect(MentionBridgeService.applyMentions('hi <@1> there', ['1'])).toBe(
            'hi <@1> there'
        );
    });

    it('prepends to empty content', () => {
        expect(MentionBridgeService.applyMentions('', ['1'])).toBe('<@1> ');
    });
});

describe('MentionBridgeService.extractUserMentionIds', () => {
    it('collects distinct <@id> and <@!id> mentions but not roles or channels', () => {
        expect(
            MentionBridgeService.extractUserMentionIds(
                '<@1> <@!2> <@1> <@&3> <#4>'
            )
        ).toEqual(['1', '2']);
    });
});
