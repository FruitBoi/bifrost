import { beforeEach, describe, expect, it, vi } from 'vitest';
import MentionBridgeService, {
    CounterpartRoleLookup,
    GeneralRole,
    RoleMentionsInput,
} from '../../src/services/mentionBridge/MentionBridgeService';
import { FakeLinkService } from '../helpers/fakes';
import logger from '../../src/utils/logging/logger';
import {
    breakMentions,
    sanitizeMentions,
} from '../../src/utils/sanitizeMentions';

const ZWSP = '​';

function fakeRoleLookup({
    discord = [],
    fluxer = [],
}: { discord?: GeneralRole[]; fluxer?: GeneralRole[] } = {}) {
    const fetchDiscordRoles = vi.fn(async (_guildId: string) => discord);
    const fetchFluxerRoles = vi.fn(async (_guildId: string) => fluxer);
    const lookup: CounterpartRoleLookup = {
        fetchDiscordRoles,
        fetchFluxerRoles,
    };
    return { lookup, fetchDiscordRoles, fetchFluxerRoles };
}

/** A Discord-written message in the linked guild mentioning one role. */
function discordInput(
    overrides: Partial<RoleMentionsInput> = {}
): RoleMentionsInput {
    return {
        platform: 'discord',
        guildId: 'dguild',
        mentions: [{ id: 'drole-mods', name: 'Mods', mentionable: true }],
        authorCanMentionAnyRole: false,
        ...overrides,
    };
}

describe('MentionBridgeService.resolveRoleMentions', () => {
    let links: FakeLinkService;
    let info: ReturnType<typeof vi.spyOn>;
    let warn: ReturnType<typeof vi.spyOn>;
    let debug: ReturnType<typeof vi.spyOn>;

    const infoLines = () => info.mock.calls.map((call) => String(call[0]));

    beforeEach(() => {
        vi.restoreAllMocks();
        links = new FakeLinkService();
        info = vi.spyOn(logger, 'info').mockImplementation(() => logger);
        warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
        debug = vi.spyOn(logger, 'debug').mockImplementation(() => logger);
    });

    it('resolves a mentionable role to the Fluxer role of the same name and logs the bridge', async () => {
        const { lookup, fetchFluxerRoles, fetchDiscordRoles } = fakeRoleLookup({
            fluxer: [
                { id: 'frole-admins', name: 'Admins' },
                { id: 'frole-mods', name: 'Mods' },
            ],
        });
        const service = new MentionBridgeService(links.asLinkService(), {
            roleLookup: lookup,
        });

        const result = await service.resolveRoleMentions(discordInput());

        expect(result).toEqual([
            { id: 'drole-mods', counterpartId: 'frole-mods', name: 'Mods' },
        ]);
        expect(fetchFluxerRoles).toHaveBeenCalledTimes(1);
        expect(fetchFluxerRoles).toHaveBeenCalledWith('fguild');
        expect(fetchDiscordRoles).not.toHaveBeenCalled();
        expect(infoLines()).toEqual([
            expect.stringContaining(
                '🔔 Role mention bridged: discord role drole-mods (@Mods) pings fluxer role frole-mods'
            ),
        ]);
        expect(warn).not.toHaveBeenCalled();
    });

    it('matches role names exactly and case-sensitively', async () => {
        const { lookup } = fakeRoleLookup({
            fluxer: [
                { id: 'frole-lower', name: 'mods' },
                { id: 'frole-padded', name: 'Mods ' },
                { id: 'frole-exact', name: 'Mods' },
            ],
        });
        const service = new MentionBridgeService(links.asLinkService(), {
            roleLookup: lookup,
        });

        const result = await service.resolveRoleMentions(discordInput());

        expect(result.map((r) => r.counterpartId)).toEqual(['frole-exact']);
    });

    it('relays an unmatched role as plaintext and logs that no counterpart exists', async () => {
        const { lookup } = fakeRoleLookup({
            fluxer: [{ id: 'frole-admins', name: 'Admins' }],
        });
        const service = new MentionBridgeService(links.asLinkService(), {
            roleLookup: lookup,
        });

        const result = await service.resolveRoleMentions(discordInput());

        expect(result).toEqual([]);
        expect(infoLines()).toEqual([
            '🔕 Role mention relayed as plaintext: no fluxer role named @Mods',
        ]);
    });

    it('relays a role with an unknown name as plaintext without looking the counterpart up', async () => {
        const { lookup, fetchFluxerRoles } = fakeRoleLookup({
            fluxer: [{ id: 'frole-mods', name: 'Mods' }],
        });
        const service = new MentionBridgeService(links.asLinkService(), {
            roleLookup: lookup,
        });

        const result = await service.resolveRoleMentions(
            discordInput({
                mentions: [{ id: 'drole-gone', name: null, mentionable: true }],
            })
        );

        expect(result).toEqual([]);
        expect(fetchFluxerRoles).not.toHaveBeenCalled();
        expect(infoLines()).toEqual([
            expect.stringContaining(
                'discord role drole-gone is unknown, so it cannot be matched by name'
            ),
        ]);
    });

    it('does not bridge a non-mentionable role when the author may not ping it, and skips the lookup', async () => {
        const { lookup, fetchFluxerRoles } = fakeRoleLookup({
            fluxer: [{ id: 'frole-mods', name: 'Mods' }],
        });
        const service = new MentionBridgeService(links.asLinkService(), {
            roleLookup: lookup,
        });

        const result = await service.resolveRoleMentions(
            discordInput({
                mentions: [
                    { id: 'drole-mods', name: 'Mods', mentionable: false },
                ],
                authorCanMentionAnyRole: false,
            })
        );

        expect(result).toEqual([]);
        expect(fetchFluxerRoles).not.toHaveBeenCalled();
        expect(infoLines()).toEqual([
            '🔕 Role mention not bridged: discord role drole-mods (@Mods) is not mentionable and the author may not ping it',
        ]);
    });

    it('bridges a non-mentionable role when the author holds Mention Everyone', async () => {
        const { lookup, fetchFluxerRoles } = fakeRoleLookup({
            fluxer: [{ id: 'frole-mods', name: 'Mods' }],
        });
        const service = new MentionBridgeService(links.asLinkService(), {
            roleLookup: lookup,
        });

        const result = await service.resolveRoleMentions(
            discordInput({
                mentions: [
                    { id: 'drole-mods', name: 'Mods', mentionable: false },
                ],
                authorCanMentionAnyRole: true,
            })
        );

        expect(result).toEqual([
            { id: 'drole-mods', counterpartId: 'frole-mods', name: 'Mods' },
        ]);
        expect(fetchFluxerRoles).toHaveBeenCalledTimes(1);
    });

    it('ignores the @everyone role (id equal to the guild id) without any lookup or log', async () => {
        const { lookup, fetchFluxerRoles } = fakeRoleLookup({
            fluxer: [{ id: 'fguild', name: '@everyone' }],
        });
        const service = new MentionBridgeService(links.asLinkService(), {
            roleLookup: lookup,
        });
        const getGuildLink = vi.spyOn(links, 'getGuildLinkForDiscordGuild');

        const result = await service.resolveRoleMentions(
            discordInput({
                mentions: [
                    { id: 'dguild', name: '@everyone', mentionable: true },
                ],
                authorCanMentionAnyRole: true,
            })
        );

        expect(result).toEqual([]);
        expect(getGuildLink).not.toHaveBeenCalled();
        expect(fetchFluxerRoles).not.toHaveBeenCalled();
        expect(info).not.toHaveBeenCalled();
    });

    it('never matches a counterpart role named @everyone or carrying the counterpart guild id', async () => {
        const { lookup } = fakeRoleLookup({
            fluxer: [
                { id: 'fguild', name: 'Mods' },
                { id: 'frole-everyone', name: '@everyone' },
            ],
        });
        const service = new MentionBridgeService(links.asLinkService(), {
            roleLookup: lookup,
        });

        const result = await service.resolveRoleMentions(
            discordInput({
                mentions: [
                    { id: 'drole-mods', name: 'Mods', mentionable: true },
                    {
                        id: 'drole-fake-everyone',
                        name: '@everyone',
                        mentionable: true,
                    },
                ],
            })
        );

        expect(result).toEqual([]);
        expect(infoLines()).toEqual([
            '🔕 Role mention relayed as plaintext: no fluxer role named @Mods',
            '🔕 Role mention relayed as plaintext: no fluxer role named @@everyone',
        ]);
    });

    it('relays everything as plaintext without a lookup when roles.bridgeMentions is off', async () => {
        const { lookup, fetchFluxerRoles, fetchDiscordRoles } = fakeRoleLookup({
            fluxer: [{ id: 'frole-mods', name: 'Mods' }],
        });
        const service = new MentionBridgeService(links.asLinkService(), {
            roleLookup: lookup,
            bridgeRoleMentions: false,
        });
        const getGuildLink = vi.spyOn(links, 'getGuildLinkForDiscordGuild');

        const result = await service.resolveRoleMentions(discordInput());

        expect(result).toEqual([]);
        expect(fetchFluxerRoles).not.toHaveBeenCalled();
        expect(fetchDiscordRoles).not.toHaveBeenCalled();
        expect(getGuildLink).not.toHaveBeenCalled();
        expect(info).not.toHaveBeenCalled();
        expect(debug).toHaveBeenCalledTimes(1);
        expect(String(debug.mock.calls[0][0])).toContain(
            'disabled (roles.bridgeMentions)'
        );
    });

    it('relays everything as plaintext when no role lookup is wired up', async () => {
        const service = new MentionBridgeService(links.asLinkService());
        const getGuildLink = vi.spyOn(links, 'getGuildLinkForDiscordGuild');

        const result = await service.resolveRoleMentions(discordInput());

        expect(result).toEqual([]);
        expect(getGuildLink).not.toHaveBeenCalled();
        expect(info).not.toHaveBeenCalled();
        expect(String(debug.mock.calls[0][0])).toContain('not wired up');
    });

    it('relays as plaintext when the message was written outside a linked guild', async () => {
        const { lookup, fetchFluxerRoles } = fakeRoleLookup({
            fluxer: [{ id: 'frole-mods', name: 'Mods' }],
        });
        const service = new MentionBridgeService(links.asLinkService(), {
            roleLookup: lookup,
        });

        const unlinked = await service.resolveRoleMentions(
            discordInput({ guildId: 'some-other-guild' })
        );
        const noGuild = await service.resolveRoleMentions(
            discordInput({ guildId: null })
        );

        expect(unlinked).toEqual([]);
        expect(noGuild).toEqual([]);
        expect(fetchFluxerRoles).not.toHaveBeenCalled();
        expect(infoLines()).toEqual([
            '🔕 Role mention relayed as plaintext: discord role drole-mods (@Mods) was mentioned outside a linked guild',
            '🔕 Role mention relayed as plaintext: discord role drole-mods (@Mods) was mentioned outside a linked guild',
        ]);
    });

    it('warns and relays as plaintext when the counterpart role lookup throws', async () => {
        const failure = new Error('fluxer down');
        const lookup: CounterpartRoleLookup = {
            fetchDiscordRoles: vi.fn(async () => []),
            fetchFluxerRoles: vi.fn(async () => {
                throw failure;
            }),
        };
        const service = new MentionBridgeService(links.asLinkService(), {
            roleLookup: lookup,
        });

        const result = await service.resolveRoleMentions(discordInput());

        expect(result).toEqual([]);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0][0])).toContain(
            'Role mention lookup failed for discord message'
        );
        expect(warn.mock.calls[0][1]).toBe(failure);
    });

    it('warns and relays as plaintext when the guild link lookup throws', async () => {
        const { lookup } = fakeRoleLookup({
            fluxer: [{ id: 'frole-mods', name: 'Mods' }],
        });
        const service = new MentionBridgeService(links.asLinkService(), {
            roleLookup: lookup,
        });
        vi.spyOn(links, 'getGuildLinkForDiscordGuild').mockRejectedValue(
            new Error('db down')
        );

        const result = await service.resolveRoleMentions(discordInput());

        expect(result).toEqual([]);
        expect(warn).toHaveBeenCalledTimes(1);
    });

    it('dedupes repeated mentions of the same role and lists the counterpart roles only once', async () => {
        const { lookup, fetchFluxerRoles } = fakeRoleLookup({
            fluxer: [
                { id: 'frole-mods', name: 'Mods' },
                { id: 'frole-admins', name: 'Admins' },
            ],
        });
        const service = new MentionBridgeService(links.asLinkService(), {
            roleLookup: lookup,
        });

        const result = await service.resolveRoleMentions(
            discordInput({
                mentions: [
                    { id: 'drole-mods', name: 'Mods', mentionable: true },
                    { id: 'drole-admins', name: 'Admins', mentionable: true },
                    { id: 'drole-mods', name: 'Mods', mentionable: true },
                ],
            })
        );

        expect(result).toEqual([
            { id: 'drole-mods', counterpartId: 'frole-mods', name: 'Mods' },
            {
                id: 'drole-admins',
                counterpartId: 'frole-admins',
                name: 'Admins',
            },
        ]);
        expect(fetchFluxerRoles).toHaveBeenCalledTimes(1);
        expect(info).toHaveBeenCalledTimes(2);
    });

    it('resolves a Fluxer-written mention against the Discord roles of the linked guild', async () => {
        const { lookup, fetchDiscordRoles, fetchFluxerRoles } = fakeRoleLookup({
            discord: [{ id: 'drole-mods', name: 'Mods' }],
        });
        const service = new MentionBridgeService(links.asLinkService(), {
            roleLookup: lookup,
        });

        const result = await service.resolveRoleMentions({
            platform: 'fluxer',
            guildId: 'fguild',
            mentions: [{ id: 'frole-mods', name: 'Mods', mentionable: true }],
            authorCanMentionAnyRole: false,
        });

        expect(result).toEqual([
            { id: 'frole-mods', counterpartId: 'drole-mods', name: 'Mods' },
        ]);
        expect(fetchDiscordRoles).toHaveBeenCalledTimes(1);
        expect(fetchDiscordRoles).toHaveBeenCalledWith('dguild');
        expect(fetchFluxerRoles).not.toHaveBeenCalled();
        expect(infoLines()).toEqual([
            '🔔 Role mention bridged: fluxer role frole-mods (@Mods) pings discord role drole-mods',
        ]);
    });

    it('ignores the Fluxer @everyone role by its guild id too', async () => {
        const { lookup, fetchDiscordRoles } = fakeRoleLookup({
            discord: [{ id: 'drole-everyone', name: '@everyone' }],
        });
        const service = new MentionBridgeService(links.asLinkService(), {
            roleLookup: lookup,
        });

        const result = await service.resolveRoleMentions({
            platform: 'fluxer',
            guildId: 'fguild',
            mentions: [{ id: 'fguild', name: '@everyone', mentionable: true }],
            authorCanMentionAnyRole: true,
        });

        expect(result).toEqual([]);
        expect(fetchDiscordRoles).not.toHaveBeenCalled();
    });

    it('still resolves on edits but logs nothing per message', async () => {
        const { lookup } = fakeRoleLookup({
            fluxer: [{ id: 'frole-mods', name: 'Mods' }],
        });
        const service = new MentionBridgeService(links.asLinkService(), {
            roleLookup: lookup,
        });

        const result = await service.resolveRoleMentions(
            discordInput({
                mentions: [
                    { id: 'drole-mods', name: 'Mods', mentionable: true },
                    { id: 'drole-nope', name: 'Nope', mentionable: true },
                    { id: 'drole-locked', name: 'Locked', mentionable: false },
                ],
                isEdit: true,
            })
        );

        expect(result).toEqual([
            { id: 'drole-mods', counterpartId: 'frole-mods', name: 'Mods' },
        ]);
        expect(info).not.toHaveBeenCalled();
    });
});

describe('MentionBridgeService role mention helpers', () => {
    it('extracts role ids from <@&id> only, in order and without duplicates', () => {
        expect(
            MentionBridgeService.extractRoleMentionIds(
                'ping <@&1> and <@&2>, again <@&1>; not <@3> or <@!4> or <#5>'
            )
        ).toEqual(['1', '2']);
        expect(MentionBridgeService.extractRoleMentionIds('nothing')).toEqual(
            []
        );
    });

    it('restores user and role placeholders in one string to their mention markup', () => {
        const content = `hi ${MentionBridgeService.mentionPlaceholder('21')} and ${MentionBridgeService.roleMentionPlaceholder('11')} and ${MentionBridgeService.roleMentionPlaceholder('12')}`;

        expect(MentionBridgeService.restoreMentionPlaceholders(content)).toBe(
            'hi <@21> and <@&11> and <@&12>'
        );
    });

    it('keeps role placeholders intact through sanitising and @-breaking', () => {
        const placeholder = MentionBridgeService.roleMentionPlaceholder('11');
        const sanitized = breakMentions(
            sanitizeMentions(`hey <@&11> <@&12> @everyone`, {
                resolveUser: () => null,
                resolveRole: (id) => (id === '12' ? 'Other' : null),
                resolveChannel: () => null,
                renderRoleMention: (id) => (id === '11' ? placeholder : null),
            })
        );

        expect(sanitized).toBe(
            `hey ${placeholder} @${ZWSP}Other @${ZWSP}everyone`
        );
        expect(MentionBridgeService.restoreMentionPlaceholders(sanitized)).toBe(
            `hey <@&11> @${ZWSP}Other @${ZWSP}everyone`
        );
    });
});

describe('sanitizeMentions renderRoleMention', () => {
    const resolver = {
        resolveUser: (id: string) => (id === '21' ? 'alice' : null),
        resolveRole: (id: string) => (id === '11' ? 'Mods' : null),
        resolveChannel: () => null,
    };

    it('uses the rendered replacement for a role mention when one is returned', () => {
        expect(
            sanitizeMentions('<@&11> <@&12>', {
                ...resolver,
                renderRoleMention: (id) => (id === '11' ? '[[role r1]]' : null),
            })
        ).toBe('[[role r1]] @unknown-role');
    });

    it('falls back to @RoleName / @unknown-role when the renderer declines or is absent', () => {
        expect(
            sanitizeMentions('<@&11> <@&12>', {
                ...resolver,
                renderRoleMention: () => null,
            })
        ).toBe('@Mods @unknown-role');
        expect(sanitizeMentions('<@&11> <@&12>', resolver)).toBe(
            '@Mods @unknown-role'
        );
    });

    it('does not feed user or channel mentions to the role renderer', () => {
        const renderRoleMention = vi.fn(() => '[[role]]');

        expect(
            sanitizeMentions('<@21> <@!21> <#31> <@&11>', {
                ...resolver,
                renderRoleMention,
            })
        ).toBe('@alice @alice #unknown-channel [[role]]');
        expect(renderRoleMention).toHaveBeenCalledTimes(1);
        expect(renderRoleMention).toHaveBeenCalledWith('11');
    });
});
