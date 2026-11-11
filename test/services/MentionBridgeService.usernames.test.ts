import { beforeEach, describe, expect, it, vi } from 'vitest';
import MentionBridgeService from '../../src/services/mentionBridge/MentionBridgeService';
import { GeneralMember } from '../../src/services/mentionBridge/memberLookup';
import {
    FakeLinkService,
    FakeMemberLookup,
    makeUserLink,
} from '../helpers/fakes';
import logger from '../../src/utils/logging/logger';

function member(id: string, username: string, bot = false): GeneralMember {
    return { id, username, bot };
}

describe('MentionBridgeService.resolveUsernameMentions', () => {
    let links: FakeLinkService;
    let lookup: FakeMemberLookup;
    let service: MentionBridgeService;
    let info: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.restoreAllMocks();
        links = new FakeLinkService();
        lookup = new FakeMemberLookup();
        service = new MentionBridgeService(links.asLinkService(), {
            memberLookup: lookup,
        });
        info = vi.spyOn(logger, 'info').mockImplementation(() => logger);
    });

    it('maps a typed Discord name to the Fluxer member of that username and logs it', async () => {
        lookup.fluxerMembers.push(member('f-alice', 'alice'));
        const find = vi.spyOn(lookup, 'findFluxerMembersByUsername');

        const result = await service.resolveUsernameMentions({
            platform: 'discord',
            guildId: 'dguild',
            usernames: ['alice'],
        });

        expect(result).toEqual(new Map([['alice', 'f-alice']]));
        expect(find).toHaveBeenCalledWith('fguild', 'alice');
        expect(String(info.mock.calls[0][0])).toContain('🔔');
        expect(String(info.mock.calls[0][0])).toContain('fluxer user f-alice');
    });

    it('maps a typed Fluxer name to the Discord member of that username', async () => {
        lookup.discordMembers.push(member('d-bob', 'bob'));
        const find = vi.spyOn(lookup, 'findDiscordMembersByUsername');

        const result = await service.resolveUsernameMentions({
            platform: 'fluxer',
            guildId: 'fguild',
            usernames: ['bob'],
        });

        expect(result).toEqual(new Map([['bob', 'd-bob']]));
        expect(find).toHaveBeenCalledWith('dguild', 'bob');
    });

    it('accepts a single case-insensitive match', async () => {
        lookup.fluxerMembers.push(member('f-alice', 'Alice'));

        const result = await service.resolveUsernameMentions({
            platform: 'discord',
            guildId: 'dguild',
            usernames: ['alice'],
        });

        expect(result.get('alice')).toBe('f-alice');
    });

    it('prefers the exact-case match over case-insensitive ones', async () => {
        lookup.fluxerMembers.push(
            member('f-upper', 'Alice'),
            member('f-lower', 'alice')
        );

        const result = await service.resolveUsernameMentions({
            platform: 'discord',
            guildId: 'dguild',
            usernames: ['alice', 'Alice'],
        });

        expect(result.get('alice')).toBe('f-lower');
        expect(result.get('Alice')).toBe('f-upper');
    });

    it('looks a name up once whatever its spelling', async () => {
        lookup.fluxerMembers.push(member('f-alice', 'alice'));
        const find = vi.spyOn(lookup, 'findFluxerMembersByUsername');

        await service.resolveUsernameMentions({
            platform: 'discord',
            guildId: 'dguild',
            usernames: ['alice', 'ALICE', 'alice'],
        });

        expect(find).toHaveBeenCalledTimes(1);
    });

    it('pings nobody when several members match only case-insensitively', async () => {
        lookup.fluxerMembers.push(
            member('f-1', 'Alice'),
            member('f-2', 'ALICE')
        );

        const result = await service.resolveUsernameMentions({
            platform: 'discord',
            guildId: 'dguild',
            usernames: ['alice'],
        });

        expect(result.size).toBe(0);
        expect(String(info.mock.calls[0][0])).toContain('🔕');
        expect(String(info.mock.calls[0][0])).toContain('ambiguous');
    });

    it('ignores bots', async () => {
        lookup.fluxerMembers.push(member('f-bot', 'alice', true));

        const result = await service.resolveUsernameMentions({
            platform: 'discord',
            guildId: 'dguild',
            usernames: ['alice'],
        });

        expect(result.size).toBe(0);
    });

    it('ignores a bot namesake when a human matches', async () => {
        lookup.fluxerMembers.push(
            member('f-bot', 'alice', true),
            member('f-alice', 'alice')
        );

        const result = await service.resolveUsernameMentions({
            platform: 'discord',
            guildId: 'dguild',
            usernames: ['alice'],
        });

        expect(result.get('alice')).toBe('f-alice');
    });

    it('logs and leaves out names nobody answers to', async () => {
        const result = await service.resolveUsernameMentions({
            platform: 'discord',
            guildId: 'dguild',
            usernames: ['nobody'],
        });

        expect(result.size).toBe(0);
        expect(String(info.mock.calls[0][0])).toContain(
            'no fluxer member named @nobody'
        );
    });

    it('does not log on edits', async () => {
        lookup.fluxerMembers.push(member('f-alice', 'alice'));

        const result = await service.resolveUsernameMentions({
            platform: 'discord',
            guildId: 'dguild',
            usernames: ['alice', 'nobody'],
            isEdit: true,
        });

        expect(result.get('alice')).toBe('f-alice');
        expect(info).not.toHaveBeenCalled();
    });

    it('looks nothing up outside a linked guild', async () => {
        lookup.fluxerMembers.push(member('f-alice', 'alice'));
        const find = vi.spyOn(lookup, 'findFluxerMembersByUsername');

        for (const guildId of ['other-guild', null]) {
            const result = await service.resolveUsernameMentions({
                platform: 'discord',
                guildId,
                usernames: ['alice'],
            });
            expect(result.size).toBe(0);
        }
        expect(find).not.toHaveBeenCalled();
    });

    it('treats a throwing lookup as nobody found and keeps resolving', async () => {
        const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
        lookup.fluxerMembers.push(member('f-bob', 'bob'));
        const real = lookup.findFluxerMembersByUsername.bind(lookup);
        vi.spyOn(lookup, 'findFluxerMembersByUsername').mockImplementation(
            async (guildId, username) => {
                if (username === 'alice') throw new Error('boom');
                return real(guildId, username);
            }
        );

        const result = await service.resolveUsernameMentions({
            platform: 'discord',
            guildId: 'dguild',
            usernames: ['alice', 'bob'],
        });

        expect(result).toEqual(new Map([['bob', 'f-bob']]));
        expect(warn).toHaveBeenCalledTimes(1);
    });

    it('returns what it has when the guild lookup fails', async () => {
        const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
        vi.spyOn(links, 'getGuildLinkForDiscordGuild').mockRejectedValue(
            new Error('db down')
        );

        const result = await service.resolveUsernameMentions({
            platform: 'discord',
            guildId: 'dguild',
            usernames: ['alice'],
        });

        expect(result.size).toBe(0);
        expect(warn).toHaveBeenCalledTimes(1);
    });

    it('does nothing without a member lookup', async () => {
        const plain = new MentionBridgeService(links.asLinkService());
        const guildLookup = vi.spyOn(links, 'getGuildLinkForDiscordGuild');

        const result = await plain.resolveUsernameMentions({
            platform: 'discord',
            guildId: 'dguild',
            usernames: ['alice'],
        });

        expect(result.size).toBe(0);
        expect(guildLookup).not.toHaveBeenCalled();
    });
});

describe('MentionBridgeService.resolveUserMentions username fallback', () => {
    let links: FakeLinkService;
    let lookup: FakeMemberLookup;
    let service: MentionBridgeService;
    let info: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.restoreAllMocks();
        links = new FakeLinkService();
        lookup = new FakeMemberLookup();
        service = new MentionBridgeService(links.asLinkService(), {
            memberLookup: lookup,
        });
        info = vi.spyOn(logger, 'info').mockImplementation(() => logger);
    });

    it('pings the namesake of an unmapped user and does not log it as unresolved', async () => {
        lookup.fluxerMembers.push(member('f-alice', 'alice'));
        const unresolved = vi.spyOn(service, 'logUnresolvedUserMentions');

        const result = await service.resolveUserMentions({
            platform: 'discord',
            guildId: 'dguild',
            mentions: [{ id: '42', username: 'alice' }],
        });

        expect(result).toEqual([{ id: '42', counterpartId: 'f-alice' }]);
        expect(unresolved).toHaveBeenCalledWith('discord', []);
        expect(String(info.mock.calls[0][0])).toContain('by username');
    });

    it('still uses the identity mapping for a mapped user', async () => {
        links.userLinks.push(
            makeUserLink({ discordUserId: '42', fluxerUserId: 'f-mapped' })
        );
        lookup.fluxerMembers.push(member('f-alice', 'alice'));
        const find = vi.spyOn(lookup, 'findFluxerMembersByUsername');

        const result = await service.resolveUserMentions({
            platform: 'discord',
            guildId: 'dguild',
            mentions: [{ id: '42', username: 'alice' }],
        });

        expect(result).toEqual([{ id: '42', counterpartId: 'f-mapped' }]);
        expect(find).not.toHaveBeenCalled();
    });

    it('logs as unresolved when no namesake exists or the username is unknown', async () => {
        const unresolved = vi.spyOn(service, 'logUnresolvedUserMentions');

        const result = await service.resolveUserMentions({
            platform: 'fluxer',
            guildId: 'fguild',
            mentions: [
                { id: '42', username: 'alice' },
                { id: '99', username: null },
            ],
        });

        expect(result).toEqual([]);
        expect(unresolved).toHaveBeenCalledWith('fluxer', [
            { id: '42', username: 'alice' },
            { id: '99', username: null },
        ]);
    });

    it('does not ping when the namesake is ambiguous', async () => {
        lookup.discordMembers.push(
            member('d-1', 'Alice'),
            member('d-2', 'ALICE')
        );

        const result = await service.resolveUserMentions({
            platform: 'fluxer',
            guildId: 'fguild',
            mentions: [{ id: '42', username: 'alice' }],
        });

        expect(result).toEqual([]);
        expect(
            info.mock.calls.some((call) =>
                String(call[0]).includes('2 discord members')
            )
        ).toBe(true);
    });
});

describe('MentionBridgeService.extractUsernameMentions', () => {
    const extract = (content: string) =>
        MentionBridgeService.extractUsernameMentions(content);

    it('collects distinct typed names as written', () => {
        expect(extract('@alice hi @Bob_1 and @alice, @x.y')).toEqual([
            'alice',
            'Bob_1',
            'x.y',
        ]);
    });

    it('strips a trailing dot that ends the sentence', () => {
        expect(extract('thanks @alice.')).toEqual(['alice']);
        expect(extract('thanks @alice... ok')).toEqual(['alice']);
    });

    it('skips emails, URLs and real mentions', () => {
        expect(
            extract(
                'mail bob@alice.com, see https://x.com/@user or <@123> <@!4> <@&5> a:@b @@cc'
            )
        ).toEqual([]);
    });

    it('skips @everyone and @here', () => {
        expect(extract('@everyone @Here @alice')).toEqual(['alice']);
    });

    it('skips names inside inline code and code blocks', () => {
        expect(extract('`@code` ``@double`` ```\n@fenced\n``` @alice')).toEqual(
            ['alice']
        );
    });

    it('needs 2 to 32 name characters', () => {
        expect(extract('@a @ab')).toEqual(['ab']);
        expect(extract(`@${'a'.repeat(32)}`)).toEqual(['a'.repeat(32)]);
        expect(extract(`@${'a'.repeat(33)}`)).toEqual([]);
    });
});

describe('MentionBridgeService.replaceUsernameMentions', () => {
    it('replaces only resolved names with placeholders', () => {
        const replaced = MentionBridgeService.replaceUsernameMentions(
            'hi @alice. and @bob `@alice` me@alice.com',
            new Map([['alice', 'f-alice']])
        );

        expect(replaced).toBe(
            `hi ${MentionBridgeService.mentionPlaceholder('f-alice')}. and @bob \`@alice\` me@alice.com`
        );
        expect(MentionBridgeService.restoreMentionPlaceholders(replaced)).toBe(
            'hi <@f-alice>. and @bob `@alice` me@alice.com'
        );
    });

    it('matches the name as written', () => {
        expect(
            MentionBridgeService.replaceUsernameMentions(
                '@Alice',
                new Map([['alice', 'f-alice']])
            )
        ).toBe('@Alice');
    });
});
