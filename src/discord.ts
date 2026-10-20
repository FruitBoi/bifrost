import {
    Client,
    EmbedBuilder,
    Events,
    GatewayIntentBits,
    Partials,
    TextChannel,
} from 'discord.js';
import { COMMAND_PREFIX, DELETE_INVOCATION, DISCORD_TOKEN } from './utils/env';
import { EmbedColors } from './utils/embeds';
import logger from './utils/logging/logger';
import { isFluxerApiBlocked } from './utils/fluxerApiGuard';
import CommandRegistry from './commands/CommandRegistry';
import DiscordCommandHandler from './commands/discord/DiscordCommandHandler';
import {
    isCommandString,
    parseCommandString,
} from './commands/parseCommandString';
import { LinkService } from './services/LinkService';
import LinkDiscordCommandHandler from './commands/discord/handlers/LinkDiscordCommandHandler';
import UnlinkDiscordCommandHandler from './commands/discord/handlers/UnlinkDiscordCommandHandler';
import ListDiscordCommandHandler from './commands/discord/handlers/ListDiscordCommandHandler';
import ThreadsDiscordCommandHandler from './commands/discord/handlers/ThreadsDiscordCommandHandler';
import { WebhookService } from './services/WebhookService';
import DiscordToFluxerMessageRelay from './services/messageRelay/DiscordToFluxerMessageRelay';
import HelpDiscordCommandHandler from './commands/discord/handlers/HelpDiscordCommandHandler';
import AutolinkDiscordCommandHandler from './commands/discord/handlers/AutolinkDiscordCommandHandler';
import HealthCheckService from './services/HealthCheckService';
import FluxerEntityResolver from './services/entityResolver/FluxerEntityResolver';
import DiscordEntityResolver from './services/entityResolver/DiscordEntityResolver';
import DiscordMessageTransformer from './services/messageTransformer/DiscordMessageTransformer';
import MetricsService from './services/MetricsService';
import MessageQueueService from './services/MessageQueueService';
import FluxerStatsService from './services/statsService/FluxerStatsService';
import DiscordStatsService from './services/statsService/DiscordStatsService';
import StatsDiscordCommandHandler from './commands/discord/handlers/StatsDiscordCommandHandler';
import { DbStatsService } from './services/DbStatsService';
import ThreadSyncService from './services/threadSync/ThreadSyncService';

const startDiscordClient = async ({
    linkService,
    webhookService,
    healthCheckService,
    discordEntityResolver,
    fluxerEntityResolver,
    threadSyncService,
    metricsService,
    queueService,
    discordStatsService,
    fluxerStatsService,
    dbStatsService,
}: {
    linkService: LinkService;
    webhookService: WebhookService;
    healthCheckService: HealthCheckService;
    discordEntityResolver: DiscordEntityResolver;
    fluxerEntityResolver: FluxerEntityResolver;
    threadSyncService: ThreadSyncService;
    metricsService?: MetricsService;
    queueService?: MessageQueueService;
    discordStatsService: DiscordStatsService;
    fluxerStatsService: FluxerStatsService;
    dbStatsService: DbStatsService;
}): Promise<Client> => {
    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
        ],
        partials: [Partials.Message, Partials.Channel],
        presence: {
            status: 'online',
            activities: [
                {
                    name: 'Bridging to Fluxer',
                    type: 0,
                },
            ],
        },
    });

    webhookService.setDiscordClient(client);
    healthCheckService.setDiscordClient(client);
    discordEntityResolver.setDiscordClient(client);
    threadSyncService.setDiscordClient(client);
    discordStatsService.setClient(client);

    const messageTransformer = new DiscordMessageTransformer();
    const messageRelay = new DiscordToFluxerMessageRelay({
        linkService,
        webhookService,
        messageTransformer,
        metricsService,
        queueService,
        fluxerEntityResolver,
        threadSyncService,
    });

    const commandRegistry = new CommandRegistry<DiscordCommandHandler>();
    commandRegistry.registerCommand(
        'help',
        new HelpDiscordCommandHandler(client)
    );
    commandRegistry.registerCommand(
        'stats',
        new StatsDiscordCommandHandler(
            client,
            discordStatsService,
            fluxerStatsService,
            dbStatsService
        )
    );
    commandRegistry.registerCommand(
        'link',
        new LinkDiscordCommandHandler(
            client,
            linkService,
            webhookService,
            fluxerEntityResolver,
            threadSyncService
        )
    );
    commandRegistry.registerCommand(
        'unlink',
        new UnlinkDiscordCommandHandler(
            client,
            linkService,
            webhookService,
            threadSyncService
        )
    );
    commandRegistry.registerCommand(
        'list',
        new ListDiscordCommandHandler(client, linkService, fluxerEntityResolver)
    );
    commandRegistry.registerCommand(
        'threads',
        new ThreadsDiscordCommandHandler(client, linkService)
    );
    commandRegistry.registerCommand(
        'autolink',
        new AutolinkDiscordCommandHandler(
            client,
            linkService,
            webhookService,
            fluxerEntityResolver
        )
    );

    client.once(Events.ClientReady, () => {
        logger.info(`Discord bot logged in as ${client.user?.tag}`);

        if (queueService) {
            queueService
                .drain(webhookService, linkService)
                .catch((err) =>
                    logger.error('Startup queue drain error:', err)
                );
            queueService.startDrainInterval(webhookService, linkService);
        }

        healthCheckService.pushDiscordHealthStatus();
        setInterval(async () => {
            await healthCheckService.pushDiscordHealthStatus();
        }, 30_000);
    });

    client.on(Events.Error, (error) => {
        logger.error('Discord client error:', error);
    });

    client.on(Events.ThreadCreate, async (thread, newlyCreated) => {
        // `newlyCreated` is false when the bot merely gained access to an
        // existing thread; those are handled lazily on their first message.
        if (!newlyCreated) return;
        if (isFluxerApiBlocked()) return;
        try {
            await threadSyncService.resolveDiscordThread(thread, 'auto');
        } catch (error) {
            logger.error('Error handling Discord thread creation:', error);
        }
    });

    client.on(Events.ThreadUpdate, async (oldThread, newThread) => {
        if (isFluxerApiBlocked()) return;
        try {
            await threadSyncService.handleDiscordThreadUpdate(
                oldThread,
                newThread
            );
        } catch (error) {
            logger.error('Error handling Discord thread update:', error);
        }
    });

    client.on(Events.ThreadDelete, async (thread) => {
        try {
            await threadSyncService.handleDiscordThreadDelete(thread.id);
        } catch (error) {
            logger.error('Error handling Discord thread deletion:', error);
        }
    });

    client.on(Events.MessageDelete, async (message) => {
        if (!message.inGuild()) return;

        const messageLink = await linkService.getMessageLinkByDiscordMessageId(
            message.id
        );
        if (!messageLink) return;

        try {
            linkService.deleteMessageLink(messageLink.id);
        } catch (error) {
            logger.error('Error deleting message link from database:', error);
        }

        const context =
            await linkService.resolveContextForMessageLink(messageLink);
        if (!context) return;
        const { channelLink, threadLink } = context;

        const guildLink = await linkService.getGuildLinkById(
            channelLink.guildLinkId
        );
        if (!guildLink) return;

        if (isFluxerApiBlocked()) return;

        const msg = await fluxerEntityResolver
            .fetchMessage(
                guildLink.fluxerGuildId,
                threadLink?.fluxerThreadId ?? channelLink.fluxerChannelId,
                messageLink.fluxerMessageId
            )
            .catch(() => null);
        if (!msg) {
            logger.error(
                'Could not find linked Fluxer message to delete for Discord message ID:',
                message.id
            );
            return;
        }

        try {
            await msg.delete();
        } catch (error) {
            logger.error('Error deleting message from Fluxer:', error);
        }
    });

    client.on(Events.MessageUpdate, async (_oldMessage, newMessage) => {
        if (newMessage.webhookId) return;

        const linkedMessage =
            await linkService.getMessageLinkByDiscordMessageId(newMessage.id);
        if (!linkedMessage) return;

        const context =
            await linkService.resolveContextForMessageLink(linkedMessage);
        if (!context) return;
        const { channelLink: linkedChannel, threadLink } = context;

        const guildLink = await linkService.getGuildLinkById(
            linkedChannel.guildLinkId
        );
        if (!guildLink) return;

        if (isFluxerApiBlocked()) return;

        const webhook = await webhookService.getFluxerWebhook(
            linkedChannel.fluxerWebhookId,
            linkedChannel.fluxerWebhookToken
        );
        if (!webhook) {
            logger.warn(
                `No webhook found for linked channel ${linkedChannel.linkId}, cannot relay message update`
            );
            return;
        }

        const fluxerEmojis = await fluxerEntityResolver.fetchEmojis(
            guildLink.fluxerGuildId
        );

        const newMsg = await messageTransformer.transformMessage(
            newMessage,
            fluxerEmojis
        );
        try {
            await webhookService.editMessageViaFluxerWebhook(
                webhook,
                linkedMessage.fluxerMessageId,
                newMsg,
                threadLink?.fluxerThreadId ?? null
            );
        } catch (error) {
            logger.error('Error editing message via Fluxer webhook:', error);
        }
    });

    client.on(Events.MessageCreate, async (message) => {
        if (message.author.id === client.user?.id) return;

        if (message.inGuild() && message.webhookId) {
            const context = await linkService.resolveDiscordContext(
                message.channelId
            );
            if (
                context &&
                context.channelLink.discordWebhookId === message.webhookId
            )
                return;
        }

        if (
            isCommandString(message.content, COMMAND_PREFIX) &&
            !message.author.bot
        ) {
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
                                text: `${message.author.username} used ${message.content}`,
                                iconURL: message.author.displayAvatarURL(),
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
                    `Error executing discord command "${command}":`,
                    error
                );
            }

            if (DELETE_INVOCATION && message.inGuild()) {
                message
                    .delete()
                    .catch((err) =>
                        logger.error(
                            'Failed to delete invocation message:',
                            err
                        )
                    );
            }
        }

        if (
            message.inGuild() &&
            (message.channel instanceof TextChannel ||
                message.channel.isThread()) &&
            !isCommandString(message.content, COMMAND_PREFIX)
        ) {
            await messageRelay.relayMessage(message);
        }
    });

    await client.login(DISCORD_TOKEN);

    return client;
};

export default startDiscordClient;
