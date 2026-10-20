import { describe, expect, it } from 'vitest';
import MeowService, {
    isCatNoise,
    measureStretch,
    parseCatNoises,
    stretchNoise,
} from '../../src/services/meow/MeowService';

/** Random source that returns the given values in order, then repeats the last. */
function sequence(...values: number[]): () => number {
    let i = 0;
    return () => values[Math.min(i++, values.length - 1)];
}

describe('isCatNoise', () => {
    it.each([
        'meow',
        'Meow!',
        'MEOW',
        'mew',
        'miaow',
        'meooooow',
        'meows',
        'mrow',
        'mrrow',
        'mrraow',
        'mrrp',
        'mrp',
        'mrrrrp',
        'mrrt',
        'prrp',
        'mrr',
        'nya',
        'nyah',
        'nyaaa~',
        'nyan',
        'purr',
        'prrr',
        'purrrrr',
        'meow meow',
        'mrrp meow nya',
        'meow :3',
        'nya >:3c',
        'meow 🐱',
        'meow 😸😸',
        '*meows*',
        '*purrs*',
        'meow?!',
        'meow...',
        '  meow  ',
        'meow~ meow~',
        'nyah =^.^=',
    ])('accepts %j', (content) => {
        expect(isCatNoise(content)).toBe(true);
    });

    it.each([
        '',
        '   ',
        'hello',
        'I meow sometimes',
        'meow at me',
        'the cat said meow',
        'meow <@123456789>',
        'meow https://example.com',
        'meow <:cat:1234567890>',
        'me ow',
        '🐱',
        ':3',
        'now',
        'mop',
        'mr',
        'n',
        '!b meow',
        'meowing',
        'me0w',
    ])('rejects %j', (content) => {
        expect(isCatNoise(content)).toBe(false);
    });

    it('rejects null, undefined and very long content', () => {
        expect(isCatNoise(null)).toBe(false);
        expect(isCatNoise(undefined)).toBe(false);
        expect(isCatNoise('meow '.repeat(200))).toBe(false);
    });
});

describe('parseCatNoises', () => {
    it('classifies each word into a family', () => {
        expect(parseCatNoises('Meow mrrp NYA purr mrow')).toEqual([
            { family: 'meow', word: 'meow' },
            { family: 'mrrp', word: 'mrrp' },
            { family: 'nya', word: 'nya' },
            { family: 'purr', word: 'purr' },
            { family: 'meow', word: 'mrow' },
        ]);
    });

    it('returns null when any word is not a cat noise', () => {
        expect(parseCatNoises('meow hi')).toBeNull();
    });
});

describe('measureStretch / stretchNoise', () => {
    it('ignores the doubled letters of a normal spelling', () => {
        expect(measureStretch(parseCatNoises('meow')!)).toBe(0);
        expect(measureStretch(parseCatNoises('mrrp')!)).toBe(0);
        expect(measureStretch(parseCatNoises('purr')!)).toBe(0);
    });

    it('counts letters beyond a double in the most stretched word', () => {
        expect(measureStretch(parseCatNoises('meooow')!)).toBe(1);
        expect(measureStretch(parseCatNoises('meooooow')!)).toBe(3);
        expect(measureStretch(parseCatNoises('meow mrrrrrp')!)).toBe(3);
    });

    it('stretches the last vowel of a meow and the r of a trill', () => {
        expect(stretchNoise('meow', 2, () => 0.5)).toBe('meooow');
        expect(stretchNoise('nya', 2, () => 0.5)).toBe('nyaaa');
        expect(stretchNoise('mrrp', 2, () => 0.5)).toBe('mrrrrp');
        expect(stretchNoise('purr', 2, () => 0.5)).toBe('purrrr');
        expect(stretchNoise('meow meow', 1, () => 0.5)).toBe('meoow meoow');
    });

    it('caps the stretch so a wall of letters stays readable', () => {
        const long = stretchNoise('meow', 40, () => 1);
        expect(long).toBe('me' + 'o'.repeat(9) + 'w');
    });
});

describe('MeowService.shouldReply', () => {
    it('is true for a cat noise and false for anything else', () => {
        const service = new MeowService({ cooldownMs: 0 });
        expect(service.shouldReply('meow', 'c1')).toBe(true);
        expect(service.shouldReply('hello', 'c1')).toBe(false);
        expect(service.shouldReply(null, 'c1')).toBe(false);
    });

    it('applies a per-channel cooldown', () => {
        let now = 1_000;
        const service = new MeowService({ cooldownMs: 1500, now: () => now });

        expect(service.shouldReply('meow', 'c1')).toBe(true);
        expect(service.shouldReply('meow', 'c1')).toBe(false);
        // Another channel has its own cooldown.
        expect(service.shouldReply('meow', 'c2')).toBe(true);

        now += 1_499;
        expect(service.shouldReply('meow', 'c1')).toBe(false);
        now += 1;
        expect(service.shouldReply('meow', 'c1')).toBe(true);
    });

    it('does not start a cooldown for a message it will not answer', () => {
        let now = 1_000;
        const service = new MeowService({ cooldownMs: 1500, now: () => now });
        expect(service.shouldReply('hello', 'c1')).toBe(false);
        expect(service.shouldReply('meow', 'c1')).toBe(true);
    });
});

describe('MeowService.reply', () => {
    it('always produces a cat noise', () => {
        const service = new MeowService();
        for (const content of ['meow', 'mrrp', 'nyah', 'purr', 'meow mrrp']) {
            for (let i = 0; i < 50; i++) {
                const reply = service.reply(content);
                expect(isCatNoise(reply), `${content} -> ${reply}`).toBe(true);
            }
        }
    });

    it('answers in the register of the message when it does not drift', () => {
        const service = new MeowService({ driftChance: 0, random: () => 0 });
        expect(parseCatNoises(service.reply('nyah'))![0].family).toBe('nya');
        expect(parseCatNoises(service.reply('mrrp'))![0].family).toBe('mrrp');
        expect(parseCatNoises(service.reply('purr'))![0].family).toBe('purr');
        expect(parseCatNoises(service.reply('meow'))![0].family).toBe('meow');
    });

    it('follows the last thing said in a multi-word message', () => {
        const service = new MeowService({ driftChance: 0, random: () => 0 });
        expect(parseCatNoises(service.reply('meow meow nya'))![0].family).toBe(
            'nya'
        );
    });

    it('drifts to a neighbouring family when the dice say so', () => {
        // First roll decides drift (below driftChance), second picks the
        // neighbour, the rest pick words and decorations.
        const service = new MeowService({
            driftChance: 0.25,
            random: sequence(0.1, 0, 0, 0.5),
        });
        expect(parseCatNoises(service.reply('nya'))![0].family).toBe('meow');
    });

    it('falls back to a meow for anything that is not a cat noise', () => {
        const service = new MeowService({ driftChance: 0, random: () => 0.5 });
        expect(service.reply('hello there')).toBe('maow');
        expect(service.reply(undefined)).toBe('maow');
    });

    it('answers a single word with a single word', () => {
        const service = new MeowService({ driftChance: 0 });
        for (let i = 0; i < 50; i++) {
            const words = service
                .reply('meow')
                .replace(/[^a-z ]/g, '')
                .trim()
                .split(/\s+/);
            // Vocabulary entries themselves may be two words ("meow meow").
            expect(words.length).toBeLessThanOrEqual(2);
        }
    });

    it('mirrors a stretched message', () => {
        const service = new MeowService({ driftChance: 0, random: () => 0.5 });
        const reply = service.reply('meooooooow');
        expect(reply).toMatch(
            /^m[aeiou]+o{3,}w|^m[aeiou]{4,}w|^m[aeiou]+r{3,}/
        );
        expect(isCatNoise(reply)).toBe(true);
    });

    it('keeps a plain message plain', () => {
        const service = new MeowService({ driftChance: 0, random: () => 0.5 });
        expect(service.reply('meow')).toBe('maow');
    });

    it('mirrors trailing punctuation', () => {
        const service = new MeowService({ driftChance: 0, random: () => 0.5 });
        expect(service.reply('meow!')).toMatch(/!$/);
        expect(service.reply('meow~')).toMatch(/~$/);
        expect(service.reply('meow?')).toMatch(/[!?]$/);
    });

    it('answers a cat face with a cat face', () => {
        const service = new MeowService({ driftChance: 0, random: () => 0 });
        expect(service.reply('meow :3')).toBe('meow :3');
    });
});
