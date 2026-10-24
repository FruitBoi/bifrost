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
import PinsFluxerCommandHandler from './commands/fluxer/handlers/PinsFluxerCommandHandler';
import PinBridgeService from './services/pinBridge/PinBridgeService';
import IdentityClaimService from './services/identityClaim/IdentityClaimService';
import FluxerIdentityClaimPromptSender from './services/identityClaim/FluxerIdentityClaimPromptSender';
import IamFluxerCommandHandler from './commands/fluxer/handlers/IamFluxerCommandHandler';
import { IAM_COMMAND_NAMES } from './services/identityClaim/iamCommand';
import { WebhookService } from './services/WebhookService';
import FluxerToDiscordMessageRelay from './services/messageRelay/FluxerToDiscordMessageRelay';
import FluxerToDiscordReactionRelay from './services/reactionBridge/FluxerToDiscordReactionRelay';
import TypingBridgeService from './services/typingBridge/TypingBridgeService';
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
import IdentityFluxerCommandHandler from './commands/fluxer/handlers/IdentityFluxerCommandHandler';
import type { BotConfig } from './config/BotConfig';
import VoiceFluxerCommandHandler from './commands/fluxer/handlers/VoiceFluxerCommandHandler';
import MeowService from './services/meow/MeowService';
import ReminderService from './services/reminders/ReminderService';
import ReminderTimezoneService from './services/reminders/ReminderTimezoneService';
import TimezoneFluxerCommandHandler from './commands/fluxer/handlers/TimezoneFluxerCommandHandler';
import { TIMEZONE_COMMAND_NAMES } from './commands/timezoneCommand';
import FluxerReminderDeliverer from './services/reminders/FluxerReminderDeliverer';
import RemindMeFluxerCommandHandler from './commands/fluxer/handlers/RemindMeFluxerCommandHandler';
import ReminderFluxerCommandHandler from './commands/fluxer/handlers/ReminderFluxerCommandHandler';
import { parseReminderTrigger } from './commands/reminderTrigger';
import CleanFluxerCommandHandler from './commands/fluxer/handlers/CleanFluxerCommandHandler';
import { parseCommandTrigger } from './commands/commandTrigger';
import { CLEAN_COMMAND_NAMES } from './services/clean/cleanArgs';
import ExpressionsFluxerCommandHandler from './commands/fluxer/handlers/ExpressionsFluxerCommandHandler';
import ExpressionTransferService from './services/expressionTransfer/ExpressionTransferService';
import { EXPRESSIONS_COMMAND_NAMES } from './services/expressionTransfer/expressionsCommand';
import HistoryFluxerCommandHandler from './commands/fluxer/handlers/HistoryFluxerCommandHandler';
import HistoryTransferService from './services/history/HistoryTransferService';
import ClaudeRequestFluxerCommandHandler from './commands/fluxer/handlers/ClaudeRequestFluxerCommandHandler';
import ClaudeRequestNotifyService from './services/claudeRequest/ClaudeRequestNotifyService';
import FluxerClaudeRequestNotifier from './services/claudeRequest/FluxerClaudeRequestNotifier';
import ClaudeRequestService, {
    CLAUDE_REQUEST_COMMAND_NAMES,
} from './services/claudeRequest/ClaudeRequestService';
import LinesFluxerCommandHandler from './commands/fluxer/handlers/LinesFluxerCommandHandler';
import FishTradeFluxerCommandHandler from './commands/fluxer/handlers/FishTradeFluxerCommandHandler';
import { FISH_TRADE_COMMAND_NAMES } from './services/fishTrading/fishTrading';
import ClaudeLinesService, {
    CLAUDE_LINES_COMMAND_NAMES,
} from './services/claudeLines/ClaudeLinesService';
import { HISTORY_COMMAND_NAMES } from './services/history/historyArgs';

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
    expressionTransferService,
    metricsService,
    queueService,
    discordStatsService,
    fluxerStatsService,
    dbStatsService,
    botConfig,
    reminderService,
    reminderTimezoneService,
    historyService,
    pinBridgeService,
    identityClaimService,
    claudeRequestService,
    claudeRequestNotifyService,
    claudeLinesService,
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
    expressionTransferService: ExpressionTransferService;
    metricsService?: MetricsService;
    queueService?: MessageQueueService;
    discordStatsService: DiscordStatsService;
    fluxerStatsService: FluxerStatsService;
    dbStatsService: DbStatsService;
    botConfig: BotConfig;
    reminderService: ReminderService;
    reminderTimezoneService: ReminderTimezoneService;
    historyService: HistoryTransferService;
    pinBridgeService: PinBridgeService;
    identityClaimService: IdentityClaimService;
    claudeRequestService: ClaudeRequestService;
    claudeRequestNotifyService: ClaudeRequestNotifyService | null;
    claudeLinesService: ClaudeLinesService;
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
        new MentionBridgeService(linkService, {
            roleLookup: {
                fetchDiscordRoles: (id) => discordEntityResolver.fetchRoles(id),
                fetchFluxerRoles: (id) => fluxerEntityResolver.fetchRoles(id),
            },
            bridgeRoleMentions: botConfig.roles.bridgeMentions,
        })
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
    pinBridgeService.setFluxerRelay(messageRelay);
    const reactionRelay = new FluxerToDiscordReactionRelay({
        linkService,
        discordEntityResolver,
        fluxerEntityResolver,
        metricsService,
    });
    reactionRelay.setFluxerClient(client);
    const typingBridge = new TypingBridgeService({
        linkService,
        discordEntityResolver,
        fluxerEntityResolver,
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
        'pins',
        new PinsFluxerCommandHandler(client, linkService, pinBridgeService)
    );
    identityClaimService.setPromptSender(
        'fluxer',
        new FluxerIdentityClaimPromptSender(client)
    );
    const iamHandler = new IamFluxerCommandHandler(
        client,
        linkService,
        identityClaimService
    );
    for (const name of IAM_COMMAND_NAMES) {
        commandRegistry.registerCommand(name, iamHandler);
    }
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
    const identityHandler = new IdentityFluxerCommandHandler(
        client,
        linkService,
        discordEntityResolver,
        threadMemberSyncService,
        botConfig.roles.identity
    );
    commandRegistry.registerCommand('role', identityHandler);
    commandRegistry.registerCommand('map', identityHandler);
    const expressionsHandler = new ExpressionsFluxerCommandHandler(
        client,
        linkService,
        expressionTransferService
    );
    for (const name of EXPRESSIONS_COMMAND_NAMES) {
        commandRegistry.registerCommand(name, expressionsHandler);
    }
    commandRegistry.registerCommand(
        'autolink',
        new AutolinkFluxerCommandHandler(
            client,
            linkService,
            linkProvisioner,
            discordEntityResolver
        )
    );
    if (botConfig.reminders.enabled) {
        const triggerPrefixes = botConfig.reminders.triggerPrefixes;
        const remindMeHandler = new RemindMeFluxerCommandHandler(
            client,
            reminderService,
            reminderTimezoneService,
            fluxerEntityResolver,
            triggerPrefixes
        );
        const reminderHandler = new ReminderFluxerCommandHandler(
            client,
            reminderService,
            fluxerEntityResolver,
            triggerPrefixes
        );
        for (const name of ['remindme', 'remind']) {
            commandRegistry.registerCommand(name, remindMeHandler);
        }
        for (const name of [
            'reminder',
            'reminders',
            'creminders',
            'channelreminders',
            'delreminder',
            'rmreminder',
        ]) {
            commandRegistry.registerCommand(name, reminderHandler);
        }
        const timezoneHandler = new TimezoneFluxerCommandHandler(
            client,
            reminderTimezoneService,
            triggerPrefixes
        );
        for (const name of TIMEZONE_COMMAND_NAMES) {
            commandRegistry.registerCommand(name, timezoneHandler);
        }
    }
    if (botConfig.clean.enabled) {
        const cleanHandler = new CleanFluxerCommandHandler(
            client,
            botConfig.roles.moderator,
            botConfig.clean.triggerPrefixes
        );
        for (const name of CLEAN_COMMAND_NAMES) {
            commandRegistry.registerCommand(name, cleanHandler);
        }
    }
    if (botConfig.history.enabled) {
        const historyHandler = new HistoryFluxerCommandHandler(client, {
            linkService,
            threadSyncService,
            messageRelay,
            historyService,
            moderatorRoleIds: botConfig.roles.moderator,
            limits: {
                defaultCount: botConfig.history.defaultCount,
                maxCount: botConfig.history.maxCount,
            },
            delayMs: botConfig.history.delayMs,
            triggerPrefixes: botConfig.commands.triggerPrefixes,
        });
        for (const name of HISTORY_COMMAND_NAMES) {
            commandRegistry.registerCommand(name, historyHandler);
        }
    }

    if (botConfig.claudeRequests.enabled) {
        const claudeRequestHandler = new ClaudeRequestFluxerCommandHandler(
            client,
            claudeRequestService,
            botConfig.roles.claudeRequest,
            claudeRequestNotifyService
        );
        for (const name of CLAUDE_REQUEST_COMMAND_NAMES) {
            commandRegistry.registerCommand(name, claudeRequestHandler);
        }
    }

    const linesHandler = new LinesFluxerCommandHandler(
        client,
        claudeLinesService
    );
    for (const name of CLAUDE_LINES_COMMAND_NAMES) {
        commandRegistry.registerCommand(name, linesHandler);
    }

    const fishTradeHandler = new FishTradeFluxerCommandHandler(client);
    for (const name of FISH_TRADE_COMMAND_NAMES) {
        commandRegistry.registerCommand(name, fishTradeHandler);
    }

    client.once(Events.Ready, () => {
        logger.info('🌊 Fluxer bot is ready!');
        healthCheckService.pushFluxerHealthStatus();
        // The Fluxer client is re-created on restart; registering the
        // deliverer on every Ready replaces the one bound to the old client.
        if (botConfig.reminders.enabled) {
            reminderService.setDeliverer(
                'fluxer',
                new FluxerReminderDeliverer(client)
            );
        }
        claudeRequestNotifyService?.setNotifier(
            'fluxer',
            new FluxerClaudeRequestNotifier(client)
        );
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

    // Reaction bridging (issue #13): mirror reactions on bridged messages
    // onto the counterpart on the other platform. Off via
    // `reactions.enabled: false`.
    if (botConfig.reactions.enabled) {
        client.on(Events.MessageReactionAdd, async (payload) => {
            try {
                await reactionRelay.handleReactionAdd(payload);
            } catch (error) {
                logger.error(
                    '❌ Error mirroring Fluxer reaction to Discord:',
                    error
                );
            }
        });

        client.on(Events.MessageReactionAddMany, async (payload) => {
            try {
                await reactionRelay.handleReactionAddMany(payload);
            } catch (error) {
                logger.error(
                    '❌ Error mirroring Fluxer reactions to Discord:',
                    error
                );
            }
        });

        client.on(Events.MessageReactionRemove, async (payload) => {
            try {
                await reactionRelay.handleReactionRemove(payload);
            } catch (error) {
                logger.error(
                    '❌ Error mirroring Fluxer reaction removal to Discord:',
                    error
                );
            }
        });

        client.on(Events.MessageReactionRemoveAll, async (payload) => {
            try {
                await reactionRelay.handleReactionRemoveAll(payload);
            } catch (error) {
                logger.error(
                    '❌ Error mirroring Fluxer reaction clear to Discord:',
                    error
                );
            }
        });

        client.on(Events.MessageReactionRemoveEmoji, async (payload) => {
            try {
                await reactionRelay.handleReactionRemoveEmoji(payload);
            } catch (error) {
                logger.error(
                    '❌ Error mirroring Fluxer emoji clear to Discord:',
                    error
                );
            }
        });
    }

    // Pin bridging (issue #33): the event only says that a channel's pins
    // changed, so the service diffs them against what it saw last and
    // mirrors the change onto bridged messages. Off via `pins.enabled: false`.
    if (botConfig.pins.enabled) {
        client.on(Events.ChannelPinsUpdate, async (payload) => {
            if (!payload.guildId) return;
            await pinBridgeService.handleFluxerPinsUpdate(payload.channelId);
        });
    }

    // Typing bridging (issue #25): show the bot typing in the linked Discord
    // location while someone types here. Off via `typing.enabled: false`.
    if (botConfig.typing.enabled) {
        client.on(Events.TypingStart, async (payload) => {
            if (!payload.guildId) return;
            if (payload.userId === client.user?.id) return;
            try {
                await typingBridge.handleFluxerTyping(payload.channelId);
            } catch (error) {
                logger.error('❌ Error mirroring Fluxer typing:', error);
            }
        });
    }

    // Deletes the bridged Discord copy of the Fluxer message `messageId`
    // (and its message link), if there is one. Shared by single deletions
    // and bulk deletions (e.g. the `clean` command), which Fluxer emits as
    // separate events.
    async function mirrorFluxerMessageDelete(messageId: string) {
        const messageLink =
            await linkService.getMessageLinkByFluxerMessageId(messageId);
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
                messageId
            );
            return;
        }

        try {
            await msg.delete();
        } catch (error) {
            logger.error('❌ Error deleting message from Discord:', error);
        }
    }

    client.on(Events.MessageDelete, async (message: PartialMessage) => {
        await mirrorFluxerMessageDelete(message.id);
    });

    client.on(Events.MessageDeleteBulk, async (payload) => {
        for (const id of payload.ids) {
            try {
                await mirrorFluxerMessageDelete(id);
            } catch (error) {
                logger.error(
                    `❌ Error mirroring bulk deletion of Fluxer message ${id} to Discord:`,
                    error
                );
            }
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

        // Runs a command handler and, when configured, deletes the
        // invoking message. Shared by the `!b` path and the short
        // triggers (`?remindme ...`, `?clean ...`).
        const runCommand = async (
            handler: FluxerCommandHandler,
            command: string,
            args: string[]
        ) => {
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
        };

        const isBotCommand = isCommandString(message.content, COMMAND_PREFIX);
        // `?remindme ...` / `!remindme ...` (issue #9). `!b remindme` is a
        // regular bot command and is never treated as a short trigger. Like
        // `!b` messages, a trigger-shaped message is never relayed, whoever
        // wrote it; only people (not bots or webhooks) get it executed.
        const reminderTrigger =
            !isBotCommand && botConfig.reminders.enabled
                ? parseReminderTrigger(
                      message.content,
                      botConfig.reminders.triggerPrefixes
                  )
                : null;
        const isReminderInvocation = reminderTrigger !== null;
        // `?clean 10` / `!clean 10` (issue #12), handled the same way.
        const cleanTrigger =
            botConfig.clean.enabled && !isBotCommand
                ? parseCommandTrigger(
                      message.content,
                      botConfig.clean.triggerPrefixes,
                      CLEAN_COMMAND_NAMES
                  )
                : null;
        // Short-trigger invocations are never relayed or meowed at.
        // Any registered command as `!<command>`; unknown names fall through
        // and are bridged as ordinary chat.
        const commandTrigger =
            !isBotCommand && !reminderTrigger && !cleanTrigger
                ? parseCommandTrigger(
                      message.content,
                      botConfig.commands.triggerPrefixes,
                      commandRegistry.getCommandNames()
                  )
                : null;
        const isShortInvocation =
            isReminderInvocation ||
            cleanTrigger !== null ||
            commandTrigger !== null;

        if (isBotCommand) {
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

            await runCommand(handler, command, args);
        } else if (
            reminderTrigger &&
            !message.author.bot &&
            !message.webhookId
        ) {
            const handler = commandRegistry.getCommandHandler(
                reminderTrigger.command
            );
            if (handler) {
                await runCommand(
                    handler,
                    reminderTrigger.command,
                    reminderTrigger.rawArgs.split(/\s+/).filter(Boolean)
                );
            }
        } else if (cleanTrigger && !message.author.bot && !message.webhookId) {
            const handler = commandRegistry.getCommandHandler(
                cleanTrigger.command
            );
            if (handler) {
                await runCommand(
                    handler,
                    cleanTrigger.command,
                    cleanTrigger.rawArgs.split(/\s+/).filter(Boolean)
                );
            }
        } else if (
            commandTrigger &&
            !message.author.bot &&
            !message.webhookId
        ) {
            const handler = commandRegistry.getCommandHandler(
                commandTrigger.command
            );
            if (handler) {
                await runCommand(
                    handler,
                    commandTrigger.command,
                    commandTrigger.rawArgs.split(/\s+/).filter(Boolean)
                );
            }
        }

        if (message.guildId && !isBotCommand && !isShortInvocation) {
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
            !isShortInvocation &&
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
