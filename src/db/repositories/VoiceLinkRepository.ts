import { VoiceLink } from '../entities/VoiceLink';

export interface VoiceLinkRepository {
    create(data: {
        guildLinkId: string;
        discordChannelId: string;
        fluxerChannelId: string;
        enabled?: boolean;
    }): Promise<VoiceLink>;

    findById(id: string): Promise<VoiceLink | null>;

    findByDiscordChannelId(discordChannelId: string): Promise<VoiceLink | null>;

    findByFluxerChannelId(fluxerChannelId: string): Promise<VoiceLink | null>;

    findAllByGuild(guildLinkId: string): Promise<VoiceLink[]>;

    findAll(): Promise<VoiceLink[]>;

    setEnabled(id: string, enabled: boolean): Promise<VoiceLink | null>;

    deleteById(id: string): Promise<void>;

    deleteByGuildLinkId(guildLinkId: string): Promise<void>;

    getVoiceLinksCount(): Promise<number>;
}
