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
                    headers: {
                        Authorization: `Bearer ${this.token}`,
                        Accept: 'application/vnd.github+json',
                        'X-GitHub-Api-Version': '2022-11-28',
                        'Content-Type': 'application/json',
                        'User-Agent': 'bifrost-bot',
                    },
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

    /** Drops expired cooldown entries so the map cannot grow forever. */
    private pruneCooldowns(now: number): void {
        for (const [key, until] of this.cooldowns) {
            if (until <= now) this.cooldowns.delete(key);
        }
    }
}
