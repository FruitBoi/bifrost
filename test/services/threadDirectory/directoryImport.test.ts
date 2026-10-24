import { describe, expect, it } from 'vitest';
import { parseDirectoryImport } from '../../../src/services/threadDirectory/directoryImport';

const one = (text: string) => parseDirectoryImport(text);
const item = (
    channelId: string | null,
    name: string | null,
    description: string | null,
    roleId: string | null = null
) => ({ channelId, name, description, roleId });

describe('parseDirectoryImport', () => {
    it('parses the hand-made bold-italic link format', () => {
        expect(
            one(
                '***[The Data Mine](https://fluxer.app/channels/100000000000000001/200000000000000222/300000000000000333)*** - Computer Tech'
            )
        ).toEqual([
            item('200000000000000222', 'The Data Mine', 'Computer Tech'),
        ]);
    });

    it('accepts <...> wrapped links and all separators', () => {
        for (const sep of [' - ', ' – ', ' — ', ': ', ' | ']) {
            expect(
                one(
                    `[Cars 2](<https://fluxer.app/channels/100000000000000001/200000000000000002>)${sep}Cars`
                )
            ).toEqual([item('200000000000000002', 'Cars 2', 'Cars')]);
        }
    });

    it('parses the old bot format', () => {
        expect(one('<#123456789012345678> — Computer Tech')).toEqual([
            item('123456789012345678', null, 'Computer Tech'),
        ]);
    });

    it('parses the new bot format with and without parts', () => {
        const id = '123456789012345678';
        const role = '987654321098765432';
        expect(one(`Computer Tech: <#${id}> - <@&${role}>`)).toEqual([
            item(id, null, 'Computer Tech', role),
        ]);
        expect(one(`<#${id}> - <@&${role}>`)).toEqual([
            item(id, null, null, role),
        ]);
        expect(one(`Computer Tech: <#${id}>`)).toEqual([
            item(id, null, 'Computer Tech'),
        ]);
    });

    it('parses bare links, mentions and raw IDs', () => {
        expect(
            one(
                'https://fluxer.app/channels/100000000000000001/200000000000000002'
            )
        ).toEqual([item('200000000000000002', null, null)]);
        expect(one('<#123456789012345678>')).toEqual([
            item('123456789012345678', null, null),
        ]);
        expect(one('123456789012345678')).toEqual([
            item('123456789012345678', null, null),
        ]);
    });

    it('parses plain name - description lines', () => {
        expect(one('Cars 2 - Cars')).toEqual([item(null, 'Cars 2', 'Cars')]);
    });

    it('parses markdown links whose text is a mention or url', () => {
        expect(
            one(
                '[#cars](https://fluxer.app/channels/100000000000000001/200000000000000002)'
            )
        ).toEqual([item('200000000000000002', 'cars', null)]);
        expect(
            one(
                '[https://fluxer.app/channels/100000000000000001/200000000000000002](https://fluxer.app/channels/100000000000000001/200000000000000002)'
            )
        ).toEqual([item('200000000000000002', null, null)]);
    });

    it('takes the channel from a message link', () => {
        expect(
            one(
                'https://fluxer.app/channels/100000000000000001/200000000000000002/300000000000000003 - Foo'
            )
        ).toEqual([item('200000000000000002', null, 'Foo')]);
    });

    it('strips bullets, quotes and emphasis', () => {
        const text = [
            '- __[A](https://x.io/channels/100000000000000001/200000000000000100)__ — ~~Alpha~~',
            '* **[B](https://x.io/channels/100000000000000001/200000000000000101)** - *Beta*',
            '• [C](https://x.io/channels/100000000000000001/200000000000000102) - Gamma',
            '1. [D](https://x.io/channels/100000000000000001/200000000000000103) - Delta',
            '> ***[E](https://x.io/channels/100000000000000001/200000000000000104)*** - Eps',
        ].join('\n');
        expect(one(text)).toEqual([
            item('200000000000000100', 'A', 'Alpha'),
            item('200000000000000101', 'B', 'Beta'),
            item('200000000000000102', 'C', 'Gamma'),
            item('200000000000000103', 'D', 'Delta'),
            item('200000000000000104', 'E', 'Eps'),
        ]);
    });

    it('splits only at the first separator on plain lines', () => {
        expect(one('Tools - Tools, Machining - Making')).toEqual([
            item(null, 'Tools', 'Tools, Machining - Making'),
        ]);
        expect(
            one(
                '[Shop](https://x.io/channels/100000000000000001/200000000000000002) - Tools, Machining - Making'
            )
        ).toEqual([
            item('200000000000000002', 'Shop', 'Tools, Machining - Making'),
        ]);
    });

    it('handles a screenshot-like full message with CRLF', () => {
        const names = [
            'The Data Mine',
            'Cars 2',
            'ATF no dogs here',
            'Pets',
            'Games',
            'Music',
            'Art',
            'Food',
            'Bikes',
        ];
        const lines = ['**Threads Directory**', ''].concat(
            names.map(
                (n, i) =>
                    `***[${n}](<https://fluxer.app/channels/100000000000000001/20000000000000020${i}>)*** - Topic ${i}`
            )
        );
        const items = one(lines.join('\r\n'));
        expect(items).toHaveLength(9);
        expect(items[0]).toEqual(
            item('200000000000000200', 'The Data Mine', 'Topic 0')
        );
        expect(items[8]).toEqual(
            item('200000000000000208', 'Bikes', 'Topic 8')
        );
    });

    it('skips blank lines, headings and garbage', () => {
        const text = [
            'Threads Directory',
            '# Threads',
            '',
            '   ',
            '**Threads Directory**',
            'hello',
            '- ',
            ' - x',
            'a - ',
            '<@&987654321098765432>',
        ].join('\n');
        expect(one(text)).toEqual([]);
    });

    it('takes the first role mention and removes all from the description', () => {
        const a = '987654321098765432';
        const b = '987654321098765433';
        expect(
            one(
                `Chat: https://x.io/channels/100000000000000001/200000000000000002 - <@&${a}> <@&${b}>`
            )
        ).toEqual([item('200000000000000002', null, 'Chat', a)]);
    });
});
