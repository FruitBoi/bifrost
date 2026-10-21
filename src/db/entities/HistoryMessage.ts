import { MessagePlatform } from './MessageLink';

/**
 * A source message that a history transfer (issue #16) has already copied to
 * the other platform. Several rows may share a `targetMessageId`: in digest
 * mode many source messages are packed into one destination post, which is
 * why `message_links` (strictly one-to-one) cannot record this.
 */
export interface HistoryMessage {
    id: string;
    guildLinkId: string;
    channelLinkId: string;
    /** Platform the original message lives on. */
    sourcePlatform: MessagePlatform;
    sourceMessageId: string;
    /** The destination message that carries the copy. */
    targetMessageId: string;
    createdAt: Date;
}
