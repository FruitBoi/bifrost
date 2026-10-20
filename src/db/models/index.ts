import { GuildLinkModel } from './GuildLinkModel';
import { ChannelLinkModel } from './ChannelLinkModel';
import { CategoryLinkModel } from './CategoryLinkModel';
import { MessageLinkModel } from './MessageLinkModel';
import { QueuedMessageModel } from './QueuedMessageModel';

// Guild -> Channel
GuildLinkModel.hasMany(ChannelLinkModel, {
    foreignKey: 'guildLinkId',
    as: 'channelLinks',
    onDelete: 'CASCADE',
});

ChannelLinkModel.belongsTo(GuildLinkModel, {
    foreignKey: 'guildLinkId',
    as: 'guildLink',
});

// Guild -> MessageLinks
GuildLinkModel.hasMany(MessageLinkModel, {
    foreignKey: 'guildLinkId',
    as: 'messageLinks',
    onDelete: 'CASCADE',
});

MessageLinkModel.belongsTo(GuildLinkModel, {
    foreignKey: 'guildLinkId',
    as: 'guildLink',
});

// Channel -> MessageLinks
ChannelLinkModel.hasMany(MessageLinkModel, {
    foreignKey: 'channelLinkId',
    as: 'messageLinks',
    onDelete: 'CASCADE',
});

MessageLinkModel.belongsTo(ChannelLinkModel, {
    foreignKey: 'channelLinkId',
    as: 'channelLink',
});

// Category -> channel/thread links it created
CategoryLinkModel.hasMany(ChannelLinkModel, {
    foreignKey: 'categoryLinkId',
    as: 'channelLinks',
    constraints: false,
});

ChannelLinkModel.belongsTo(CategoryLinkModel, {
    foreignKey: 'categoryLinkId',
    as: 'categoryLink',
    constraints: false,
});

export {
    GuildLinkModel,
    ChannelLinkModel,
    CategoryLinkModel,
    MessageLinkModel,
    QueuedMessageModel,
};
