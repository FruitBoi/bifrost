import { Router, Request, Response } from 'express';
import {
    ChannelType as DiscordChannelType,
    VoiceChannel as DiscordVoiceChannel,
} from 'discord.js';
import type { Client as DiscordClient } from 'discord.js';
import { GuildLink } from '../../db/entities/GuildLink';
import { VoiceLink } from '../../db/entities/VoiceLink';
import { LinkService } from '../../services/LinkService';
import logger from '../../utils/logging/logger';
import type { FluxerClientRef } from '../clientRefs';
import {
    DiscordManageWebhooks,
    FluxerManageWebhooks,
    hasDiscordGuildPermission,
    hasFluxerGuildPermission,
} from '../middleware/auth';
import type {
    ChannelSummary,
    CreateVoiceLinkBody,
    UpdateVoiceLinkBody,
    VoiceChannelsResponse,
    VoiceLinkResponse,
} from '../types';

/**
 * Dashboard routes for voice links: pairs of one Discord voice channel and
 * one Fluxer voice channel. Voice links have no webhooks, so they are
 * served separately from the channel link routes, but they use the same
 * guild authorisation.
 */
export function createVoiceRouter({
    linkService,
    discordClient,
    fluxerClientRef,
}: {
    linkService: LinkService;
    discordClient: DiscordClient;
    fluxerClientRef: FluxerClientRef;
}): Router {
    const router = Router();

    function assertPermission(
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

    /**
     * Loads the guild link and runs the permission check. Responds with the
     * right error and returns null when the request must stop.
     */
    async function loadAuthorizedGuildLink(
        req: Request,
        res: Response,
        guildLinkId: string
    ): Promise<GuildLink | null> {
        const link = await linkService.getGuildLinkById(guildLinkId);
        if (!link) {
            res.status(404).json({ error: 'Guild link not found' });
            return null;
        }
        const permError = assertPermission(
            req,
            link.discordGuildId,
            link.fluxerGuildId
        );
        if (permError) {
            res.status(403).json({ error: permError });
            return null;
        }
        return link;
    }

    /**
     * Loads a voice link, checking that it belongs to the given guild link.
     * Responds with 404 and returns null otherwise.
     */
    async function loadVoiceLink(
        res: Response,
        guildLink: GuildLink,
        voiceLinkId: string
    ): Promise<VoiceLink | null> {
        const voiceLink = await linkService.getVoiceLinkById(voiceLinkId);
        if (!voiceLink || voiceLink.guildLinkId !== guildLink.id) {
            res.status(404).json({ error: 'Voice link not found' });
            return null;
        }
        return voiceLink;
    }

    /** Voice channels of both guilds, in display order. */
    async function getVoiceChannels(
        link: GuildLink
    ): Promise<VoiceChannelsResponse> {
        const discordGuild = discordClient.guilds.cache.get(
            link.discordGuildId
        );
        const fluxerGuild = fluxerClientRef.current?.guilds.get(
            link.fluxerGuildId
        );

        const discord: ChannelSummary[] = discordGuild
            ? [...discordGuild.channels.cache.values()]
                  .filter(
                      (c): c is DiscordVoiceChannel =>
                          c.type === DiscordChannelType.GuildVoice
                  )
                  .sort((a, b) => a.rawPosition - b.rawPosition)
                  .map((c) => ({ id: c.id, name: c.name }))
            : [];

        let fluxer: ChannelSummary[] = [];
        if (fluxerGuild) {
            try {
                fluxer = (await fluxerGuild.fetchChannels())
                    .filter((c) => c.isVoice())
                    .sort((a, b) => (a.position ?? -1) - (b.position ?? -1))
                    .map((c) => ({ id: c.id, name: c.name ?? c.id }));
            } catch (err) {
                logger.warn('⚠️ Could not list Fluxer voice channels:', err);
            }
        }

        return { discord, fluxer };
    }

    function toResponse(
        voiceLink: VoiceLink,
        channels: VoiceChannelsResponse
    ): VoiceLinkResponse {
        return {
            id: voiceLink.id,
            discordChannelId: voiceLink.discordChannelId,
            fluxerChannelId: voiceLink.fluxerChannelId,
            discordChannelName:
                channels.discord.find(
                    (c) => c.id === voiceLink.discordChannelId
                )?.name ?? null,
            fluxerChannelName:
                channels.fluxer.find((c) => c.id === voiceLink.fluxerChannelId)
                    ?.name ?? null,
            enabled: voiceLink.enabled,
            createdAt: voiceLink.createdAt.toISOString(),
        };
    }

    router.get('/guild-links/:id/voice-channels', async (req, res) => {
        const link = await loadAuthorizedGuildLink(req, res, req.params.id);
        if (!link) return;

        const response: VoiceChannelsResponse = await getVoiceChannels(link);
        res.json(response);
    });

    router.get('/guild-links/:id/voice-links', async (req, res) => {
        const link = await loadAuthorizedGuildLink(req, res, req.params.id);
        if (!link) return;

        const [voiceLinks, channels] = await Promise.all([
            linkService.getVoiceLinksForGuildLink(link.id),
            getVoiceChannels(link),
        ]);
        const response: VoiceLinkResponse[] = voiceLinks.map((l) =>
            toResponse(l, channels)
        );
        res.json(response);
    });

    router.post('/guild-links/:id/voice-links', async (req, res) => {
        const { discordChannelId, fluxerChannelId } =
            req.body as Partial<CreateVoiceLinkBody>;
        if (
            typeof discordChannelId !== 'string' ||
            typeof fluxerChannelId !== 'string' ||
            !discordChannelId ||
            !fluxerChannelId
        ) {
            res.status(400).json({
                error: 'discordChannelId and fluxerChannelId are required',
            });
            return;
        }

        const link = await loadAuthorizedGuildLink(req, res, req.params.id);
        if (!link) return;

        const channels = await getVoiceChannels(link);
        if (!channels.discord.some((c) => c.id === discordChannelId)) {
            res.status(400).json({
                error: 'discordChannelId is not a voice channel of the linked Discord guild',
            });
            return;
        }
        if (!channels.fluxer.some((c) => c.id === fluxerChannelId)) {
            res.status(400).json({
                error: 'fluxerChannelId is not a voice channel of the linked Fluxer guild',
            });
            return;
        }

        try {
            const voiceLink = await linkService.createVoiceLink({
                guildLinkId: link.id,
                discordChannelId,
                fluxerChannelId,
            });
            const response: VoiceLinkResponse = toResponse(voiceLink, channels);
            res.status(201).json(response);
        } catch (err) {
            const message = (err as Error).message;
            if (/already linked/i.test(message)) {
                res.status(409).json({ error: message });
                return;
            }
            logger.error('❌ Failed to create voice link via dashboard:', err);
            res.status(500).json({ error: message });
        }
    });

    router.patch(
        '/guild-links/:id/voice-links/:voiceLinkId',
        async (req, res) => {
            const { enabled } = req.body as Partial<UpdateVoiceLinkBody>;
            if (typeof enabled !== 'boolean') {
                res.status(400).json({ error: 'enabled must be a boolean' });
                return;
            }

            const link = await loadAuthorizedGuildLink(req, res, req.params.id);
            if (!link) return;
            const voiceLink = await loadVoiceLink(
                res,
                link,
                req.params.voiceLinkId
            );
            if (!voiceLink) return;

            try {
                const [updated, channels] = await Promise.all([
                    linkService.setVoiceLinkEnabled(voiceLink.id, enabled),
                    getVoiceChannels(link),
                ]);
                const response: VoiceLinkResponse = toResponse(
                    updated,
                    channels
                );
                res.json(response);
            } catch (err) {
                logger.error(
                    '❌ Failed to update voice link via dashboard:',
                    err
                );
                res.status(500).json({ error: (err as Error).message });
            }
        }
    );

    router.delete(
        '/guild-links/:id/voice-links/:voiceLinkId',
        async (req, res) => {
            const link = await loadAuthorizedGuildLink(req, res, req.params.id);
            if (!link) return;
            const voiceLink = await loadVoiceLink(
                res,
                link,
                req.params.voiceLinkId
            );
            if (!voiceLink) return;

            try {
                await linkService.removeVoiceLink(voiceLink.id);
                res.status(204).end();
            } catch (err) {
                logger.error(
                    '❌ Failed to remove voice link via dashboard:',
                    err
                );
                res.status(500).json({ error: (err as Error).message });
            }
        }
    );

    return router;
}
