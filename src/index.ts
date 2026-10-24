import { CachedChannelLinkRepository } from './db/cachedrepos/CachedChannelLinkRepository';
import { CachedGuildLinkRepository } from './db/cachedrepos/CachedGuildLinkRepository';
import { CachedMessageLinkRepository } from './db/cachedrepos/CachedMessageLinkRepository';
import { initDatabase } from './db/migrator';
import { inviteBotPermissions, loadBotConfig } from './config/BotConfig';
import { SequelizeChannelLinkRepository } from './db/sequelizerepos/SequelizeChannelLinkRepository';
import { SequelizeGuildLinkRepository } from './db/sequelizerepos/SequelizeGuildLinkRepository';
import { SequelizeMessageLinkRepository } from './db/sequelizerepos/SequelizeMessageLinkRepository';
import { SequelizeCategoryLinkRepository } from './db/sequelizerepos/SequelizeCategoryLinkRepository';
import { SequelizeVoiceLinkRepository } from './db/sequelizerepos/SequelizeVoiceLinkRepository';
import { SequelizeUserLinkRepository } from './db/sequelizerepos/SequelizeUserLinkRepository';
import { SequelizeReminderRepository } from './db/sequelizerepos/SequelizeReminderRepository';
import { SequelizeUserTimezoneRepository } from './db/sequelizerepos/SequelizeUserTimezoneRepository';
import { SequelizeHistoryMessageRepository } from './db/sequelizerepos/SequelizeHistoryMessageRepository';
import HistoryTransferService from './services/history/HistoryTransferService';
import PinBridgeService from './services/pinBridge/PinBridgeService';
import IdentityClaimService from './services/identityClaim/IdentityClaimService';
import ClaudeRequestService from './services/claudeRequest/ClaudeRequestService';
import ClaudeRequestNotifyService from './services/claudeRequest/ClaudeRequestNotifyService';
import { SequelizeClaudeRequestRepository } from './db/sequelizerepos/SequelizeClaudeRequestRepository';
import { SequelizeClaudeRequestNoticeRepository } from './db/sequelizerepos/SequelizeClaudeRequestNoticeRepository';
import ClaudeLinesService from './services/claudeLines/ClaudeLinesService';
import startDiscordClient from './discord';
import type { Client as FluxerClient } from '@fluxerjs/core';
import startFluxerClient from './fluxer';
import { DbStatsService } from './services/DbStatsService';
import FluxerEntityResolver from './services/entityResolver/FluxerEntityResolver';
import DiscordEntityResolver from './services/entityResolver/DiscordEntityResolver';
import HealthCheckService from './services/HealthCheckService';
import MetricsService from './services/MetricsService';
import MessageQueueService from './services/MessageQueueService';
import { LinkService } from './services/LinkService';
import { WebhookService } from './services/WebhookService';
import ThreadDirectoryService from './services/threadDirectory/ThreadDirectoryService';
import { SequelizeThreadDirectoryRepository } from './db/sequelizerepos/SequelizeThreadDirectoryRepository';
import ThreadSyncService from './services/threadSync/ThreadSyncService';
import LinkProvisioner from './services/LinkProvisioner';
import CategorySyncService from './services/categorySync/CategorySyncService';
import ThreadMemberSyncService from './services/threadMemberSync/ThreadMemberSyncService';
import ExpressionTransferService from './services/expressionTransfer/ExpressionTransferService';
import ReminderService from './services/reminders/ReminderService';
import ReminderTimezoneService from './services/reminders/ReminderTimezoneService';
import {
    DISCORD_APP_ID,
    DISABLE_MESSAGE_QUEUE,
    ENABLE_VOICE_BRIDGE,
    VOICE_LEAVE_GRACE_MS,
    DISCORD_HEALTH_URL,
    ENABLE_WEB_DASHBOARD,
    FLUXER_APP_ID,
    FLUXER_HEALTH_URL,
    GIT_COMMIT,
    METRICS_PORT,
    QUEUE_TTL_MS,
    REPO_URL,
    WEB_PORT,
    GITHUB_TOKEN,
    COMMAND_PREFIX,
} from './utils/env';
import { createWebApp } from './web/app';
import {
    generateDiscordBotInviteLink,
    generateFluxerBotInviteLink,
} from './utils/generateBotInvite';
import logger from './utils/logging/logger';
import DiscordStatsService from './services/statsService/DiscordStatsService';
import FluxerStatsService from './services/statsService/FluxerStatsService';
import type VoiceBridgeService from './services/voice/VoiceBridgeService';
import type { VoiceTransport } from './services/voice/VoiceTransport';

const main = async () => {
    const {
        config: botConfig,
        source: botConfigSource,
        unknownKeys,
        deprecatedKeys,
    } = loadBotConfig();
    logger.info(
        botConfigSource
            ? `Loaded config file ${botConfigSource}`
            : 'No config file found; using default configuration'
    );
    for (const key of unknownKeys) {
        logger.warn(`Config: ignoring unknown key "${key}"`);
    }
    for (const { key, replacement, applied } of deprecatedKeys) {
        logger.warn(
            applied
                ? `Config: "${key}" is deprecated, rename it to "${replacement}"`
                : `Config: ignoring deprecated key "${key}" because "${replacement}" is set`
        );
    }
    if (!botConfig.permissions.manageThreads) {
        logger.info(
            'Config: Manage Threads is not requested (permissions.manageThreads=false); the bot can rename only threads it created and will never delete threads'
        );
    }

    await initDatabase();

    logger.debug(
        `GIT_COMMIT: ${GIT_COMMIT ?? 'not resolved — stats will show N/A'}`
    );
    logger.debug(
        `REPO_URL: ${REPO_URL ?? 'not resolved — build link will be hash only'}`
    );

    const metricsService = new MetricsService(METRICS_PORT);
    const queueService = DISABLE_MESSAGE_QUEUE
        ? undefined
        : new MessageQueueService(QUEUE_TTL_MS);
    if (DISABLE_MESSAGE_QUEUE) logger.info('Message queue is disabled');

    const healthCheckService = new HealthCheckService(
        DISCORD_HEALTH_URL || null,
        FLUXER_HEALTH_URL || null
    );
    healthCheckService.setMetricsService(metricsService);

    const guildLinkRepo = new SequelizeGuildLinkRepository();
    const channelLinkRepo = new SequelizeChannelLinkRepository();
    const messageLinkRepo = new SequelizeMessageLinkRepository();
    const categoryLinkRepo = new SequelizeCategoryLinkRepository();
    const voiceLinkRepo = new SequelizeVoiceLinkRepository();
    const userLinkRepo = new SequelizeUserLinkRepository();

    const cachedGuildLinkRepo = new CachedGuildLinkRepository(guildLinkRepo, 0);
    const cachedChannelLinkRepo = new CachedChannelLinkRepository(
        channelLinkRepo,
        0
    );
    const cachedMessageLinkRepo = new CachedMessageLinkRepository(
        messageLinkRepo,
        15_000
    );

    const linkService = new LinkService(
        cachedGuildLinkRepo,
        cachedChannelLinkRepo,
        cachedMessageLinkRepo,
        categoryLinkRepo,
        voiceLinkRepo,
        userLinkRepo
    );
    const webhookService = new WebhookService();
    const discordEntityResolver = new DiscordEntityResolver();
    const fluxerEntityResolver = new FluxerEntityResolver();
    const linkProvisioner = new LinkProvisioner(
        linkService,
        webhookService,
        discordEntityResolver,
        fluxerEntityResolver
    );
    const threadSyncService = new ThreadSyncService(
        linkService,
        linkProvisioner,
        discordEntityResolver,
        fluxerEntityResolver
    );
    const categorySyncService = new CategorySyncService(
        linkService,
        linkProvisioner,
        discordEntityResolver,
        fluxerEntityResolver
    );
    const threadMemberSyncService = new ThreadMemberSyncService(
        linkService,
        discordEntityResolver,
        fluxerEntityResolver
    );
    const expressionTransferService = new ExpressionTransferService({
        discordEntityResolver,
        fluxerEntityResolver,
    });
    threadSyncService.setBotConfig(botConfig);
    const threadDirectoryService = new ThreadDirectoryService(
        new SequelizeThreadDirectoryRepository()
    );
    categorySyncService.setBotConfig(botConfig);
    const discordStatsService = new DiscordStatsService();
    const fluxerStatsService = new FluxerStatsService();
    const dbStatsService = new DbStatsService(
        cachedChannelLinkRepo,
        cachedMessageLinkRepo
    );
    // Reminders (issue #9): one service for both platforms; each client
    // registers its own deliverer once it is ready, and the service starts
    // polling for due reminders after both clients have been started.
    const reminderService = new ReminderService(
        new SequelizeReminderRepository()
    );
    // Date/time reminders (issue #27) need the user's time zone; reminders
    // waiting for one are kept in this service until the user sets it.
    const reminderTimezoneService = new ReminderTimezoneService(
        new SequelizeUserTimezoneRepository(),
        reminderService
    );
    if (!botConfig.reminders.enabled) {
        logger.info('Config: reminders are disabled (reminders.enabled=false)');
    }
    // History transfer (issue #16): one background queue for both platforms;
    // transferred messages are remembered so a re-run skips them.
    const historyMessageRepo = new SequelizeHistoryMessageRepository();
    linkService.setHistoryMessageRepository(historyMessageRepo);
    const historyService = new HistoryTransferService(historyMessageRepo, {
        delayMs: botConfig.history.delayMs,
    });
    if (!botConfig.history.enabled) {
        logger.info(
            'Config: history transfer is disabled (history.enabled=false)'
        );
    }

    // Pin bridging (issue #33): one service for both platforms, so the pin
    // snapshots it keeps per link are shared by both directions.
    const pinBridgeService = new PinBridgeService({
        linkService,
        discordEntityResolver,
        fluxerEntityResolver,
        metricsService,
        delayMs: botConfig.history.delayMs,
    });
    if (!botConfig.pins.enabled) {
        logger.info('Config: pin bridging is disabled (pins.enabled=false)');
    }

    // Self-service identity mapping (issue #3): one service for both
    // platforms, so a claim made on one side is confirmed on the other.
    const identityClaimService = new IdentityClaimService({
        linkService,
        commandPrefix: COMMAND_PREFIX,
    });

    // Claude requests (issue #18): one service (and one per-user cooldown)
    // for both platforms.
    const claudeRequestService = new ClaudeRequestService({
        token: GITHUB_TOKEN,
        repo: botConfig.claudeRequests.repo,
        label: botConfig.claudeRequests.label,
    });
    if (!botConfig.claudeRequests.enabled) {
        logger.info(
            'Config: Claude requests are disabled (claudeRequests.enabled=false)'
        );
    } else if (!claudeRequestService.isConfigured()) {
        logger.warn(
            'Config: Claude requests are enabled but BF_GITHUB_TOKEN is not set; the clauderequest command will refuse requests'
        );
    }

    // Done notifications (issue #26): polls the issues the command filed and
    // tells the requester in their channel once one is closed. Posted notices
    // are remembered so replies to them reach the issue (issue #35).
    let claudeRequestNotifyService: ClaudeRequestNotifyService | null = null;
    if (
        botConfig.claudeRequests.enabled &&
        botConfig.claudeRequests.notifyOnClose &&
        GITHUB_TOKEN
    ) {
        claudeRequestNotifyService = new ClaudeRequestNotifyService(
            new SequelizeClaudeRequestRepository(),
            {
                token: GITHUB_TOKEN,
                repo: botConfig.claudeRequests.repo,
                pollIntervalMs: botConfig.claudeRequests.notifyPollMs,
                notices: new SequelizeClaudeRequestNoticeRepository(),
            }
        );
    } else if (
        botConfig.claudeRequests.enabled &&
        !botConfig.claudeRequests.notifyOnClose
    ) {
        logger.info(
            'Config: Claude request notifications are disabled (claudeRequests.notifyOnClose=false)'
        );
    }

    // `lines` (issue #19): counts the lines in Claude-co-authored commits of
    // the same repository; one service (and one cache) for both platforms.
    const claudeLinesService = new ClaudeLinesService({
        token: GITHUB_TOKEN,
        repo: botConfig.claudeRequests.repo,
    });

    const FLUXER_DOWN_THRESHOLD = 5; // 5 × 30s = 2.5 min before restart
    const FLUXER_MAX_RESTARTS = 3; // restart up to N times, then long backoff
    const FLUXER_BACKOFF_MS = 20 * 60_000; // 20 min wait after exhausting restarts

    // The voice stack (native Opus/DAVE/LiveKit modules) is only loaded when
    // the bridge is enabled, so a deployment without voice never touches it.
    // The Fluxer transport must be created before the client logs in, and the
    // Fluxer client is re-created on restart, so the bridge is (re)started
    // from startVoiceBridge() every time both clients are up.
    const voice = ENABLE_VOICE_BRIDGE
        ? {
              DiscordVoiceTransport: (
                  await import('./services/voice/discord/DiscordVoiceTransport')
              ).default,
              FluxerVoiceTransport: (
                  await import('./services/voice/fluxer/FluxerVoiceTransport')
              ).default,
              VoiceBridgeService: (
                  await import('./services/voice/VoiceBridgeService')
              ).default,
              createOpusMixer: (await import('./services/voice/OpusMixer'))
                  .createOpusMixer,
          }
        : null;
    if (voice) logger.info('[VoiceBridge] 🔊 Voice bridging is enabled');

    let discordVoiceTransport: VoiceTransport | null = null;
    let fluxerVoiceTransport: VoiceTransport | null = null;
    let voiceBridge: VoiceBridgeService | null = null;

    const stopVoiceBridge = async () => {
        if (!voiceBridge) return;
        const bridge = voiceBridge;
        voiceBridge = null;
        try {
            await bridge.stop();
        } catch (err) {
            logger.error('[VoiceBridge] ❌ Error while stopping bridge:', err);
        }
    };

    const startVoiceBridge = async () => {
        if (!voice || !discordVoiceTransport || !fluxerVoiceTransport) return;
        await stopVoiceBridge();
        voiceBridge = new voice.VoiceBridgeService({
            linkService,
            discord: discordVoiceTransport,
            fluxer: fluxerVoiceTransport,
            createMixer: voice.createOpusMixer,
            metricsService,
            leaveGraceMs: VOICE_LEAVE_GRACE_MS,
        });
        try {
            await voiceBridge.start();
            logger.info('[VoiceBridge] ✅ Bridge service started');
        } catch (err) {
            logger.error(
                '[VoiceBridge] ❌ Failed to start bridge service:',
                err
            );
        }
    };

    const fluxerArgs = {
        linkService,
        linkProvisioner,
        webhookService,
        healthCheckService,
        discordEntityResolver,
        fluxerEntityResolver,
        threadSyncService,
        threadDirectoryService,
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
        onClientCreated: voice
            ? (client: FluxerClient) => {
                  fluxerVoiceTransport = new voice.FluxerVoiceTransport(client);
              }
            : undefined,
    };

    const fluxerClientRef: { current: FluxerClient | null } = { current: null };
    let fluxerRestartAttempts = 0;
    let fluxerRestartState: 'idle' | 'restarting' | 'backoff' = 'idle';

    const doFluxerRestart = async () => {
        fluxerRestartState = 'restarting';
        fluxerRestartAttempts++;
        logger.warn(
            `[Fluxer] 🔁 Restarting client (attempt #${fluxerRestartAttempts})...`
        );
        healthCheckService.resetFluxerDownCount();
        await stopVoiceBridge();
        try {
            fluxerClientRef.current?.destroy?.();
            // eslint-disable-next-line no-empty
        } catch {}
        await new Promise((r) => setTimeout(r, 3_000));
        try {
            fluxerClientRef.current = await startFluxerClient(fluxerArgs);
            logger.info(
                `[Fluxer] ✅ Client restarted successfully (attempt #${fluxerRestartAttempts})`
            );
            fluxerRestartState = 'idle';
            await startVoiceBridge();
        } catch (err) {
            logger.error(
                `[Fluxer] ❌ Restart #${fluxerRestartAttempts} failed:`,
                err
            );
            enterFluxerBackoff();
        }
    };

    const enterFluxerBackoff = () => {
        fluxerRestartState = 'backoff';
        healthCheckService.resetFluxerDownCount();
        logger.warn(
            `[Fluxer] ⚠️ Entering ${FLUXER_BACKOFF_MS / 60_000}-minute backoff before next restart`
        );
        setTimeout(() => {
            fluxerRestartState = 'idle';
            doFluxerRestart().catch((err) =>
                logger.error('[Fluxer] ❌ Restart after backoff failed:', err)
            );
        }, FLUXER_BACKOFF_MS);
    };

    healthCheckService.setOnDiscordRecovered(() => {
        queueService
            ?.drain(webhookService, linkService)
            .catch((err) =>
                logger.error('Queue drain on Discord recovery error:', err)
            );
    });
    healthCheckService.setOnFluxerRecovered(() => {
        fluxerRestartAttempts = 0;
        queueService
            ?.drain(webhookService, linkService)
            .catch((err) =>
                logger.error('Queue drain on Fluxer recovery error:', err)
            );
    });
    healthCheckService.setOnFluxerDown((count) => {
        if (fluxerRestartState !== 'idle') return;
        if (count < FLUXER_DOWN_THRESHOLD) return;
        if (fluxerRestartAttempts >= FLUXER_MAX_RESTARTS) {
            enterFluxerBackoff();
            return;
        }
        doFluxerRestart().catch((err) =>
            logger.error('[Fluxer] ❌ Restart error:', err)
        );
    });

    // Permission bits are identical on Discord and Fluxer; Manage Threads is
    // only included when enabled in the config file (see src/config/BotConfig.ts).
    const perms = inviteBotPermissions(botConfig);
    const discordBotInviteLink = generateDiscordBotInviteLink(
        DISCORD_APP_ID,
        perms
    );
    logger.info(`🔗 Discord Bot Invite Link: ${discordBotInviteLink}`);
    const fluxerBotInviteLink = generateFluxerBotInviteLink(
        FLUXER_APP_ID,
        perms
    );
    logger.info(`🔗 Fluxer Bot Invite Link: ${fluxerBotInviteLink}`);

    const connectFluxer = async () => {
        try {
            fluxerClientRef.current = await startFluxerClient(fluxerArgs);
        } catch (err) {
            logger.error('[Fluxer] ❌ Initial connection failed:', err);
            enterFluxerBackoff();
        }
    };

    const [discordClient] = await Promise.all([
        startDiscordClient({
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
            botConfig,
            reminderService,
            reminderTimezoneService,
            historyService,
            pinBridgeService,
            identityClaimService,
            claudeRequestService,
            claudeRequestNotifyService,
            claudeLinesService,
        }),
        connectFluxer(),
    ]);

    setInterval(async () => {
        await healthCheckService.pushFluxerHealthStatus();
    }, 30_000);

    logger.info(
        '🚀 Both Discord and Fluxer clients have started successfully.'
    );

    if (botConfig.reminders.enabled) {
        reminderService.start();
        logger.info('⏰ Reminder scheduler started');
    }

    claudeRequestNotifyService?.start();

    if (voice) {
        discordVoiceTransport = new voice.DiscordVoiceTransport(discordClient);
        if (fluxerClientRef.current) await startVoiceBridge();
    }

    if (ENABLE_WEB_DASHBOARD) {
        const webApp = createWebApp({
            linkService,
            linkProvisioner,
            categorySyncService,
            webhookService,
            discordClient,
            fluxerClientRef,
            discordStatsService,
            fluxerStatsService,
            dbStatsService,
        });
        webApp.listen(WEB_PORT, () => {
            logger.info(`🖥️ Web dashboard listening on port ${WEB_PORT}`);
        });
    }
};

main().catch((err) => {
    logger.error('Fatal error during startup:', err);
    process.exit(1);
});
