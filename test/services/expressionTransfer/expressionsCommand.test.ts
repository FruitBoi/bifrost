import { describe, expect, it } from 'vitest';
import {
    DESCRIPTION_MAX,
    describePlan,
    EXPRESSIONS_COMMAND_NAMES,
    formatExpressionTransferReport,
    MAX_LISTED,
    parseExpressionsArgs,
} from '../../../src/services/expressionTransfer/expressionsCommand';
import {
    ALL_EXPRESSION_KINDS,
    ExpressionKindReport,
    ExpressionTransferReport,
} from '../../../src/services/expressionTransfer/ExpressionTransferService';
import { EmbedColors } from '../../../src/utils/embeds';

const empty = (): ExpressionKindReport => ({
    created: [],
    skipped: [],
    failed: [],
});

function report(
    partial: Partial<
        Record<'emojis' | 'stickers', Partial<ExpressionKindReport>>
    >
): ExpressionTransferReport {
    return {
        emojis: { ...empty(), ...partial.emojis },
        stickers: { ...empty(), ...partial.stickers },
    };
}

const names = (prefix: string, count: number) =>
    Array.from({ length: count }, (_, i) => `${prefix}${i + 1}`);

describe('EXPRESSIONS_COMMAND_NAMES', () => {
    it('covers the command and its aliases', () => {
        expect(EXPRESSIONS_COMMAND_NAMES).toEqual([
            'expressions',
            'emotes',
            'emojis',
        ]);
    });
});

describe('parseExpressionsArgs', () => {
    it('copies both kinds without an argument', () => {
        expect(parseExpressionsArgs([])).toEqual({
            ok: true,
            kinds: ALL_EXPRESSION_KINDS,
        });
    });

    it.each([
        [['emojis'], ['emojis']],
        [['stickers'], ['stickers']],
        [['STICKERS'], ['stickers']],
        [['Emojis'], ['emojis']],
    ])('limits the kinds for %j', (args, kinds) => {
        expect(parseExpressionsArgs(args)).toEqual({ ok: true, kinds });
    });

    it.each([
        [['emoji']],
        [['sticker']],
        [['emotes']],
        [['both']],
        [['emojis', 'stickers']],
        [['emojis', 'extra']],
    ])('rejects %j', (args) => {
        expect(parseExpressionsArgs(args)).toEqual({ ok: false });
    });
});

describe('describePlan', () => {
    it('is silent when nothing will be uploaded', () => {
        expect(describePlan({ emojis: 0, stickers: 0 })).toBeNull();
    });

    it.each([
        [
            { emojis: 12, stickers: 3 },
            'Copying 12 emojis and 3 stickers to the Fluxer server… this can take a while.',
        ],
        [
            { emojis: 1, stickers: 1 },
            'Copying 1 emoji and 1 sticker to the Fluxer server… this can take a while.',
        ],
        [
            { emojis: 0, stickers: 2 },
            'Copying 2 stickers to the Fluxer server… this can take a while.',
        ],
        [
            { emojis: 1, stickers: 0 },
            'Copying 1 emoji to the Fluxer server… this can take a while.',
        ],
    ])('describes %j', (plan, expected) => {
        expect(describePlan(plan)).toBe(expected);
    });
});

describe('formatExpressionTransferReport', () => {
    it('is green with a copied list when everything was created', () => {
        const result = formatExpressionTransferReport(
            report({
                emojis: { created: ['wave', 'party'] },
                stickers: { created: ['hi'] },
            })
        );
        expect(result.title).toBe('Emoji & sticker transfer');
        expect(result.color).toBe(EmbedColors.Success);
        expect(result.description).toBe(
            [
                'Copied 2 emojis and 1 sticker to the Fluxer server.',
                '',
                '**Emojis:** 2 copied',
                '- Copied: `wave`, `party`',
                '',
                '**Stickers:** 1 copied',
                '- Copied: `hi`',
            ].join('\n')
        );
    });

    it('groups skipped names by reason and is informational when nothing was copied', () => {
        const result = formatExpressionTransferReport(
            report({
                emojis: {
                    skipped: [
                        { name: 'a', reason: 'already on Fluxer' },
                        { name: 'b', reason: 'duplicate name on Discord' },
                        { name: 'c', reason: 'already on Fluxer' },
                    ],
                },
                stickers: {
                    skipped: [
                        {
                            name: 'lottie',
                            reason: 'Lottie stickers cannot be uploaded',
                        },
                    ],
                },
            })
        );
        expect(result.color).toBe(EmbedColors.Info);
        expect(result.description).toBe(
            [
                'Nothing to copy: every emoji and sticker of the Discord server was skipped.',
                '',
                '**Emojis:** 3 skipped',
                '- Skipped (already on Fluxer): `a`, `c`',
                '- Skipped (duplicate name on Discord): `b`',
                '',
                '**Stickers:** 1 skipped',
                '- Skipped (Lottie stickers cannot be uploaded): `lottie`',
            ].join('\n')
        );
    });

    it('says so when the Discord server has nothing of the kind', () => {
        const result = formatExpressionTransferReport(report({}));
        expect(result.color).toBe(EmbedColors.Info);
        expect(result.description).toBe(
            [
                'Nothing to copy: the Discord server has no custom emojis and stickers.',
                '',
                '**Emojis:** none on the Discord server.',
                '',
                '**Stickers:** none on the Discord server.',
            ].join('\n')
        );
    });

    it('is yellow with failures listed individually when some were copied', () => {
        const result = formatExpressionTransferReport(
            report({
                emojis: {
                    created: ['ok'],
                    failed: [
                        { name: 'big', reason: 'HTTP 413' },
                        { name: 'odd', reason: 'HTTP 500' },
                    ],
                },
                stickers: { created: ['s'] },
            })
        );
        expect(result.color).toBe(EmbedColors.Warning);
        expect(result.description).toContain(
            'Copied 1 emoji and 1 sticker to the Fluxer server; 2 emojis failed.'
        );
        expect(result.description).toContain('**Emojis:** 1 copied, 2 failed');
        expect(result.description).toContain(
            '- Failed: `big` (HTTP 413), `odd` (HTTP 500)'
        );
    });

    it('is red when nothing was copied and something failed', () => {
        const result = formatExpressionTransferReport(
            report({
                stickers: {
                    skipped: [{ name: 'x', reason: 'already on Fluxer' }],
                    failed: [{ name: 'y', reason: 'HTTP 500' }],
                },
            }),
            ['stickers']
        );
        expect(result.title).toBe('Sticker transfer');
        expect(result.color).toBe(EmbedColors.Error);
        expect(result.description).toBe(
            [
                'Could not copy 1 sticker to the Fluxer server.',
                '',
                '**Stickers:** 1 skipped, 1 failed',
                '- Skipped (already on Fluxer): `x`',
                '- Failed: `y` (HTTP 500)',
            ].join('\n')
        );
    });

    it('only renders the requested kinds', () => {
        const result = formatExpressionTransferReport(
            report({ emojis: { created: ['a'] } }),
            ['emojis']
        );
        expect(result.title).toBe('Emoji transfer');
        expect(result.description).not.toContain('Stickers');
        expect(result.description).toContain('**Emojis:** 1 copied');

        const none = formatExpressionTransferReport(report({}), ['emojis']);
        expect(none.description).toBe(
            [
                'Nothing to copy: the Discord server has no custom emojis.',
                '',
                '**Emojis:** none on the Discord server.',
            ].join('\n')
        );
    });

    it('caps every list with "+N more"', () => {
        const created = names('e', MAX_LISTED + 5);
        const result = formatExpressionTransferReport(
            report({
                emojis: { created },
                stickers: {
                    skipped: names('s', MAX_LISTED + 1).map((name) => ({
                        name,
                        reason: 'already on Fluxer',
                    })),
                    failed: names('f', MAX_LISTED + 2).map((name) => ({
                        name,
                        reason: 'HTTP 500',
                    })),
                },
            })
        );
        expect(result.description).toContain(
            `- Copied: ${created
                .slice(0, MAX_LISTED)
                .map((n) => `\`${n}\``)
                .join(', ')} +5 more`
        );
        expect(result.description).not.toContain('`e25`');
        expect(result.description).toContain('`s20` +1 more');
        expect(result.description).toContain('`f20` (HTTP 500) +2 more');
    });

    it('never exceeds the description cap', () => {
        const longReason = 'x'.repeat(400);
        const result = formatExpressionTransferReport(
            report({
                emojis: {
                    failed: names('f', MAX_LISTED).map((name) => ({
                        name,
                        reason: longReason,
                    })),
                },
            })
        );
        expect(result.description.length).toBe(DESCRIPTION_MAX);
        expect(result.description.endsWith('…')).toBe(true);
    });
});
