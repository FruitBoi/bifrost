import logger from '../../utils/logging/logger';

/** Command names (after the prefix) that submit a Claude request. */
export const CLAUDE_REQUEST_COMMAND_NAMES = ['clauderequest'] as const;
/** Maximum characters of request text accepted. */
export const MAX_CLAUDE_REQUEST_LENGTH = 4000;
/** Per-user cooldown, started only after a successful submit. */
export const CLAUDE_REQUEST_COOLDOWN_MS = 60_000;
/** Maximum characters of the GitHub issue title. */
export const MAX_CLAUDE_REQUEST_TITLE_LENGTH = 80;

export interface ClaudeRequestInput {
    /** Raw request text, whitespace/newlines preserved. */
    text: string;
    platform: 'discord' | 'fluxer';
    authorId: string;
    /** Username of the author. */
    authorName: string;
    guildName?: string | null;
    channelName?: string | null;
    /** Jump link to the invoking message when known. */
    messageUrl?: string | null;
}

export type ClaudeRequestFailure =
    | 'not_configured'
    | 'empty'
    | 'too_long'
    | 'cooldown'
    | 'github_error';

export type ClaudeRequestResult =
    | { ok: true; number: number; url: string; title: string }
    | {
          ok: false;
          reason: ClaudeRequestFailure;
          /** Remaining cooldown, for `cooldown`. */
          retryAfterMs?: number;
          /** Short status/message, for `github_error`. */
          detail?: string;
      };

/**
 * A reply to a "Claude request implemented/closed" notice (issue #35), to be
 * commented on the GitHub issue before it is reopened.
 */
export interface ClaudeRequestReplyInput {
    issueNumber: number;
    /** Raw reply text, whitespace/newlines preserved. */
    text: string;
    platform: 'discord' | 'fluxer';
    authorId: string;
    /** Username of the author. */
    authorName: string;
    guildName?: string | null;
    channelName?: string | null;
    /** Jump link to the reply message when known. */
    messageUrl?: string | null;
}

export type ClaudeRequestReplyResult =
    | {
          ok: true;
          number: number;
          url: string;
          /** Issue title as GitHub reports it, or '' when unknown. */
          title: string;
          /**
           * Whether the issue is open again. False means the comment was
           * posted but reopening failed; `detail` then says why.
           */
          reopened: boolean;
          detail?: string;
      }
    | {
          ok: false;
          reason: ClaudeRequestFailure;
          /** Remaining cooldown, for `cooldown`. */
          retryAfterMs?: number;
          /** Short status/message, for `github_error`. */
          detail?: string;
      };

export interface ClaudeRequestServiceOptions {
    token: string;
    repo: string;
    label: string;
    fetchImpl?: typeof fetch;
    now?: () => number;
    cooldownMs?: number;
}

/**
 * Inserts a zero-width space after any `@` that would start a GitHub mention,
 * so user-supplied text cannot ping people from the issue.
 */
export function neutralizeGitHubMentions(text: string): string {
    return text.replace(/(^|[^\w])@(?=[A-Za-z0-9])/g, '$1@​');
}

/**
 * Strips `prefix` + a Claude request command name from the start of `content`,
 * returning the rest (trimmed at both ends, inner whitespace kept), or null if
 * `content` is not such an invocation.
 */
export function stripClaudeRequestInvocation(
    content: string,
    prefix: string
): string | null {
    if (!content.startsWith(prefix)) return null;
    const afterPrefix = content.slice(prefix.length);
    for (const name of CLAUDE_REQUEST_COMMAND_NAMES) {
        if (afterPrefix.slice(0, name.length).toLowerCase() !== name) continue;
        const rest = afterPrefix.slice(name.length);
        if (rest === '' || /^\s/.test(rest)) return rest.trim();
    }
    return null;
}

/** Builds the issue title and body (following the Claude request template). */
export function buildClaudeRequestIssue(input: ClaudeRequestInput): {
    title: string;
    body: string;
} {
    const text = input.text.trim();
    const firstLine =
        text
            .split(/\r?\n/)
            .map((line) => line.replace(/\s+/g, ' ').trim())
            .find((line) => line.length > 0) ?? '';
    const rawTitle =
        firstLine.length > MAX_CLAUDE_REQUEST_TITLE_LENGTH
            ? `${firstLine.slice(0, MAX_CLAUDE_REQUEST_TITLE_LENGTH - 1).trimEnd()}…`
            : firstLine;
    const title = neutralizeGitHubMentions(rawTitle);

    const platformName = input.platform === 'discord' ? 'Discord' : 'Fluxer';
    let context = `Submitted from ${platformName} by ${input.authorName} (\`${input.authorId}\`)`;
    if (input.guildName && input.channelName) {
        context += `, in ${input.guildName} #${input.channelName}`;
    } else if (input.guildName) {
        context += `, in ${input.guildName}`;
    } else if (input.channelName) {
        context += `, in #${input.channelName}`;
    }
    if (input.messageUrl) context += ` ([message](${input.messageUrl}))`;
    context += ' via the `clauderequest` command.';

    const body =
        `**Tell claude what you want**\n${neutralizeGitHubMentions(text)}\n\n` +
        `**Additional context**\n${neutralizeGitHubMentions(context)}\n`;
    return { title, body };
}

/**
 * Builds the GitHub comment for a reply to a notice (issue #35). The first
 * line is always the bot's attribution header, never user text: the repo's
 * swarm watcher acts on comments whose first line is `/swarm`.
 */
export function buildClaudeRequestReplyComment(
    input: ClaudeRequestReplyInput
): string {
    const oneLine = (value: string) => value.replace(/\s+/g, ' ').trim();
    const platformName = input.platform === 'discord' ? 'Discord' : 'Fluxer';
    let header = `**Reply from ${platformName} by ${oneLine(input.authorName)} (\`${oneLine(input.authorId)}\`)**`;
    const guildName = input.guildName ? oneLine(input.guildName) : '';
    const channelName = input.channelName ? oneLine(input.channelName) : '';
    if (guildName && channelName) {
        header += ` in ${guildName} #${channelName}`;
    } else if (guildName) {
        header += ` in ${guildName}`;
    } else if (channelName) {
        header += ` in #${channelName}`;
    }
    if (input.messageUrl)
        header += ` ([message](${oneLine(input.messageUrl)}))`;
    return `${neutralizeGitHubMentions(header)}\n\n${neutralizeGitHubMentions(input.text.trim())}\n`;
}

/**
 * The embed text and colour kind answering a reply to a notice (issue #35),
 * or null for `empty` (the reply handlers never send empty text).
 */
export function describeClaudeRequestReplyResult(
    result: ClaudeRequestReplyResult
): { kind: 'success' | 'warning' | 'error'; description: string } | null {
    if (result.ok) {
        const link = `[#${result.number}](${result.url})`;
        return result.reopened
            ? {
                  kind: 'success',
                  description: `Posted your reply on ${link} and reopened it. I'll let you know here when it's done.`,
              }
            : {
                  kind: 'warning',
                  description: `Posted your reply on ${link}, but could not reopen it: ${result.detail ?? 'unknown error'}`,
              };
    }
    switch (result.reason) {
        case 'not_configured':
            return {
                kind: 'error',
                description:
                    'Claude requests are not configured on this bot (BF_GITHUB_TOKEN is not set).',
            };
        case 'too_long':
            return {
                kind: 'error',
                description: `Replies can be at most ${MAX_CLAUDE_REQUEST_LENGTH} characters.`,
            };
        case 'cooldown':
            return {
                kind: 'error',
                description: `Please wait ${Math.max(1, Math.ceil((result.retryAfterMs ?? 0) / 1000))} seconds before sending another reply.`,
            };
        case 'github_error':
            return {
                kind: 'error',
                description: `Could not post your reply on GitHub: ${result.detail ?? 'unknown error'}`,
            };
        case 'empty':
            return null;
    }
}

/** Submits Claude requests as labelled GitHub issues, with a per-user cooldown. */
export default class ClaudeRequestService {
    private readonly token: string;
    private readonly repo: string;
    private readonly label: string;
    private readonly fetchImpl: typeof fetch;
    private readonly now: () => number;
    private readonly cooldownMs: number;
    /** `${platform}:${authorId}` -> time the cooldown ends. */
    private readonly cooldowns = new Map<string, number>();

    constructor(options: ClaudeRequestServiceOptions) {
        this.token = options.token;
        this.repo = options.repo;
        this.label = options.label;
        this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
        this.now = options.now ?? Date.now;
        this.cooldownMs = options.cooldownMs ?? CLAUDE_REQUEST_COOLDOWN_MS;
    }

    isConfigured(): boolean {
        return this.token.length > 0;
    }

    async submit(input: ClaudeRequestInput): Promise<ClaudeRequestResult> {
        if (!this.isConfigured())
            return { ok: false, reason: 'not_configured' };
        if (input.text.trim().length === 0)
            return { ok: false, reason: 'empty' };
        if (input.text.trim().length > MAX_CLAUDE_REQUEST_LENGTH) {
            return { ok: false, reason: 'too_long' };
        }

        const key = `${input.platform}:${input.authorId}`;
        const now = this.now();
        this.pruneCooldowns(now);
        const until = this.cooldowns.get(key);
        if (until !== undefined && until > now) {
            return { ok: false, reason: 'cooldown', retryAfterMs: until - now };
        }

        // Reserve the cooldown before the request so two quick invocations
        // cannot both get through; a failed submit releases it again.
        this.cooldowns.set(key, now + this.cooldownMs);
        const { title, body } = buildClaudeRequestIssue(input);
        try {
            const response = await this.fetchImpl(
                `https://api.github.com/repos/${this.repo}/issues`,
                {
                    method: 'POST',
                    headers: this.headers(),
                    body: JSON.stringify({ title, body, labels: [this.label] }),
                }
            );
            let data: { number?: number; html_url?: string; message?: string } =
                {};
            try {
                data = (await response.json()) as typeof data;
            } catch {
                // Non-JSON response; fall back to the status alone.
            }
            if (
                response.status === 201 &&
                typeof data.number === 'number' &&
                typeof data.html_url === 'string'
            ) {
                this.cooldowns.set(key, this.now() + this.cooldownMs);
                return {
                    ok: true,
                    number: data.number,
                    url: data.html_url,
                    title,
                };
            }
            this.cooldowns.delete(key);
            const detail = [response.status, data.message]
                .filter((part) => part !== undefined && part !== '')
                .join(' ');
            logger.error(`❌ GitHub rejected Claude request: ${detail}`);
            return { ok: false, reason: 'github_error', detail };
        } catch (error) {
            this.cooldowns.delete(key);
            const message = (
                error instanceof Error ? error.message : 'unknown error'
            )
                .split(this.token)
                .join('***');
            logger.error(`❌ Failed to submit Claude request: ${message}`);
            return { ok: false, reason: 'github_error', detail: message };
        }
    }

    /**
     * Comments a reply to a "Claude request implemented/closed" notice on its
     * issue and reopens it (issue #35). Shares the per-user cooldown with
     * {@link submit}. The issue is always PATCHed to open without checking
     * its state first: GitHub accepts reopening an open issue, and the
     * notice only exists because the issue was closed. A failed reopen after
     * a posted comment is still `ok` (with `reopened: false`), since the
     * reply did reach GitHub and keeps the cooldown.
     */
    async reopenWithReply(
        input: ClaudeRequestReplyInput
    ): Promise<ClaudeRequestReplyResult> {
        if (!this.isConfigured())
            return { ok: false, reason: 'not_configured' };
        if (input.text.trim().length === 0)
            return { ok: false, reason: 'empty' };
        if (input.text.trim().length > MAX_CLAUDE_REQUEST_LENGTH) {
            return { ok: false, reason: 'too_long' };
        }

        const key = `${input.platform}:${input.authorId}`;
        const now = this.now();
        this.pruneCooldowns(now);
        const until = this.cooldowns.get(key);
        if (until !== undefined && until > now) {
            return { ok: false, reason: 'cooldown', retryAfterMs: until - now };
        }

        this.cooldowns.set(key, now + this.cooldownMs);
        const issueApiUrl = `https://api.github.com/repos/${this.repo}/issues/${input.issueNumber}`;
        try {
            const commentResponse = await this.fetchImpl(
                `${issueApiUrl}/comments`,
                {
                    method: 'POST',
                    headers: this.headers(),
                    body: JSON.stringify({
                        body: buildClaudeRequestReplyComment(input),
                    }),
                }
            );
            const comment = await readJson<{ message?: string }>(
                commentResponse
            );
            if (commentResponse.status !== 201) {
                this.cooldowns.delete(key);
                const detail = describeFailure(
                    commentResponse.status,
                    comment.message
                );
                logger.error(
                    `❌ GitHub rejected the reply to Claude request #${input.issueNumber}: ${detail}`
                );
                return { ok: false, reason: 'github_error', detail };
            }
        } catch (error) {
            this.cooldowns.delete(key);
            const message = this.scrub(error);
            logger.error(
                `❌ Failed to post the reply to Claude request #${input.issueNumber}: ${message}`
            );
            return { ok: false, reason: 'github_error', detail: message };
        }
        this.cooldowns.set(key, this.now() + this.cooldownMs);

        const fallbackUrl = `https://github.com/${this.repo}/issues/${input.issueNumber}`;
        try {
            const response = await this.fetchImpl(issueApiUrl, {
                method: 'PATCH',
                headers: this.headers(),
                body: JSON.stringify({
                    state: 'open',
                    state_reason: 'reopened',
                }),
            });
            const data = await readJson<{
                html_url?: string;
                title?: string;
                state?: string;
                message?: string;
            }>(response);
            const url =
                typeof data.html_url === 'string' ? data.html_url : fallbackUrl;
            const title = typeof data.title === 'string' ? data.title : '';
            if (response.status === 200 && data.state === 'open') {
                return {
                    ok: true,
                    number: input.issueNumber,
                    url,
                    title,
                    reopened: true,
                };
            }
            const detail = describeFailure(response.status, data.message);
            logger.error(
                `❌ GitHub refused to reopen Claude request #${input.issueNumber}: ${detail}`
            );
            return {
                ok: true,
                number: input.issueNumber,
                url,
                title,
                reopened: false,
                detail,
            };
        } catch (error) {
            const message = this.scrub(error);
            logger.error(
                `❌ Failed to reopen Claude request #${input.issueNumber}: ${message}`
            );
            return {
                ok: true,
                number: input.issueNumber,
                url: fallbackUrl,
                title: '',
                reopened: false,
                detail: message,
            };
        }
    }

    private headers(): Record<string, string> {
        return {
            Authorization: `Bearer ${this.token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'Content-Type': 'application/json',
            'User-Agent': 'bifrost-bot',
        };
    }

    /** An error's message with the token blanked out. */
    private scrub(error: unknown): string {
        return (error instanceof Error ? error.message : 'unknown error')
            .split(this.token)
            .join('***');
    }

    /** Drops expired cooldown entries so the map cannot grow forever. */
    private pruneCooldowns(now: number): void {
        for (const [key, until] of this.cooldowns) {
            if (until <= now) this.cooldowns.delete(key);
        }
    }
}

/** The parsed JSON body of `response`, or `{}` when it is not JSON. */
async function readJson<T extends object>(response: Response): Promise<T> {
    try {
        return ((await response.json()) ?? {}) as T;
    } catch {
        return {} as T;
    }
}

/** `"<status> <message>"`, omitting a missing message. */
function describeFailure(status: number, message?: string): string {
    return [status, message]
        .filter((part) => part !== undefined && part !== '')
        .join(' ');
}
