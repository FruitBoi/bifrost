import type {
    ClaudeLinesCommit,
    ClaudeLinesStats,
} from '../services/claudeLines/ClaudeLinesService';

export interface ClaudeLinesSummaryField {
    name: string;
    value: string;
    inline: boolean;
}

export interface ClaudeLinesSummary {
    title: string;
    description: string;
    fields: ClaudeLinesSummaryField[];
}

const HEADLINE_MAX = 80;

const fmt = (n: number) => n.toLocaleString('en-US');
const signed = (n: number) => (n < 0 ? `-${fmt(-n)}` : `+${fmt(n)}`);

function unix(iso: string): number | null {
    const ms = Date.parse(iso);
    return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

function truncate(text: string, max: number): string {
    const clean = text.replace(/\s+/g, ' ').trim();
    return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

function commitLine(commit: ClaudeLinesCommit, withTime: boolean): string {
    const headline = truncate(commit.headline, HEADLINE_MAX)
        // Keep link text from breaking markdown.
        .replace(/[[\]]/g, '');
    let line = `[\`${commit.sha.slice(0, 7)}\`](${commit.url}) +${fmt(commit.additions)}: ${headline}`;
    if (withTime) {
        const ts = unix(commit.committedAt);
        if (ts !== null) line += ` (<t:${ts}:R>)`;
    }
    return line;
}

export function buildClaudeLinesSummary(
    stats: ClaudeLinesStats
): ClaudeLinesSummary {
    const title = '🤖 Lines of code written by Claude';
    const repoLink = `[${stats.repo}](https://github.com/${stats.repo})`;

    if (stats.commits === 0) {
        return {
            title,
            description: `Claude has not written any lines in ${repoLink} yet. Give it time.`,
            fields: [],
        };
    }

    let description = `Claude has written **${fmt(stats.additions)}** lines of code in ${repoLink} across **${fmt(stats.commits)}** commits.`;
    if (stats.truncated) {
        description += ' (only the most recent commits were counted)';
    }

    const share =
        stats.totalAdditions > 0
            ? (stats.additions / stats.totalAdditions) * 100
            : 0;

    const fields: ClaudeLinesSummaryField[] = [
        { name: 'Added', value: `+${fmt(stats.additions)}`, inline: true },
        { name: 'Deleted', value: `-${fmt(stats.deletions)}`, inline: true },
        {
            name: 'Net',
            value: signed(stats.additions - stats.deletions),
            inline: true,
        },
        {
            name: 'Share of all lines added',
            value: `${share.toFixed(1)}%`,
            inline: true,
        },
    ];
    if (stats.biggest) {
        fields.push({
            name: 'Biggest commit',
            value: commitLine(stats.biggest, false),
            inline: false,
        });
    }
    if (stats.latest) {
        fields.push({
            name: 'Latest commit',
            value: commitLine(stats.latest, true),
            inline: false,
        });
    }
    const since = stats.firstCommitAt ? unix(stats.firstCommitAt) : null;
    if (since !== null) {
        fields.push({ name: 'Since', value: `<t:${since}:D>`, inline: true });
    }
    return { title, description, fields };
}
