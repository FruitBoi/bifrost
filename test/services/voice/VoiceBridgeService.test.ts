import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GuildLink } from '../../../src/db/entities/GuildLink';
import { VoiceLink } from '../../../src/db/entities/VoiceLink';
import {
    LinkService,
    VoiceLinkListener,
} from '../../../src/services/LinkService';
import VoiceBridgeService from '../../../src/services/voice/VoiceBridgeService';
import { guildLink, nextId } from '../../helpers/fakes';
import { FakeVoiceTransport, createFakeMixer } from '../../helpers/voiceFakes';

const DGUILD = guildLink.discordGuildId;
const FGUILD = guildLink.fluxerGuildId;

function makeVoiceLink(overrides: Partial<VoiceLink> = {}): VoiceLink {
    return {
        id: nextId('vlink'),
        guildLinkId: guildLink.id,
        discordChannelId: 'dvoice',
        fluxerChannelId: 'fvoice',
        enabled: true,
        createdAt: new Date(),
        ...overrides,
    };
}

/** Just the slice of LinkService the bridge touches. */
class FakeVoiceLinkService {
    listener: VoiceLinkListener | null = null;
    guildLinks: GuildLink[] = [guildLink];

    constructor(public voiceLinks: VoiceLink[]) {}

    setVoiceLinkListener(listener: VoiceLinkListener | null) {
        this.listener = listener;
    }

    async getAllVoiceLinks() {
        return [...this.voiceLinks];
    }

    async getGuildLinkById(id: string) {
        return this.guildLinks.find((g) => g.id === id) ?? null;
    }

    asLinkService(): LinkService {
        return this as unknown as LinkService;
    }
}

/** Drains microtasks and promise chains without advancing fake timers. */
const flush = () => new Promise<void>((r) => setImmediate(r));

const pkt = (tag: string) => Buffer.from(tag);

function setup(
    options: {
        links?: VoiceLink[];
        leaveGraceMs?: number;
        joinRetryBackoffMs?: number[];
    } = {}
) {
    const link = options.links?.[0] ?? makeVoiceLink();
    const links = new FakeVoiceLinkService(options.links ?? [link]);
    const discord = new FakeVoiceTransport('discord', 'dbot');
    const fluxer = new FakeVoiceTransport('fluxer', 'fbot');
    const mixers = createFakeMixer();
    const service = new VoiceBridgeService({
        linkService: links.asLinkService(),
        discord,
        fluxer,
        createMixer: mixers.factory,
        leaveGraceMs: options.leaveGraceMs,
        joinRetryBackoffMs: options.joinRetryBackoffMs,
    });

    const joinAlice = async () => {
        discord.setParticipant(DGUILD, link.discordChannelId, {
            userId: 'alice',
        });
        await flush();
    };

    return {
        link,
        links,
        discord,
        fluxer,
        mixers: mixers.mixers,
        service,
        joinAlice,
    };
}

beforeEach(() => {
    // Keep setImmediate real so flush() can drain promise chains.
    vi.useFakeTimers({
        toFake: [
            'setTimeout',
            'clearTimeout',
            'setInterval',
            'clearInterval',
            'Date',
        ],
    });
});

afterEach(() => {
    vi.useRealTimers();
});

describe('joining', () => {
    it('joins both sides when a human enters the Discord side of an enabled link', async () => {
        const t = setup();
        await t.service.start();
        expect(t.links.listener).toBe(t.service);

        await t.joinAlice();

        expect(t.discord.joinCalls).toEqual([
            { guildId: DGUILD, channelId: 'dvoice' },
        ]);
        expect(t.fluxer.joinCalls).toEqual([
            { guildId: FGUILD, channelId: 'fvoice' },
        ]);
        expect(t.service.status().live).toHaveLength(1);
        expect(t.mixers).toHaveLength(2);
        expect(t.mixers.every((m) => m.started)).toBe(true);
    });

    it('joins both sides when a human enters the Fluxer side', async () => {
        const t = setup();
        await t.service.start();

        t.fluxer.setParticipant(FGUILD, 'fvoice', { userId: 'fred' });
        await flush();

        expect(t.discord.joinCalls).toHaveLength(1);
        expect(t.fluxer.joinCalls).toHaveLength(1);
        expect(t.service.status().live[0].fluxerParticipants).toBe(1);
    });

    it('joins on start() when someone is already in voice', async () => {
        const t = setup();
        t.discord.setParticipant(DGUILD, 'dvoice', { userId: 'alice' });

        await t.service.start();
        await flush();

        expect(t.service.status().live).toHaveLength(1);
    });

    it('does not join for a disabled link', async () => {
        const t = setup({ links: [makeVoiceLink({ enabled: false })] });
        await t.service.start();

        await t.joinAlice();

        expect(t.discord.joinCalls).toHaveLength(0);
        expect(t.fluxer.joinCalls).toHaveLength(0);
        expect(t.service.status().live).toHaveLength(0);
    });

    it('does not join for a channel that is not linked', async () => {
        const t = setup();
        await t.service.start();

        t.discord.setParticipant(DGUILD, 'other-voice', { userId: 'alice' });
        await flush();

        expect(t.discord.joinCalls).toHaveLength(0);
    });

    it("ignores the bots' own voice states and other bots", async () => {
        const t = setup();
        await t.service.start();

        t.discord.setParticipant(DGUILD, 'dvoice', {
            userId: 'dbot',
            isBot: true,
        });
        t.fluxer.setParticipant(FGUILD, 'fvoice', { userId: 'fbot' });
        t.discord.setParticipant(DGUILD, 'dvoice', {
            userId: 'some-other-bot',
            isBot: true,
        });
        await flush();

        expect(t.discord.joinCalls).toHaveLength(0);
        expect(t.fluxer.joinCalls).toHaveLength(0);
    });

    it('leaves the first side again when the second join fails, then retries', async () => {
        const t = setup({ joinRetryBackoffMs: [1_000] });
        await t.service.start();
        t.fluxer.rejectNextJoins(1);

        await t.joinAlice();

        expect(t.discord.sessions).toHaveLength(1);
        expect(t.discord.sessions[0].left).toBe(true);
        expect(t.service.status().live).toHaveLength(0);

        await vi.advanceTimersByTimeAsync(1_000);
        await flush();

        expect(t.discord.joinCalls).toHaveLength(2);
        expect(t.fluxer.joinCalls).toHaveLength(2);
        expect(t.service.status().live).toHaveLength(1);
    });

    it('allows only one live bridge per guild link', async () => {
        const a = makeVoiceLink({
            discordChannelId: 'dv-a',
            fluxerChannelId: 'fv-a',
        });
        const b = makeVoiceLink({
            discordChannelId: 'dv-b',
            fluxerChannelId: 'fv-b',
        });
        const t = setup({ links: [a, b] });
        await t.service.start();

        t.discord.setParticipant(DGUILD, 'dv-a', { userId: 'alice' });
        await flush();
        t.discord.setParticipant(DGUILD, 'dv-b', { userId: 'bob' });
        await flush();

        expect(t.discord.joinCalls).toEqual([
            { guildId: DGUILD, channelId: 'dv-a' },
        ]);
        expect(t.fluxer.joinCalls).toHaveLength(1);
        const live = t.service.status().live;
        expect(live).toHaveLength(1);
        expect(live[0].voiceLinkId).toBe(a.id);
    });

    it('bridges the waiting link once the other bridge of the guild link leaves', async () => {
        const a = makeVoiceLink({
            discordChannelId: 'dv-a',
            fluxerChannelId: 'fv-a',
        });
        const b = makeVoiceLink({
            discordChannelId: 'dv-b',
            fluxerChannelId: 'fv-b',
        });
        const t = setup({ links: [a, b], leaveGraceMs: 1_000 });
        await t.service.start();

        t.discord.setParticipant(DGUILD, 'dv-a', { userId: 'alice' });
        await flush();
        t.discord.setParticipant(DGUILD, 'dv-b', { userId: 'bob' });
        await flush();
        t.discord.setParticipant(DGUILD, null, { userId: 'alice' });
        await vi.advanceTimersByTimeAsync(1_000);
        await flush();

        const live = t.service.status().live;
        expect(live).toHaveLength(1);
        expect(live[0].voiceLinkId).toBe(b.id);
    });
});

describe('audio routing', () => {
    it('routes Discord audio into the toFluxer mixer and its frames to the Fluxer session', async () => {
        const t = setup();
        await t.service.start();
        await t.joinAlice();
        const [toFluxer] = t.mixers;
        const discordSession = t.discord.sessions[0];
        const fluxerSession = t.fluxer.sessions[0];

        discordSession.simulateAudio('alice', pkt('a1'));
        toFluxer.emitFrame(pkt('mix1'));

        expect(toFluxer.pushes).toEqual([
            { sourceId: 'alice', packet: pkt('a1') },
        ]);
        expect(fluxerSession.sent).toEqual([pkt('mix1')]);
        expect(discordSession.sent).toEqual([]);
    });

    it('routes Fluxer audio into the toDiscord mixer and its frames to the Discord session', async () => {
        const t = setup();
        await t.service.start();
        await t.joinAlice();
        const [, toDiscord] = t.mixers;
        const discordSession = t.discord.sessions[0];
        const fluxerSession = t.fluxer.sessions[0];

        fluxerSession.simulateAudio('fred', pkt('f1'));
        toDiscord.emitFrame(pkt('mix2'));

        expect(toDiscord.pushes).toEqual([
            { sourceId: 'fred', packet: pkt('f1') },
        ]);
        expect(discordSession.sent).toEqual([pkt('mix2')]);
        expect(fluxerSession.sent).toEqual([]);
    });

    it('never feeds audio attributed to either bot into a mixer', async () => {
        const t = setup();
        await t.service.start();
        await t.joinAlice();

        t.discord.sessions[0].simulateAudio('dbot', pkt('x'));
        t.discord.sessions[0].simulateAudio('fbot', pkt('y'));
        t.fluxer.sessions[0].simulateAudio('fbot', pkt('z'));

        expect(t.mixers[0].pushes).toEqual([]);
        expect(t.mixers[1].pushes).toEqual([]);
    });
});

describe('mute mapping', () => {
    it('mutes and unmutes the source on the mixer the user feeds', async () => {
        const t = setup();
        await t.service.start();
        await t.joinAlice();
        const [toFluxer, toDiscord] = t.mixers;

        t.discord.setParticipant(DGUILD, 'dvoice', {
            userId: 'alice',
            selfMute: true,
        });
        expect(toFluxer.mutedState('alice')).toBe(true);

        t.discord.setParticipant(DGUILD, 'dvoice', {
            userId: 'alice',
            selfMute: false,
        });
        expect(toFluxer.mutedState('alice')).toBe(false);

        t.discord.setParticipant(DGUILD, 'dvoice', {
            userId: 'alice',
            selfDeaf: true,
        });
        expect(toFluxer.mutedState('alice')).toBe(true);

        t.fluxer.setParticipant(FGUILD, 'fvoice', {
            userId: 'fred',
            selfMute: true,
        });
        expect(toDiscord.mutedState('fred')).toBe(true);
        expect(toFluxer.mutedState('fred')).toBeUndefined();
    });

    it('mutes participants who were already muted when the bridge joined', async () => {
        const t = setup();
        t.discord.setParticipant(DGUILD, 'dvoice', {
            userId: 'alice',
            selfMute: true,
        });
        await t.service.start();
        await flush();

        expect(t.mixers[0].mutedState('alice')).toBe(true);
    });

    it('removes the source when a participant leaves', async () => {
        const t = setup();
        await t.service.start();
        await t.joinAlice();
        t.fluxer.setParticipant(FGUILD, 'fvoice', { userId: 'fred' });

        t.discord.setParticipant(DGUILD, null, { userId: 'alice' });

        expect(t.mixers[0].removed).toEqual(['alice']);
        expect(t.mixers[1].removed).toEqual([]);
        expect(t.service.status().live[0].discordParticipants).toBe(0);
    });
});

describe('auto-leave', () => {
    it('leaves both channels after the grace period once everyone is gone', async () => {
        const t = setup({ leaveGraceMs: 30_000 });
        await t.service.start();
        await t.joinAlice();
        const discordSession = t.discord.sessions[0];
        const fluxerSession = t.fluxer.sessions[0];

        t.discord.setParticipant(DGUILD, null, { userId: 'alice' });
        await vi.advanceTimersByTimeAsync(29_999);
        await flush();

        expect(t.service.status().live).toHaveLength(1);
        expect(discordSession.left).toBe(false);

        await vi.advanceTimersByTimeAsync(1);
        await flush();

        expect(discordSession.left).toBe(true);
        expect(fluxerSession.left).toBe(true);
        expect(t.mixers.every((m) => m.stopped)).toBe(true);
        expect(t.service.status().live).toHaveLength(0);
    });

    it('cancels the grace timer when someone returns', async () => {
        const t = setup({ leaveGraceMs: 30_000 });
        await t.service.start();
        await t.joinAlice();

        t.discord.setParticipant(DGUILD, null, { userId: 'alice' });
        await vi.advanceTimersByTimeAsync(10_000);
        t.fluxer.setParticipant(FGUILD, 'fvoice', { userId: 'fred' });
        await vi.advanceTimersByTimeAsync(60_000);
        await flush();

        expect(t.service.status().live).toHaveLength(1);
        expect(t.discord.sessions[0].left).toBe(false);
        expect(t.fluxer.sessions[0].left).toBe(false);
    });

    it('stays while someone is still on the other side', async () => {
        const t = setup({ leaveGraceMs: 1_000 });
        await t.service.start();
        await t.joinAlice();
        t.fluxer.setParticipant(FGUILD, 'fvoice', { userId: 'fred' });

        t.discord.setParticipant(DGUILD, null, { userId: 'alice' });
        await vi.advanceTimersByTimeAsync(5_000);
        await flush();

        expect(t.service.status().live).toHaveLength(1);
    });

    it('rejoins when someone comes back after the bot left', async () => {
        const t = setup({ leaveGraceMs: 1_000 });
        await t.service.start();
        await t.joinAlice();

        t.discord.setParticipant(DGUILD, null, { userId: 'alice' });
        await vi.advanceTimersByTimeAsync(1_000);
        await flush();
        expect(t.service.status().live).toHaveLength(0);

        await t.joinAlice();

        expect(t.discord.joinCalls).toHaveLength(2);
        expect(t.service.status().live).toHaveLength(1);
    });
});

describe('reconnect', () => {
    it('leaves the other side and rejoins after the first backoff when a session drops', async () => {
        const t = setup({ joinRetryBackoffMs: [2_000, 5_000] });
        await t.service.start();
        await t.joinAlice();
        const discordSession = t.discord.sessions[0];
        const fluxerSession = t.fluxer.sessions[0];

        discordSession.simulateClose('network');
        await flush();

        expect(fluxerSession.left).toBe(true);
        expect(t.mixers.every((m) => m.stopped)).toBe(true);
        expect(t.service.status().live).toHaveLength(0);
        expect(t.discord.joinCalls).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(1_999);
        await flush();
        expect(t.discord.joinCalls).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(1);
        await flush();

        expect(t.discord.joinCalls).toHaveLength(2);
        expect(t.fluxer.joinCalls).toHaveLength(2);
        expect(t.service.status().live).toHaveLength(1);
        expect(t.mixers).toHaveLength(4);
    });

    it('gives up after the backoff array is exhausted and tries again on the next voice update', async () => {
        const backoff = [2_000, 5_000, 15_000, 60_000];
        const t = setup({ joinRetryBackoffMs: backoff });
        await t.service.start();
        await t.joinAlice();
        t.discord.rejectNextJoins(100);

        t.discord.sessions[0].simulateClose('network');
        await flush();

        for (const delay of backoff) {
            await vi.advanceTimersByTimeAsync(delay);
            await flush();
        }

        expect(t.discord.joinCalls).toHaveLength(1 + backoff.length);
        expect(t.service.status().live).toHaveLength(0);

        await vi.advanceTimersByTimeAsync(600_000);
        await flush();
        expect(t.discord.joinCalls).toHaveLength(1 + backoff.length);

        t.discord.rejectNextJoins(0);
        await t.joinAlice();

        expect(t.discord.joinCalls).toHaveLength(2 + backoff.length);
        expect(t.service.status().live).toHaveLength(1);
    });

    it('does not reconnect when nobody is left in either channel', async () => {
        const t = setup({ joinRetryBackoffMs: [1_000] });
        await t.service.start();
        await t.joinAlice();
        t.discord.setParticipant(DGUILD, null, { userId: 'alice' });

        t.fluxer.sessions[0].simulateClose('kicked');
        await flush();
        await vi.advanceTimersByTimeAsync(10_000);
        await flush();

        expect(t.discord.sessions[0].left).toBe(true);
        expect(t.discord.joinCalls).toHaveLength(1);
        expect(t.service.status().live).toHaveLength(0);
    });
});

describe('link changes', () => {
    it('tears the bridge down when the link is removed', async () => {
        const t = setup();
        await t.service.start();
        await t.joinAlice();

        t.service.onVoiceLinkChanged(t.link.id, null);
        await flush();

        expect(t.discord.sessions[0].left).toBe(true);
        expect(t.fluxer.sessions[0].left).toBe(true);
        expect(t.mixers.every((m) => m.stopped)).toBe(true);
        expect(t.service.status().live).toHaveLength(0);

        // Nobody listens for that channel any more.
        await t.joinAlice();
        expect(t.discord.joinCalls).toHaveLength(1);
    });

    it('tears the bridge down when the link is disabled and rejoins when re-enabled', async () => {
        const t = setup();
        await t.service.start();
        await t.joinAlice();

        t.service.onVoiceLinkChanged(t.link.id, { ...t.link, enabled: false });
        await flush();

        expect(t.discord.sessions[0].left).toBe(true);
        expect(t.fluxer.sessions[0].left).toBe(true);
        expect(t.service.status().live).toHaveLength(0);

        t.service.onVoiceLinkChanged(t.link.id, { ...t.link, enabled: true });
        await flush();

        expect(t.discord.joinCalls).toHaveLength(2);
        expect(t.service.status().live).toHaveLength(1);
    });

    it('joins a newly created link when people are already in its channels', async () => {
        const t = setup({ links: [] });
        await t.service.start();
        const link = makeVoiceLink({
            discordChannelId: 'dv-new',
            fluxerChannelId: 'fv-new',
        });
        t.fluxer.setParticipant(FGUILD, 'fv-new', { userId: 'fred' });

        t.service.onVoiceLinkChanged(link.id, link);
        await flush();

        expect(t.discord.joinCalls).toEqual([
            { guildId: DGUILD, channelId: 'dv-new' },
        ]);
        expect(t.service.status().live[0].voiceLinkId).toBe(link.id);
    });

    it('cancels a pending reconnect when the link is removed', async () => {
        const t = setup({ joinRetryBackoffMs: [5_000] });
        await t.service.start();
        await t.joinAlice();
        t.discord.sessions[0].simulateClose('network');
        await flush();

        t.service.onVoiceLinkChanged(t.link.id, null);
        await vi.advanceTimersByTimeAsync(10_000);
        await flush();

        expect(t.discord.joinCalls).toHaveLength(1);
    });
});

describe('status and stop', () => {
    it('reports live bridges with their participant counts', async () => {
        const t = setup();
        await t.service.start();
        expect(t.service.status()).toEqual({ live: [] });

        await t.joinAlice();
        t.discord.setParticipant(DGUILD, 'dvoice', { userId: 'bob' });
        t.fluxer.setParticipant(FGUILD, 'fvoice', { userId: 'fred' });
        t.fluxer.setParticipant(FGUILD, 'fvoice', { userId: 'fbot' });

        const status = t.service.status();
        expect(status.live).toHaveLength(1);
        expect(status.live[0]).toEqual({
            voiceLinkId: t.link.id,
            guildLinkId: guildLink.id,
            discordChannelId: 'dvoice',
            fluxerChannelId: 'fvoice',
            since: expect.any(Date),
            discordParticipants: 2,
            fluxerParticipants: 1,
        });
    });

    it('stop() leaves everything and unregisters the listener', async () => {
        const t = setup();
        await t.service.start();
        await t.joinAlice();

        await t.service.stop();

        expect(t.links.listener).toBeNull();
        expect(t.discord.sessions[0].left).toBe(true);
        expect(t.fluxer.sessions[0].left).toBe(true);
        expect(t.service.status().live).toHaveLength(0);

        await t.joinAlice();
        expect(t.discord.joinCalls).toHaveLength(1);
    });
});
