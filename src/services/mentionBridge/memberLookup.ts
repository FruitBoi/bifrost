/** A guild member on either platform, reduced to what username matching needs. */
export type GeneralMember = { id: string; username: string; bot: boolean };

/**
 * Finds members of the OTHER platform's guild by username, so a mention of
 * someone who is only on that side of the bridge can still ping them
 * (issue #61). Each lookup returns the members whose username equals
 * `username` case-insensitively (exact, no prefix or fuzzy matching), and an
 * empty list when there are none or the lookup fails.
 */
export type CounterpartMemberLookup = {
    findDiscordMembersByUsername(
        guildId: string,
        username: string
    ): Promise<GeneralMember[]>;
    findFluxerMembersByUsername(
        guildId: string,
        username: string
    ): Promise<GeneralMember[]>;
};
