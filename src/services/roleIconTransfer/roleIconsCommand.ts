import { EmbedColors } from '../../utils/embeds';
import {
    DESCRIPTION_MAX,
    MAX_LISTED,
} from '../expressionTransfer/expressionsCommand';
import {
    RoleIconOutcome,
    RoleIconTransferPlan,
    RoleIconTransferReport,
} from './RoleIconTransferService';

/**
 * The platform-independent half of the `roleicons` command (issue #54):
 * argument parsing and the wording of the progress notice and the final
 * report. The Discord and Fluxer handlers only adapt their message APIs.
 */

/** The command name and its aliases; one handler is registered under all. */
export const ROLE_ICONS_COMMAND_NAMES = [
    'roleicons',
    'roleemotes',
    'roleemojis',
] as const;

export type ParsedRoleIconsArgs =
    | { ok: true; overwrite: boolean }
    | { ok: false };

/**
 * `[overwrite]`: no argument leaves Fluxer roles that already have an icon
 * alone, `overwrite` (case-insensitive) replaces their icons. Anything else
 * is a usage error.
 */
export function parseRoleIconsArgs(args: string[]): ParsedRoleIconsArgs {
    if (args.length === 0) return { ok: true, overwrite: false };
    if (args.length === 1 && args[0].toLowerCase() === 'overwrite') {
        return { ok: true, overwrite: true };
    }
    return { ok: false };
}

/** "1 role icon", "3 role icons". */
function iconsOf(count: number): string {
    return `${count} role icon${count === 1 ? '' : 's'}`;
}

/**
 * The "working on it" notice for a transfer that is about to update
 * something, or null when there is nothing to update (the final report
 * follows right away, so a notice would only be noise).
 */
export function describeRoleIconPlan(
    plan: RoleIconTransferPlan
): string | null {
    if (plan.roles === 0) return null;
    return `Setting ${iconsOf(plan.roles)} on the Fluxer server… this can take a while.`;
}

/** `a`, `b`, `c` +N more */
function list<T>(items: T[], format: (item: T) => string): string {
    const shown = items.slice(0, MAX_LISTED).map(format);
    const rest = items.length - shown.length;
    return rest > 0 ? `${shown.join(', ')} +${rest} more` : shown.join(', ');
}

const name = (value: string) => `\`${value}\``;
const nameAndReason = ({ name: value, reason }: RoleIconOutcome) =>
    `\`${value}\` (${reason})`;

/** The outcomes grouped by their reason, in order of first appearance. */
function groupByReason(outcomes: RoleIconOutcome[]): Map<string, string[]> {
    const groups = new Map<string, string[]>();
    for (const { name, reason } of outcomes) {
        const names = groups.get(reason);
        if (names) names.push(name);
        else groups.set(reason, [name]);
    }
    return groups;
}

export interface FormattedRoleIconTransferReport {
    title: string;
    description: string;
    color: number;
}

/**
 * Renders the outcome of a transfer as one embed's worth of text. Green when
 * something was copied and nothing failed, informational when there was
 * nothing to copy, yellow when some roles failed and red when everything
 * that was attempted failed. Every name list is capped (`+N more`) and the
 * whole description never exceeds {@link DESCRIPTION_MAX}.
 */
export function formatRoleIconTransferReport(
    report: RoleIconTransferReport
): FormattedRoleIconTransferReport {
    const copied = report.copied.length;
    const skipped = report.skipped.length;
    const failed = report.failed.length;

    let summary: string;
    let color: number;
    if (failed > 0) {
        summary = copied
            ? `Set ${iconsOf(copied)} on the Fluxer server; ${failed} failed.`
            : `Could not set ${iconsOf(failed)} on the Fluxer server.`;
        color = copied ? EmbedColors.Warning : EmbedColors.Error;
    } else if (copied > 0) {
        summary = `Set ${iconsOf(copied)} on the Fluxer server.`;
        color = EmbedColors.Success;
    } else if (skipped > 0) {
        summary =
            'Nothing to copy: every role icon of the Discord server was skipped.';
        color = EmbedColors.Info;
    } else {
        summary = 'Nothing to copy: no role on the Discord server has an icon.';
        color = EmbedColors.Info;
    }

    const lines = [summary];
    if (copied || skipped || failed) lines.push('');
    if (copied) lines.push(`- Copied: ${list(report.copied, name)}`);
    for (const [reason, names] of groupByReason(report.skipped)) {
        lines.push(`- Skipped (${reason}): ${list(names, name)}`);
    }
    if (failed) lines.push(`- Failed: ${list(report.failed, nameAndReason)}`);

    let description = lines.join('\n');
    if (description.length > DESCRIPTION_MAX) {
        description = `${description.slice(0, DESCRIPTION_MAX - 1)}…`;
    }

    return { title: 'Role icon transfer', description, color };
}
