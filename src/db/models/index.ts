import { GuildLinkModel } from './GuildLinkModel';
import { ChannelLinkModel } from './ChannelLinkModel';
import { ThreadLinkModel } from './ThreadLinkModel';
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

// Channel -> Threads
ChannelLinkModel.hasMany(ThreadLinkModel, {
    foreignKey: 'channelLinkId',
    as: 'threadLinks',
    onDelete: 'CASCADE',
});

ThreadLinkModel.belongsTo(ChannelLinkModel, {
    foreignKey: 'channelLinkId',
    as: 'channelLink',
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

// Thread -> MessageLinks (nullable; messages in the channel itself have no thread link)
ThreadLinkModel.hasMany(MessageLinkModel, {
    foreignKey: 'threadLinkId',
    as: 'messageLinks',
    constraints: false,
});

MessageLinkModel.belongsTo(ThreadLinkModel, {
    foreignKey: 'threadLinkId',
    as: 'threadLink',
    constraints: false,
});

export {
    GuildLinkModel,
    ChannelLinkModel,
    ThreadLinkModel,
    MessageLinkModel,
    QueuedMessageModel,
};
