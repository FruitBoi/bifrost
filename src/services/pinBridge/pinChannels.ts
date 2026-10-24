/**
 * Thin, duck-typed views of the pin APIs of discord.js and `@fluxerjs/core`,
 * so the pin bridge can list a location's pins page by page without caring
 * whether the location is a text channel, an announcement channel or a thread.
 */

/** Pins per page; both APIs cap a page at 50. */
const PAGE_SIZE = 50;

/**
 * Safety net against an API that keeps answering `hasMore` without making
 * progress. Discord allows 250 pins per channel, five full pages.
 */
const MAX_PAGES = 20;

/** The subset of a message the pin bridge touches on either platform. */
export interface PinnableMessage {
    id: string;
    pinned: boolean;
    webhookId?: string | null;
    pin(): Promise<unknown>;
    unpin(): Promise<unknown>;
}

/** One pinned message and when it was pinned (epoch ms). */
export interface PinEntry<M> {
    id: string;
    pinnedAt: number;
    message: M;
}

/** discord.js 14.25 `MessageManager#fetchPins`. */
interface DiscordPinsChannel<M> {
    messages: {
        fetchPins(options?: { before?: Date; limit?: number }): Promise<{
            items: readonly { pinnedTimestamp: number; message: M }[];
            hasMore: boolean;
        }>;
    };
}

/** `@fluxerjs/core` text channels and threads (`fetchPinnedMessagesPage`). */
interface FluxerPinsChannel<M> {
    fetchPinnedMessagesPage(options?: {
        before?: string;
        limit?: number;
    }): Promise<{ messages: M[]; pinnedAt: string[]; hasMore: boolean }>;
}

export function isDiscordPinsChannel<M>(
    channel: unknown
): channel is DiscordPinsChannel<M> {
    const messages = (channel as { messages?: { fetchPins?: unknown } } | null)
        ?.messages;
    return typeof messages?.fetchPins === 'function';
}

export function isFluxerPinsChannel<M>(
    channel: unknown
): channel is FluxerPinsChannel<M> {
    return (
        typeof (channel as { fetchPinnedMessagesPage?: unknown } | null)
            ?.fetchPinnedMessagesPage === 'function'
    );
}

/** Every pin of a Discord channel or thread, newest pin first. */
export async function fetchAllDiscordPins<M extends { id: string }>(
    channel: DiscordPinsChannel<M>
): Promise<PinEntry<M>[]> {
    const pins: PinEntry<M>[] = [];
    let before: Date | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
        const { items, hasMore } = await channel.messages.fetchPins({
            limit: PAGE_SIZE,
            ...(before ? { before } : {}),
        });
        for (const item of items) {
            pins.push({
                id: item.message.id,
                pinnedAt: item.pinnedTimestamp,
                message: item.message,
            });
        }
        if (!hasMore || items.length === 0) break;
        before = new Date(items[items.length - 1].pinnedTimestamp);
    }
    return pins;
}

/** Every pin of a Fluxer channel or thread, newest pin first. */
export async function fetchAllFluxerPins<M extends { id: string }>(
    channel: FluxerPinsChannel<M>
): Promise<PinEntry<M>[]> {
    const pins: PinEntry<M>[] = [];
    let before: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
        const { messages, pinnedAt, hasMore } =
            await channel.fetchPinnedMessagesPage({
                limit: PAGE_SIZE,
                ...(before ? { before } : {}),
            });
        messages.forEach((message, i) => {
            const parsed = Date.parse(pinnedAt[i] ?? '');
            pins.push({
                id: message.id,
                pinnedAt: Number.isNaN(parsed) ? 0 : parsed,
                message,
            });
        });
        if (!hasMore || messages.length === 0) break;
        before = pinnedAt[pinnedAt.length - 1];
        if (!before) break;
    }
    return pins;
}
