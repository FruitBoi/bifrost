/**
 * Platform-independent contract of the `history` command (issue #16): the
 * command handlers adapt their platform's channel history to a
 * {@link HistorySource}, and {@link HistoryTransferService} walks it and
 * posts bridged-style copies to the linked location on the other platform.
 */

import { ChannelLink } from '../../db/entities/ChannelLink';
import { GuildLink } from '../../db/entities/GuildLink';
import { MessagePlatform } from '../../db/entities/MessageLink';
import { WebhookMessageData } from '../WebhookService';

/** One source message, normalised for the transfer loop. */
export interface HistoryItem<M> {
    id: string;
    createdAt: Date;
    authorId: string;
    /** Display name used in digest headers (what the bridged copy would show as webhook username). */
    authorName: string;
    authorIsBot: boolean;
    webhookId: string | null;
    /** System message (join, pin notice, thread created, ...): never transferred. */
    isSystem: boolean;
    /** Nothing to show: no content, attachments, embeds or stickers. */
    isEmpty: boolean;
    /** A bot command invocation (`!b ...`): never transferred. */
    isCommand: boolean;
    raw: M;
}

/**
 * A linked location's history on the platform the command ran on, plus the
 * means to post copies to its counterpart. `M` is the platform's message type.
 */
export interface HistorySource<M> {
    /** Platform the history is read from (the command's platform). */
    readonly platform: MessagePlatform;
    readonly link: ChannelLink;
    readonly guildLink: GuildLink;
    /** This platform's bot user id; its own messages are skipped. Null if unknown. */
    readonly botUserId: string | null;
    /** Up to `limit` messages strictly older than `beforeId` (the newest ones when undefined), in any order. Empty = nothing older. */
    fetchBefore(
        beforeId: string | undefined,
        limit: number
    ): Promise<HistoryItem<M>[]>;
    /** Up to `limit` messages strictly newer than `afterId`, in any order. Empty = nothing newer. */
    fetchAfter(afterId: string, limit: number): Promise<HistoryItem<M>[]>;
    /** The bridged-style payload for the message, exactly as the live relay would build it. */
    buildPayload(item: HistoryItem<M>): Promise<WebhookMessageData>;
    /** Posts `payload` to the linked location on the other platform. */
    send(payload: WebhookMessageData): Promise<{ messageId: string }>;
    /** True when a message link already records this source message as bridged. */
    isBridged(messageId: string): Promise<boolean>;
    /** Records a 1:1 message link for a transferred message (messages mode only). */
    createMessageLink(
        item: HistoryItem<M>,
        targetMessageId: string
    ): Promise<void>;
    /** Username/avatar for digest posts (the bot's own). */
    digestIdentity(): { username: string; avatarURL: string };
}

/**
 * `messages` posts one copy per source message; `digest` packs many
 * messages into transcript posts (far fewer destination messages).
 */
export type HistoryMode = 'messages' | 'digest';

export interface HistoryOptions {
    /** Number of most recent eligible messages to transfer, or null for the whole history (`all`). */
    count: number | null;
    /** Only messages younger than this (ms), or null. */
    maxAgeMs: number | null;
    /** Only messages newer than this message id, or null. */
    afterId: string | null;
    /** Only messages older than this message id, or null. */
    beforeId: string | null;
    mode: HistoryMode;
    /** Prefix each copy (or digest line) with the original time. */
    timestamps: boolean;
}

export type HistoryJobStatus =
    | 'queued'
    | 'running'
    | 'done'
    | 'stopped'
    | 'failed';

export interface HistoryJobProgress {
    status: HistoryJobStatus;
    /** Messages looked at in the forward pass. */
    scanned: number;
    /** Messages that passed the kind filters (bridged or not). */
    eligible: number;
    /** Source messages copied over in this run. */
    transferred: number;
    /** Destination messages posted (equals transferred in messages mode; fewer in digest mode). */
    posts: number;
    /** Eligible messages skipped because they were already bridged/transferred, or are our own webhook's copies. */
    skippedBridged: number;
    /** Messages skipped for other reasons (system, empty, command, bot's own). */
    skippedOther: number;
    failed: number;
    /** Newest source message id processed so far. */
    lastMessageId: string | null;
    error: string | null;
    queuedAt: Date;
    startedAt: Date | null;
    finishedAt: Date | null;
}

/**
 * A transfer run. The object handed out by `HistoryTransferService.start`
 * is updated in place for the job's whole life, including after it finished.
 */
export interface HistoryJob {
    id: string;
    channelLinkId: string;
    sourcePlatform: MessagePlatform;
    options: HistoryOptions;
    /** User id of the moderator who started it (on the source platform). */
    requestedBy: string;
    progress: HistoryJobProgress;
}
