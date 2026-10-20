/**
 * Bridges a Discord voice channel with a Fluxer voice channel. While the
 * bridge is live, the bot sits in both channels and relays the mixed audio
 * of each side into the other.
 *
 * Voice links have no webhooks and no threads, so they live in their own
 * table rather than in `channel_links`. Each voice channel can be linked at
 * most once. Only one voice link per guild link can be *live* at a time,
 * because a bot can be in one voice channel per guild on either platform.
 */
export interface VoiceLink {
    id: string;
    guildLinkId: string;
    discordChannelId: string;
    fluxerChannelId: string;
    /** When false the link is kept but the bridge never joins. */
    enabled: boolean;
    createdAt: Date;
}
