import { randomUUID } from 'crypto';
import { VoiceLink } from '../entities/VoiceLink';
import { VoiceLinkModel } from '../models';
import { VoiceLinkRepository } from '../repositories/VoiceLinkRepository';

export class SequelizeVoiceLinkRepository implements VoiceLinkRepository {
    async create(data: {
        guildLinkId: string;
        discordChannelId: string;
        fluxerChannelId: string;
        enabled?: boolean;
    }): Promise<VoiceLink> {
        const model = await VoiceLinkModel.create({
            id: randomUUID(),
            ...data,
            enabled: data.enabled ?? true,
        });
        return model.toJSON() as VoiceLink;
    }

    async findById(id: string): Promise<VoiceLink | null> {
        const model = await VoiceLinkModel.findOne({ where: { id } });
        return model ? (model.toJSON() as VoiceLink) : null;
    }

    async findByDiscordChannelId(
        discordChannelId: string
    ): Promise<VoiceLink | null> {
        const model = await VoiceLinkModel.findOne({
            where: { discordChannelId },
        });
        return model ? (model.toJSON() as VoiceLink) : null;
    }

    async findByFluxerChannelId(
        fluxerChannelId: string
    ): Promise<VoiceLink | null> {
        const model = await VoiceLinkModel.findOne({
            where: { fluxerChannelId },
        });
        return model ? (model.toJSON() as VoiceLink) : null;
    }

    async findAllByGuild(guildLinkId: string): Promise<VoiceLink[]> {
        const models = await VoiceLinkModel.findAll({
            where: { guildLinkId },
            order: [['createdAt', 'ASC']],
        });
        return models.map((m) => m.toJSON() as VoiceLink);
    }

    async findAll(): Promise<VoiceLink[]> {
        const models = await VoiceLinkModel.findAll({
            order: [['createdAt', 'ASC']],
        });
        return models.map((m) => m.toJSON() as VoiceLink);
    }

    async setEnabled(id: string, enabled: boolean): Promise<VoiceLink | null> {
        const model = await VoiceLinkModel.findOne({ where: { id } });
        if (!model) return null;
        await model.update({ enabled });
        return model.toJSON() as VoiceLink;
    }

    async deleteById(id: string): Promise<void> {
        await VoiceLinkModel.destroy({ where: { id } });
    }

    async deleteByGuildLinkId(guildLinkId: string): Promise<void> {
        await VoiceLinkModel.destroy({ where: { guildLinkId } });
    }

    async getVoiceLinksCount(): Promise<number> {
        return VoiceLinkModel.count();
    }
}
