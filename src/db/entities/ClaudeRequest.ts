/** Platform a Claude request was filed from and is reported back to. */
export type ClaudeRequestPlatform = 'discord' | 'fluxer';

/**
 * A Claude request (issue #26) filed as a GitHub issue by the `clauderequest`
 * command and still waiting for that issue to be closed. The user, guild,
 * channel and message IDs all belong to `platform`; once the issue closes
 * the requester is pinged in `channelId` and the row is deleted.
 */
export interface ClaudeRequest {
    id: number;
    platform: ClaudeRequestPlatform;
    /** Number of the GitHub issue in the configured repository. */
    issueNumber: number;
    issueUrl: string;
    /** Issue title as filed. */
    title: string;
    userId: string;
    guildId: string;
    channelId: string;
    /** The invoking message, replied to when it still exists. */
    messageId: string | null;
    /** Failed notification attempts so far; the row is dropped after too many. */
    attempts: number;
    createdAt: Date;
}
