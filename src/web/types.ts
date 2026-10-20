export interface Identity {
    id: string;
    username: string;
    avatarUrl: string | null;
}

export interface MeResponse {
    discord: Identity | null;
    fluxer: Identity | null;
    isOwner: boolean;
}

export interface GuildSummary {
    id: string;
    name: string;
    icon: string | null;
    botPresent: boolean;
}

export interface GuildPair {
    guildLinkId: string;
    discord: GuildSummary;
    fluxer: GuildSummary;
}

export interface GuildsResponse {
    linkedPairs: GuildPair[];
    unlinkedDiscordGuilds: GuildSummary[];
    unlinkedFluxerGuilds: GuildSummary[];
}

export interface ChannelSummary {
    id: string;
    name: string;
}

export interface UnlinkedChannelSummary extends ChannelSummary {
    categoryId: string | null;
    categoryName: string | null;
    position: number;
    categoryPosition: number | null;
}

/** An active thread that is not linked yet, with its parent channel. */
export interface UnlinkedThreadSummary extends ChannelSummary {
    parentId: string;
    parentName: string;
}

/**
 * A link between two locations. Each side is a channel, or a thread inside
 * that channel when the matching `*Thread` field is set.
 */
export interface ChannelLinkSummary {
    id: string;
    /** Webhook-owning channel (the thread's parent when `discordThread` is set). */
    discordChannel: ChannelSummary;
    /** Webhook-owning channel (the thread's parent when `fluxerThread` is set). */
    fluxerChannel: ChannelSummary;
    discordThread: ChannelSummary | null;
    fluxerThread: ChannelSummary | null;
    /** Only meaningful for channel↔channel links. */
    autoSyncThreads: boolean;
}

export interface UpdateChannelLinkBody {
    autoSyncThreads: boolean;
}

export interface GuildChannelsResponse {
    linked: ChannelLinkSummary[];
    unlinkedDiscordChannels: UnlinkedChannelSummary[];
    unlinkedFluxerChannels: UnlinkedChannelSummary[];
    unlinkedDiscordThreads: UnlinkedThreadSummary[];
    unlinkedFluxerThreads: UnlinkedThreadSummary[];
}

export interface CreateGuildLinkBody {
    discordGuildId: string;
    fluxerGuildId: string;
}

export interface CreateChannelLinkBody {
    guildLinkId: string;
    /** A Discord text channel ID or a thread ID. */
    discordTargetId: string;
    /** A Fluxer text channel ID or a thread ID. */
    fluxerTargetId: string;
}

export interface InviteLinkResponse {
    url: string;
}

export interface AutolinkProposal {
    discordChannel: ChannelSummary;
    fluxerChannel: ChannelSummary;
    score: number;
}

export interface AutolinkPreviewResponse {
    proposals: AutolinkProposal[];
    unmatchedDiscordCount: number;
    unmatchedFluxerCount: number;
}

export interface AutolinkResultItem {
    discordChannel: ChannelSummary;
    fluxerChannel: ChannelSummary;
    error?: string;
}

export interface AutolinkResponse {
    linkedCount: number;
    results: AutolinkResultItem[];
}

export interface ApiErrorResponse {
    error: string;
}

export interface AdminStatsResponse {
    discordGuildCount: number | null;
    fluxerGuildCount: number | null;
    discordUserCount: number | null;
    fluxerUserCount: number | null;
    discordPingMs: number | null;
    fluxerPingMs: number | null;
    channelLinksCount: number;
    messageLinksCount: number;
    uptimeSeconds: number;
    memoryUsageMB: number;
    gitCommit: string | null;
    repoUrl: string | null;
    discordHealthy: boolean;
    fluxerHealthy: boolean;
}

export interface AdminGuildLinkSummary {
    guildLinkId: string;
    createdAt: string;
    discord: GuildSummary;
    fluxer: GuildSummary;
}

export interface AdminGuildLinksResponse {
    guildLinks: AdminGuildLinkSummary[];
}
