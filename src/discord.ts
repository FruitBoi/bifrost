import {
    Client,
    EmbedBuilder,
    Events,
    GatewayIntentBits,
    Message,
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
import { fluxerLocationId } from './db/entities/ChannelLink';
import LinkDiscordCommandHandler from './commands/discord/handlers/LinkDiscordCommandHandler';
import UnlinkDiscordCommandHandler from './commands/discord/handlers/UnlinkDiscordCommandHandler';
import ListDiscordCommandHandler from './commands/discord/handlers/ListDiscordCommandHandler';
import ThreadsDiscordCommandHandler from './commands/discord/handlers/ThreadsDiscordCommandHandler';
import PinsDiscordCommandHandler from './commands/discord/handlers/PinsDiscordCommandHandler';
import PinBridgeService from './services/pinBridge/PinBridgeService';
import IdentityClaimService from './services/identityClaim/IdentityClaimService';
import DiscordIdentityClaimPromptSender from './services/identityClaim/DiscordIdentityClaimPromptSender';
import IamDiscordCommandHandler from './commands/discord/handlers/IamDiscordCommandHandler';
import { IAM_COMMAND_NAMES } from './services/identityClaim/iamCommand';
import { WebhookService } from './services/WebhookService';
import DiscordToFluxerMessageRelay from './services/messageRelay/DiscordToFluxerMessageRelay';
import DiscordToFluxerReactionRelay from './services/reactionBridge/DiscordToFluxerReactionRelay';
import TypingBridgeService from './services/typingBridge/TypingBridgeService';
import HelpDiscordCommandHandler from './commands/discord/handlers/HelpDiscordCommandHandler';
import AutolinkDiscordCommandHandler from './commands/discord/handlers/AutolinkDiscordCommandHandler';
import HealthCheckService from './services/HealthCheckService';
import FluxerEntityResolver from './services/entityResolver/FluxerEntityResolver';
import DiscordEntityResolver from './services/entityResolver/DiscordEntityResolver';
import DiscordMessageTransformer from './services/messageTransformer/DiscordMessageTransformer';
import ReplyLinkResolver from './services/replyQuote/ReplyLinkResolver';
import MentionBridgeService from './services/mentionBridge/MentionBridgeService';
import MetricsService from './services/MetricsService';
import MessageQueueService from './services/MessageQueueService';
import FluxerStatsService from './services/statsService/FluxerStatsService';
import DiscordStatsService from './services/statsService/DiscordStatsService';
import StatsDiscordCommandHandler from './commands/discord/handlers/StatsDiscordCommandHandler';
import { DbStatsService } from './services/DbStatsService';
import ThreadSyncService from './services/threadSync/ThreadSyncService';
import LinkProvisioner from './services/LinkProvisioner';
import CategorySyncService from './services/categorySync/CategorySyncService';
import CategoryDiscordCommandHandler from './commands/discord/handlers/CategoryDiscordCommandHandler';
import VoiceDiscordCommandHandler from './commands/discord/handlers/VoiceDiscordCommandHandler';
import RemindMeDiscordCommandHandler from './commands/discord/handlers/RemindMeDiscordCommandHandler';
import ReminderDiscordCommandHandler from './commands/discord/handlers/ReminderDiscordCommandHandler';
import ReminderService from './services/reminders/ReminderService';
import ReminderTimezoneService from './services/reminders/ReminderTimezoneService';
import TimezoneDiscordCommandHandler from './commands/discord/handlers/TimezoneDiscordCommandHandler';
import { TIMEZONE_COMMAND_NAMES } from './commands/timezoneCommand';
import DiscordReminderDeliverer from './services/reminders/DiscordReminderDeliverer';
import { parseReminderTrigger } from './commands/reminderTrigger';
import CleanDiscordCommandHandler from './commands/discord/handlers/CleanDiscordCommandHandler';
import { parseCommandTrigger } from './commands/commandTrigger';
import {
    handleSlashCommand,
    registerSlashCommands,
} from './commands/discord/slashCommands';
import {
    discordAllowedCommandNames,
    pickFluxerOnlyReply,
} from './commands/discord/fluxerOnly';
import { CLEAN_COMMAND_NAMES } from './services/clean/cleanArgs';
import ExpressionsDiscordCommandHandler from './commands/discord/handlers/ExpressionsDiscordCommandHandler';
import ExpressionTransferService from './services/expressionTransfer/ExpressionTransferService';
import { EXPRESSIONS_COMMAND_NAMES } from './services/expressionTransfer/expressionsCommand';
import HistoryDiscordCommandHandler from './commands/discord/handlers/HistoryDiscordCommandHandler';
import HistoryTransferService from './services/history/HistoryTransferService';
import ClaudeRequestDiscordCommandHandler from './commands/discord/handlers/ClaudeRequestDiscordCommandHandler';
import ClaudeRequestNotifyService from './services/claudeRequest/ClaudeRequestNotifyService';
import DiscordClaudeRequestNotifier from './services/claudeRequest/DiscordClaudeRequestNotifier';
import DiscordClaudeRequestReplyHandler from './services/claudeRequest/DiscordClaudeRequestReplyHandler';
import ClaudeRequestService, {
    CLAUDE_REQUEST_COMMAND_NAMES,
} from './services/claudeRequest/ClaudeRequestService';
import LinesDiscordCommandHandler from './commands/discord/handlers/LinesDiscordCommandHandler';
import FishTradeDiscordCommandHandler from './commands/discord/handlers/FishTradeDiscordCommandHandler';
import { FISH_TRADE_COMMAND_NAMES } from './services/fishTrading/fishTrading';
import ClaudeLinesService, {
    CLAUDE_LINES_COMMAND_NAMES,
} from './services/claudeLines/ClaudeLinesService';
import { HISTORY_COMMAND_NAMES } from './services/history/historyArgs';
import { BotConfig } from './config/BotConfig';

const startDiscordClient = async ({
    linkService,
    linkProvisioner,
    webhookService,
    healthCheckService,
    discordEntityResolver,
    fluxerEntityResolver,
    threadSyncService,
    categorySyncService,
    expressionTransferService,
    metricsService,
    queueService,
    discordStatsService,
    fluxerStatsService,
    dbStatsService,
    reminderService,
    reminderTimezoneService,
    historyService,
    pinBridgeService,
    identityClaimService,
    claudeRequestService,
    claudeRequestNotifyService,
    claudeLinesService,
    botConfig,
}: {
    linkService: LinkService;
    linkProvisioner: LinkProvisioner;
    webhookService: WebhookService;
    healthCheckService: HealthCheckService;
    discordEntityResolver: DiscordEntityResolver;
    fluxerEntityResolver: FluxerEntityResolver;
    threadSyncService: ThreadSyncService;
    categorySyncService: CategorySyncService;
    expressionTransferService: ExpressionTransferService;
    metricsService?: MetricsService;
    queueService?: MessageQueueService;
    discordStatsService: DiscordStatsService;
    fluxerStatsService: FluxerStatsService;
    dbStatsService: DbStatsService;
    reminderService: ReminderService;
    reminderTimezoneService: ReminderTimezoneService;
    historyService: HistoryTransferService;
    pinBridgeService: PinBridgeService;
    identityClaimService: IdentityClaimService;
    claudeRequestService: ClaudeRequestService;
    claudeRequestNotifyService: ClaudeRequestNotifyService | null;
    claudeLinesService: ClaudeLinesService;
    botConfig: BotConfig;
}): Promise<Client> => {
    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
            GatewayIntentBits.GuildVoiceStates,
            GatewayIntentBits.GuildMessageReactions,
            // Typing events are frequent; only subscribe when they're bridged.
            ...(botConfig.typing.enabled
                ? [GatewayIntentBits.GuildMessageTyping]
                : []),
        ],
        // Reaction/User partials: without them discord.js drops reaction
        // events on uncached messages and removals by uncached users.
        partials: [
            Partials.Message,
            Partials.Channel,
            Partials.Reaction,
            Partials.User,
        ],
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
    categorySyncService.setDiscordClient(client);
    discordStatsService.setClient(client);

    const messageTransformer = new DiscordMessageTransformer(
        new MentionBridgeService(linkService, {
            roleLookup: {
                fetchDiscordRoles: (id) => discordEntityResolver.fetchRoles(id),
                fetchFluxerRoles: (id) => fluxerEntityResolver.fetchRoles(id),
            },
            bridgeRoleMentions: botConfig.roles.bridgeMentions,
        }),
        new ReplyLinkResolver(linkService)
    );
    const messageRelay = new DiscordToFluxerMessageRelay({
        linkService,
        webhookService,
        messageTransformer,
        metricsService,
        queueService,
        fluxerEntityResolver,
        threadSyncService,
    });
    pinBridgeService.setDiscordRelay(messageRelay);
    const reactionRelay = new DiscordToFluxerReactionRelay({
        linkService,
        fluxerEntityResolver,
        metricsService,
    });
    const typingBridge = new TypingBridgeService({
        linkService,
        discordEntityResolver,
        fluxerEntityResolver,
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
            linkProvisioner,
            fluxerEntityResolver
        )
    );
    commandRegistry.registerCommand(
        'unlink',
        new UnlinkDiscordCommandHandler(client, linkService, linkProvisioner)
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
        'pins',
        new PinsDiscordCommandHandler(client, linkService, pinBridgeService)
    );
    identityClaimService.setPromptSender(
        'discord',
        new DiscordIdentityClaimPromptSender(client)
    );
    const iamHandler = new IamDiscordCommandHandler(
        client,
        linkService,
        identityClaimService
    );
    for (const name of IAM_COMMAND_NAMES) {
        commandRegistry.registerCommand(name, iamHandler);
    }
    commandRegistry.registerCommand(
        'category',
        new CategoryDiscordCommandHandler(
            client,
            linkService,
            categorySyncService
        )
    );
    commandRegistry.registerCommand(
        'voice',
        new VoiceDiscordCommandHandler(client, linkService, linkProvisioner)
    );
    commandRegistry.registerCommand(
        'autolink',
        new AutolinkDiscordCommandHandler(
            client,
            linkService,
            linkProvisioner,
            fluxerEntityResolver
        )
    );
    const expressionsHandler = new ExpressionsDiscordCommandHandler(
        client,
        linkService,
        expressionTransferService
    );
    for (const name of EXPRESSIONS_COMMAND_NAMES) {
        commandRegistry.registerCommand(name, expressionsHandler);
    }

    const remindersEnabled = botConfig.reminders.enabled;
    if (remindersEnabled) {
        const triggerPrefixes = botConfig.reminders.triggerPrefixes;
        const remindMeHandler = new RemindMeDiscordCommandHandler(
            client,
            reminderService,
            reminderTimezoneService,
            triggerPrefixes
        );
        for (const name of ['remindme', 'remind']) {
            commandRegistry.registerCommand(name, remindMeHandler);
        }
        const reminderHandler = new ReminderDiscordCommandHandler(
            client,
            reminderService,
            triggerPrefixes
        );
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
        const timezoneHandler = new TimezoneDiscordCommandHandler(
            client,
            reminderTimezoneService,
            triggerPrefixes
        );
        for (const name of TIMEZONE_COMMAND_NAMES) {
            commandRegistry.registerCommand(name, timezoneHandler);
        }
    }

    const cleanEnabled = botConfig.clean.enabled;
    if (cleanEnabled) {
        const cleanHandler = new CleanDiscordCommandHandler(
            client,
            botConfig.roles.moderator,
            botConfig.clean.triggerPrefixes
        );
        for (const name of CLEAN_COMMAND_NAMES) {
            commandRegistry.registerCommand(name, cleanHandler);
        }
    }

    if (botConfig.history.enabled) {
        const historyHandler = new HistoryDiscordCommandHandler(client, {
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

    // Issue #40: `clauderequest` invocations, the bot's replies to them and
    // the "done" notices are bridged like ordinary chat.
    const bridgeClaudeRequestMessage = async (bridged: Message) => {
        if (
            !bridged.inGuild() ||
            !(
                bridged.channel instanceof TextChannel ||
                bridged.channel.isThread()
            )
        )
            return;
        try {
            await messageRelay.relayMessage(bridged);
        } catch (error) {
            logger.error(
                '❌ Failed to bridge a Claude request message:',
                error
            );
        }
    };
    const isClaudeRequestCommand = (command: string) =>
        botConfig.claudeRequests.enabled &&
        (CLAUDE_REQUEST_COMMAND_NAMES as readonly string[]).includes(command);

    // Replies to "Claude request implemented/closed" notices (issue #35).
    const claudeRequestReplyHandler =
        botConfig.claudeRequests.enabled && claudeRequestNotifyService
            ? new DiscordClaudeRequestReplyHandler(
                  claudeRequestService,
                  claudeRequestNotifyService,
                  botConfig.roles.claudeRequest
              )
            : null;

    if (botConfig.claudeRequests.enabled) {
        const claudeRequestHandler = new ClaudeRequestDiscordCommandHandler(
            client,
            claudeRequestService,
            botConfig.roles.claudeRequest,
            claudeRequestNotifyService,
            bridgeClaudeRequestMessage
        );
        for (const name of CLAUDE_REQUEST_COMMAND_NAMES) {
            commandRegistry.registerCommand(name, claudeRequestHandler);
        }
    }

    const linesHandler = new LinesDiscordCommandHandler(
        client,
        claudeLinesService
    );
    for (const name of CLAUDE_LINES_COMMAND_NAMES) {
        commandRegistry.registerCommand(name, linesHandler);
    }

    const fishTradeHandler = new FishTradeDiscordCommandHandler(client);
    for (const name of FISH_TRADE_COMMAND_NAMES) {
        commandRegistry.registerCommand(name, fishTradeHandler);
    }

    // Issue #39: with `commands.fluxerOnly`, Discord only runs the bridging
    // and YAGPDB commands; everything else gets a "use Fluxer" reply.
    const fluxerOnly = botConfig.commands.fluxerOnly;
    const discordAllowed = discordAllowedCommandNames(commandRegistry);
    const isDiscordAllowed = (command: string) =>
        !fluxerOnly || discordAllowed.has(command);

    client.once(Events.ClientReady, () => {
        logger.info(`💬 Discord bot logged in as ${client.user?.tag}`);

        reminderService.setDeliverer(
            'discord',
            new DiscordReminderDeliverer(client)
        );
        claudeRequestNotifyService?.setNotifier(
            'discord',
            new DiscordClaudeRequestNotifier(client, bridgeClaudeRequestMessage)
        );

        if (botConfig.commands.slashCommands) {
            void registerSlashCommands(
                client,
                commandRegistry,
                commandRegistry.getCommandNames().filter(isDiscordAllowed)
            );
        }

        if (queueService) {
            queueService
                .drain(webhookService, linkService)
                .catch((err) =>
                    logger.error('❌ Startup queue drain error:', err)
                );
            queueService.startDrainInterval(webhookService, linkService);
        }

        healthCheckService.pushDiscordHealthStatus();
        setInterval(async () => {
            await healthCheckService.pushDiscordHealthStatus();
        }, 30_000);
    });

    client.on(Events.Error, (error) => {
        logger.error('❌ Discord client error:', error);
    });

    client.on(Events.ChannelCreate, async (channel) => {
        if (isFluxerApiBlocked()) return;
        try {
            await categorySyncService.handleDiscordChannelCreate(channel);
        } catch (error) {
            logger.error('❌ Error handling Discord channel creation:', error);
        }
    });

    client.on(Events.ChannelUpdate, async (oldChannel, newChannel) => {
        if (isFluxerApiBlocked()) return;
        try {
            await categorySyncService.handleDiscordChannelUpdate(
                oldChannel,
                newChannel
            );
        } catch (error) {
            logger.error('❌ Error handling Discord channel update:', error);
        }
    });

    client.on(Events.ChannelDelete, async (channel) => {
        try {
            await categorySyncService.handleDiscordChannelDelete(channel);
        } catch (error) {
            logger.error('❌ Error handling Discord channel deletion:', error);
        }
    });

    client.on(Events.ThreadCreate, async (thread, newlyCreated) => {
        // `newlyCreated` is false when the bot merely gained access to an
        // existing thread; those are handled lazily on their first message.
        if (!newlyCreated) return;
        if (isFluxerApiBlocked()) return;
        try {
            await threadSyncService.resolveDiscordThread(thread, 'auto');
        } catch (error) {
            logger.error('❌ Error handling Discord thread creation:', error);
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
            logger.error('❌ Error handling Discord thread update:', error);
        }
    });

    client.on(Events.ThreadDelete, async (thread) => {
        try {
            await threadSyncService.handleDiscordThreadDelete(thread.id);
        } catch (error) {
            logger.error('❌ Error handling Discord thread deletion:', error);
        }
    });

    /**
     * Deletes the bridged Fluxer copy of a Discord message that was deleted
     * (singly or as part of a bulk delete) and forgets the message link.
     */
    async function mirrorDiscordMessageDelete(messageId: string) {
        const messageLink =
            await linkService.getMessageLinkByDiscordMessageId(messageId);
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

        if (isFluxerApiBlocked()) return;

        const msg = await fluxerEntityResolver
            .fetchMessage(
                guildLink.fluxerGuildId,
                fluxerLocationId(channelLink),
                messageLink.fluxerMessageId
            )
            .catch(() => null);
        if (!msg) {
            logger.error(
                '❌ Could not find linked Fluxer message to delete for Discord message ID:',
                messageId
            );
            return;
        }

        try {
            await msg.delete();
        } catch (error) {
            logger.error('❌ Error deleting message from Fluxer:', error);
        }
    }

    client.on(Events.MessageDelete, async (message) => {
        if (!message.inGuild()) return;
        await mirrorDiscordMessageDelete(message.id);
    });

    // Bulk deletes (e.g. the `clean` command) arrive as one event instead of
    // a MessageDelete per message; mirror each of them to Fluxer.
    client.on(Events.MessageBulkDelete, async (messages, channel) => {
        if (!channel.isTextBased() || !channel.guild) return;
        for (const id of messages.keys()) {
            try {
                await mirrorDiscordMessageDelete(id);
            } catch (error) {
                logger.error(
                    '❌ Error mirroring a bulk-deleted Discord message to Fluxer:',
                    error
                );
            }
        }
    });

    // Reaction bridging (issue #13): mirror reactions on bridged messages
    // onto the counterpart on the other platform. Off via
    // `reactions.enabled: false`.
    if (botConfig.reactions.enabled) {
        client.on(Events.MessageReactionAdd, async (reaction, user) => {
            try {
                await reactionRelay.handleReactionAdd(reaction, user);
            } catch (error) {
                logger.error('❌ Error mirroring Discord reaction add:', error);
            }
        });

        client.on(Events.MessageReactionRemove, async (reaction, user) => {
            try {
                await reactionRelay.handleReactionRemove(reaction, user);
            } catch (error) {
                logger.error(
                    '❌ Error mirroring Discord reaction removal:',
                    error
                );
            }
        });

        client.on(Events.MessageReactionRemoveAll, async (message) => {
            try {
                await reactionRelay.handleReactionRemoveAll(message);
            } catch (error) {
                logger.error(
                    '❌ Error mirroring Discord reaction clear-all:',
                    error
                );
            }
        });

        client.on(Events.MessageReactionRemoveEmoji, async (reaction) => {
            try {
                await reactionRelay.handleReactionRemoveEmoji(reaction);
            } catch (error) {
                logger.error(
                    '❌ Error mirroring Discord reaction emoji clear:',
                    error
                );
            }
        });
    }

    // Pin bridging (issue #33): the event only says that a channel's pins
    // changed, so the service diffs them against what it saw last and
    // mirrors the change onto bridged messages. Off via `pins.enabled: false`.
    if (botConfig.pins.enabled) {
        client.on(Events.ChannelPinsUpdate, async (channel) => {
            if (channel.isDMBased()) return;
            await pinBridgeService.handleDiscordPinsUpdate(channel.id);
        });
    }

    // Typing bridging (issue #25): show the bot typing in the linked Fluxer
    // location while someone types here. Off via `typing.enabled: false`.
    if (botConfig.typing.enabled) {
        client.on(Events.TypingStart, async (typing) => {
            if (!typing.inGuild()) return;
            if (typing.user.id === client.user?.id) return;
            try {
                await typingBridge.handleDiscordTyping(typing.channel.id);
            } catch (error) {
                logger.error('❌ Error mirroring Discord typing:', error);
            }
        });
    }

    client.on(Events.MessageUpdate, async (_oldMessage, newMessage) => {
        if (newMessage.webhookId) return;

        const linkedMessage =
            await linkService.getMessageLinkByDiscordMessageId(newMessage.id);
        if (!linkedMessage) return;

        const linkedChannel = await linkService.getChannelLinkById(
            linkedMessage.channelLinkId
        );
        if (!linkedChannel) return;

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
                `⚠️ No webhook found for linked channel ${linkedChannel.linkId}, cannot relay message update`
            );
            return;
        }

        const fluxerEmojis = await fluxerEntityResolver.fetchEmojis(
            guildLink.fluxerGuildId
        );

        const newMsg = await messageTransformer.transformMessage(
            newMessage,
            fluxerEmojis,
            { isEdit: true }
        );
        try {
            await webhookService.editMessageViaFluxerWebhook(
                webhook,
                linkedMessage.fluxerMessageId,
                newMsg,
                linkedChannel.fluxerThreadId
            );
        } catch (error) {
            logger.error('❌ Error editing message via Fluxer webhook:', error);
        }
    });

    client.on(Events.InteractionCreate, async (interaction) => {
        if (!interaction.isChatInputCommand()) return;
        if (!botConfig.commands.slashCommands) return;
        try {
            await handleSlashCommand(
                interaction,
                commandRegistry,
                isDiscordAllowed
            );
        } catch (error) {
            logger.error('❌ Error handling Discord slash command:', error);
        }
    });

    client.on(Events.MessageCreate, async (message) => {
        if (message.author.id === client.user?.id) return;

        if (message.inGuild() && message.webhookId) {
            const link = await linkService.getChannelLinkByDiscordLocation(
                message.channelId
            );
            if (link && link.discordWebhookId === message.webhookId) return;
        }

        const isBotCommand = isCommandString(message.content, COMMAND_PREFIX);
        // Short reminder triggers (`?remindme ...`); a bot-prefix message is
        // never one, so `!b remindme` and `!remindme` take different paths.
        const reminderTrigger =
            remindersEnabled && !isBotCommand
                ? parseReminderTrigger(
                      message.content,
                      botConfig.reminders.triggerPrefixes
                  )
                : null;
        const isReminderInvocation = reminderTrigger !== null;
        // Likewise `?clean 10` / `!clean 10`.
        const cleanTrigger =
            cleanEnabled && !isBotCommand
                ? parseCommandTrigger(
                      message.content,
                      botConfig.clean.triggerPrefixes,
                      CLEAN_COMMAND_NAMES
                  )
                : null;
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

        const runCommand = async (
            handler: DiscordCommandHandler,
            command: string,
            args: string[]
        ) => {
            if (isClaudeRequestCommand(command) && !message.author.bot) {
                await bridgeClaudeRequestMessage(message);
            }
            try {
                await handler.handleCommand(message, command, ...args);
            } catch (error) {
                logger.error(
                    `❌ Error executing discord command "${command}":`,
                    error
                );
            }

            if (DELETE_INVOCATION && message.inGuild()) {
                message
                    .delete()
                    .catch((err) =>
                        logger.error(
                            '❌ Failed to delete invocation message:',
                            err
                        )
                    );
            }
        };

        const replyFluxerOnly = async () => {
            await message
                .reply({
                    content: pickFluxerOnlyReply(),
                    allowedMentions: { parse: [], repliedUser: true },
                })
                .catch((err) =>
                    logger.error('❌ Failed to send a Fluxer-only reply:', err)
                );
        };

        if (isBotCommand && !message.author.bot) {
            const { command, args } = parseCommandString(
                message.content,
                COMMAND_PREFIX
            );
            const handler = commandRegistry.getCommandHandler(command);
            if (!isDiscordAllowed(command)) {
                await replyFluxerOnly();
                return;
            }
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

            await runCommand(handler, command, args);
        } else if (reminderTrigger && !message.author.bot) {
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
        } else if (cleanTrigger && !message.author.bot) {
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
        } else if (commandTrigger && !message.author.bot) {
            const handler = commandRegistry.getCommandHandler(
                commandTrigger.command
            );
            if (!isDiscordAllowed(commandTrigger.command)) {
                await replyFluxerOnly();
            } else if (handler) {
                await runCommand(
                    handler,
                    commandTrigger.command,
                    commandTrigger.rawArgs.split(/\s+/).filter(Boolean)
                );
            }
        }

        // A permitted reply to a Claude request notice (issue #35) is also
        // commented on GitHub. Not awaited: it never rejects, and the
        // message is still relayed below as ordinary chat.
        if (claudeRequestReplyHandler && !isBotCommand && !isShortInvocation) {
            void claudeRequestReplyHandler.handle(message);
        }

        if (
            message.inGuild() &&
            (message.channel instanceof TextChannel ||
                message.channel.isThread()) &&
            !isBotCommand &&
            !isShortInvocation
        ) {
            await messageRelay.relayMessage(message);
        }
    });

    await client.login(DISCORD_TOKEN);

    return client;
};

export default startDiscordClient;
