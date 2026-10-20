import { GuildLinkModel } from './GuildLinkModel';
import { ChannelLinkModel } from './ChannelLinkModel';
import { CategoryLinkModel } from './CategoryLinkModel';
import { MessageLinkModel } from './MessageLinkModel';
import { QueuedMessageModel } from './QueuedMessageModel';
import { VoiceLinkModel } from './VoiceLinkModel';
import { UserLinkModel } from './UserLinkModel';

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

// Guild -> VoiceLinks
GuildLinkModel.hasMany(VoiceLinkModel, {
    foreignKey: 'guildLinkId',
    as: 'voiceLinks',
    onDelete: 'CASCADE',
});

VoiceLinkModel.belongsTo(GuildLinkModel, {
    foreignKey: 'guildLinkId',
    as: 'guildLink',
});

// Guild -> UserLinks
GuildLinkModel.hasMany(UserLinkModel, {
    foreignKey: 'guildLinkId',
    as: 'userLinks',
    onDelete: 'CASCADE',
});

UserLinkModel.belongsTo(GuildLinkModel, {
    foreignKey: 'guildLinkId',
    as: 'guildLink',
});

export {
    GuildLinkModel,
    ChannelLinkModel,
    CategoryLinkModel,
    MessageLinkModel,
    QueuedMessageModel,
    VoiceLinkModel,
    UserLinkModel,
};
