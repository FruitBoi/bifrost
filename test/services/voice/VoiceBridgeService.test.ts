import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GuildLink } from '../../../src/db/entities/GuildLink';
import { VoiceLink } from '../../../src/db/entities/VoiceLink';
import {
    LinkService,
    VoiceLinkListener,
} from '../../../src/services/LinkService';
import VoiceBridgeService from '../../../src/services/voice/VoiceBridgeService';
import logger from '../../../src/utils/logging/logger';
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
        statsIntervalMs?: number;
        silentSideWarnMs?: number;
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
        statsIntervalMs: options.statsIntervalMs,
        silentSideWarnMs: options.silentSideWarnMs,
    });

    /** Puts 'alice' in the Discord channel of the link. */
    const joinAlice = async () => {
        discord.setParticipant(DGUILD, link.discordChannelId, {
            userId: 'alice',
        });
        await flush();
    };

    /** Puts 'fred' in the Fluxer channel of the link. */
    const joinFred = async () => {
        fluxer.setParticipant(FGUILD, link.fluxerChannelId, {
            userId: 'fred',
        });
        await flush();
    };

    /** Populates both sides, which is what makes the bridge join. */
    const joinBoth = async () => {
        discord.setParticipant(DGUILD, link.discordChannelId, {
            userId: 'alice',
        });
        fluxer.setParticipant(FGUILD, link.fluxerChannelId, {
            userId: 'fred',
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
        joinFred,
        joinBoth,
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
    vi.restoreAllMocks();
});

/** Messages logged at `level` so far (first argument of each call). */
function logged(spy: ReturnType<typeof vi.spyOn>): string[] {
    return spy.mock.calls.map((call) => String(call[0]));
}

describe('joining', () => {
    it('joins both sides once humans are on both the Discord and the Fluxer side', async () => {
        const t = setup();
        await t.service.start();
        expect(t.links.listener).toBe(t.service);

        await t.joinAlice();

        expect(t.discord.joinCalls).toEqual([]);
        expect(t.fluxer.joinCalls).toEqual([]);
        expect(t.service.status().live).toEqual([]);

        await t.joinFred();

        expect(t.discord.joinCalls).toEqual([
            { guildId: DGUILD, channelId: 'dvoice' },
        ]);
        expect(t.fluxer.joinCalls).toEqual([
            { guildId: FGUILD, channelId: 'fvoice' },
        ]);
        const live = t.service.status().live;
        expect(live).toHaveLength(1);
        expect(live[0].discordParticipants).toBe(1);
        expect(live[0].fluxerParticipants).toBe(1);
        expect(t.mixers).toHaveLength(2);
        expect(t.mixers.every((m) => m.started)).toBe(true);
    });

    it('joins when the Discord side gets its first human after the Fluxer side', async () => {
        const t = setup();
        await t.service.start();

        await t.joinFred();

        expect(t.discord.joinCalls).toEqual([]);
        expect(t.fluxer.joinCalls).toEqual([]);
        expect(t.service.status().live).toEqual([]);

        await t.joinAlice();

        expect(t.discord.joinCalls).toHaveLength(1);
        expect(t.fluxer.joinCalls).toHaveLength(1);
        expect(t.service.status().live).toHaveLength(1);
    });

    it('does not join when only the Discord side has people', async () => {
        const info = vi.spyOn(logger, 'info');
        const t = setup();
        await t.service.start();

        await t.joinAlice();
        t.discord.setParticipant(DGUILD, 'dvoice', { userId: 'bob' });
        await flush();

        expect(t.discord.joinCalls).toEqual([]);
        expect(t.fluxer.joinCalls).toEqual([]);
        expect(t.service.status().live).toEqual([]);
        expect(t.mixers).toEqual([]);
        expect(logged(info)).toContain(
            `[VoiceBridge] ⏳ Not joining voice link ${t.link.id}: Fluxer side is empty; waiting for someone on the other side`
        );
    });

    it('does not join when only the Fluxer side has people', async () => {
        const info = vi.spyOn(logger, 'info');
        const t = setup();
        await t.service.start();

        await t.joinFred();
        t.fluxer.setParticipant(FGUILD, 'fvoice', { userId: 'gina' });
        await flush();

        expect(t.discord.joinCalls).toEqual([]);
        expect(t.fluxer.joinCalls).toEqual([]);
        expect(t.service.status().live).toEqual([]);
        expect(t.mixers).toEqual([]);
        expect(logged(info)).toContain(
            `[VoiceBridge] ⏳ Not joining voice link ${t.link.id}: Discord side is empty; waiting for someone on the other side`
        );
    });

    it('logs why it is waiting once per occupancy change, not on every voice state update', async () => {
        const info = vi.spyOn(logger, 'info');
        const t = setup();
        await t.service.start();
        const waiting = () =>
            logged(info).filter((m) => m.includes('Not joining voice link'));

        await t.joinAlice();
        t.discord.setParticipant(DGUILD, 'dvoice', {
            userId: 'alice',
            selfMute: true,
        });
        t.discord.setParticipant(DGUILD, 'dvoice', {
            userId: 'alice',
            selfMute: false,
        });
        await flush();
        expect(waiting()).toHaveLength(1);

        // Leaving and coming back is news again.
        t.discord.setParticipant(DGUILD, null, { userId: 'alice' });
        await t.joinAlice();
        expect(waiting()).toHaveLength(2);

        // So is the empty side flipping.
        t.discord.setParticipant(DGUILD, null, { userId: 'alice' });
        await t.joinFred();
        expect(waiting()).toHaveLength(3);
        expect(waiting()[2]).toContain('Discord side is empty');

        expect(t.discord.joinCalls).toEqual([]);
    });

    it('joins on start() when both sides are already populated', async () => {
        const t = setup();
        t.discord.setParticipant(DGUILD, 'dvoice', { userId: 'alice' });
        t.fluxer.setParticipant(FGUILD, 'fvoice', { userId: 'fred' });

        await t.service.start();
        await flush();

        expect(t.discord.joinCalls).toHaveLength(1);
        expect(t.fluxer.joinCalls).toHaveLength(1);
        expect(t.service.status().live).toHaveLength(1);
    });

    it.each(['discord', 'fluxer'] as const)(
        'does not join on start() when only the %s side is populated',
        async (side) => {
            const info = vi.spyOn(logger, 'info');
            const t = setup();
            if (side === 'discord') {
                t.discord.setParticipant(DGUILD, 'dvoice', {
                    userId: 'alice',
                });
            } else {
                t.fluxer.setParticipant(FGUILD, 'fvoice', { userId: 'fred' });
            }

            await t.service.start();
            await flush();

            expect(t.discord.joinCalls).toEqual([]);
            expect(t.fluxer.joinCalls).toEqual([]);
            expect(t.service.status().live).toEqual([]);
            expect(logged(info)).toContain(
                `[VoiceBridge] ⏳ Not joining voice link ${t.link.id}: ${
                    side === 'discord' ? 'Fluxer' : 'Discord'
                } side is empty; waiting for someone on the other side`
            );
        }
    );

    it('does not join for a disabled link', async () => {
        const t = setup({ links: [makeVoiceLink({ enabled: false })] });
        await t.service.start();

        await t.joinBoth();

        expect(t.discord.joinCalls).toHaveLength(0);
        expect(t.fluxer.joinCalls).toHaveLength(0);
        expect(t.service.status().live).toHaveLength(0);
    });

    it('does not join for a channel that is not linked', async () => {
        const t = setup();
        await t.service.start();

        await t.joinFred();
        t.discord.setParticipant(DGUILD, 'other-voice', { userId: 'alice' });
        await flush();

        expect(t.discord.joinCalls).toHaveLength(0);
        expect(t.fluxer.joinCalls).toHaveLength(0);
    });

    it("ignores the bots' own voice states and other bots", async () => {
        const t = setup();
        await t.service.start();

        // A human on Discord, only the bot on Fluxer: not populated.
        t.discord.setParticipant(DGUILD, 'dvoice', { userId: 'alice' });
        t.fluxer.setParticipant(FGUILD, 'fvoice', { userId: 'fbot' });
        await flush();

        expect(t.discord.joinCalls).toHaveLength(0);
        expect(t.fluxer.joinCalls).toHaveLength(0);

        // A human on Fluxer, only bots on Discord: still not populated.
        t.discord.setParticipant(DGUILD, null, { userId: 'alice' });
        t.discord.setParticipant(DGUILD, 'dvoice', {
            userId: 'dbot',
            isBot: true,
        });
        t.discord.setParticipant(DGUILD, 'dvoice', {
            userId: 'some-other-bot',
            isBot: true,
        });
        t.fluxer.setParticipant(FGUILD, 'fvoice', { userId: 'fred' });
        await flush();

        expect(t.discord.joinCalls).toHaveLength(0);
        expect(t.fluxer.joinCalls).toHaveLength(0);
        expect(t.service.status().live).toHaveLength(0);
    });

    it('leaves the first side again when the second join fails, then retries', async () => {
        const t = setup({ joinRetryBackoffMs: [1_000] });
        await t.service.start();
        t.fluxer.rejectNextJoins(1);

        await t.joinBoth();

        expect(t.discord.sessions).toHaveLength(1);
        expect(t.discord.sessions[0].left).toBe(true);
        expect(t.service.status().live).toHaveLength(0);

        await vi.advanceTimersByTimeAsync(1_000);
        await flush();

        expect(t.discord.joinCalls).toHaveLength(2);
        expect(t.fluxer.joinCalls).toHaveLength(2);
        expect(t.service.status().live).toHaveLength(1);
    });

    it('abandons a retry when one side emptied during the backoff', async () => {
        const info = vi.spyOn(logger, 'info');
        const t = setup({ joinRetryBackoffMs: [1_000] });
        await t.service.start();
        t.fluxer.rejectNextJoins(1);

        await t.joinBoth();
        t.fluxer.setParticipant(FGUILD, null, { userId: 'fred' });
        await vi.advanceTimersByTimeAsync(1_000);
        await flush();

        expect(t.discord.joinCalls).toHaveLength(1);
        expect(t.fluxer.joinCalls).toHaveLength(1);
        expect(t.service.status().live).toHaveLength(0);
        expect(logged(info)).toContain(
            `[VoiceBridge] 👋 Not joining voice link ${t.link.id}: Fluxer side is empty`
        );

        // Nothing lingers: both sides populated again means a fresh join.
        await t.joinFred();
        expect(t.discord.joinCalls).toHaveLength(2);
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
        t.fluxer.setParticipant(FGUILD, 'fv-a', { userId: 'fred' });
        await flush();
        t.discord.setParticipant(DGUILD, 'dv-b', { userId: 'bob' });
        t.fluxer.setParticipant(FGUILD, 'fv-b', { userId: 'gina' });
        await flush();

        expect(t.discord.joinCalls).toEqual([
            { guildId: DGUILD, channelId: 'dv-a' },
        ]);
        expect(t.fluxer.joinCalls).toEqual([
            { guildId: FGUILD, channelId: 'fv-a' },
        ]);
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
        t.fluxer.setParticipant(FGUILD, 'fv-a', { userId: 'fred' });
        await flush();
        t.discord.setParticipant(DGUILD, 'dv-b', { userId: 'bob' });
        t.fluxer.setParticipant(FGUILD, 'fv-b', { userId: 'gina' });
        await flush();
        expect(t.service.status().live[0].voiceLinkId).toBe(a.id);

        // Fred is still in fv-a, but a bridge needs both sides.
        t.discord.setParticipant(DGUILD, null, { userId: 'alice' });
        await vi.advanceTimersByTimeAsync(1_000);
        await flush();

        const live = t.service.status().live;
        expect(live).toHaveLength(1);
        expect(live[0].voiceLinkId).toBe(b.id);
        expect(t.discord.joinCalls).toEqual([
            { guildId: DGUILD, channelId: 'dv-a' },
            { guildId: DGUILD, channelId: 'dv-b' },
        ]);
    });
});

describe('audio routing', () => {
    it('routes Discord audio into the toFluxer mixer and its frames to the Fluxer session', async () => {
        const t = setup();
        await t.service.start();
        await t.joinBoth();
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
        await t.joinBoth();
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
        await t.joinBoth();

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
        await t.joinBoth();
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
        t.fluxer.setParticipant(FGUILD, 'fvoice', { userId: 'fred' });
        await t.service.start();
        await flush();

        expect(t.service.status().live).toHaveLength(1);
        expect(t.mixers[0].mutedState('alice')).toBe(true);
        expect(t.mixers[1].mutedState('fred')).toBeUndefined();
    });

    it('removes the source when a participant leaves', async () => {
        const t = setup();
        await t.service.start();
        await t.joinBoth();

        t.discord.setParticipant(DGUILD, null, { userId: 'alice' });

        expect(t.mixers[0].removed).toEqual(['alice']);
        expect(t.mixers[1].removed).toEqual([]);
        expect(t.service.status().live[0].discordParticipants).toBe(0);
        expect(t.service.status().live[0].fluxerParticipants).toBe(1);
    });
});

describe('auto-leave', () => {
    it('leaves after the grace period when one side empties while the other still has people', async () => {
        const info = vi.spyOn(logger, 'info');
        const t = setup({ leaveGraceMs: 30_000 });
        await t.service.start();
        await t.joinBoth();
        const discordSession = t.discord.sessions[0];
        const fluxerSession = t.fluxer.sessions[0];

        t.discord.setParticipant(DGUILD, null, { userId: 'alice' });
        await vi.advanceTimersByTimeAsync(29_999);
        await flush();

        expect(logged(info)).toContain(
            `[VoiceBridge] 👋 Voice link ${t.link.id}: Discord side is empty; leaving in 30000 ms`
        );
        expect(t.service.status().live).toHaveLength(1);
        expect(discordSession.left).toBe(false);
        expect(fluxerSession.left).toBe(false);

        await vi.advanceTimersByTimeAsync(1);
        await flush();

        expect(discordSession.left).toBe(true);
        expect(fluxerSession.left).toBe(true);
        expect(t.mixers.every((m) => m.stopped)).toBe(true);
        expect(t.service.status().live).toHaveLength(0);
        expect(logged(info)).toContain(
            `[VoiceBridge] 👋 Leaving voice link ${t.link.id}: Discord side is empty`
        );

        // Fred alone on Fluxer does not bring the bot back.
        expect(t.fluxer.listParticipants(FGUILD, 'fvoice')).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(60_000);
        await flush();
        expect(t.discord.joinCalls).toHaveLength(1);
        expect(t.fluxer.joinCalls).toHaveLength(1);
    });

    it('leaves after the grace period when the Fluxer side empties', async () => {
        const info = vi.spyOn(logger, 'info');
        const t = setup({ leaveGraceMs: 1_000 });
        await t.service.start();
        await t.joinBoth();

        t.fluxer.setParticipant(FGUILD, null, { userId: 'fred' });
        await vi.advanceTimersByTimeAsync(1_000);
        await flush();

        expect(logged(info)).toContain(
            `[VoiceBridge] 👋 Voice link ${t.link.id}: Fluxer side is empty; leaving in 1000 ms`
        );
        expect(t.discord.sessions[0].left).toBe(true);
        expect(t.fluxer.sessions[0].left).toBe(true);
        expect(t.service.status().live).toHaveLength(0);
    });

    it('cancels the grace timer when the empty side is repopulated', async () => {
        const info = vi.spyOn(logger, 'info');
        const t = setup({ leaveGraceMs: 30_000 });
        await t.service.start();
        await t.joinBoth();

        t.discord.setParticipant(DGUILD, null, { userId: 'alice' });
        await vi.advanceTimersByTimeAsync(10_000);
        t.discord.setParticipant(DGUILD, 'dvoice', { userId: 'bob' });
        await vi.advanceTimersByTimeAsync(60_000);
        await flush();

        expect(logged(info)).toContain(
            `[VoiceBridge] 🔗 Both sides of voice link ${t.link.id} are populated again; staying`
        );
        expect(t.service.status().live).toHaveLength(1);
        expect(t.discord.sessions[0].left).toBe(false);
        expect(t.fluxer.sessions[0].left).toBe(false);
    });

    it('does not cancel the grace timer when someone joins the side that was populated anyway', async () => {
        const t = setup({ leaveGraceMs: 30_000 });
        await t.service.start();
        await t.joinBoth();

        t.discord.setParticipant(DGUILD, null, { userId: 'alice' });
        await vi.advanceTimersByTimeAsync(10_000);
        t.fluxer.setParticipant(FGUILD, 'fvoice', { userId: 'gina' });
        await vi.advanceTimersByTimeAsync(20_000);
        await flush();

        expect(t.service.status().live).toHaveLength(0);
        expect(t.discord.sessions[0].left).toBe(true);
        expect(t.fluxer.sessions[0].left).toBe(true);
    });

    it('leaves when everyone is gone', async () => {
        const info = vi.spyOn(logger, 'info');
        const t = setup({ leaveGraceMs: 1_000 });
        await t.service.start();
        await t.joinBoth();

        t.discord.setParticipant(DGUILD, null, { userId: 'alice' });
        t.fluxer.setParticipant(FGUILD, null, { userId: 'fred' });
        await vi.advanceTimersByTimeAsync(1_000);
        await flush();

        expect(t.discord.sessions[0].left).toBe(true);
        expect(t.fluxer.sessions[0].left).toBe(true);
        expect(t.mixers.every((m) => m.stopped)).toBe(true);
        expect(t.service.status().live).toHaveLength(0);
        expect(logged(info)).toContain(
            `[VoiceBridge] 👋 Leaving voice link ${t.link.id}: both sides are empty`
        );
    });

    it('rejoins when both sides are populated again after the bot left', async () => {
        const t = setup({ leaveGraceMs: 1_000 });
        await t.service.start();
        await t.joinBoth();

        t.discord.setParticipant(DGUILD, null, { userId: 'alice' });
        await vi.advanceTimersByTimeAsync(1_000);
        await flush();
        expect(t.service.status().live).toHaveLength(0);

        await t.joinAlice();

        expect(t.discord.joinCalls).toHaveLength(2);
        expect(t.fluxer.joinCalls).toHaveLength(2);
        expect(t.service.status().live).toHaveLength(1);
    });
});

describe('reconnect', () => {
    it('leaves the other side and rejoins after the first backoff when a session drops', async () => {
        const t = setup({ joinRetryBackoffMs: [2_000, 5_000] });
        await t.service.start();
        await t.joinBoth();
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
        await t.joinBoth();
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

    it('does not reconnect when one side is empty at the time of the drop', async () => {
        const info = vi.spyOn(logger, 'info');
        const t = setup({ joinRetryBackoffMs: [1_000], leaveGraceMs: 30_000 });
        await t.service.start();
        await t.joinBoth();
        t.discord.setParticipant(DGUILD, null, { userId: 'alice' });

        t.fluxer.sessions[0].simulateClose('kicked');
        await flush();
        await vi.advanceTimersByTimeAsync(10_000);
        await flush();

        expect(t.discord.sessions[0].left).toBe(true);
        expect(t.discord.joinCalls).toHaveLength(1);
        expect(t.fluxer.joinCalls).toHaveLength(1);
        expect(t.service.status().live).toHaveLength(0);
        expect(logged(info)).toContain(
            `[VoiceBridge] 👋 Not reconnecting voice link ${t.link.id}: Discord side is empty`
        );

        // Nothing is pending: the old grace timer must not fire anything.
        await vi.advanceTimersByTimeAsync(60_000);
        await flush();
        expect(t.discord.joinCalls).toHaveLength(1);
    });

    it('does not reconnect when nobody is left in either channel', async () => {
        const info = vi.spyOn(logger, 'info');
        const t = setup({ joinRetryBackoffMs: [1_000] });
        await t.service.start();
        await t.joinBoth();
        t.discord.setParticipant(DGUILD, null, { userId: 'alice' });
        t.fluxer.setParticipant(FGUILD, null, { userId: 'fred' });

        t.fluxer.sessions[0].simulateClose('kicked');
        await flush();
        await vi.advanceTimersByTimeAsync(10_000);
        await flush();

        expect(t.discord.sessions[0].left).toBe(true);
        expect(t.discord.joinCalls).toHaveLength(1);
        expect(t.service.status().live).toHaveLength(0);
        expect(logged(info)).toContain(
            `[VoiceBridge] 👋 Not reconnecting voice link ${t.link.id}: both sides are empty`
        );
    });
});

describe('link changes', () => {
    it('tears the bridge down when the link is removed', async () => {
        const t = setup();
        await t.service.start();
        await t.joinBoth();

        t.service.onVoiceLinkChanged(t.link.id, null);
        await flush();

        expect(t.discord.sessions[0].left).toBe(true);
        expect(t.fluxer.sessions[0].left).toBe(true);
        expect(t.mixers.every((m) => m.stopped)).toBe(true);
        expect(t.service.status().live).toHaveLength(0);

        // Nobody listens for those channels any more.
        await t.joinBoth();
        expect(t.discord.joinCalls).toHaveLength(1);
    });

    it('tears the bridge down when the link is disabled and rejoins when re-enabled', async () => {
        const t = setup();
        await t.service.start();
        await t.joinBoth();

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

    it('joins a newly created link when people are already in both its channels', async () => {
        const t = setup({ links: [] });
        await t.service.start();
        const link = makeVoiceLink({
            discordChannelId: 'dv-new',
            fluxerChannelId: 'fv-new',
        });
        t.discord.setParticipant(DGUILD, 'dv-new', { userId: 'alice' });
        t.fluxer.setParticipant(FGUILD, 'fv-new', { userId: 'fred' });

        t.service.onVoiceLinkChanged(link.id, link);
        await flush();

        expect(t.discord.joinCalls).toEqual([
            { guildId: DGUILD, channelId: 'dv-new' },
        ]);
        expect(t.fluxer.joinCalls).toEqual([
            { guildId: FGUILD, channelId: 'fv-new' },
        ]);
        expect(t.service.status().live[0].voiceLinkId).toBe(link.id);
    });

    it('does not join a newly created link when only one of its channels has people', async () => {
        const info = vi.spyOn(logger, 'info');
        const t = setup({ links: [] });
        await t.service.start();
        const link = makeVoiceLink({
            discordChannelId: 'dv-new',
            fluxerChannelId: 'fv-new',
        });
        t.fluxer.setParticipant(FGUILD, 'fv-new', { userId: 'fred' });

        t.service.onVoiceLinkChanged(link.id, link);
        await flush();

        expect(t.discord.joinCalls).toEqual([]);
        expect(t.fluxer.joinCalls).toEqual([]);
        expect(t.service.status().live).toEqual([]);
        expect(logged(info)).toContain(
            `[VoiceBridge] ⏳ Not joining voice link ${link.id}: Discord side is empty; waiting for someone on the other side`
        );

        t.discord.setParticipant(DGUILD, 'dv-new', { userId: 'alice' });
        await flush();

        expect(t.service.status().live[0].voiceLinkId).toBe(link.id);
    });

    it('cancels a pending reconnect when the link is removed', async () => {
        const t = setup({ joinRetryBackoffMs: [5_000] });
        await t.service.start();
        await t.joinBoth();
        t.discord.sessions[0].simulateClose('network');
        await flush();

        t.service.onVoiceLinkChanged(t.link.id, null);
        await vi.advanceTimersByTimeAsync(10_000);
        await flush();

        expect(t.discord.joinCalls).toHaveLength(1);
    });
});

describe('diagnostics', () => {
    const statsLines = (spy: ReturnType<typeof vi.spyOn>) =>
        logged(spy).filter((m) => m.includes('📊'));

    it('logs who is on each side (and the bot ids) when the bridge goes live', async () => {
        const info = vi.spyOn(logger, 'info');
        const t = setup();
        t.discord.setParticipant(DGUILD, 'dvoice', { userId: 'alice' });
        t.fluxer.setParticipant(FGUILD, 'fvoice', {
            userId: 'fred',
            selfMute: true,
        });
        await t.service.start();
        await flush();

        const line = logged(info).find((m) => m.includes('participants:'));
        expect(line).toBe(
            `[VoiceBridge] 👥 link ${t.link.id} participants: Discord [alice] · Fluxer [fred (muted)] · bots D=dbot F=fbot`
        );
    });

    it('logs per-direction deltas every stats interval and stops on teardown', async () => {
        const info = vi.spyOn(logger, 'info');
        const t = setup({ statsIntervalMs: 15_000, leaveGraceMs: 1_000 });
        await t.service.start();
        await t.joinBoth();
        const [toFluxer, toDiscord] = t.mixers;
        const discordSession = t.discord.sessions[0];
        const fluxerSession = t.fluxer.sessions[0];

        discordSession.simulateAudio('alice', pkt('a1'));
        discordSession.simulateAudio('alice', pkt('a2'));
        discordSession.simulateAudio('alice', pkt('a3'));
        discordSession.simulateAudio('dbot', pkt('ignored'));
        toFluxer.emitFrame(pkt('s'), true);
        toFluxer.emitFrame(pkt('v1'), false);
        toFluxer.emitFrame(pkt('v2')); // no flag: counted as voiced
        fluxerSession.simulateAudio('fred', pkt('f1'));
        toDiscord.emitFrame(pkt('s'), true);
        toDiscord.emitFrame(pkt('s'), true);

        await vi.advanceTimersByTimeAsync(14_999);
        expect(statsLines(info)).toEqual([]);

        await vi.advanceTimersByTimeAsync(1);
        expect(statsLines(info)).toEqual([
            `[VoiceBridge] 📊 link ${t.link.id}: Discord→Fluxer in=3 out=3 (2 voiced) · Fluxer→Discord in=1 out=2 (0 voiced) · participants D=1 F=1`,
        ]);

        // Deltas, not totals: a quiet interval reports zeros.
        await vi.advanceTimersByTimeAsync(15_000);
        expect(statsLines(info)).toHaveLength(2);
        expect(statsLines(info)[1]).toBe(
            `[VoiceBridge] 📊 link ${t.link.id}: Discord→Fluxer in=0 out=0 (0 voiced) · Fluxer→Discord in=0 out=0 (0 voiced) · participants D=1 F=1`
        );

        // Everyone leaves; after the grace period the interval must be gone.
        t.discord.setParticipant(DGUILD, null, { userId: 'alice' });
        t.fluxer.setParticipant(FGUILD, null, { userId: 'fred' });
        await vi.advanceTimersByTimeAsync(1_000);
        await flush();
        expect(t.service.status().live).toHaveLength(0);

        await vi.advanceTimersByTimeAsync(60_000);
        expect(statsLines(info)).toHaveLength(2);
    });

    it('appends session stats() when a transport exposes them', async () => {
        const info = vi.spyOn(logger, 'info');
        const t = setup({ statsIntervalMs: 15_000 });
        await t.service.start();
        await t.joinBoth();
        t.fluxer.sessions[0].statsOverride = {
            framesIn: 0,
            packetsOut: 750,
            participants: 2,
        };

        await vi.advanceTimersByTimeAsync(15_000);

        expect(statsLines(info)).toEqual([
            `[VoiceBridge] 📊 link ${t.link.id}: Discord→Fluxer in=0 out=0 (0 voiced) · Fluxer→Discord in=0 out=0 (0 voiced) · participants D=1 F=1 · Fluxer session framesIn=0 packetsOut=750 participants=2`,
        ]);
    });

    it('warns once when a side with unmuted people has sent no audio after the warn delay', async () => {
        const warn = vi.spyOn(logger, 'warn');
        const t = setup({ silentSideWarnMs: 10_000 });
        await t.service.start();
        await t.joinBoth();
        t.fluxer.setParticipant(FGUILD, 'fvoice', { userId: 'gina' });

        // Discord audio flows, Fluxer audio never arrives: today's bug.
        t.discord.sessions[0].simulateAudio('alice', pkt('a1'));

        await vi.advanceTimersByTimeAsync(9_999);
        expect(logged(warn)).toEqual([]);

        await vi.advanceTimersByTimeAsync(1);
        expect(logged(warn)).toEqual([
            `[VoiceBridge] ⚠️ link ${t.link.id}: no audio received from Fluxer in the first 10000 ms although 2 unmuted participant(s) are there (fred, gina); Fluxer→Discord is silent — check the fluxer transport's receive path`,
        ]);

        await vi.advanceTimersByTimeAsync(60_000);
        expect(logged(warn)).toHaveLength(1);
    });

    it('does not warn when audio arrived from every populated side, or when the silent side is muted', async () => {
        const warn = vi.spyOn(logger, 'warn');
        const t = setup({ silentSideWarnMs: 10_000 });
        await t.service.start();
        t.discord.setParticipant(DGUILD, 'dvoice', { userId: 'alice' });
        t.fluxer.setParticipant(FGUILD, 'fvoice', {
            userId: 'fred',
            selfMute: true,
        });
        await flush();
        expect(t.service.status().live).toHaveLength(1);

        t.discord.sessions[0].simulateAudio('alice', pkt('a1'));
        await vi.advanceTimersByTimeAsync(10_000);

        expect(logged(warn)).toEqual([]);
    });

    it('cancels the silent-side check when the bridge leaves before it fires', async () => {
        const warn = vi.spyOn(logger, 'warn');
        const t = setup({ silentSideWarnMs: 10_000 });
        await t.service.start();
        await t.joinBoth();

        t.service.onVoiceLinkChanged(t.link.id, null);
        await flush();
        await vi.advanceTimersByTimeAsync(20_000);

        expect(logged(warn)).toEqual([]);
    });
});

describe('status and stop', () => {
    it('reports live bridges with their participant counts', async () => {
        const t = setup();
        await t.service.start();
        expect(t.service.status()).toEqual({ live: [] });

        await t.joinBoth();
        t.discord.setParticipant(DGUILD, 'dvoice', { userId: 'bob' });
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
        await t.joinBoth();

        await t.service.stop();

        expect(t.links.listener).toBeNull();
        expect(t.discord.sessions[0].left).toBe(true);
        expect(t.fluxer.sessions[0].left).toBe(true);
        expect(t.service.status().live).toHaveLength(0);

        await t.joinBoth();
        expect(t.discord.joinCalls).toHaveLength(1);
    });
});
