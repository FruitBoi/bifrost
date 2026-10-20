import { describe, expect, it, vi } from 'vitest';
import LinkProvisioner from '../../src/services/LinkProvisioner';
import { LinkService } from '../../src/services/LinkService';
import { WebhookService } from '../../src/services/WebhookService';
import DiscordEntityResolver from '../../src/services/entityResolver/DiscordEntityResolver';
import FluxerEntityResolver from '../../src/services/entityResolver/FluxerEntityResolver';
import { VoiceLink } from '../../src/db/entities/VoiceLink';
import { guildLink } from '../helpers/fakes';

/**
 * Minimal in-memory voice-link store standing in for LinkService. Only the
 * voice methods the provisioner touches exist; everything else throws.
 */
function voiceLinkStore() {
    const voiceLinks: VoiceLink[] = [];
    let n = 0;
    const store = {
        voiceLinks,
        getVoiceLinkForDiscordChannel: vi.fn(
            async (id: string) =>
                voiceLinks.find((v) => v.discordChannelId === id) ?? null
        ),
        getVoiceLinkForFluxerChannel: vi.fn(
            async (id: string) =>
                voiceLinks.find((v) => v.fluxerChannelId === id) ?? null
        ),
        createVoiceLink: vi.fn(
            async (data: {
                guildLinkId: string;
                discordChannelId: string;
                fluxerChannelId: string;
            }) => {
                const link: VoiceLink = {
                    id: `voice-${++n}`,
                    enabled: true,
                    createdAt: new Date(),
                    ...data,
                };
                voiceLinks.push(link);
                return link;
            }
        ),
        removeVoiceLink: vi.fn(async (id: string) => {
            const idx = voiceLinks.findIndex((v) => v.id === id);
            if (idx === -1) throw new Error('Voice link not found');
            return voiceLinks.splice(idx, 1)[0];
        }),
    };
    return store;
}

function setup() {
    const links = voiceLinkStore();
    const discordResolver = {
        fetchVoiceChannel: vi.fn(async () => null as unknown),
    };
    const fluxerResolver = {
        fetchVoiceChannel: vi.fn(async () => null as unknown),
    };
    const provisioner = new LinkProvisioner(
        links as unknown as LinkService,
        {} as WebhookService,
        discordResolver as unknown as DiscordEntityResolver,
        fluxerResolver as unknown as FluxerEntityResolver
    );
    return { provisioner, links, discordResolver, fluxerResolver };
}

const discordVoice = (id: string, name = `discord ${id}`) => ({ id, name });
const fluxerVoice = (id: string, name: string | null = `fluxer ${id}`) => ({
    id,
    name,
});

describe('LinkProvisioner voice target resolution', () => {
    it('resolves a Discord voice channel to id and name', async () => {
        const t = setup();
        t.discordResolver.fetchVoiceChannel.mockResolvedValue(
            discordVoice('dvoice', 'General')
        );

        await expect(
            t.provisioner.resolveDiscordVoiceTarget('dguild', 'dvoice')
        ).resolves.toEqual({ id: 'dvoice', name: 'General' });
        expect(t.discordResolver.fetchVoiceChannel).toHaveBeenCalledWith(
            'dguild',
            'dvoice'
        );
    });

    it('returns null when the Discord ID is not a voice channel of the guild', async () => {
        const t = setup();
        await expect(
            t.provisioner.resolveDiscordVoiceTarget('dguild', 'dtext')
        ).resolves.toBeNull();
    });

    it('resolves a Fluxer voice channel, falling back to the ID as name', async () => {
        const t = setup();
        t.fluxerResolver.fetchVoiceChannel.mockResolvedValue(
            fluxerVoice('fvoice', null)
        );

        await expect(
            t.provisioner.resolveFluxerVoiceTarget('fguild', 'fvoice')
        ).resolves.toEqual({ id: 'fvoice', name: 'fvoice' });
        expect(t.fluxerResolver.fetchVoiceChannel).toHaveBeenCalledWith(
            'fguild',
            'fvoice'
        );
    });

    it('returns null when the Fluxer ID is not a voice channel of the guild', async () => {
        const t = setup();
        await expect(
            t.provisioner.resolveFluxerVoiceTarget('fguild', 'ftext')
        ).resolves.toBeNull();
    });
});

describe('LinkProvisioner.createVoiceLink', () => {
    it('persists a voice link once both sides resolve to voice channels', async () => {
        const t = setup();
        t.discordResolver.fetchVoiceChannel.mockResolvedValue(
            discordVoice('dvoice')
        );
        t.fluxerResolver.fetchVoiceChannel.mockResolvedValue(
            fluxerVoice('fvoice')
        );

        const link = await t.provisioner.createVoiceLink(
            guildLink,
            'dvoice',
            'fvoice'
        );

        expect(link).toMatchObject({
            guildLinkId: guildLink.id,
            discordChannelId: 'dvoice',
            fluxerChannelId: 'fvoice',
            enabled: true,
        });
        expect(t.links.createVoiceLink).toHaveBeenCalledWith({
            guildLinkId: guildLink.id,
            discordChannelId: 'dvoice',
            fluxerChannelId: 'fvoice',
        });
        expect(t.discordResolver.fetchVoiceChannel).toHaveBeenCalledWith(
            guildLink.discordGuildId,
            'dvoice'
        );
        expect(t.fluxerResolver.fetchVoiceChannel).toHaveBeenCalledWith(
            guildLink.fluxerGuildId,
            'fvoice'
        );
    });

    it('rejects when the Discord side is not a voice channel', async () => {
        const t = setup();
        t.fluxerResolver.fetchVoiceChannel.mockResolvedValue(
            fluxerVoice('fvoice')
        );

        await expect(
            t.provisioner.createVoiceLink(guildLink, 'dtext', 'fvoice')
        ).rejects.toThrow(
            'Discord channel dtext is not a voice channel of the linked server'
        );
        expect(t.links.createVoiceLink).not.toHaveBeenCalled();
    });

    it('rejects when the Fluxer side is not a voice channel', async () => {
        const t = setup();
        t.discordResolver.fetchVoiceChannel.mockResolvedValue(
            discordVoice('dvoice')
        );

        await expect(
            t.provisioner.createVoiceLink(guildLink, 'dvoice', 'ftext')
        ).rejects.toThrow(
            'Fluxer channel ftext is not a voice channel of the linked server'
        );
        expect(t.links.createVoiceLink).not.toHaveBeenCalled();
    });

    it('rejects a Discord voice channel that is already linked', async () => {
        const t = setup();
        t.discordResolver.fetchVoiceChannel.mockResolvedValue(
            discordVoice('dvoice')
        );
        t.fluxerResolver.fetchVoiceChannel.mockResolvedValue(
            fluxerVoice('fvoice-2')
        );
        await t.links.createVoiceLink({
            guildLinkId: guildLink.id,
            discordChannelId: 'dvoice',
            fluxerChannelId: 'fvoice-1',
        });
        t.links.createVoiceLink.mockClear();

        await expect(
            t.provisioner.createVoiceLink(guildLink, 'dvoice', 'fvoice-2')
        ).rejects.toThrow('Discord voice channel already linked');
        expect(t.links.createVoiceLink).not.toHaveBeenCalled();
        expect(t.links.voiceLinks).toHaveLength(1);
    });

    it('rejects a Fluxer voice channel that is already linked', async () => {
        const t = setup();
        t.discordResolver.fetchVoiceChannel.mockResolvedValue(
            discordVoice('dvoice-2')
        );
        t.fluxerResolver.fetchVoiceChannel.mockResolvedValue(
            fluxerVoice('fvoice')
        );
        await t.links.createVoiceLink({
            guildLinkId: guildLink.id,
            discordChannelId: 'dvoice-1',
            fluxerChannelId: 'fvoice',
        });
        t.links.createVoiceLink.mockClear();

        await expect(
            t.provisioner.createVoiceLink(guildLink, 'dvoice-2', 'fvoice')
        ).rejects.toThrow('Fluxer voice channel already linked');
        expect(t.links.createVoiceLink).not.toHaveBeenCalled();
        expect(t.links.voiceLinks).toHaveLength(1);
    });
});

describe('LinkProvisioner.removeVoiceLink', () => {
    it('delegates to the link service and returns the removed link', async () => {
        const t = setup();
        const created = await t.links.createVoiceLink({
            guildLinkId: guildLink.id,
            discordChannelId: 'dvoice',
            fluxerChannelId: 'fvoice',
        });

        const removed = await t.provisioner.removeVoiceLink(created.id);

        expect(removed).toBe(created);
        expect(t.links.removeVoiceLink).toHaveBeenCalledWith(created.id);
        expect(t.links.voiceLinks).toHaveLength(0);
    });

    it('propagates a missing voice link error', async () => {
        const t = setup();
        await expect(t.provisioner.removeVoiceLink('nope')).rejects.toThrow(
            'Voice link not found'
        );
    });
});
