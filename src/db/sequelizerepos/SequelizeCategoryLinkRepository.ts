import { randomUUID } from 'crypto';
import { CategoryLink } from '../entities/CategoryLink';
import { CategoryLinkModel } from '../models';
import { CategoryLinkRepository } from '../repositories/CategoryLinkRepository';

export class SequelizeCategoryLinkRepository implements CategoryLinkRepository {
    async create(data: {
        guildLinkId: string;
        discordCategoryId: string;
        fluxerChannelId: string;
    }): Promise<CategoryLink> {
        const model = await CategoryLinkModel.create({
            id: randomUUID(),
            ...data,
        });
        return model.toJSON() as CategoryLink;
    }

    async findById(id: string): Promise<CategoryLink | null> {
        const model = await CategoryLinkModel.findOne({ where: { id } });
        return model ? (model.toJSON() as CategoryLink) : null;
    }

    async findByDiscordCategoryId(
        discordCategoryId: string
    ): Promise<CategoryLink | null> {
        const model = await CategoryLinkModel.findOne({
            where: { discordCategoryId },
        });
        return model ? (model.toJSON() as CategoryLink) : null;
    }

    async findAllByFluxerChannelId(
        fluxerChannelId: string
    ): Promise<CategoryLink[]> {
        const models = await CategoryLinkModel.findAll({
            where: { fluxerChannelId },
            order: [['createdAt', 'ASC']],
        });
        return models.map((m) => m.toJSON() as CategoryLink);
    }

    async findAllByGuild(guildLinkId: string): Promise<CategoryLink[]> {
        const models = await CategoryLinkModel.findAll({
            where: { guildLinkId },
            order: [['createdAt', 'ASC']],
        });
        return models.map((m) => m.toJSON() as CategoryLink);
    }

    async deleteById(id: string): Promise<void> {
        await CategoryLinkModel.destroy({ where: { id } });
    }

    async deleteByGuildLinkId(guildLinkId: string): Promise<void> {
        await CategoryLinkModel.destroy({ where: { guildLinkId } });
    }

    async getCategoryLinksCount(): Promise<number> {
        return CategoryLinkModel.count();
    }
}
