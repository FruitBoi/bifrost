import { ClaudeRequest } from '../../db/entities/ClaudeRequest';
import { EmbedColors } from '../../utils/embeds';

/** How the request's GitHub issue was closed. */
export type ClaudeRequestOutcome = 'completed' | 'not_planned';

/**
 * Thrown by a {@link ClaudeRequestNotifier} when the requester can never be
 * notified (channel deleted, bot kicked, no permission to post there, ...).
 * The service drops such requests instead of retrying them.
 */
export class ClaudeRequestNotifyError extends Error {
    /** The underlying error, when there is one (tsconfig targets ES6, so `Error.cause` is declared here). */
    readonly cause?: unknown;

    constructor(
        message: string,
        /** True when retrying later cannot help. */
        public readonly permanent: boolean,
        options?: { cause?: unknown }
    ) {
        super(message);
        this.name = 'ClaudeRequestNotifyError';
        this.cause = options?.cause;
    }
}

/**
 * Tells a requester, in the channel they ran `clauderequest` in, that their
 * request's GitHub issue was closed. Implemented once per platform (Discord
 * and Fluxer) and registered on the ClaudeRequestNotifyService.
 *
 * Contract: resolve with the ID of the posted notice message (null when the
 * platform did not report one) once the notice was posted, so replies to it
 * can be recognised (issue #35); throw a
 * {@link ClaudeRequestNotifyError} with `permanent: true` for failures that
 * will not go away (unknown channel, missing access, not a text channel);
 * throw anything else for transient failures such as network errors, which
 * the service retries on a later tick.
 */
export interface ClaudeRequestNotifier {
    notify(
        request: ClaudeRequest,
        outcome: ClaudeRequestOutcome
    ): Promise<string | null>;
}

/** Longest issue title shown in a notice. */
const MAX_NOTICE_TITLE_LENGTH = 100;

/**
 * Makes an issue title safe to put inside a markdown link label: square
 * brackets (which would end or nest the label) are dropped, whitespace is
 * collapsed and the result is capped at {@link MAX_NOTICE_TITLE_LENGTH}.
 */
export function sanitizeIssueTitle(title: string): string {
    const clean = title.replace(/[[\]]/g, '').replace(/\s+/g, ' ').trim();
    return clean.length > MAX_NOTICE_TITLE_LENGTH
        ? `${clean.slice(0, MAX_NOTICE_TITLE_LENGTH - 1).trimEnd()}…`
        : clean;
}

/** Platform-neutral text of a notice; each notifier wraps it in its embed type. */
export interface ClaudeRequestNotice {
    content: string;
    title: string;
    description: string;
    color: number;
}

/** Builds the ping line and embed text telling the requester the outcome. */
export function buildClaudeRequestNotice(
    request: ClaudeRequest,
    outcome: ClaudeRequestOutcome
): ClaudeRequestNotice {
    const title = sanitizeIssueTitle(request.title);
    const link = `[#${request.issueNumber}${title ? ` ${title}` : ''}](${request.issueUrl})`;
    if (outcome === 'completed') {
        return {
            content: `<@${request.userId}>, your Claude request has been implemented!`,
            title: 'Claude request implemented',
            description: `The feature you asked for in ${link} has been implemented.`,
            color: EmbedColors.Success,
        };
    }
    return {
        content: `<@${request.userId}>, your Claude request was closed.`,
        title: 'Claude request closed',
        description: `${link} was closed without being implemented.`,
        color: EmbedColors.Warning,
    };
}
