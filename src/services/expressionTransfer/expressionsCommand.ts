import { EmbedColors } from '../../utils/embeds';
import {
    ALL_EXPRESSION_KINDS,
    ExpressionKind,
    ExpressionKindReport,
    ExpressionOutcome,
    ExpressionTransferPlan,
    ExpressionTransferReport,
} from './ExpressionTransferService';

/**
 * The platform-independent half of the `expressions` command (issue #17):
 * argument parsing and the wording of the progress notice and the final
 * report. The Discord and Fluxer handlers only adapt their message APIs.
 */

/** The command name and its aliases; one handler is registered under all. */
export const EXPRESSIONS_COMMAND_NAMES = [
    'expressions',
    'emotes',
    'emojis',
] as const;

export type ParsedExpressionsArgs =
    | { ok: true; kinds: readonly ExpressionKind[] }
    | { ok: false };

/**
 * `[emojis | stickers]`: no argument copies both kinds, one argument
 * (case-insensitive) limits the transfer to that kind. Anything else is a
 * usage error.
 */
export function parseExpressionsArgs(args: string[]): ParsedExpressionsArgs {
    if (args.length === 0) return { ok: true, kinds: ALL_EXPRESSION_KINDS };
    if (args.length > 1) return { ok: false };
    const kind = args[0].toLowerCase();
    if (kind === 'emojis' || kind === 'stickers') {
        return { ok: true, kinds: [kind] };
    }
    return { ok: false };
}

/** Longest list rendered in the report; the rest is summarised as "+N more". */
export const MAX_LISTED = 20;

/**
 * Hard cap for the report description. Discord and Fluxer allow 4096
 * characters per embed description and 6000 across a message's embeds; a
 * little headroom keeps the embed valid together with its title and footer.
 */
export const DESCRIPTION_MAX = 4000;

const KIND_NOUNS: Record<ExpressionKind, { one: string; many: string }> = {
    emojis: { one: 'emoji', many: 'emojis' },
    stickers: { one: 'sticker', many: 'stickers' },
};

/** "1 emoji", "3 stickers". */
export function countOf(kind: ExpressionKind, count: number): string {
    const noun = KIND_NOUNS[kind];
    return `${count} ${count === 1 ? noun.one : noun.many}`;
}

/** "emojis", "stickers" or "emojis and stickers", for the requested kinds. */
function kindsLabel(kinds: readonly ExpressionKind[]): string {
    return kinds.map((kind) => KIND_NOUNS[kind].many).join(' and ');
}

/** "3 emojis and 1 sticker"; kinds with a zero count are left out. */
function countsOf(counts: Partial<Record<ExpressionKind, number>>): string {
    const parts = ALL_EXPRESSION_KINDS.filter(
        (kind) => (counts[kind] ?? 0) > 0
    ).map((kind) => countOf(kind, counts[kind] ?? 0));
    return parts.join(' and ');
}

/**
 * The "working on it" notice for a transfer that is about to upload
 * something, or null when there is nothing to upload (the final report
 * follows right away, so a notice would only be noise).
 */
export function describePlan(plan: ExpressionTransferPlan): string | null {
    if (plan.emojis + plan.stickers === 0) return null;
    return `Copying ${countsOf(plan)} to the Fluxer server… this can take a while.`;
}

/** `a`, `b`, `c` +N more */
function list<T>(
    items: T[],
    format: (item: T) => string,
    max = MAX_LISTED
): string {
    const shown = items.slice(0, max).map(format);
    const rest = items.length - shown.length;
    return rest > 0 ? `${shown.join(', ')} +${rest} more` : shown.join(', ');
}

const name = (value: string) => `\`${value}\``;
const nameAndReason = ({ name: value, reason }: ExpressionOutcome) =>
    `\`${value}\` (${reason})`;

/** The outcomes grouped by their reason, in order of first appearance. */
function groupByReason(outcomes: ExpressionOutcome[]): Map<string, string[]> {
    const groups = new Map<string, string[]>();
    for (const { name, reason } of outcomes) {
        const names = groups.get(reason);
        if (names) names.push(name);
        else groups.set(reason, [name]);
    }
    return groups;
}

function kindSection(kind: ExpressionKind, report: ExpressionKindReport) {
    const heading = `**${KIND_NOUNS[kind].many[0].toUpperCase()}${KIND_NOUNS[kind].many.slice(1)}:**`;
    const total =
        report.created.length + report.skipped.length + report.failed.length;
    if (total === 0) {
        return [`${heading} none on the Discord server.`];
    }

    const summary: string[] = [];
    if (report.created.length) summary.push(`${report.created.length} copied`);
    if (report.skipped.length) summary.push(`${report.skipped.length} skipped`);
    if (report.failed.length) summary.push(`${report.failed.length} failed`);
    const lines = [`${heading} ${summary.join(', ')}`];

    if (report.created.length) {
        lines.push(`- Copied: ${list(report.created, name)}`);
    }
    for (const [reason, names] of groupByReason(report.skipped)) {
        lines.push(`- Skipped (${reason}): ${list(names, name)}`);
    }
    if (report.failed.length) {
        lines.push(`- Failed: ${list(report.failed, nameAndReason)}`);
    }
    return lines;
}

export interface FormattedExpressionTransferReport {
    title: string;
    description: string;
    color: number;
}

/**
 * Renders the outcome of a transfer as one embed's worth of text. Green when
 * something was copied and nothing failed, informational when there was
 * nothing to copy, yellow when some items failed and red when everything
 * that was attempted failed. Every name list is capped (`+N more`) and the
 * whole description never exceeds {@link DESCRIPTION_MAX}.
 */
export function formatExpressionTransferReport(
    report: ExpressionTransferReport,
    kinds: readonly ExpressionKind[] = ALL_EXPRESSION_KINDS
): FormattedExpressionTransferReport {
    const requested = ALL_EXPRESSION_KINDS.filter((kind) =>
        kinds.includes(kind)
    );
    const created: Partial<Record<ExpressionKind, number>> = {};
    const failed: Partial<Record<ExpressionKind, number>> = {};
    let createdTotal = 0;
    let skippedTotal = 0;
    let failedTotal = 0;
    for (const kind of requested) {
        created[kind] = report[kind].created.length;
        failed[kind] = report[kind].failed.length;
        createdTotal += report[kind].created.length;
        skippedTotal += report[kind].skipped.length;
        failedTotal += report[kind].failed.length;
    }

    let summary: string;
    let color: number;
    if (failedTotal > 0) {
        summary = createdTotal
            ? `Copied ${countsOf(created)} to the Fluxer server; ${countsOf(failed)} failed.`
            : `Could not copy ${countsOf(failed)} to the Fluxer server.`;
        color = createdTotal ? EmbedColors.Warning : EmbedColors.Error;
    } else if (createdTotal > 0) {
        summary = `Copied ${countsOf(created)} to the Fluxer server.`;
        color = EmbedColors.Success;
    } else if (skippedTotal > 0) {
        summary = `Nothing to copy: every ${requested.map((kind) => KIND_NOUNS[kind].one).join(' and ')} of the Discord server was skipped.`;
        color = EmbedColors.Info;
    } else {
        summary = `Nothing to copy: the Discord server has no custom ${kindsLabel(requested)}.`;
        color = EmbedColors.Info;
    }

    const lines = [summary];
    for (const kind of requested) {
        lines.push('', ...kindSection(kind, report[kind]));
    }

    let description = lines.join('\n');
    if (description.length > DESCRIPTION_MAX) {
        description = `${description.slice(0, DESCRIPTION_MAX - 1)}…`;
    }

    const title =
        requested.length === 1
            ? `${requested[0] === 'emojis' ? 'Emoji' : 'Sticker'} transfer`
            : 'Emoji & sticker transfer';

    return { title, description, color };
}
