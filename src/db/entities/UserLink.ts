/**
 * Identity mapping between a Discord account and a Fluxer account: "this
 * Fluxer member is that Discord user". Recorded by the Fluxer identity
 * command `role` (alias `map`, which also copies a Discord user's roles to
 * the Fluxer member and replaces an existing mapping), and used to carry user pings across the bridge: a
 * `<@id>` mention on one platform pings the mapped account on the other.
 *
 * One-to-one within a guild link: each Discord user maps to at most one
 * Fluxer user and vice versa.
 */
export interface UserLink {
    id: string;
    guildLinkId: string;
    discordUserId: string;
    fluxerUserId: string;
    createdAt: Date;
}
