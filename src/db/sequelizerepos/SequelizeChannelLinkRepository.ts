import { nanoid } from 'nanoid';
import { Op } from 'sequelize';
import { ChannelLink } from '../entities/ChannelLink';
import { ChannelLinkModel } from '../models';
import {
    ChannelLinkRepository,
    CreateChannelLinkData,
} from '../repositories/ChannelLinkRepository';

export class SequelizeChannelLinkRepository implements ChannelLinkRepository {
    async create(data: CreateChannelLinkData): Promise<ChannelLink> {
        const model = await ChannelLinkModel.create({
            id: crypto.randomUUID(),
            linkId: nanoid(10),
            ...data,
            discordThreadId: data.discordThreadId ?? null,
            fluxerThreadId: data.fluxerThreadId ?? null,
        });

        if (!model) {
            throw new Error('Failed to create channel link');
        }

        return model.toJSON() as ChannelLink;
    }

    async findByGuildAndLinkId(
        guildLinkId: string,
        linkId: string
    ): Promise<ChannelLink | null> {
        const model = await ChannelLinkModel.findOne({
            where: { guildLinkId, linkId },
        });

        if (!model) return null;

        return model.toJSON() as ChannelLink;
    }

    async findAllByGuild(guildLinkId: string): Promise<ChannelLink[]> {
        const models = await ChannelLinkModel.findAll({
            where: { guildLinkId },
            order: [['createdAt', 'ASC']],
        });

        return models.map((m) => m.toJSON() as ChannelLink);
    }

    async findById(id: string): Promise<ChannelLink | null> {
        const model = await ChannelLinkModel.findOne({
            where: { id },
        });

        if (!model) return null;

        return model.toJSON() as ChannelLink;
    }

    async findByDiscordLocation(
        locationId: string
    ): Promise<ChannelLink | null> {
        const model = await ChannelLinkModel.findOne({
            where: {
                [Op.or]: [
                    { discordThreadId: locationId },
                    { discordChannelId: locationId, discordThreadId: null },
                ],
            },
        });

        if (!model) return null;

        return model.toJSON() as ChannelLink;
    }

    async findByFluxerLocation(
        locationId: string
    ): Promise<ChannelLink | null> {
        const model = await ChannelLinkModel.findOne({
            where: {
                [Op.or]: [
                    { fluxerThreadId: locationId },
                    { fluxerChannelId: locationId, fluxerThreadId: null },
                ],
            },
        });

        if (!model) return null;

        return model.toJSON() as ChannelLink;
    }

    async findAllByDiscordChannel(
        discordChannelId: string
    ): Promise<ChannelLink[]> {
        const models = await ChannelLinkModel.findAll({
            where: { discordChannelId },
            order: [['createdAt', 'ASC']],
        });

        return models.map((m) => m.toJSON() as ChannelLink);
    }

    async findAllByFluxerChannel(
        fluxerChannelId: string
    ): Promise<ChannelLink[]> {
        const models = await ChannelLinkModel.findAll({
            where: { fluxerChannelId },
            order: [['createdAt', 'ASC']],
        });

        return models.map((m) => m.toJSON() as ChannelLink);
    }

    async findAllByCategoryLink(
        categoryLinkId: string
    ): Promise<ChannelLink[]> {
        const models = await ChannelLinkModel.findAll({
            where: { categoryLinkId },
            order: [['createdAt', 'ASC']],
        });
        return models.map((m) => m.toJSON() as ChannelLink);
    }

    async countByDiscordWebhookId(discordWebhookId: string): Promise<number> {
        return await ChannelLinkModel.count({ where: { discordWebhookId } });
    }

    async countByFluxerWebhookId(fluxerWebhookId: string): Promise<number> {
        return await ChannelLinkModel.count({ where: { fluxerWebhookId } });
    }

    async setAutoSyncThreads(
        id: string,
        enabled: boolean
    ): Promise<ChannelLink> {
        const model = await ChannelLinkModel.findOne({ where: { id } });
        if (!model) {
            throw new Error('Channel link not found');
        }
        await model.update({ autoSyncThreads: enabled });
        return model.toJSON() as ChannelLink;
    }

    async deleteById(id: string): Promise<void> {
        await ChannelLinkModel.destroy({
            where: { id },
        });
    }

    async deleteByGuildLinkId(guildLinkId: string): Promise<void> {
        await ChannelLinkModel.destroy({
            where: { guildLinkId },
        });
    }

    async getChannelLinksCount(): Promise<number> {
        return await ChannelLinkModel.count();
    }
}
