export default interface EntityResolver<Guild, Channel, Message, Emoji> {
    fetchGuild(guildId: string): Promise<Guild | null>;
    fetchChannel(
        guildId: string | Guild,
        channelId: string
    ): Promise<Channel | null>;
    fetchMessage(
        guildId: string | Guild,
        channelId: string | Channel,
        messageId: string
    ): Promise<Message>;
    fetchEmojis(guildId: string | Guild): Promise<Emoji[]>;
    /** Fetches a channel of the guild; null unless it is a voice channel. */
    fetchVoiceChannel(
        guildId: string | Guild,
        channelId: string
    ): Promise<Channel | null>;
    /** Lists the guild's voice channels as `{ id, name }` pairs. */
    listVoiceChannels(
        guildId: string | Guild
    ): Promise<{ id: string; name: string }[]>;
}
