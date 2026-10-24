import { describe, expect, it } from 'vitest';
import {
    parseChannelRef,
    parseGuildOrChannelRef,
    parseLink,
    parseMessageRef,
    parseRoleRef,
} from '../../src/utils/channelRef';

const G = '111111111111111111';
const C = '222222222222222222';
const M = '333333333333333333';

describe('parseChannelRef', () => {
    it.each<[string, string | null]>([
        [`<#${C}>`, C],
        [` <#${C}> `, C],
        [C, C],
        [`https://discord.com/channels/${G}/${C}`, C],
        [`https://ptb.discord.com/channels/${G}/${C}`, C],
        [`https://canary.discord.com/channels/${G}/${C}`, C],
        [`http://discord.com/channels/${G}/${C}`, C],
        [`https://fluxer.app/channels/${G}/${C}`, C],
        [`https://chat.example.org/channels/${G}/${C}`, C],
        [`https://discord.com/channels/${G}/${C}/${M}`, C],
        [`<https://discord.com/channels/${G}/${C}>`, C],
        [`<https://discord.com/channels/${G}/${C}/${M}>`, C],
        [`https://discord.com/channels/${G}/${C}/`, C],
        [`https://discord.com/channels/${G}/${C}?foo=bar`, C],
        [`https://discord.com/channels/${G}/${C}#frag`, C],
        [`https://discord.com/channels/@me/${C}`, C],
        [`https://discord.com/channels/${G}`, null],
        ['https://discord.com/channels/@me', null],
        ['general', null],
        ['#general', null],
        ['<#>', null],
        ['<#12a>', null],
        ['12345', null],
        [`<@${C}>`, null],
        [`<@&${C}>`, null],
        [`https://discord.com/users/${G}/${C}`, null],
        [`https://discord.com/channels/${G}/abc`, null],
        [`see https://discord.com/channels/${G}/${C}`, null],
        ['', null],
    ])('%j -> %j', (arg, expected) => {
        expect(parseChannelRef(arg)).toBe(expected);
    });

    it('handles null and undefined', () => {
        expect(parseChannelRef(undefined)).toBeNull();
        expect(parseChannelRef(null)).toBeNull();
    });
});

describe('parseGuildOrChannelRef', () => {
    it.each<[string, string | null]>([
        [`https://discord.com/channels/${G}`, G],
        [`<https://discord.com/channels/${G}>`, G],
        [`https://fluxer.app/channels/${G}/`, G],
        [`https://discord.com/channels/${G}/${C}`, C],
        [`<#${C}>`, C],
        [C, C],
        ['https://discord.com/channels/@me', null],
        ['nonsense', null],
        ['', null],
    ])('%j -> %j', (arg, expected) => {
        expect(parseGuildOrChannelRef(arg)).toBe(expected);
    });

    it('handles undefined', () => {
        expect(parseGuildOrChannelRef(undefined)).toBeNull();
    });
});

describe('parseLink', () => {
    it('splits guild, channel and message', () => {
        expect(
            parseLink(`https://discord.com/channels/${G}/${C}/${M}`)
        ).toEqual({
            guildId: G,
            channelId: C,
            messageId: M,
        });
        expect(parseLink(`https://discord.com/channels/${G}/${C}`)).toEqual({
            guildId: G,
            channelId: C,
            messageId: null,
        });
        expect(parseLink(`https://discord.com/channels/${G}`)).toEqual({
            guildId: G,
            channelId: null,
            messageId: null,
        });
    });

    it('reports DM links with a null guild', () => {
        expect(parseLink(`https://discord.com/channels/@me/${C}`)).toEqual({
            guildId: null,
            channelId: C,
            messageId: null,
        });
    });

    it('returns null for non-links', () => {
        expect(parseLink(C)).toBeNull();
        expect(parseLink(`<#${C}>`)).toBeNull();
        expect(parseLink('https://example.com/')).toBeNull();
        expect(parseLink(undefined)).toBeNull();
        expect(parseLink('')).toBeNull();
    });
});

describe('parseMessageRef', () => {
    it('reads message links with their channel', () => {
        expect(
            parseMessageRef(`https://discord.com/channels/${G}/${C}/${M}`)
        ).toEqual({ channelId: C, messageId: M });
        expect(
            parseMessageRef(`<https://fluxer.app/channels/${G}/${C}/${M}>`)
        ).toEqual({ channelId: C, messageId: M });
    });

    it('reads raw IDs with an unknown channel', () => {
        expect(parseMessageRef(M)).toEqual({ channelId: null, messageId: M });
    });

    it('rejects channel links, mentions and garbage', () => {
        expect(
            parseMessageRef(`https://discord.com/channels/${G}/${C}`)
        ).toBeNull();
        expect(parseMessageRef(`<#${C}>`)).toBeNull();
        expect(parseMessageRef('nope')).toBeNull();
        expect(parseMessageRef(undefined)).toBeNull();
    });
});

describe('parseRoleRef', () => {
    it.each<[string, string | null]>([
        [`<@&${C}>`, C],
        [C, C],
        [` <@&${C}> `, C],
        [`<@${C}>`, null],
        [`<#${C}>`, null],
        ['<@&>', null],
        ['everyone', null],
        ['', null],
    ])('%j -> %j', (arg, expected) => {
        expect(parseRoleRef(arg)).toBe(expected);
    });
});
