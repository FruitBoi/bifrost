import { beforeEach, describe, expect, it, vi } from 'vitest';
import MentionBridgeService from '../../src/services/mentionBridge/MentionBridgeService';
import { MessageLink } from '../../src/db/entities/MessageLink';
import { FakeLinkService } from '../helpers/fakes';
import logger from '../../src/utils/logging/logger';

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

    it('returns null and logs when the original author is on the same platform as the replier', async () => {
        links.messageLinks.push(
            makeMessageLink({
                sourcePlatform: 'discord',
                sourceAuthorId: 'duser-original',
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
