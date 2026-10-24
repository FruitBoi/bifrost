/**
 * Calendar dates and wall-clock times for `remindme` (issue #27):
 * `remindme Oct 26 20:15 <message>`, `remindme Monday 7pm <message>`,
 * `remindme tomorrow <message>` and friends. Parsing is pure and zone-free;
 * {@link resolveReminderDate} turns the parsed spec into an instant in the
 * user's time zone, doing all calendar arithmetic (tomorrow, next weekday,
 * year rollover) in that zone and DST-correctly via `Intl`.
 */

/** The hour used when a date is given without a time (09:00 local). */
const DEFAULT_HOUR = 9;
/** The hour `tonight` means when no time is given (20:00 local). */
const TONIGHT_HOUR = 20;

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/**
 * A wall-clock date/time as typed by the user; needs a time zone to become
 * an instant.
 *
 * - `date`: an explicit calendar date (`Oct 26`, `26 Oct 2027`,
 *   `2026-10-26`); `month` (1–12) and `day` are set, `year` only when typed.
 * - `weekday`: the next `weekday` (0 = Sunday … 6 = Saturday).
 * - `relativeDay`: today plus `dayOffset` days (`today`/`tonight` 0,
 *   `tomorrow` 1).
 * - `time`: a bare time of day, today if still ahead, otherwise tomorrow.
 *
 * `hour` (0–23) and `minute` are always set; `hasTime` tells whether the
 * user typed the time or it is the default (09:00, or 20:00 for `tonight`).
 */
export interface ReminderDateSpec {
    kind: 'date' | 'weekday' | 'relativeDay' | 'time';
    year?: number;
    month?: number;
    day?: number;
    weekday?: number;
    dayOffset?: number;
    hour: number;
    minute: number;
    hasTime: boolean;
}

const MONTHS: Readonly<Record<string, number>> = {
    jan: 1,
    january: 1,
    feb: 2,
    february: 2,
    mar: 3,
    march: 3,
    apr: 4,
    april: 4,
    may: 5,
    jun: 6,
    june: 6,
    jul: 7,
    july: 7,
    aug: 8,
    august: 8,
    sep: 9,
    sept: 9,
    september: 9,
    oct: 10,
    october: 10,
    nov: 11,
    november: 11,
    dec: 12,
    december: 12,
};

const WEEKDAYS: Readonly<Record<string, number>> = {
    sun: 0,
    sunday: 0,
    mon: 1,
    monday: 1,
    tue: 2,
    tues: 2,
    tuesday: 2,
    wed: 3,
    weds: 3,
    wednesday: 3,
    thu: 4,
    thur: 4,
    thurs: 4,
    thursday: 4,
    fri: 5,
    friday: 5,
    sat: 6,
    saturday: 6,
};

const RELATIVE_DAYS: Readonly<Record<string, number>> = {
    today: 0,
    tonight: 0,
    tomorrow: 1,
    tmrw: 1,
    tmr: 1,
    tmrow: 1,
};

/** Days in `month` (1–12) of `year`; February has 29 when `year` is unknown. */
function daysInMonth(month: number, year?: number): number {
    if (month === 2) {
        if (year === undefined) return 29;
        const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
        return leap ? 29 : 28;
    }
    return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** Lower-cases a token and drops a trailing comma (`26,` → `26`). */
function norm(token: string | undefined): string {
    return (token ?? '').toLowerCase().replace(/,+$/, '');
}

/** The month a token names (`oct`, `October`, `oct.`), or null. */
function monthOf(token: string | undefined): number | null {
    return MONTHS[norm(token).replace(/\.$/, '')] ?? null;
}

/** The weekday a token names (`mon`, `Monday`, `thurs.`), or null. */
function weekdayOf(token: string | undefined): number | null {
    return WEEKDAYS[norm(token).replace(/\.$/, '')] ?? null;
}

/** A day-of-month token (`26`, `26th`, `1st`, `26,`), or null. */
function dayOf(token: string | undefined): number | null {
    const match = /^(\d{1,2})(?:st|nd|rd|th)?$/.exec(norm(token));
    if (!match) return null;
    const day = Number(match[1]);
    return day >= 1 && day <= 31 ? day : null;
}

/** A four-digit year token (`2027`, `2027,`), or null. */
function yearOf(token: string | undefined): number | null {
    const match = /^(\d{4})$/.exec(norm(token));
    if (!match) return null;
    const year = Number(match[1]);
    return year >= 1970 ? year : null;
}

type TimeResult = { hour: number; minute: number; consumed: number };

/** `am`/`pm` meridiem, with or without dots; null for anything else. */
function meridiemOf(text: string | undefined): 'am' | 'pm' | null {
    const value = (text ?? '').replace(/\./g, '');
    if (value === 'am') return 'am';
    if (value === 'pm') return 'pm';
    return null;
}

/** Applies a meridiem to a 12-hour clock hour (1–12); null when out of range. */
function to24h(hour: number, meridiem: 'am' | 'pm'): number | null {
    if (hour < 1 || hour > 12) return null;
    return (hour % 12) + (meridiem === 'pm' ? 12 : 0);
}

/**
 * Parses a time of day at `tokens[i]`: `20:15` (24-hour), `7pm`, `7:30pm`,
 * `7 pm`, `7:30 p.m.`, `noon`, `midnight`. A bare number is not a time.
 * Returns null when there is no time there and `'invalid'` when the token is
 * time-shaped but out of range (`25:00`, `13pm`, `7:60`).
 */
function parseTime(
    tokens: readonly string[],
    i: number
): TimeResult | 'invalid' | null {
    const token = norm(tokens[i]);
    if (token === 'noon') return { hour: 12, minute: 0, consumed: 1 };
    if (token === 'midnight') return { hour: 0, minute: 0, consumed: 1 };

    const match = /^(\d{1,2})(?::(\d{2}))?((?:[ap]\.?m\.?))?$/.exec(token);
    if (!match) return null;
    const rawHour = Number(match[1]);
    const minute = match[2] === undefined ? 0 : Number(match[2]);
    let meridiem = meridiemOf(match[3]);
    let consumed = 1;
    if (meridiem === null) {
        meridiem = meridiemOf(norm(tokens[i + 1]));
        if (meridiem !== null) consumed = 2;
    }

    if (meridiem === null && match[2] === undefined) return null;
    if (minute > 59) return 'invalid';
    if (meridiem === null) {
        return rawHour <= 23 ? { hour: rawHour, minute, consumed } : 'invalid';
    }
    const hour = to24h(rawHour, meridiem);
    return hour === null ? 'invalid' : { hour, minute, consumed };
}

type DateResult = {
    spec: Omit<ReminderDateSpec, 'hour' | 'minute' | 'hasTime'>;
    consumed: number;
};

/** `Oct 26[th][,] [2027]` or `26[th] Oct [2027]` at `tokens[i]`, or null. */
function parseMonthDay(
    tokens: readonly string[],
    i: number
): DateResult | null {
    let month = monthOf(tokens[i]);
    let day = dayOf(tokens[i + 1]);
    if (month === null || day === null) {
        day = dayOf(tokens[i]);
        month = monthOf(tokens[i + 1]);
        if (month === null || day === null) return null;
    }
    const year = yearOf(tokens[i + 2]);
    if (day > daysInMonth(month, year ?? undefined)) return null;
    return year === null
        ? { spec: { kind: 'date', month, day }, consumed: 2 }
        : { spec: { kind: 'date', year, month, day }, consumed: 3 };
}

/**
 * Parses a date/time at the start of `tokens`; returns the spec and how many
 * tokens it consumed, or null when tokens[0..] is not a date/time (or is a
 * time-shaped but invalid one such as `Oct 26 25:00`).
 *
 * Accepted (case-insensitive), after an optional `on`/`at`/`next`:
 * `Oct 26`, `October 26th, 2027`, `26 Oct`, `2026-10-26`, `Monday`,
 * `next mon`, `tomorrow`/`tmrw`/`tmr`, `today`, `tonight`, each optionally
 * followed by `[at] <time>`; or a bare `<time>`. A weekday may also be
 * followed by a month-day (`Monday Oct 26`), in which case the date wins.
 * `next Monday` means the same as `Monday`: the next one still ahead.
 */
export function parseReminderDate(
    tokens: readonly string[]
): { spec: ReminderDateSpec; consumed: number } | null {
    let i = 0;
    const prefix = norm(tokens[0]);
    const isNext = prefix === 'next';
    if (prefix === 'on' || prefix === 'at' || isNext) i = 1;
    if (i >= tokens.length) return null;

    let date: DateResult | null;
    const weekday = weekdayOf(tokens[i]);
    const relative = RELATIVE_DAYS[norm(tokens[i])];
    const iso = /^(\d{4})-(\d{2})-(\d{2})(?:t(\d{2}):(\d{2}))?$/.exec(
        norm(tokens[i])
    );

    if (weekday !== null) {
        const following = parseMonthDay(tokens, i + 1);
        date = following
            ? { spec: following.spec, consumed: 1 + following.consumed }
            : { spec: { kind: 'weekday', weekday }, consumed: 1 };
    } else if (isNext) {
        return null;
    } else if (relative !== undefined) {
        date = {
            spec: { kind: 'relativeDay', dayOffset: relative },
            consumed: 1,
        };
    } else if (iso) {
        const [year, month, day] = [iso[1], iso[2], iso[3]].map(Number);
        if (month < 1 || month > 12) return null;
        if (day < 1 || day > daysInMonth(month, year)) return null;
        const spec = { kind: 'date' as const, year, month, day };
        if (iso[4] !== undefined) {
            const hour = Number(iso[4]);
            const minute = Number(iso[5]);
            if (hour > 23 || minute > 59) return null;
            return {
                spec: { ...spec, hour, minute, hasTime: true },
                consumed: i + 1,
            };
        }
        date = { spec, consumed: 1 };
    } else {
        date = parseMonthDay(tokens, i);
    }

    if (date === null) {
        const time = parseTime(tokens, i);
        if (time === null || time === 'invalid') return null;
        return {
            spec: {
                kind: 'time',
                hour: time.hour,
                minute: time.minute,
                hasTime: true,
            },
            consumed: i + time.consumed,
        };
    }

    i += date.consumed;
    const hasAt = norm(tokens[i]) === 'at';
    const time = parseTime(tokens, hasAt ? i + 1 : i);
    if (time === 'invalid') return null;
    if (time !== null) {
        return {
            spec: {
                ...date.spec,
                hour: time.hour,
                minute: time.minute,
                hasTime: true,
            },
            consumed: i + (hasAt ? 1 : 0) + time.consumed,
        };
    }
    const tonight = norm(tokens[i - 1]) === 'tonight';
    return {
        spec: {
            ...date.spec,
            hour: tonight ? TONIGHT_HOUR : DEFAULT_HOUR,
            minute: 0,
            hasTime: false,
        },
        consumed: i,
    };
}

// ---------------------------------------------------------------------------
// Time zones

/** `UTC+05:30` / `UTC-03:00`: the stored form of a fixed offset. */
const FIXED_OFFSET_RE = /^UTC([+-])(\d{2}):(\d{2})$/;

/** Common abbreviations mapped to DST-aware IANA zones. */
const ZONE_ABBREVIATIONS: Readonly<Record<string, string>> = {
    EST: 'America/New_York',
    EDT: 'America/New_York',
    ET: 'America/New_York',
    CST: 'America/Chicago',
    CDT: 'America/Chicago',
    CT: 'America/Chicago',
    MST: 'America/Denver',
    MDT: 'America/Denver',
    MT: 'America/Denver',
    PST: 'America/Los_Angeles',
    PDT: 'America/Los_Angeles',
    PT: 'America/Los_Angeles',
    AKST: 'America/Anchorage',
    AKDT: 'America/Anchorage',
    HST: 'Pacific/Honolulu',
    BST: 'Europe/London',
    CET: 'Europe/Berlin',
    CEST: 'Europe/Berlin',
    EET: 'Europe/Athens',
    EEST: 'Europe/Athens',
    IST: 'Asia/Kolkata',
    JST: 'Asia/Tokyo',
    AEST: 'Australia/Sydney',
    AEDT: 'Australia/Sydney',
};

let canonicalZones: Map<string, string> | null = null;

/** Lower-cased IANA name → canonical spelling, from `Intl`. */
function canonicalZoneMap(): Map<string, string> {
    if (canonicalZones === null) {
        canonicalZones = new Map();
        const intl = Intl as unknown as {
            supportedValuesOf?: (key: string) => string[];
        };
        for (const zone of intl.supportedValuesOf?.('timeZone') ?? []) {
            canonicalZones.set(zone.toLowerCase(), zone);
        }
        // Preferred spellings ICU may only know as aliases (Asia/Kolkata).
        for (const zone of Object.values(ZONE_ABBREVIATIONS)) {
            canonicalZones.set(zone.toLowerCase(), zone);
        }
        canonicalZones.set('utc', 'UTC');
    }
    return canonicalZones;
}

/**
 * Normalises user input to a stored zone string, or null when unknown:
 * IANA names case-insensitively (`america/new_york` → `America/New_York`),
 * `UTC`/`GMT`/`Z` → `UTC`, fixed offsets (`UTC+2`, `GMT-5`, `+05:30`,
 * `UTC-3:30`) → `UTC+02:00` style (a zero offset is `UTC`), and common
 * abbreviations (`EST`, `PT`, `CET`, `IST`, …) → their DST-aware zone.
 */
export function parseTimeZone(input: string): string | null {
    const text = input.trim();
    if (text === '') return null;
    const upper = text.toUpperCase();

    if (upper === 'UTC' || upper === 'GMT' || upper === 'Z') return 'UTC';
    const abbreviation = ZONE_ABBREVIATIONS[upper];
    if (abbreviation !== undefined) return abbreviation;

    const offset = /^(?:UTC|GMT)?\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?$/.exec(
        upper
    );
    if (offset) {
        const hours = Number(offset[2]);
        const minutes = offset[3] === undefined ? 0 : Number(offset[3]);
        if (minutes > 59 || hours * 60 + minutes > 14 * 60) return null;
        if (hours === 0 && minutes === 0) return 'UTC';
        const pad = (n: number): string => String(n).padStart(2, '0');
        return `UTC${offset[1]}${pad(hours)}:${pad(minutes)}`;
    }

    const known = canonicalZoneMap().get(text.toLowerCase());
    if (known !== undefined) return known;
    // Aliases such as `US/Eastern` are valid but not in supportedValuesOf.
    if (!/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(text)) return null;
    try {
        return new Intl.DateTimeFormat('en-US', {
            timeZone: text,
        }).resolvedOptions().timeZone;
    } catch {
        return null;
    }
}

/** A stored zone for display (`America/New_York`, `UTC+05:30`). */
export function formatTimeZone(zone: string): string {
    return zone;
}

const formatters = new Map<string, Intl.DateTimeFormat | null>();

/** A cached numeric formatter for `zone`, or null when the zone is unknown. */
function formatterFor(zone: string): Intl.DateTimeFormat | null {
    if (!formatters.has(zone)) {
        let formatter: Intl.DateTimeFormat | null;
        try {
            formatter = new Intl.DateTimeFormat('en-US', {
                timeZone: zone,
                hourCycle: 'h23',
                year: 'numeric',
                month: 'numeric',
                day: 'numeric',
                hour: 'numeric',
                minute: 'numeric',
                second: 'numeric',
            });
        } catch {
            formatter = null;
        }
        formatters.set(zone, formatter);
    }
    return formatters.get(zone) ?? null;
}

/**
 * A zone's offset from UTC in ms at `instantMs` (wall clock minus UTC), or
 * null when the zone is unknown. Accepts IANA names and `UTC±HH:MM`.
 */
function zoneOffsetMs(zone: string, instantMs: number): number | null {
    const fixed = FIXED_OFFSET_RE.exec(zone);
    if (fixed) {
        const sign = fixed[1] === '-' ? -1 : 1;
        return sign * (Number(fixed[2]) * 60 + Number(fixed[3])) * MINUTE_MS;
    }
    const formatter = formatterFor(zone);
    if (formatter === null) return null;
    const parts: Record<string, number> = {};
    for (const part of formatter.formatToParts(new Date(instantMs))) {
        if (part.type !== 'literal') parts[part.type] = Number(part.value);
    }
    const wallMs = Date.UTC(
        parts.year,
        parts.month - 1,
        parts.day,
        parts.hour % 24,
        parts.minute,
        parts.second
    );
    return wallMs - Math.floor(instantMs / 1000) * 1000;
}

/**
 * The instant a wall-clock time (as a UTC-based ms value) means in `zone`.
 * Uses the offset at the first guess, then corrects once for a DST change
 * between the guess and the result; a time inside a spring-forward gap
 * lands just after it.
 */
function wallToInstant(zone: string, wallMs: number): number | null {
    const first = zoneOffsetMs(zone, wallMs);
    if (first === null) return null;
    const guess = wallMs - first;
    const second = zoneOffsetMs(zone, guess);
    if (second === null || second === first) return guess;
    const corrected = wallMs - second;
    // Inside a gap no offset round-trips; keep the guess, which is after it.
    return zoneOffsetMs(zone, corrected) === second ? corrected : guess;
}

/** Wall-clock calendar fields of `instantMs` in `zone`. */
function wallDate(
    zone: string,
    instantMs: number
): { year: number; month: number; day: number } | null {
    const offset = zoneOffsetMs(zone, instantMs);
    if (offset === null) return null;
    const wall = new Date(instantMs + offset);
    return {
        year: wall.getUTCFullYear(),
        month: wall.getUTCMonth() + 1,
        day: wall.getUTCDate(),
    };
}

/**
 * The instant (epoch ms) the spec means in `timeZone` relative to `nowMs`,
 * or null when it cannot be resolved (e.g. Feb 30, invalid zone).
 *
 * - `date` without a year: this year if still ahead, otherwise the next year
 *   that has that date (Feb 29 waits for a leap year). With a year: that
 *   exact date, even when it is in the past.
 * - `weekday`: today if the time is still ahead, otherwise the next one.
 * - `relativeDay`: today + `dayOffset` at the time, even when in the past
 *   (`today 8am` in the afternoon).
 * - `time`: today if still ahead, otherwise tomorrow.
 *
 * The caller decides what to do with instants that are not in the future.
 */
export function resolveReminderDate(
    spec: ReminderDateSpec,
    timeZone: string,
    nowMs: number
): number | null {
    const { hour, minute } = spec;
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
    const today = wallDate(timeZone, nowMs);
    if (today === null) return null;

    const at = (year: number, month: number, day: number): number | null =>
        wallToInstant(timeZone, Date.UTC(year, month - 1, day, hour, minute));
    /** `today` shifted by `days` calendar days, at the spec's time. */
    const inDays = (days: number): number | null => {
        const date = new Date(
            Date.UTC(today.year, today.month - 1, today.day) + days * DAY_MS
        );
        return at(
            date.getUTCFullYear(),
            date.getUTCMonth() + 1,
            date.getUTCDate()
        );
    };

    switch (spec.kind) {
        case 'date': {
            const { month, day } = spec;
            if (month === undefined || day === undefined) return null;
            if (month < 1 || month > 12 || day < 1) return null;
            if (spec.year !== undefined) {
                if (day > daysInMonth(month, spec.year)) return null;
                return at(spec.year, month, day);
            }
            if (day > daysInMonth(month)) return null;
            for (let year = today.year; year <= today.year + 8; year++) {
                if (day > daysInMonth(month, year)) continue;
                const instant = at(year, month, day);
                if (instant === null) return null;
                if (instant > nowMs) return instant;
            }
            return null;
        }
        case 'weekday': {
            const { weekday } = spec;
            if (weekday === undefined || weekday < 0 || weekday > 6) {
                return null;
            }
            const todayWeekday = new Date(
                Date.UTC(today.year, today.month - 1, today.day)
            ).getUTCDay();
            const days = (weekday - todayWeekday + 7) % 7;
            const instant = inDays(days);
            if (instant === null) return null;
            return instant > nowMs ? instant : inDays(days + 7);
        }
        case 'relativeDay':
            return inDays(spec.dayOffset ?? 0);
        case 'time': {
            const instant = inDays(0);
            if (instant === null) return null;
            return instant > nowMs ? instant : inDays(1);
        }
        default:
            return null;
    }
}
