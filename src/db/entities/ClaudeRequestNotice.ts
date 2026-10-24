import { ClaudeRequestPlatform } from './ClaudeRequest';

/**
 * A "Claude request implemented/closed" notice the bot posted (issue #35).
 * Replying to it with a permitted account comments the reply on the GitHub
 * issue and reopens it. `noticeMessageId` and the other IDs belong to
 * `platform`; `userId` is the original requester.
 */
export interface ClaudeRequestNotice {
    id: number;
    platform: ClaudeRequestPlatform;
    issueNumber: number;
    issueUrl: string;
    /** Issue title as filed. */
    title: string;
    userId: string;
    guildId: string;
    channelId: string;
    /** The notice message the bot posted. */
    noticeMessageId: string;
    createdAt: Date;
}
