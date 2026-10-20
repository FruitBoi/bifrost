import { Router, Request } from 'express';
import {
    ChannelType as DiscordChannelType,
    TextChannel as DiscordTextChannel,
} from 'discord.js';
import type { Client as DiscordClient } from 'discord.js';
import { ChannelLink } from '../../db/entities/ChannelLink';
import { GuildLink } from '../../db/entities/GuildLink';
import { LinkService } from '../../services/LinkService';
import { WebhookService } from '../../services/WebhookService';
import ThreadSyncService from '../../services/threadSync/ThreadSyncService';
import { matchChannels } from '../../utils/channelMatcher';
import logger from '../../utils/logging/logger';
import type { FluxerClientRef } from '../clientRefs';
import {
    DiscordManageWebhooks,
    FluxerManageWebhooks,
    hasDiscordGuildPermission,
    hasFluxerGuildPermission,
} from '../middleware/auth';
import type {
    AutolinkPreviewResponse,
    AutolinkResponse,
    AutolinkResultItem,
    ChannelLinkSummary,
    ChannelSummary,
    ChannelThreadsResponse,
    CreateChannelLinkBody,
    CreateThreadLinkBody,
    GuildChannelsResponse,
    ThreadLinkSummary,
    UnlinkedChannelSummary,
    UpdateChannelLinkBody,
} from '../types';
import { ChannelType as FluxerChannelType } from '@fluxerjs/core';

export function createChannelsRouter({
    linkService,
    webhookService,
    threadSyncService,
    discordClient,
    fluxerClientRef,
}: {
    linkService: LinkService;
    webhookService: WebhookService;
    threadSyncService: ThreadSyncService;
    discordClient: DiscordClient;
    fluxerClientRef: FluxerClientRef;
}): Router {
    const router = Router();

    async function discordThreadName(threadId: string): Promise<string> {
        const cached = discordClient.channels.cache.get(threadId);
        if (cached && cached.isThread()) return cached.name;
        try {
            const fetched = await discordClient.channels.fetch(threadId);
            if (fetched && fetched.isThread()) return fetched.name;
        } catch {
            // fall through to id
        }
        return threadId;
    }

    async function fluxerThreadName(threadId: string): Promise<string> {
        const client = fluxerClientRef.current;
        if (!client) return threadId;
        const cached = client.channels.get(threadId);
        if (cached?.name) return cached.name;
        try {
            const fetched = await client.channels.fetch(threadId);
            if (fetched?.name) return fetched.name;
        } catch {
            // fall through to id
        }
        return threadId;
    }

    async function buildThreadSummaries(
        channelLinkId: string
    ): Promise<ThreadLinkSummary[]> {
        const threadLinks =
            await linkService.getThreadLinksForChannelLink(channelLinkId);
        return Promise.all(
            threadLinks.map(async (t) => {
                const [discordName, fluxerName] = await Promise.all([
                    discordThreadName(t.discordThreadId),
                    fluxerThreadName(t.fluxerThreadId),
                ]);
                return {
                    id: t.id,
                    discordThread: { id: t.discordThreadId, name: discordName },
                    fluxerThread: { id: t.fluxerThreadId, name: fluxerName },
                };
            })
        );
    }

    /**
     * Loads a channel link together with its guild link and runs the usual
     * permission check. Responds with the right error and returns null when
     * the request must stop.
     */
    async function loadAuthorizedChannelLink(
        req: Request,
        res: import('express').Response,
        channelLinkId: string
    ): Promise<{ channelLink: ChannelLink; guildLink: GuildLink } | null> {
        const channelLink = await linkService.getChannelLinkById(channelLinkId);
        if (!channelLink) {
            res.status(404).json({ error: 'Channel link not found' });
            return null;
        }
        const guildLink = await linkService.getGuildLinkById(
            channelLink.guildLinkId
        );
        if (!guildLink) {
            res.status(404).json({ error: 'Guild link not found' });
            return null;
        }
        const permError = assertChannelPermission(
            req,
            guildLink.discordGuildId,
            guildLink.fluxerGuildId
        );
        if (permError) {
            res.status(403).json({ error: permError });
            return null;
        }
        return { channelLink, guildLink };
    }

    function assertChannelPermission(
        req: Request,
        discordGuildId: string,
        fluxerGuildId: string
    ): string | null {
        const okDiscord = hasDiscordGuildPermission(
            req,
            discordGuildId,
            DiscordManageWebhooks
        );
        const okFluxer = hasFluxerGuildPermission(
            req,
            fluxerGuildId,
            FluxerManageWebhooks
        );
        if (!okDiscord && !okFluxer) {
            return 'You do not have Manage Webhooks on either linked guild';
        }
        return null;
    }

    async function getChannelState(link: GuildLink) {
        const channelLinks = await linkService.getChannelLinksForDiscordGuild(
            link.discordGuildId
        );

        const discordGuild = discordClient.guilds.cache.get(
            link.discordGuildId
        );
        const fluxerGuild = fluxerClientRef.current?.guilds.get(
            link.fluxerGuildId
        );

        const discordChannels: UnlinkedChannelSummary[] = discordGuild
            ? [...discordGuild.channels.cache.values()]
                  .filter(
                      (c): c is DiscordTextChannel =>
                          c.type === DiscordChannelType.GuildText
                  )
                  .map((c) => {
                      const category = c.parentId
                          ? discordGuild.channels.cache.get(c.parentId)
                          : null;
                      const categoryPosition =
                          category &&
                          category.type === DiscordChannelType.GuildCategory
                              ? category.position
                              : null;
                      return {
                          id: c.id,
                          name: c.name,
                          categoryId: c.parentId ?? null,
                          categoryName: category?.name ?? null,
                          position: c.position,
                          categoryPosition: categoryPosition,
                      };
                  })
                  .sort((a, b) => {
                      const catA = a.categoryPosition ?? -1;
                      const catB = b.categoryPosition ?? -1;
                      if (catA !== catB) return catA - catB;
                      return a.position - b.position;
                  })
            : [];

        const fluxerChannels: UnlinkedChannelSummary[] = fluxerGuild
            ? (await fluxerGuild.fetchChannels())
                  .filter((c) => c.isTextBased())
                  .map((c) => {
                      const category = c.parentId
                          ? fluxerGuild.channels.get(c.parentId)
                          : null;
                      const categoryPosition: number =
                          category &&
                          category.type === FluxerChannelType.GuildCategory
                              ? (category.position ?? -1)
                              : -1;
                      return {
                          id: c.id,
                          name: c.name ?? '',
                          categoryId: c.parentId ?? null,
                          categoryName: category?.name ?? null,
                          position: c.position ?? -1,
                          categoryPosition: categoryPosition,
                      };
                  })
                  .sort((a, b) => {
                      const catA = a.categoryPosition ?? -1;
                      const catB = b.categoryPosition ?? -1;
                      if (catA !== catB) return catA - catB;
                      return a.position - b.position;
                  })
            : [];

        const linkedDiscordIds = new Set(
            channelLinks.map((l) => l.discordChannelId)
        );
        const linkedFluxerIds = new Set(
            channelLinks.map((l) => l.fluxerChannelId)
        );

        return {
            channelLinks,
            discordChannels,
            fluxerChannels,
            unlinkedDiscordChannels: discordChannels.filter(
                (c) => !linkedDiscordIds.has(c.id)
            ),
            unlinkedFluxerChannels: fluxerChannels.filter(
                (c) => !linkedFluxerIds.has(c.id)
            ),
        };
    }

    router.get('/guild-links/:id/channels', async (req, res) => {
        const link = await linkService.getGuildLinkById(req.params.id);
        if (!link) {
            res.status(404).json({ error: 'Guild link not found' });
            return;
        }

        const permError = assertChannelPermission(
            req,
            link.discordGuildId,
            link.fluxerGuildId
        );
        if (permError) {
            res.status(403).json({ error: permError });
            return;
        }

        const {
            channelLinks,
            discordChannels,
            fluxerChannels,
            unlinkedDiscordChannels,
            unlinkedFluxerChannels,
        } = await getChannelState(link);

        const linked: ChannelLinkSummary[] = await Promise.all(
            channelLinks.map(async (l) => ({
                id: l.id,
                discordChannel: {
                    id: l.discordChannelId,
                    name:
                        discordChannels.find((c) => c.id === l.discordChannelId)
                            ?.name ?? l.discordChannelId,
                },
                fluxerChannel: {
                    id: l.fluxerChannelId,
                    name:
                        fluxerChannels.find((c) => c.id === l.fluxerChannelId)
                            ?.name ?? l.fluxerChannelId,
                },
                autoSyncThreads: l.autoSyncThreads,
                threads: await buildThreadSummaries(l.id),
            }))
        );

        const response: GuildChannelsResponse = {
            linked,
            unlinkedDiscordChannels,
            unlinkedFluxerChannels,
        };
        res.json(response);
    });

    router.get('/guild-links/:id/autolink', async (req, res) => {
        const link = await linkService.getGuildLinkById(req.params.id);
        if (!link) {
            res.status(404).json({ error: 'Guild link not found' });
            return;
        }

        const permError = assertChannelPermission(
            req,
            link.discordGuildId,
            link.fluxerGuildId
        );
        if (permError) {
            res.status(403).json({ error: permError });
            return;
        }

        const { unlinkedDiscordChannels, unlinkedFluxerChannels } =
            await getChannelState(link);
        const matches = matchChannels(
            unlinkedDiscordChannels,
            unlinkedFluxerChannels
        );

        const response: AutolinkPreviewResponse = {
            proposals: matches.map((m) => ({
                discordChannel: m.discord,
                fluxerChannel: m.fluxer,
                score: m.score,
            })),
            unmatchedDiscordCount:
                unlinkedDiscordChannels.length - matches.length,
            unmatchedFluxerCount:
                unlinkedFluxerChannels.length - matches.length,
        };
        res.json(response);
    });

    router.post('/guild-links/:id/autolink', async (req, res) => {
        const link = await linkService.getGuildLinkById(req.params.id);
        if (!link) {
            res.status(404).json({ error: 'Guild link not found' });
            return;
        }

        const permError = assertChannelPermission(
            req,
            link.discordGuildId,
            link.fluxerGuildId
        );
        if (permError) {
            res.status(403).json({ error: permError });
            return;
        }

        const { unlinkedDiscordChannels, unlinkedFluxerChannels } =
            await getChannelState(link);
        const matches = matchChannels(
            unlinkedDiscordChannels,
            unlinkedFluxerChannels
        );

        const results: AutolinkResultItem[] = [];
        let linkedCount = 0;

        for (const match of matches) {
            try {
                const discordWebhook =
                    await webhookService.createDiscordWebhook(
                        match.discord.id,
                        `Fluxer Bridge Webhook for channel ${match.discord.id}`
                    );
                const fluxerWebhook = await webhookService.createFluxerWebhook(
                    match.fluxer.id,
                    `Discord Bridge Webhook for channel ${match.fluxer.id}`
                );
                await linkService.createChannelLink({
                    guildLinkId: link.id,
                    discordChannelId: match.discord.id,
                    fluxerChannelId: match.fluxer.id,
                    discordWebhookId: discordWebhook.id,
                    discordWebhookToken: discordWebhook.token,
                    fluxerWebhookId: fluxerWebhook.id,
                    fluxerWebhookToken: fluxerWebhook.token,
                });
                linkedCount++;
                results.push({
                    discordChannel: match.discord,
                    fluxerChannel: match.fluxer,
                });
            } catch (err) {
                logger.error(
                    `Autolink failed for #${match.discord.name} ↔ #${match.fluxer.name}:`,
                    err
                );
                results.push({
                    discordChannel: match.discord,
                    fluxerChannel: match.fluxer,
                    error: (err as Error).message,
                });
            }
        }

        const response: AutolinkResponse = { linkedCount, results };
        res.json(response);
    });

    router.post('/channel-links', async (req, res) => {
        const { guildLinkId, discordChannelId, fluxerChannelId } =
            req.body as Partial<CreateChannelLinkBody>;
        if (!guildLinkId || !discordChannelId || !fluxerChannelId) {
            res.status(400).json({
                error: 'guildLinkId, discordChannelId and fluxerChannelId are required',
            });
            return;
        }

        const link = await linkService.getGuildLinkById(guildLinkId);
        if (!link) {
            res.status(404).json({ error: 'Guild link not found' });
            return;
        }

        const permError = assertChannelPermission(
            req,
            link.discordGuildId,
            link.fluxerGuildId
        );
        if (permError) {
            res.status(403).json({ error: permError });
            return;
        }

        const { unlinkedDiscordChannels, unlinkedFluxerChannels } =
            await getChannelState(link);
        if (!unlinkedDiscordChannels.some((c) => c.id === discordChannelId)) {
            res.status(400).json({
                error: 'discordChannelId does not belong to this guild link',
            });
            return;
        }
        if (!unlinkedFluxerChannels.some((c) => c.id === fluxerChannelId)) {
            res.status(400).json({
                error: 'fluxerChannelId does not belong to this guild link',
            });
            return;
        }

        try {
            const discordWebhook = await webhookService.createDiscordWebhook(
                discordChannelId,
                `Fluxer Bridge Webhook for channel ${discordChannelId}`
            );
            const fluxerWebhook = await webhookService.createFluxerWebhook(
                fluxerChannelId,
                `Discord Bridge Webhook for channel ${fluxerChannelId}`
            );
            const channelLink = await linkService.createChannelLink({
                guildLinkId,
                discordChannelId,
                fluxerChannelId,
                discordWebhookId: discordWebhook.id,
                discordWebhookToken: discordWebhook.token,
                fluxerWebhookId: fluxerWebhook.id,
                fluxerWebhookToken: fluxerWebhook.token,
            });
            res.status(201).json({ id: channelLink.id });
        } catch (err) {
            logger.error('Failed to create channel link via dashboard:', err);
            res.status(500).json({ error: (err as Error).message });
        }
    });

    router.patch('/channel-links/:id', async (req, res) => {
        const { autoSyncThreads } = req.body as Partial<UpdateChannelLinkBody>;
        if (typeof autoSyncThreads !== 'boolean') {
            res.status(400).json({
                error: 'autoSyncThreads must be a boolean',
            });
            return;
        }

        const loaded = await loadAuthorizedChannelLink(req, res, req.params.id);
        if (!loaded) return;

        try {
            const updated = await linkService.setChannelAutoSyncThreads(
                loaded.channelLink.id,
                autoSyncThreads
            );
            res.json({
                id: updated.id,
                autoSyncThreads: updated.autoSyncThreads,
            });
        } catch (err) {
            logger.error('Failed to update channel link via dashboard:', err);
            res.status(500).json({ error: (err as Error).message });
        }
    });

    router.get('/channel-links/:id/threads', async (req, res) => {
        const loaded = await loadAuthorizedChannelLink(req, res, req.params.id);
        if (!loaded) return;
        const { channelLink, guildLink } = loaded;

        const threadLinks = await linkService.getThreadLinksForChannelLink(
            channelLink.id
        );
        const linkedDiscordIds = new Set(
            threadLinks.map((t) => t.discordThreadId)
        );
        const linkedFluxerIds = new Set(
            threadLinks.map((t) => t.fluxerThreadId)
        );

        let unlinkedDiscordThreads: ChannelSummary[] = [];
        try {
            const discordChannel = await discordClient.channels.fetch(
                channelLink.discordChannelId
            );
            if (discordChannel instanceof DiscordTextChannel) {
                const active = await discordChannel.threads.fetchActive();
                unlinkedDiscordThreads = [...active.threads.values()]
                    .filter((t) => !linkedDiscordIds.has(t.id))
                    .map((t) => ({ id: t.id, name: t.name }));
            }
        } catch (err) {
            logger.warn('Could not list active Discord threads:', err);
        }

        let unlinkedFluxerThreads: ChannelSummary[] = [];
        try {
            const fluxerGuild = fluxerClientRef.current?.guilds.get(
                guildLink.fluxerGuildId
            );
            if (fluxerGuild) {
                const active = await fluxerGuild.fetchActiveThreads();
                unlinkedFluxerThreads = active.threads
                    .filter(
                        (t) =>
                            t.parentId === channelLink.fluxerChannelId &&
                            !linkedFluxerIds.has(t.id)
                    )
                    .map((t) => ({ id: t.id, name: t.name ?? t.id }));
            }
        } catch (err) {
            logger.warn('Could not list active Fluxer threads:', err);
        }

        const response: ChannelThreadsResponse = {
            unlinkedDiscordThreads,
            unlinkedFluxerThreads,
        };
        res.json(response);
    });

    router.post('/thread-links', async (req, res) => {
        const { channelLinkId, discordThreadId, fluxerThreadId } =
            req.body as Partial<CreateThreadLinkBody>;
        if (!channelLinkId || !discordThreadId || !fluxerThreadId) {
            res.status(400).json({
                error: 'channelLinkId, discordThreadId and fluxerThreadId are required',
            });
            return;
        }

        const loaded = await loadAuthorizedChannelLink(req, res, channelLinkId);
        if (!loaded) return;

        try {
            const threadLink = await threadSyncService.linkExistingThreads({
                channelLink: loaded.channelLink,
                discordThreadId,
                fluxerThreadId,
            });
            res.status(201).json({ id: threadLink.id });
        } catch (err) {
            logger.error('Failed to create thread link via dashboard:', err);
            res.status(400).json({ error: (err as Error).message });
        }
    });

    router.delete('/thread-links/:id', async (req, res) => {
        const threadLink = await linkService.getThreadLinkById(req.params.id);
        if (!threadLink) {
            res.status(404).json({ error: 'Thread link not found' });
            return;
        }

        const loaded = await loadAuthorizedChannelLink(
            req,
            res,
            threadLink.channelLinkId
        );
        if (!loaded) return;

        try {
            await threadSyncService.unlinkThread(threadLink.id);
            res.status(204).end();
        } catch (err) {
            logger.error('Failed to delete thread link via dashboard:', err);
            res.status(500).json({ error: (err as Error).message });
        }
    });

    router.delete('/channel-links/:id', async (req, res) => {
        const channelLink = await linkService.getChannelLinkById(req.params.id);
        if (!channelLink) {
            res.status(404).json({ error: 'Channel link not found' });
            return;
        }
        const guildLink = await linkService.getGuildLinkById(
            channelLink.guildLinkId
        );
        if (!guildLink) {
            res.status(404).json({ error: 'Guild link not found' });
            return;
        }

        const permError = assertChannelPermission(
            req,
            guildLink.discordGuildId,
            guildLink.fluxerGuildId
        );
        if (permError) {
            res.status(403).json({ error: permError });
            return;
        }

        try {
            await webhookService
                .deleteDiscordWebhook(
                    channelLink.discordWebhookId,
                    channelLink.discordWebhookToken
                )
                .catch((err) =>
                    logger.error('Failed to delete Discord webhook:', err)
                );
            await webhookService
                .deleteFluxerWebhook(
                    channelLink.fluxerWebhookId,
                    channelLink.fluxerWebhookToken
                )
                .catch((err) =>
                    logger.error('Failed to delete Fluxer webhook:', err)
                );
            await linkService.removeChannelLinkForDiscord(
                guildLink.discordGuildId,
                channelLink.linkId
            );
            res.status(204).end();
        } catch (err) {
            res.status(500).json({ error: (err as Error).message });
        }
    });

    return router;
}
