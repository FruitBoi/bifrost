import { randomUUID } from 'crypto';
import { ThreadLink } from '../entities/ThreadLink';
import { ThreadLinkModel } from '../models';
import { ThreadLinkRepository } from '../repositories/ThreadLinkRepository';

export class SequelizeThreadLinkRepository implements ThreadLinkRepository {
    async create(data: {
        guildLinkId: string;
        channelLinkId: string;
        discordThreadId: string;
        fluxerThreadId: string;
    }): Promise<ThreadLink> {
        const model = await ThreadLinkModel.create({
            id: randomUUID(),
            ...data,
        });

        if (!model) {
            throw new Error('Failed to create thread link');
        }

        return model.toJSON() as ThreadLink;
    }

    async findById(id: string): Promise<ThreadLink | null> {
        const model = await ThreadLinkModel.findOne({ where: { id } });
        if (!model) return null;
        return model.toJSON() as ThreadLink;
    }

    async findByDiscordThreadId(
        discordThreadId: string
    ): Promise<ThreadLink | null> {
        const model = await ThreadLinkModel.findOne({
            where: { discordThreadId },
        });
        if (!model) return null;
        return model.toJSON() as ThreadLink;
    }

    async findByFluxerThreadId(
        fluxerThreadId: string
    ): Promise<ThreadLink | null> {
        const model = await ThreadLinkModel.findOne({
            where: { fluxerThreadId },
        });
        if (!model) return null;
        return model.toJSON() as ThreadLink;
    }

    async findAllByChannelLink(channelLinkId: string): Promise<ThreadLink[]> {
        const models = await ThreadLinkModel.findAll({
            where: { channelLinkId },
            order: [['createdAt', 'ASC']],
        });
        return models.map((m) => m.toJSON() as ThreadLink);
    }

    async findAllByGuild(guildLinkId: string): Promise<ThreadLink[]> {
        const models = await ThreadLinkModel.findAll({
            where: { guildLinkId },
            order: [['createdAt', 'ASC']],
        });
        return models.map((m) => m.toJSON() as ThreadLink);
    }

    async deleteById(id: string): Promise<void> {
        await ThreadLinkModel.destroy({ where: { id } });
    }

    async deleteByChannelLinkId(channelLinkId: string): Promise<void> {
        await ThreadLinkModel.destroy({ where: { channelLinkId } });
    }

    async deleteByGuildLinkId(guildLinkId: string): Promise<void> {
        await ThreadLinkModel.destroy({ where: { guildLinkId } });
    }

    async getThreadLinksCount(): Promise<number> {
        return await ThreadLinkModel.count();
    }
}
