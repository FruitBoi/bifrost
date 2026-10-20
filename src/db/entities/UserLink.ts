/**
 * Identity mapping between a Discord account and a Fluxer account: "this
 * Fluxer member is that Discord user". Recorded by the Fluxer `role` command
 * (which copies a Discord user's roles to a Fluxer member) and used to carry
 * user pings across the bridge: a `<@id>` mention on one platform pings the
 * mapped account on the other.
 *
 * One-to-one within a guild link: each Discord user maps to at most one
 * Fluxer user and vice versa. Mapping a user again replaces the old row.
 */
export interface UserLink {
    id: string;
    guildLinkId: string;
    discordUserId: string;
    fluxerUserId: string;
    createdAt: Date;
}
