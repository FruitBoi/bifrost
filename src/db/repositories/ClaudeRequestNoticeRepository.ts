import { ClaudeRequestPlatform } from '../entities/ClaudeRequest';
import { ClaudeRequestNotice } from '../entities/ClaudeRequestNotice';

export interface CreateClaudeRequestNoticeData {
    platform: ClaudeRequestPlatform;
    issueNumber: number;
    issueUrl: string;
    title: string;
    userId: string;
    guildId: string;
    channelId: string;
    noticeMessageId: string;
}

export interface ClaudeRequestNoticeRepository {
    create(data: CreateClaudeRequestNoticeData): Promise<ClaudeRequestNotice>;

    /** The notice posted as `noticeMessageId` on `platform`, if any. */
    findByNoticeMessage(
        platform: ClaudeRequestPlatform,
        noticeMessageId: string
    ): Promise<ClaudeRequestNotice | null>;

    /** Removes notices created before `cutoff`; returns how many. */
    deleteOlderThan(cutoff: Date): Promise<number>;
}
