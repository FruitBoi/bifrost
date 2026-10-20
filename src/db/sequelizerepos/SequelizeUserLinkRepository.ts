import { randomUUID } from 'crypto';
import { UserLink } from '../entities/UserLink';
import { UserLinkModel } from '../models';
import {
    CreateUserLinkData,
    UserLinkRepository,
} from '../repositories/UserLinkRepository';

export class SequelizeUserLinkRepository implements UserLinkRepository {
    async create(data: CreateUserLinkData): Promise<UserLink> {
        const model = await UserLinkModel.create({
            id: randomUUID(),
            ...data,
        });
        return model.toJSON() as UserLink;
    }

    async findById(id: string): Promise<UserLink | null> {
        const model = await UserLinkModel.findOne({ where: { id } });
        return model ? (model.toJSON() as UserLink) : null;
    }

    async findByDiscordUser(
        guildLinkId: string,
        discordUserId: string
    ): Promise<UserLink | null> {
        const model = await UserLinkModel.findOne({
            where: { guildLinkId, discordUserId },
        });
        return model ? (model.toJSON() as UserLink) : null;
    }

    async findByFluxerUser(
        guildLinkId: string,
        fluxerUserId: string
    ): Promise<UserLink | null> {
        const model = await UserLinkModel.findOne({
            where: { guildLinkId, fluxerUserId },
        });
        return model ? (model.toJSON() as UserLink) : null;
    }

    async findAllByGuild(guildLinkId: string): Promise<UserLink[]> {
        const models = await UserLinkModel.findAll({
            where: { guildLinkId },
            order: [['createdAt', 'ASC']],
        });
        return models.map((m) => m.toJSON() as UserLink);
    }

    async deleteById(id: string): Promise<void> {
        await UserLinkModel.destroy({ where: { id } });
    }

    async deleteByGuildLinkId(guildLinkId: string): Promise<void> {
        await UserLinkModel.destroy({ where: { guildLinkId } });
    }

    async getUserLinksCount(): Promise<number> {
        return UserLinkModel.count();
    }
}
