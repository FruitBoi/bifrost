import { Router, Request } from 'express';
import {
    ChannelType as DiscordChannelType,
    TextChannel as DiscordTextChannel,
} from 'discord.js';
import type { Client as DiscordClient } from 'discord.js';
import {
    ChannelLink,
    discordLocationId,
    fluxerLocationId,
    isChannelPairLink,
} from '../../db/entities/ChannelLink';
import { GuildLink } from '../../db/entities/GuildLink';
import { LinkService } from '../../services/LinkService';
import LinkProvisioner from '../../services/LinkProvisioner';
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
    CreateChannelLinkBody,
    GuildChannelsResponse,
    UnlinkedChannelSummary,
    UnlinkedThreadSummary,
    UpdateChannelLinkBody,
} from '../types';
import { ChannelType as FluxerChannelType } from '@fluxerjs/core';

export function createChannelsRouter({
    linkService,
    linkProvisioner,
    discordClient,
    fluxerClientRef,
}: {
    linkService: LinkService;
    linkProvisioner: LinkProvisioner;
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
        const channelLinks = await linkService.getChannelLinksForGuildLink(
            link.id
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

        const discordChannelNames = new Map(
            discordChannels.map((c) => [c.id, c.name])
        );
        const fluxerChannelNames = new Map(
            fluxerChannels.map((c) => [c.id, c.name])
        );

        let discordThreads: UnlinkedThreadSummary[] = [];
        if (discordGuild) {
            try {
                const active = await discordGuild.channels.fetchActiveThreads();
                discordThreads = [...active.threads.values()]
                    .filter(
                        (t) =>
                            !!t.parentId && discordChannelNames.has(t.parentId)
                    )
                    .map((t) => ({
                        id: t.id,
                        name: t.name,
                        parentId: t.parentId!,
                        parentName: discordChannelNames.get(t.parentId!)!,
                    }));
            } catch (err) {
                logger.warn('Could not list active Discord threads:', err);
            }
        }

        let fluxerThreads: UnlinkedThreadSummary[] = [];
        if (fluxerGuild) {
            try {
                const active = await fluxerGuild.fetchActiveThreads();
                fluxerThreads = active.threads
                    .filter(
                        (t) =>
                            !!t.parentId && fluxerChannelNames.has(t.parentId)
                    )
                    .map((t) => ({
                        id: t.id,
                        name: t.name ?? t.id,
                        parentId: t.parentId!,
                        parentName: fluxerChannelNames.get(t.parentId!)!,
                    }));
            } catch (err) {
                logger.warn('Could not list active Fluxer threads:', err);
            }
        }

        const linkedDiscordIds = new Set(channelLinks.map(discordLocationId));
        const linkedFluxerIds = new Set(channelLinks.map(fluxerLocationId));

        return {
            channelLinks,
            discordChannelNames,
            fluxerChannelNames,
            unlinkedDiscordChannels: discordChannels.filter(
                (c) => !linkedDiscordIds.has(c.id)
            ),
            unlinkedFluxerChannels: fluxerChannels.filter(
                (c) => !linkedFluxerIds.has(c.id)
            ),
            unlinkedDiscordThreads: discordThreads.filter(
                (t) => !linkedDiscordIds.has(t.id)
            ),
            unlinkedFluxerThreads: fluxerThreads.filter(
                (t) => !linkedFluxerIds.has(t.id)
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
            discordChannelNames,
            fluxerChannelNames,
            unlinkedDiscordChannels,
            unlinkedFluxerChannels,
            unlinkedDiscordThreads,
            unlinkedFluxerThreads,
        } = await getChannelState(link);

        const linked: ChannelLinkSummary[] = await Promise.all(
            channelLinks.map(async (l) => {
                const discordThread: ChannelSummary | null = l.discordThreadId
                    ? {
                          id: l.discordThreadId,
                          name: await discordThreadName(l.discordThreadId),
                      }
                    : null;
                const fluxerThread: ChannelSummary | null = l.fluxerThreadId
                    ? {
                          id: l.fluxerThreadId,
                          name: await fluxerThreadName(l.fluxerThreadId),
                      }
                    : null;
                return {
                    id: l.id,
                    discordChannel: {
                        id: l.discordChannelId,
                        name:
                            discordChannelNames.get(l.discordChannelId) ??
                            l.discordChannelId,
                    },
                    fluxerChannel: {
                        id: l.fluxerChannelId,
                        name:
                            fluxerChannelNames.get(l.fluxerChannelId) ??
                            l.fluxerChannelId,
                    },
                    discordThread,
                    fluxerThread,
                    autoSyncThreads: l.autoSyncThreads,
                };
            })
        );

        const response: GuildChannelsResponse = {
            linked,
            unlinkedDiscordChannels,
            unlinkedFluxerChannels,
            unlinkedDiscordThreads,
            unlinkedFluxerThreads,
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
                await linkProvisioner.createLink({
                    guildLink: link,
                    discord: { channelId: match.discord.id, threadId: null },
                    fluxer: { channelId: match.fluxer.id, threadId: null },
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
        const { guildLinkId, discordTargetId, fluxerTargetId } =
            req.body as Partial<CreateChannelLinkBody>;
        if (!guildLinkId || !discordTargetId || !fluxerTargetId) {
            res.status(400).json({
                error: 'guildLinkId, discordTargetId and fluxerTargetId are required',
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

        const [discord, fluxer] = await Promise.all([
            linkProvisioner.resolveDiscordTarget(
                link.discordGuildId,
                discordTargetId
            ),
            linkProvisioner.resolveFluxerTarget(
                link.fluxerGuildId,
                fluxerTargetId
            ),
        ]);
        if (!discord) {
            res.status(400).json({
                error: 'discordTargetId is not a text channel or thread of the linked Discord guild',
            });
            return;
        }
        if (!fluxer) {
            res.status(400).json({
                error: 'fluxerTargetId is not a text channel or thread of the linked Fluxer guild',
            });
            return;
        }

        try {
            const channelLink = await linkProvisioner.createLink({
                guildLink: link,
                discord,
                fluxer,
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

        if (!isChannelPairLink(loaded.channelLink)) {
            res.status(400).json({
                error: 'Automatic thread sync is only available on channel-to-channel links',
            });
            return;
        }

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

    router.delete('/channel-links/:id', async (req, res) => {
        const loaded = await loadAuthorizedChannelLink(req, res, req.params.id);
        if (!loaded) return;

        try {
            await linkProvisioner.removeLink(loaded.channelLink);
            res.status(204).end();
        } catch (err) {
            res.status(500).json({ error: (err as Error).message });
        }
    });

    return router;
}
