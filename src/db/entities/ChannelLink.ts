/**
 * A bridge between two locations. Each side is a text channel or a thread
 * inside a text channel:
 *
 * - `discordChannelId` / `fluxerChannelId` is always the *channel* that owns
 *   the webhook (for a thread, that is the thread's parent channel).
 * - `discordThreadId` / `fluxerThreadId` is set when that side is a thread.
 *
 * So a row can be channel↔channel, thread↔thread, or mixed. Messages are
 * always posted through the channel's webhook with the thread as target.
 */
export interface ChannelLink {
    id: string;
    guildLinkId: string;

    discordChannelId: string;
    discordThreadId: string | null;

    fluxerChannelId: string;
    fluxerThreadId: string | null;

    discordWebhookId: string;
    discordWebhookToken: string;

    fluxerWebhookId: string;
    fluxerWebhookToken: string;

    linkId: string;

    /** Set when this link was created by a category link (see CategoryLink). */
    categoryLinkId: string | null;

    /**
     * Only meaningful for channel↔channel links: when true, new threads in
     * either channel get a counterpart thread and a link of their own.
     */
    autoSyncThreads: boolean;

    createdAt: Date;
}

/** The ID messages are read from / posted to on the Discord side. */
export function discordLocationId(link: ChannelLink): string {
    return link.discordThreadId ?? link.discordChannelId;
}

/** The ID messages are read from / posted to on the Fluxer side. */
export function fluxerLocationId(link: ChannelLink): string {
    return link.fluxerThreadId ?? link.fluxerChannelId;
}

/** True when neither side is a thread. */
export function isChannelPairLink(link: ChannelLink): boolean {
    return link.discordThreadId === null && link.fluxerThreadId === null;
}
