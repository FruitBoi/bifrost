import {
    ClaudeRequest,
    ClaudeRequestPlatform,
} from '../entities/ClaudeRequest';

export interface CreateClaudeRequestData {
    platform: ClaudeRequestPlatform;
    issueNumber: number;
    issueUrl: string;
    title: string;
    userId: string;
    guildId: string;
    channelId: string;
    messageId: string | null;
}

export interface ClaudeRequestRepository {
    create(data: CreateClaudeRequestData): Promise<ClaudeRequest>;

    findById(id: number): Promise<ClaudeRequest | null>;

    /** Oldest first (by id); at most `limit` rows when given. */
    findAll(limit?: number): Promise<ClaudeRequest[]>;

    incrementAttempts(id: number): Promise<void>;

    /** True when a row was removed. */
    deleteById(id: number): Promise<boolean>;

    count(): Promise<number>;
}
