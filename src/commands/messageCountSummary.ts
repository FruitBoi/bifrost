import type {
    MessageCounts,
    PlatformCounts,
} from '../services/messageCount/MessageCountService';

export interface MessageCountField {
    name: string;
    value: string;
    inline: boolean;
}

function fmt(n: number): string {
    return n.toLocaleString('en-US');
}

/**
 * Each platform's share of the total as whole percents that add up to 100,
 * or null when nothing was counted.
 */
export function platformShares(
    counts: PlatformCounts
): { discord: number; fluxer: number } | null {
    const total = counts.discord + counts.fluxer;
    if (total <= 0) return null;
    const discord = Math.round((counts.discord / total) * 100);
    return { discord, fluxer: 100 - discord };
}

function windowValue(counts: PlatformCounts): string {
    const total = counts.discord + counts.fluxer;
    const shares = platformShares(counts);
    const pct = (n: number | undefined) => (n === undefined ? '' : ` (${n}%)`);
    return [
        `Discord: **${fmt(counts.discord)}**${pct(shares?.discord)}`,
        `Fluxer: **${fmt(counts.fluxer)}**${pct(shares?.fluxer)}`,
        `Total: **${fmt(total)}**`,
    ].join('\n');
}

/** The "counting since" line; `<t:...>` renders on both Discord and Fluxer. */
export function buildCountingSince(since: Date | null): string {
    if (!since || isNaN(since.getTime())) return 'Nothing bridged yet.';
    const unix = Math.floor(since.getTime() / 1000);
    return `Counting since <t:${unix}:D>. Only messages bridged after message counting was introduced are included.`;
}

/** Embed fields (one per window, plus the counting-since note). */
export function buildMessageCountFields(
    counts: MessageCounts
): MessageCountField[] {
    return [
        {
            name: 'Last 24 hours',
            value: windowValue(counts.last24h),
            inline: true,
        },
        {
            name: 'Last 7 days',
            value: windowValue(counts.last7d),
            inline: true,
        },
        {
            name: 'Last 30 days',
            value: windowValue(counts.last30d),
            inline: true,
        },
        { name: 'All time', value: windowValue(counts.allTime), inline: true },
        {
            name: 'Counting since',
            value: buildCountingSince(counts.since),
            inline: false,
        },
    ];
}
