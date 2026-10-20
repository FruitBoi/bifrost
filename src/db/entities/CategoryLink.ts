/**
 * Maps a Discord channel category onto one Fluxer channel: every text channel
 * in the category is bridged to a thread inside that Fluxer channel. The
 * resulting channel↔thread links are ordinary {@link ChannelLink} rows that
 * carry this row's id in `categoryLinkId`.
 */
export interface CategoryLink {
    id: string;
    guildLinkId: string;
    discordCategoryId: string;
    fluxerChannelId: string;
    createdAt: Date;
}
