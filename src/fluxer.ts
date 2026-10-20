import {
    Client,
    ClientOptions,
    EmbedBuilder,
    Events,
    Message,
    PartialMessage,
    TextChannel,
} from '@fluxerjs/core';
import CommandRegistry from './commands/CommandRegistry';
import {
    isCommandString,
    parseCommandString,
} from './commands/parseCommandString';
import { EmbedColors } from './utils/embeds';
import logger from './utils/logging/logger';
import FluxerCommandHandler from './commands/fluxer/FluxerCommandHandler';
import {
    COMMAND_PREFIX,
    DELETE_INVOCATION,
    AUTODISCOVERY_FLUXER_DOMAIN,
    FLUXER_TOKEN,
    FLUXER_API_URL,
    FLUXER_CHANNEL_CACHE_LIMIT,
    FLUXER_GUILD_CACHE_LIMIT,
    FLUXER_MEDIA_URL,
    FLUXER_STATIC_CDN_URL,
    FLUXER_INVITE_URL,
} from './utils/env';
import { LinkService } from './services/LinkService';
import { discordLocationId } from './db/entities/ChannelLink';
import LinkFluxerCommandHandler from './commands/fluxer/handlers/LinkFluxerCommandHandler';
import UnlinkFluxerCommandHandler from './commands/fluxer/handlers/UnlinkFluxerCommandHandler';
import ListFluxerCommandHandler from './commands/fluxer/handlers/ListFluxerCommandHandler';
import ThreadsFluxerCommandHandler from './commands/fluxer/handlers/ThreadsFluxerCommandHandler';
import { WebhookService } from './services/WebhookService';
import FluxerToDiscordMessageRelay from './services/messageRelay/FluxerToDiscordMessageRelay';
import HelpFluxerCommandHandler from './commands/fluxer/handlers/HelpFluxerCommandHandler';
import AutolinkFluxerCommandHandler from './commands/fluxer/handlers/AutolinkFluxerCommandHandler';
import HealthCheckService from './services/HealthCheckService';
import FluxerEntityResolver from './services/entityResolver/FluxerEntityResolver';
import DiscordEntityResolver from './services/entityResolver/DiscordEntityResolver';
import FluxerMessageTransformer from './services/messageTransformer/FluxerMessageTransformer';
import MentionBridgeService from './services/mentionBridge/MentionBridgeService';
import MetricsService from './services/MetricsService';
import MessageQueueService from './services/MessageQueueService';
import StatsFluxerCommandHandler from './commands/fluxer/handlers/StatsFluxerCommandHandler';
import DiscordStatsService from './services/statsService/DiscordStatsService';
import FluxerStatsService from './services/statsService/FluxerStatsService';
import { DbStatsService } from './services/DbStatsService';
import ThreadSyncService from './services/threadSync/ThreadSyncService';
import LinkProvisioner from './services/LinkProvisioner';
import CategorySyncService from './services/categorySync/CategorySyncService';
import ThreadMemberSyncService from './services/threadMemberSync/ThreadMemberSyncService';
import CategoryFluxerCommandHandler from './commands/fluxer/handlers/CategoryFluxerCommandHandler';
import RoleFluxerCommandHandler from './commands/fluxer/handlers/RoleFluxerCommandHandler';
import type { BotConfig } from './config/BotConfig';
import VoiceFluxerCommandHandler from './commands/fluxer/handlers/VoiceFluxerCommandHandler';
import MeowService from './services/meow/MeowService';

const startFluxerClient = async ({
    linkService,
    linkProvisioner,
    webhookService,
    healthCheckService,
    discordEntityResolver,
    fluxerEntityResolver,
    threadSyncService,
    categorySyncService,
    threadMemberSyncService,
    metricsService,
    queueService,
    discordStatsService,
    fluxerStatsService,
    dbStatsService,
    botConfig,
    onClientCreated,
}: {
    linkService: LinkService;
    linkProvisioner: LinkProvisioner;
    webhookService: WebhookService;
    healthCheckService: HealthCheckService;
    discordEntityResolver: DiscordEntityResolver;
    fluxerEntityResolver: FluxerEntityResolver;
    threadSyncService: ThreadSyncService;
    categorySyncService: CategorySyncService;
    threadMemberSyncService: ThreadMemberSyncService;
    metricsService?: MetricsService;
    queueService?: MessageQueueService;
    discordStatsService: DiscordStatsService;
    fluxerStatsService: FluxerStatsService;
    dbStatsService: DbStatsService;
    botConfig: BotConfig;
    /**
     * Called with the freshly created client before any listener is attached
     * and before login. The voice bridge uses this to attach its transport,
     * which must see the gateway from READY onwards.
     */
    onClientCreated?: (client: Client) => void;
}): Promise<Client> => {
    const clientOptions: ClientOptions = {
        intents: 0,
        waitForGuilds: true,
        cache: {
            guilds: FLUXER_GUILD_CACHE_LIMIT,
            channels: FLUXER_CHANNEL_CACHE_LIMIT,
        },
        presence: {
            status: 'online',
            customStatus: {
                text: 'Bridging to Discord',
            },
        },
        instance: {
            api: FLUXER_API_URL || undefined,
            media: FLUXER_MEDIA_URL || undefined,
            static_cdn: FLUXER_STATIC_CDN_URL || undefined,
            invite: FLUXER_INVITE_URL || undefined,
        },
    };

    const client = AUTODISCOVERY_FLUXER_DOMAIN
        ? await Client.fromDiscovery(AUTODISCOVERY_FLUXER_DOMAIN, clientOptions)
        : new Client(clientOptions);

    console.log();

    onClientCreated?.(client);

    webhookService.setFluxerClient(client);
    healthCheckService.setFluxerClient(client);
    fluxerEntityResolver.setFluxerClient(client);
    threadSyncService.setFluxerClient(client);
    categorySyncService.setFluxerClient(client);
    fluxerStatsService.setClient(client);

    const messageTransformer = new FluxerMessageTransformer(
        new MentionBridgeService(linkService)
    );
    const meowService = new MeowService();
    const messageRelay = new FluxerToDiscordMessageRelay({
        linkService,
        webhookService,
        messageTransformer,
        metricsService,
        queueService,
        discordEntityResolver,
        threadSyncService,
    });

    const commandRegistry = new CommandRegistry<FluxerCommandHandler>();
    commandRegistry.registerCommand(
        'help',
        new HelpFluxerCommandHandler(client)
    );
    commandRegistry.registerCommand(
        'stats',
        new StatsFluxerCommandHandler(
            client,
            discordStatsService,
            fluxerStatsService,
            dbStatsService
        )
    );
    commandRegistry.registerCommand(
        'link',
        new LinkFluxerCommandHandler(
            client,
            linkService,
            linkProvisioner,
            discordEntityResolver
        )
    );
    commandRegistry.registerCommand(
        'unlink',
        new UnlinkFluxerCommandHandler(client, linkService, linkProvisioner)
    );
    commandRegistry.registerCommand(
        'list',
        new ListFluxerCommandHandler(client, linkService, discordEntityResolver)
    );
    commandRegistry.registerCommand(
        'threads',
        new ThreadsFluxerCommandHandler(client, linkService)
    );
    commandRegistry.registerCommand(
        'category',
        new CategoryFluxerCommandHandler(
            client,
            linkService,
            categorySyncService
        )
    );
    commandRegistry.registerCommand(
        'voice',
        new VoiceFluxerCommandHandler(client, linkService, linkProvisioner)
    );
    commandRegistry.registerCommand(
        'role',
        new RoleFluxerCommandHandler(
            client,
            linkService,
            discordEntityResolver,
            threadMemberSyncService,
            botConfig.roles.copyAllowedRoleIds
        )
    );
    commandRegistry.registerCommand(
        'autolink',
        new AutolinkFluxerCommandHandler(
            client,
            linkService,
            linkProvisioner,
            discordEntityResolver
        )
    );

    client.once(Events.Ready, () => {
        logger.info('🌊 Fluxer bot is ready!');
        healthCheckService.pushFluxerHealthStatus();
    });

    client.on(Events.Error, (error) => {
        logger.error('❌ Fluxer client error:', error);
    });

    client.on(Events.ChannelDelete, async (channel) => {
        if (channel.isThread()) return; // handled by ThreadDelete
        try {
            await categorySyncService.handleFluxerChannelDelete(channel.id);
        } catch (error) {
            logger.error('❌ Error handling Fluxer channel deletion:', error);
        }
    });

    client.on(Events.ThreadCreate, async (thread) => {
        try {
            await threadSyncService.resolveFluxerThread(thread, 'auto');
        } catch (error) {
            logger.error('❌ Error handling Fluxer thread creation:', error);
        }
    });

    client.on(Events.ThreadUpdate, async (oldThread, newThread) => {
        try {
            await threadSyncService.handleFluxerThreadUpdate(
                oldThread,
                newThread
            );
        } catch (error) {
            logger.error('❌ Error handling Fluxer thread update:', error);
        }
    });

    client.on(Events.ThreadDelete, async (thread) => {
        try {
            await threadSyncService.handleFluxerThreadDelete(thread.id);
        } catch (error) {
            logger.error('❌ Error handling Fluxer thread deletion:', error);
        }
    });

    client.on(Events.MessageDelete, async (message: PartialMessage) => {
        const messageLink = await linkService.getMessageLinkByFluxerMessageId(
            message.id
        );
        if (!messageLink) return;

        try {
            linkService.deleteMessageLink(messageLink.id);
        } catch (error) {
            logger.error(
                '❌ Error deleting message link from database:',
                error
            );
        }

        const channelLink = await linkService.getChannelLinkById(
            messageLink.channelLinkId
        );
        if (!channelLink) return;

        const guildLink = await linkService.getGuildLinkById(
            channelLink.guildLinkId
        );
        if (!guildLink) return;

        const msg = await discordEntityResolver
            .fetchMessage(
                guildLink.discordGuildId,
                discordLocationId(channelLink),
                messageLink.discordMessageId
            )
            .catch(() => null);
        if (!msg) {
            logger.error(
                '❌ Could not find linked Discord message to delete for Fluxer message ID:',
                message.id
            );
            return;
        }

        try {
            await msg.delete();
        } catch (error) {
            logger.error('❌ Error deleting message from Discord:', error);
        }
    });

    client.on(Events.MessageUpdate, async (_oldMessage, updatedMessage) => {
        if (!updatedMessage.partial && updatedMessage.webhookId) return;

        const linkedMessage = await linkService.getMessageLinkByFluxerMessageId(
            updatedMessage.id
        );
        if (!linkedMessage) return;

        let newMessage: Message;
        try {
            newMessage = updatedMessage.partial
                ? await updatedMessage.fetch()
                : updatedMessage;
        } catch (error) {
            logger.error('❌ Error fetching updated Fluxer message:', error);
            return;
        }
        if (newMessage.webhookId) return;

        const linkedChannel = await linkService.getChannelLinkById(
            linkedMessage.channelLinkId
        );
        if (!linkedChannel) return;

        const guildLink = await linkService.getGuildLinkById(
            linkedChannel.guildLinkId
        );
        if (!guildLink) return;

        const webhook = await webhookService.getDiscordWebhook(
            linkedChannel.discordWebhookId,
            linkedChannel.discordWebhookToken
        );
        if (!webhook) {
            logger.warn(
                `⚠️ No webhook found for linked channel ${linkedChannel.linkId}, cannot relay message update`
            );
            return;
        }

        const discordEmojis = await discordEntityResolver.fetchEmojis(
            guildLink.discordGuildId
        );

        const newMsg = await messageTransformer.transformMessage(
            newMessage,
            discordEmojis,
            { isEdit: true }
        );
        try {
            await webhookService.editMessageViaDiscordWebhook(
                webhook,
                linkedMessage.discordMessageId,
                newMsg,
                linkedChannel.discordThreadId
            );
        } catch (error) {
            logger.error(
                '❌ Error editing message via Discord webhook:',
                error
            );
        }
    });

    client.on(Events.MessageCreate, async (message) => {
        if (message.author.id === client.user?.id) return;

        if (message.guildId && message.webhookId) {
            const link = await linkService.getChannelLinkByFluxerLocation(
                message.channelId
            );
            if (link && link.fluxerWebhookId === message.webhookId) return;
        }

        if (isCommandString(message.content, COMMAND_PREFIX)) {
            const { command, args } = parseCommandString(
                message.content,
                COMMAND_PREFIX
            );
            const handler = commandRegistry.getCommandHandler(command);
            if (!handler) {
                await message.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setDescription(
                                `Unknown command: \`${command}\`\nUse \`${COMMAND_PREFIX}help\` to see available commands.`
                            )
                            .setColor(EmbedColors.Error)
                            .setFooter({
                                text: `${message.author.username} used ${message.content} • ${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`,
                                iconURL:
                                    (
                                        message.author as {
                                            avatarURL?: () =>
                                                | string
                                                | undefined;
                                        }
                                    ).avatarURL?.() ?? undefined,
                            })
                            .setTimestamp(),
                    ],
                });
                return;
            }

            try {
                await handler.handleCommand(message, command, ...args);
            } catch (error) {
                logger.error(
                    `❌ Error executing fluxer command "${command}":`,
                    error
                );
            }

            if (DELETE_INVOCATION && message.guildId) {
                message
                    .delete()
                    .catch((err: unknown) =>
                        logger.error(
                            '❌ Failed to delete invocation message:',
                            err
                        )
                    );
            }
        }

        if (
            message.guildId &&
            !isCommandString(message.content, COMMAND_PREFIX)
        ) {
            // Thread channels are often not cached until first seen; resolve
            // once so threads are relayed just like text channels.
            const channel =
                message.channel ??
                (await message.resolveChannel().catch(() => null));
            if (channel instanceof TextChannel || channel?.isThread()) {
                await messageRelay.relayMessage(message);
            }
        }

        // Cat-noise conversation (issue #4): meow back at Fluxer users who
        // meow at us (Fluxer only, by request on the issue), then bridge our
        // half of the exchange too (our own messages are otherwise skipped at
        // the top of this handler).
        if (
            botConfig.meow.enabled &&
            message.guildId &&
            !message.author.bot &&
            !message.webhookId &&
            meowService.shouldReply(message.content, message.channelId)
        ) {
            try {
                const reply = await message.reply(
                    meowService.reply(message.content),
                    { ping: false }
                );
                await messageRelay.relayMessage(reply);
            } catch (error) {
                logger.error('❌ Failed to meow back:', error);
            }
        }
    });

    await client.login(FLUXER_TOKEN);

    return client;
};

export default startFluxerClient;
