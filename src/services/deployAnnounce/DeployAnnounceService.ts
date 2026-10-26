/**
 * Deploy announcement (issue #47): when the bot starts with a new commit
 * (`GIT_COMMIT`), it posts one message summarising what was deployed: the
 * commits since the previously announced deploy and the Claude requests
 * (issues carrying the configured label) those commits reference.
 *
 * The last announced commit is stored in the bot state table, so a plain
 * restart of the same image posts nothing. The commits come from the GitHub
 * compare API (`<previous>...<commit>`); with no previous commit, an unknown
 * or force-pushed one, or a rollback, only the deployed commit is shown. If
 * GitHub cannot be reached at all, a minimal message naming the short sha is
 * still posted: the deploy happened either way.
 *
 * The message always begins with "Claude wins again", is full of emojis, and
 * stays within the 2000-character message limit. Nothing is ever thrown:
 * failures are logged, and a failed send leaves the stored commit unchanged
 * so the next start tries again.
 */
import type { BotStateRepository } from '../../db/repositories/BotStateRepository';
import logger from '../../utils/logging/logger';

/** Bot state key holding the last commit that was announced. */
export const DEPLOY_ANNOUNCE_STATE_KEY = 'deployAnnounce.lastCommit';
/** Message content limit on Discord and Fluxer. */
export const DEPLOY_MESSAGE_MAX_LENGTH = 2000;
/** Most issues looked up per deploy. */
export const DEPLOY_MAX_ISSUE_LOOKUPS = 10;
/** Timeout of each GitHub request. */
export const DEPLOY_GITHUB_TIMEOUT_MS = 10_000;

/** Longest commit headline / issue title shown, in characters. */
const MAX_TITLE_LENGTH = 120;
const SHORT_SHA_LENGTH = 7;

const HEADER = 'Claude wins again 🏆🎉🤖✨🚀🔥🥳🙌';
const COMMIT_EMOJIS = [
    '✨',
    '🚀',
    '🐛',
    '🔧',
    '🧵',
    '🎨',
    '⚡',
    '🛠️',
    '📦',
    '🧹',
    '💎',
    '🌈',
    '🦄',
    '🎯',
    '🧪',
    '🔥',
];
const ISSUE_EMOJIS = ['✅', '🎯', '🏁', '💪', '🙌', '🫡'];
const FOOTER =
    '🥳🎊🙌💪🔥🌈🦄🎯🫡🏁🎈🍾🥂🎁⭐🌟💫🎆🎇🪅🤖🏆🎉✨🚀💯🙏❤️🍕🌮🎸🕺💃🦾🧠';

/** A deployed commit, as far as the message needs it. */
export interface DeployCommit {
    /** Full sha. */
    sha: string;
    /** Full commit message. */
    message: string;
}

/** A Claude request fixed by the deploy. */
export interface DeployIssue {
    number: number;
    title: string;
}

export interface DeployMessageInput {
    /** "owner/name" */
    repo: string;
    /** Deployed commit (full or short sha). */
    commit: string;
    /** Previously announced commit, when the commits are a compare range. */
    previous?: string | null;
    /** Deployed commits, newest first; `null` when GitHub was unreachable. */
    commits: DeployCommit[] | null;
    /** Total commits in the range when GitHub listed fewer than all of them. */
    totalCommits?: number;
    /** Claude requests referenced by the commits. */
    issues: DeployIssue[];
}

export interface DeployAnnounceOptions {
    /** "owner/name" */
    repo: string;
    /** Optional GitHub token (public repos work unauthenticated). */
    token?: string | null;
    /** Commit being deployed (GIT_COMMIT); empty/undefined => never announce. */
    commit?: string | null;
    /** Label marking Claude-request issues, e.g. "claude". */
    label: string;
    state: BotStateRepository;
    fetchImpl?: typeof fetch;
}

interface GitHubCommit {
    sha?: string;
    commit?: { message?: string };
}

interface GitHubCompare {
    status?: string;
    total_commits?: number;
    commits?: GitHubCommit[];
}

interface GitHubIssue {
    number?: number;
    title?: string;
    pull_request?: unknown;
    labels?: (string | { name?: string })[];
}

/** First `length` characters of a sha. */
export function shortSha(sha: string): string {
    return sha.slice(0, SHORT_SHA_LENGTH);
}

/** Breaks `@` mentions (`@everyone`, `<@id>`) with a zero-width space. */
export function neutraliseMentions(text: string): string {
    return text.replace(/@/g, '@​');
}

/** Cuts `text` to `max` characters (code points), ending in an ellipsis. */
function truncate(text: string, max: number): string {
    const chars = Array.from(text);
    if (chars.length <= max) return text;
    return `${chars
        .slice(0, max - 1)
        .join('')
        .trimEnd()}…`;
}

/** First line of a commit message, made safe to post. */
function headline(message: string): string {
    const first = message.split(/\r?\n/, 1)[0]?.trim() ?? '';
    return neutraliseMentions(
        truncate(first || '(no message)', MAX_TITLE_LENGTH)
    );
}

/**
 * Issue numbers referenced in `message` as `#123` or `owner/name#123` (the
 * latter only when it names `repo`), in order of appearance.
 */
export function issueRefs(message: string, repo: string): number[] {
    const refs: number[] = [];
    const pattern = /(?<![\w#/.-])(?:([\w.-]+\/[\w.-]+))?#(\d+)\b/g;
    for (const match of message.matchAll(pattern)) {
        const target = match[1];
        if (target && target.toLowerCase() !== repo.toLowerCase()) continue;
        const number = Number(match[2]);
        if (Number.isSafeInteger(number) && number > 0) refs.push(number);
    }
    return refs;
}

/**
 * Builds the announcement. Commit and issue bullets that do not fit in
 * {@link DEPLOY_MESSAGE_MAX_LENGTH} are replaced by an "…and N more" line,
 * commits first.
 */
export function buildDeployMessage(input: DeployMessageInput): string {
    const repoUrl = `https://github.com/${input.repo}`;
    const commits = input.commits ?? [];
    const total = Math.max(input.totalCommits ?? 0, commits.length);
    const commitBullets = commits.map(
        (commit, i) =>
            `- ${COMMIT_EMOJIS[i % COMMIT_EMOJIS.length]} ${headline(commit.message)} · \`${shortSha(commit.sha)}\``
    );
    const issueBullets = input.issues.map(
        (issue, i) =>
            `- ${ISSUE_EMOJIS[i % ISSUE_EMOJIS.length]} #${issue.number} ${neutraliseMentions(truncate(issue.title.trim(), MAX_TITLE_LENGTH))} · <${repoUrl}/issues/${issue.number}>`
    );

    const render = (commitCount: number, issueCount: number): string => {
        const lines = [HEADER];
        const sha = shortSha(input.commit);
        lines.push(`🚢 **Deployed** \`${sha}\` to the Bifröst 🌈⚡`);
        if (input.commits === null) {
            lines.push(
                "🛰️ Couldn't reach GitHub for the details, but the deploy went out anyway 🤷✨"
            );
        } else if (input.previous) {
            lines.push(
                `🔗 <${repoUrl}/compare/${shortSha(input.previous)}...${sha}>`
            );
        } else {
            lines.push(`🔗 <${repoUrl}/commit/${input.commit}>`);
        }

        if (commitBullets.length > 0) {
            lines.push('', `📜 **Commits shipped (${total})** 🧑‍💻`);
            lines.push(...commitBullets.slice(0, commitCount));
            if (total > commitCount) {
                lines.push(`- 📚 …and ${total - commitCount} more`);
            }
        }
        if (issueBullets.length > 0) {
            lines.push(
                '',
                `🐛 **Claude requests fixed (${issueBullets.length})** 🎯`
            );
            lines.push(...issueBullets.slice(0, issueCount));
            if (issueBullets.length > issueCount) {
                lines.push(
                    `- 🗂️ …and ${issueBullets.length - issueCount} more`
                );
            }
        }
        lines.push('', FOOTER);
        return lines.join('\n');
    };

    let commitCount = commitBullets.length;
    let issueCount = issueBullets.length;
    let message = render(commitCount, issueCount);
    while (message.length > DEPLOY_MESSAGE_MAX_LENGTH) {
        if (commitCount > 0) commitCount--;
        else if (issueCount > 0) issueCount--;
        else break;
        message = render(commitCount, issueCount);
    }
    // Only reachable with an absurd repo name; never exceed the limit.
    return message.length > DEPLOY_MESSAGE_MAX_LENGTH
        ? truncate(message, DEPLOY_MESSAGE_MAX_LENGTH)
        : message;
}

/** Thrown for a non-2xx GitHub response; carries the status. */
class GitHubStatusError extends Error {
    constructor(readonly status: number) {
        super(`GitHub answered ${status}`);
    }
}

/** Posts a summary of each new deploy once (issue #47). */
export default class DeployAnnounceService {
    private readonly repo: string;
    private readonly token: string;
    private readonly commit: string;
    private readonly label: string;
    private readonly state: BotStateRepository;
    private readonly fetchImpl: typeof fetch;
    private started = false;

    constructor(options: DeployAnnounceOptions) {
        this.repo = options.repo;
        this.token = options.token?.trim() ?? '';
        this.commit = options.commit?.trim() ?? '';
        this.label = options.label.trim().toLowerCase();
        this.state = options.state;
        this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    }

    /**
     * Announces the deploy at most once per process; later calls (also while
     * the first is in flight) resolve immediately. `send` posts the message
     * text and is called at most once. Never throws.
     */
    async announce(send: (content: string) => Promise<void>): Promise<void> {
        if (this.started) return;
        this.started = true;
        try {
            await this.run(send);
        } catch (error) {
            logger.error(
                `❌ Deploy announcement failed: ${this.describe(error)}`
            );
        }
    }

    private async run(send: (content: string) => Promise<void>) {
        const commit = this.commit;
        if (!commit) {
            logger.debug('No GIT_COMMIT set; skipping the deploy announcement');
            return;
        }

        let previous: string | null;
        try {
            previous =
                (await this.state.get(DEPLOY_ANNOUNCE_STATE_KEY))?.trim() ||
                null;
        } catch (error) {
            // Without the stored commit a plain restart would look like a
            // deploy; skip rather than risk a duplicate announcement.
            logger.error(
                `❌ Could not read the last announced deploy: ${this.describe(error)}`
            );
            return;
        }
        if (previous && previous.toLowerCase() === commit.toLowerCase()) {
            logger.debug(
                `Commit ${shortSha(commit)} was already announced; skipping`
            );
            return;
        }

        const range = await this.collectCommits(previous, commit);
        const issues = range.commits
            ? await this.collectIssues(range.commits)
            : [];
        const content = buildDeployMessage({
            repo: this.repo,
            commit,
            previous: range.compared ? previous : null,
            commits: range.commits,
            totalCommits: range.total,
            issues,
        });

        try {
            await send(content);
        } catch (error) {
            logger.error(
                `❌ Failed to send the deploy announcement for ${shortSha(commit)}: ${this.describe(error)}`
            );
            return;
        }
        logger.info(
            `📣 Announced deploy ${shortSha(commit)} (${range.commits?.length ?? 0} commit(s), ${issues.length} Claude request(s))`
        );
        try {
            await this.state.set(DEPLOY_ANNOUNCE_STATE_KEY, commit);
        } catch (error) {
            logger.error(
                `❌ Could not store the announced deploy: ${this.describe(error)}`
            );
        }
    }

    /**
     * Commits deployed since `previous`, newest first. Falls back to just
     * `commit` when there is no usable range, and to `null` when GitHub
     * cannot be reached.
     */
    private async collectCommits(
        previous: string | null,
        commit: string
    ): Promise<{
        commits: DeployCommit[] | null;
        total?: number;
        compared: boolean;
    }> {
        if (previous) {
            try {
                const compare = await this.request<GitHubCompare>(
                    `/compare/${encodeURIComponent(previous)}...${encodeURIComponent(commit)}`
                );
                const commits = this.toCommits(compare.commits ?? []);
                if (
                    compare.status !== 'behind' &&
                    compare.status !== 'identical' &&
                    commits.length > 0
                ) {
                    return {
                        commits: commits.reverse(),
                        total: compare.total_commits,
                        compared: true,
                    };
                }
                logger.info(
                    `Deploy ${shortSha(commit)} is ${compare.status ?? 'unrelated'} to ${shortSha(previous)}; announcing it alone`
                );
            } catch (error) {
                logger.warn(
                    `⚠️ Could not compare ${shortSha(previous)}...${shortSha(commit)}: ${this.describe(error)}`
                );
            }
        }

        try {
            const single = await this.request<GitHubCommit>(
                `/commits/${encodeURIComponent(commit)}`
            );
            const commits = this.toCommits([single]);
            if (commits.length > 0) return { commits, compared: false };
            logger.warn(`⚠️ GitHub returned no commit for ${shortSha(commit)}`);
        } catch (error) {
            logger.warn(
                `⚠️ Could not fetch commit ${shortSha(commit)}: ${this.describe(error)}`
            );
        }
        return { commits: null, compared: false };
    }

    private toCommits(raw: GitHubCommit[]): DeployCommit[] {
        return raw.flatMap((c) =>
            typeof c.sha === 'string' && c.sha
                ? [{ sha: c.sha, message: c.commit?.message ?? '' }]
                : []
        );
    }

    /**
     * Claude requests referenced by `commits` (newest commit's references
     * first, at most {@link DEPLOY_MAX_ISSUE_LOOKUPS} looked up), sorted by
     * number. Pull requests, unlabelled issues and failed lookups are skipped.
     */
    private async collectIssues(
        commits: DeployCommit[]
    ): Promise<DeployIssue[]> {
        if (!this.label) return [];
        const numbers = [
            ...new Set(commits.flatMap((c) => issueRefs(c.message, this.repo))),
        ].slice(0, DEPLOY_MAX_ISSUE_LOOKUPS);

        const results = await Promise.all(
            numbers.map(async (number): Promise<DeployIssue | null> => {
                try {
                    const issue = await this.request<GitHubIssue>(
                        `/issues/${number}`
                    );
                    if (issue.pull_request !== undefined) return null;
                    const labelled = (issue.labels ?? []).some(
                        (label) =>
                            (typeof label === 'string'
                                ? label
                                : (label.name ?? '')
                            ).toLowerCase() === this.label
                    );
                    if (!labelled) return null;
                    return { number, title: issue.title ?? '' };
                } catch (error) {
                    logger.warn(
                        `⚠️ Could not look up issue #${number}: ${this.describe(error)}`
                    );
                    return null;
                }
            })
        );
        return results
            .filter((issue): issue is DeployIssue => issue !== null)
            .sort((a, b) => a.number - b.number);
    }

    /** GET `https://api.github.com/repos/<repo><path>` as JSON. */
    private async request<T>(path: string): Promise<T> {
        const headers: Record<string, string> = {
            Accept: 'application/vnd.github+json',
            'User-Agent': 'bifrost-bot',
            'X-GitHub-Api-Version': '2022-11-28',
        };
        if (this.token) headers.Authorization = `Bearer ${this.token}`;
        const response = await this.fetchImpl(
            `https://api.github.com/repos/${this.repo}${path}`,
            {
                headers,
                signal: AbortSignal.timeout(DEPLOY_GITHUB_TIMEOUT_MS),
            }
        );
        if (!response.ok) throw new GitHubStatusError(response.status);
        return (await response.json()) as T;
    }

    private describe(error: unknown): string {
        const message = error instanceof Error ? error.message : String(error);
        return this.token ? message.split(this.token).join('***') : message;
    }
}
