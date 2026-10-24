import logger from '../../utils/logging/logger';

/** Command names (after the prefix) that show Claude's line count. */
export const CLAUDE_LINES_COMMAND_NAMES = ['lines'] as const;
/** How long fetched stats are reused. */
export const CLAUDE_LINES_CACHE_MS = 10 * 60_000;
/** Safety cap on history pages (100 commits each). */
export const CLAUDE_LINES_MAX_PAGES = 50;

const HISTORY_QUERY = `query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef {
      target {
        ... on Commit {
          history(first: 100, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes { oid messageHeadline message additions deletions committedDate url }
          }
        }
      }
    }
  }
}`;

/** True when a commit message has a `Co-Authored-By: Claude ...` trailer. */
export function isClaudeCommit(message: string): boolean {
    return /^co-authored-by:[ \t]*claude\b/im.test(message);
}

export interface ClaudeLinesCommit {
    /** Full commit oid. */
    sha: string;
    headline: string;
    url: string;
    additions: number;
    deletions: number;
    /** ISO commit date. */
    committedAt: string;
}

export interface ClaudeLinesStats {
    /** "owner/name" */
    repo: string;
    /** Claude commits. */
    commits: number;
    /** Lines added / deleted in Claude commits. */
    additions: number;
    deletions: number;
    /** All commits scanned on the default branch. */
    totalCommits: number;
    /** Lines added by all commits scanned. */
    totalAdditions: number;
    /** Date of the oldest Claude commit. */
    firstCommitAt: string | null;
    /** Newest Claude commit. */
    latest: ClaudeLinesCommit | null;
    /** Claude commit with the most additions. */
    biggest: ClaudeLinesCommit | null;
    /** True when the page cap was hit before the end of history. */
    truncated: boolean;
    /** `now()` at fetch time. */
    fetchedAt: number;
}

export type ClaudeLinesFailure = 'not_configured' | 'github_error';

export type ClaudeLinesResult =
    | { ok: true; stats: ClaudeLinesStats }
    | {
          ok: false;
          reason: ClaudeLinesFailure;
          /** Short status/message, for `github_error`. */
          detail?: string;
      };

export interface ClaudeLinesServiceOptions {
    token: string;
    /** "owner/name" */
    repo: string;
    fetchImpl?: typeof fetch;
    now?: () => number;
    cacheMs?: number;
    maxPages?: number;
}

interface HistoryNode {
    oid: string;
    messageHeadline: string;
    message: string;
    additions: number;
    deletions: number;
    committedDate: string;
    url: string;
}

interface GraphQLResponse {
    errors?: { message?: string }[];
    data?: {
        repository?: {
            defaultBranchRef?: {
                target?: {
                    history?: {
                        pageInfo?: {
                            hasNextPage?: boolean;
                            endCursor?: string | null;
                        };
                        nodes?: HistoryNode[];
                    };
                };
            } | null;
        } | null;
    };
}

/** Thrown for expected GitHub failures; the message is the short detail. */
class GitHubLinesError extends Error {}

/** Counts lines of code in commits co-authored by Claude via the GitHub API. */
export default class ClaudeLinesService {
    private readonly token: string;
    private readonly repo: string;
    private readonly fetchImpl: typeof fetch;
    private readonly now: () => number;
    private readonly cacheMs: number;
    private readonly maxPages: number;
    private cached: ClaudeLinesStats | null = null;
    private inFlight: Promise<ClaudeLinesResult> | null = null;

    constructor(options: ClaudeLinesServiceOptions) {
        this.token = options.token;
        this.repo = options.repo;
        this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
        this.now = options.now ?? Date.now;
        this.cacheMs = options.cacheMs ?? CLAUDE_LINES_CACHE_MS;
        this.maxPages = options.maxPages ?? CLAUDE_LINES_MAX_PAGES;
    }

    isConfigured(): boolean {
        return this.token.length > 0;
    }

    async getStats(): Promise<ClaudeLinesResult> {
        if (!this.isConfigured())
            return { ok: false, reason: 'not_configured' };
        if (this.cached && this.now() - this.cached.fetchedAt < this.cacheMs) {
            return { ok: true, stats: this.cached };
        }
        if (this.inFlight) return this.inFlight;

        const promise = this.fetchStats().finally(() => {
            this.inFlight = null;
        });
        this.inFlight = promise;
        return promise;
    }

    private async fetchStats(): Promise<ClaudeLinesResult> {
        try {
            const stats = await this.scanHistory();
            this.cached = stats;
            return { ok: true, stats };
        } catch (error) {
            const message = this.redact(
                error instanceof Error ? error.message : 'unknown error'
            );
            logger.error(`❌ Failed to fetch Claude line stats: ${message}`);
            return { ok: false, reason: 'github_error', detail: message };
        }
    }

    private async scanHistory(): Promise<ClaudeLinesStats> {
        const [owner, name] = this.repo.split('/');
        const stats: ClaudeLinesStats = {
            repo: this.repo,
            commits: 0,
            additions: 0,
            deletions: 0,
            totalCommits: 0,
            totalAdditions: 0,
            firstCommitAt: null,
            latest: null,
            biggest: null,
            truncated: false,
            fetchedAt: this.now(),
        };

        let cursor: string | null = null;
        for (let page = 1; ; page++) {
            const history = await this.fetchPage(owner, name, cursor);
            for (const node of history.nodes ?? []) {
                stats.totalCommits++;
                stats.totalAdditions += node.additions;
                if (!isClaudeCommit(node.message)) continue;
                const commit: ClaudeLinesCommit = {
                    sha: node.oid,
                    headline: node.messageHeadline,
                    url: node.url,
                    additions: node.additions,
                    deletions: node.deletions,
                    committedAt: node.committedDate,
                };
                stats.commits++;
                stats.additions += commit.additions;
                stats.deletions += commit.deletions;
                if (
                    !stats.latest ||
                    Date.parse(commit.committedAt) >
                        Date.parse(stats.latest.committedAt)
                ) {
                    stats.latest = commit;
                }
                if (
                    !stats.firstCommitAt ||
                    Date.parse(commit.committedAt) <
                        Date.parse(stats.firstCommitAt)
                ) {
                    stats.firstCommitAt = commit.committedAt;
                }
                if (
                    !stats.biggest ||
                    commit.additions > stats.biggest.additions
                ) {
                    stats.biggest = commit;
                }
            }

            const pageInfo = history.pageInfo;
            if (!pageInfo?.hasNextPage || !pageInfo.endCursor) break;
            if (page >= this.maxPages) {
                stats.truncated = true;
                break;
            }
            cursor = pageInfo.endCursor;
        }
        return stats;
    }

    private async fetchPage(
        owner: string,
        name: string,
        cursor: string | null
    ) {
        const response = await this.fetchImpl(
            'https://api.github.com/graphql',
            {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${this.token}`,
                    'Content-Type': 'application/json',
                    'User-Agent': 'bifrost-bot',
                },
                body: JSON.stringify({
                    query: HISTORY_QUERY,
                    variables: { owner, name, cursor },
                }),
            }
        );
        let data: GraphQLResponse & { message?: string } = {};
        try {
            data = (await response.json()) as typeof data;
        } catch {
            // Non-JSON response; fall back to the status alone.
        }
        if (response.status !== 200) {
            throw new GitHubLinesError(
                [response.status, data.message]
                    .filter((part) => part !== undefined && part !== '')
                    .join(' ')
            );
        }
        if (Array.isArray(data.errors) && data.errors.length > 0) {
            throw new GitHubLinesError(
                data.errors[0]?.message ?? 'GraphQL error'
            );
        }
        const history =
            data.data?.repository?.defaultBranchRef?.target?.history;
        if (!history) {
            throw new GitHubLinesError(
                `No commit history found for ${this.repo}`
            );
        }
        return history;
    }

    private redact(message: string): string {
        return this.token.length > 0
            ? message.split(this.token).join('***')
            : message;
    }
}
