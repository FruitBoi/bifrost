/**
 * Cat-noise conversation (issue #4).
 *
 * When a message consists of nothing but cat noises (meow, mrrp, nya, purr and
 * their stretched or decorated variants such as `meooow!!`, `mrrrp~` or
 * `nya :3`), the bridge answers with a cat noise of its own so it looks like
 * it is chatting back. Only messages written on Fluxer are answered (asked
 * for on the issue): a Discord user's meow is bridged as usual but gets no
 * reply, while a reply given on Fluxer is bridged to Discord like any other
 * message. The reply stays in the same "register" as the message
 * (a `nyah` gets a nya-family answer, a `mrrp` a trill or purr), mirrors how
 * stretched and how decorated the message was, and drifts to a neighbouring
 * noise now and then so a long exchange does not repeat itself.
 *
 * Detection is deliberately strict: every word must be a cat noise, so
 * ordinary sentences that merely contain "meow" are left alone. Mentions,
 * links and custom emoji disqualify a message as well.
 */

export type NoiseFamily = 'meow' | 'mrrp' | 'nya' | 'purr';

/** A single word that counts as a cat noise, after decorations are removed. */
const NOISE_PATTERNS: ReadonlyArray<readonly [NoiseFamily, RegExp]> = [
    // meow, mew, miaow, meeeow, maow, meows
    ['meow', /^m+[aeiou]+w+s?$/],
    // mrow, mrrow, mraow, mrrrrow, mrrao, mrrp-less trills that end in a vowel
    ['meow', /^m+r+[aeiou]*w+s?$/],
    ['meow', /^m+r+[aeiou]+$/],
    // mrrp, mrp, mrrrp, mrrt, prrp, prrt, purrt
    ['mrrp', /^[mp]+u*r+[pt]+s?$/],
    // mrr, mrrr (a short trill)
    ['mrrp', /^m+r{2,}$/],
    // nya, nyah, nyaa~, nyan, nyahs
    ['nya', /^n+y+a+[hn]*s?$/],
    // purr, prr, purrs, purrrrr
    ['purr', /^p+u*r{2,}s?$/],
];

/**
 * Things that may surround a cat noise without changing its meaning:
 * emoticons such as `:3`, `>:3c`, `=^.^=`, cat emoji, and plain punctuation.
 * They are removed before the words are inspected.
 */
const EMOTICON_RE = />?[:;=xX]3c?|=\^\.\^=|\^\.\^|\^\^|<3|\^w\^|owo|uwu/g;
const EMOJI_RE = /\p{Extended_Pictographic}|️|‍|[\u{1F3FB}-\u{1F3FF}]/gu;
const PUNCTUATION_RE = /[!?.,~*…'"`()[\]{}\-_^|/\\+]/g;

/** Mentions, links and custom emoji are never part of a pure cat noise. */
const DISQUALIFY_RE = /<[@#a]?[!&]?:?[\w~]*:?\d+>|https?:\/\//i;

/** Longer than this and it is not a conversation any more. */
const MAX_CONTENT_LENGTH = 400;

interface NoiseWord {
    family: NoiseFamily;
    word: string;
}

/**
 * Splits `content` into its cat-noise words, or returns null when any word is
 * not a cat noise (or when there are no words at all).
 */
export function parseCatNoises(
    content: string | null | undefined
): NoiseWord[] | null {
    if (!content) return null;
    if (content.length > MAX_CONTENT_LENGTH) return null;
    if (DISQUALIFY_RE.test(content)) return null;

    const cleaned = content
        .normalize('NFKC')
        .toLowerCase()
        .replace(EMOTICON_RE, ' ')
        .replace(EMOJI_RE, ' ')
        .replace(PUNCTUATION_RE, ' ');

    const words = cleaned.split(/\s+/).filter((w) => w.length > 0);
    if (words.length === 0) return null;

    const noises: NoiseWord[] = [];
    for (const word of words) {
        const match = NOISE_PATTERNS.find(([, re]) => re.test(word));
        if (!match) return null;
        noises.push({ family: match[0], word });
    }
    return noises;
}

/** True when the whole message is cat noises (see {@link parseCatNoises}). */
export function isCatNoise(content: string | null | undefined): boolean {
    return parseCatNoises(content) !== null;
}

/** Base vocabulary per family; stretching and decoration are applied on top. */
const VOCABULARY: Record<NoiseFamily, readonly string[]> = {
    meow: ['meow', 'mew', 'mrow', 'maow', 'mrrow', 'meow meow', 'miaow'],
    mrrp: ['mrrp', 'mrp', 'prrp', 'mrrt', 'mrr', 'mrrp mrrp'],
    nya: ['nya', 'nyah', 'nyaa', 'nya nya', 'nyan', 'nyah nyah'],
    purr: ['purr', 'prrr', 'purr purr', 'mrrr', 'purrr'],
};

/** Where the conversation tends to wander when it does not stay put. */
const NEIGHBOURS: Record<NoiseFamily, readonly NoiseFamily[]> = {
    meow: ['mrrp', 'purr'],
    mrrp: ['purr', 'meow'],
    nya: ['meow', 'mrrp'],
    purr: ['mrrp', 'meow'],
};

/** Decorations the reply may borrow from the message. */
const CAT_FACES = [':3', ':3', '>:3', '=^.^=', '^w^'];
/** Non-global test for "did the message carry a cat face" (see EMOTICON_RE). */
const CAT_FACE_RE = />?[:;=xX]3c?|=\^\.\^=|\^\.\^|\^w\^/;

export interface MeowServiceOptions {
    /**
     * Source of randomness in `[0, 1)`; defaults to `Math.random`. Tests pass a
     * fixed function to make replies predictable.
     */
    random?: () => number;
    /**
     * Minimum time between two replies in the same channel, in milliseconds.
     * Protects against someone pasting fifty meows in a row. Default 1500.
     */
    cooldownMs?: number;
    /** Clock used for the cooldown; defaults to `Date.now`. */
    now?: () => number;
    /** Probability of drifting to a neighbouring noise family. Default 0.25. */
    driftChance?: number;
}

export default class MeowService {
    private readonly random: () => number;
    private readonly cooldownMs: number;
    private readonly now: () => number;
    private readonly driftChance: number;
    private readonly lastReplyAt = new Map<string, number>();

    constructor(options: MeowServiceOptions = {}) {
        this.random = options.random ?? Math.random;
        this.cooldownMs = options.cooldownMs ?? 1500;
        this.now = options.now ?? Date.now;
        this.driftChance = options.driftChance ?? 0.25;
    }

    /**
     * Whether the bridge should meow back at `content`. `channelKey` scopes
     * the cooldown; pass the channel (or thread) ID. A `true` result records
     * the reply time, so call it once per message.
     */
    shouldReply(content: string | null | undefined, channelKey = ''): boolean {
        if (!isCatNoise(content)) return false;
        if (this.cooldownMs > 0) {
            const now = this.now();
            const last = this.lastReplyAt.get(channelKey);
            if (last !== undefined && now - last < this.cooldownMs) {
                return false;
            }
            this.lastReplyAt.set(channelKey, now);
            this.pruneCooldowns(now);
        }
        return true;
    }

    /**
     * Builds a cat-noise answer to `content`. Works for any input; when the
     * message is not a cat noise the reply is simply a generic meow.
     */
    reply(content: string | null | undefined): string {
        const noises = parseCatNoises(content) ?? [];
        const text = content ?? '';

        const family = this.pickFamily(noises);
        const count = this.pickWordCount(noises.length);
        const words: string[] = [];
        for (let i = 0; i < count; i++) {
            words.push(
                this.pickWord(i === 0 ? family : this.maybeDrift(family))
            );
        }

        let reply = words.join(' ');
        const stretch = measureStretch(noises);
        if (stretch > 0) reply = stretchNoise(reply, stretch, this.random);

        return reply + this.pickDecoration(text);
    }

    private pickFamily(noises: NoiseWord[]): NoiseFamily {
        if (noises.length === 0) return 'meow';
        // Answer in the register of the last thing said, with some drift.
        const spoken = noises[noises.length - 1].family;
        return this.maybeDrift(spoken);
    }

    private maybeDrift(family: NoiseFamily): NoiseFamily {
        if (this.random() >= this.driftChance) return family;
        return this.choose(NEIGHBOURS[family]);
    }

    private pickWord(family: NoiseFamily): string {
        return this.choose(VOCABULARY[family]);
    }

    /** One word usually; a chatty message gets a slightly longer answer. */
    private pickWordCount(spokenWords: number): number {
        if (spokenWords <= 1) return 1;
        const max = Math.min(spokenWords, 3);
        return 1 + Math.floor(this.random() * max);
    }

    private pickDecoration(text: string): string {
        const roll = this.random();
        const hasFace = CAT_FACE_RE.test(text);
        if (hasFace && roll < 0.6) return ' ' + this.choose(CAT_FACES);

        const trailing = text.trim().match(/[!?~…]+$/)?.[0] ?? '';
        if (trailing.includes('?')) return roll < 0.7 ? '!' : '?';
        if (trailing.includes('!')) return roll < 0.8 ? '!' : '!!';
        if (trailing.includes('~')) return roll < 0.8 ? '~' : '~~';
        if (roll < 0.15) return '~';
        if (roll < 0.25) return '!';
        return '';
    }

    private choose<T>(items: readonly T[]): T {
        const index = Math.min(
            items.length - 1,
            Math.floor(this.random() * items.length)
        );
        return items[index];
    }

    private pruneCooldowns(now: number): void {
        if (this.lastReplyAt.size < 1000) return;
        for (const [key, at] of this.lastReplyAt) {
            if (now - at >= this.cooldownMs) this.lastReplyAt.delete(key);
        }
    }
}

/**
 * How stretched the message was: the letters beyond a doubled run in its most
 * stretched word. Doubles are part of normal spelling (`mrrp`, `purr`), so
 * `meow` and `mrrp` measure 0, `meooow` 1 and `meooooow` 3.
 */
export function measureStretch(noises: NoiseWord[]): number {
    let best = 0;
    for (const { word } of noises) {
        for (const run of word.match(/(.)\1{2,}/g) ?? []) {
            best = Math.max(best, run.length - 2);
        }
    }
    return best;
}

/**
 * Stretches a reply to roughly match `amount` extra letters. Trills stretch
 * their `r`s (`mrrp` → `mrrrrrp`), everything else its last vowel (`meow` →
 * `meoooow`). Caps at eight so a wall of `meooooooooooow` gets an enthusiastic
 * rather than an unreadable answer.
 */
export function stretchNoise(
    reply: string,
    amount: number,
    random: () => number = Math.random
): string {
    const extra = Math.min(
        8,
        Math.max(1, Math.round(amount * (0.6 + random() * 0.8)))
    );
    return reply
        .split(' ')
        .map((word) => {
            const trill = /r{2,}/.exec(word);
            const vowel = /[aeiou](?!.*[aeiou])/.exec(word);
            const target = trill ?? vowel ?? /r/.exec(word);
            if (!target) return word;
            const i = target.index;
            return (
                word.slice(0, i + 1) + word[i].repeat(extra) + word.slice(i + 1)
            );
        })
        .join(' ');
}
