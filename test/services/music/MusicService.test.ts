import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GuildLink } from '../../../src/db/entities/GuildLink';
import { VoiceLink } from '../../../src/db/entities/VoiceLink';
import {
    LinkService,
    VoiceLinkListener,
} from '../../../src/services/LinkService';
import MusicService from '../../../src/services/music/MusicService';
import {
    EnqueueRequest,
    MusicError,
    OpusSink,
    PlaybackEndReason,
    PlaybackHandle,
    TrackInfo,
    TrackPlayer,
    TrackResolver,
} from '../../../src/services/music/types';
import VoiceBridgeService from '../../../src/services/voice/VoiceBridgeService';
import { guildLink } from '../../helpers/fakes';
import { FakeVoiceTransport, createFakeMixer } from '../../helpers/voiceFakes';

const DGUILD = guildLink.discordGuildId;
const FGUILD = guildLink.fluxerGuildId;

/** Drains microtasks and promise chains without advancing fake timers. */
const flush = () => new Promise<void>((r) => setImmediate(r));

const pkt = (tag: string) => Buffer.from(tag);

class FakeResolver implements TrackResolver {
    readonly queries: string[] = [];

    async resolve(query: string): Promise<TrackInfo> {
        this.queries.push(query);
        if (query === 'nothing') throw new MusicError('No results found.');
        return {
            title: query,
            url: `https://example.com/${query}`,
            durationSec: 60,
            isLive: false,
        };
    }
}

class FakeHandle extends EventEmitter {
    paused = false;
    stopped = false;
    ended = false;

    constructor(
        readonly track: TrackInfo,
        readonly sink: OpusSink
    ) {
        super();
    }

    elapsedMs(): number {
        return 12_500;
    }

    pause() {
        this.paused = true;
    }

    resume() {
        this.paused = false;
    }

    stop() {
        this.stopped = true;
        this.finish('stopped');
    }

    finish(reason: PlaybackEndReason = 'finished', err?: Error) {
        if (this.ended) return;
        this.ended = true;
        this.emit('end', reason, err);
    }
}

class FakePlayer implements TrackPlayer {
    readonly handles: FakeHandle[] = [];

    play(track: TrackInfo, sink: OpusSink): PlaybackHandle {
        const handle = new FakeHandle(track, sink);
        this.handles.push(handle);
        return handle as unknown as PlaybackHandle;
    }

    get last(): FakeHandle {
        return this.handles[this.handles.length - 1];
    }
}

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

const link: VoiceLink = {
    id: 'vlink-music',
    guildLinkId: guildLink.id,
    discordChannelId: 'dvoice',
    fluxerChannelId: 'fvoice',
    enabled: true,
    createdAt: new Date(),
};

async function setup(options: { withBridge?: boolean } = {}) {
    const discord = new FakeVoiceTransport('discord', 'dbot');
    const fluxer = new FakeVoiceTransport('fluxer', 'fbot');
    const mixers = createFakeMixer();
    const resolver = new FakeResolver();
    const player = new FakePlayer();
    const announcements: string[] = [];

    let music: MusicService | null = null;
    const bridge =
        options.withBridge === false
            ? null
            : new VoiceBridgeService({
                  linkService: new FakeVoiceLinkService([link]).asLinkService(),
                  discord,
                  fluxer,
                  createMixer: mixers.factory,
                  leaveGraceMs: 200,
                  joinRetryBackoffMs: [],
                  beforeJoin: (p, g, c) => music?.yieldToBridge(p, g, c),
              });
    await bridge?.start();

    music = new MusicService({
        transports: { discord: () => discord, fluxer: () => fluxer },
        bridge: () => bridge,
        resolver,
        player,
        maxQueueLength: 3,
        idleLeaveMs: 1_000,
        aloneLeaveMs: 500,
        monitorIntervalMs: 100,
        bridgeWaitMs: 5_000,
    });

    const request = (
        userId: string,
        query: string,
        overrides: Partial<EnqueueRequest> = {}
    ): EnqueueRequest => ({
        platform: 'discord',
        guildId: DGUILD,
        userId,
        requesterName: `${userId}-name`,
        query,
        announce: (text) => announcements.push(text),
        ...overrides,
    });

    /** Puts a user into a Discord voice channel. */
    const enterDiscord = async (userId: string, channelId: string | null) => {
        discord.setParticipant(DGUILD, channelId, { userId });
        await flush();
    };
    const enterFluxer = async (userId: string, channelId: string | null) => {
        fluxer.setParticipant(FGUILD, channelId, { userId });
        await flush();
    };

    return {
        discord,
        fluxer,
        mixers: mixers.mixers,
        resolver,
        player,
        announcements,
        bridge,
        music,
        request,
        enterDiscord,
        enterFluxer,
    };
}

async function advance(ms: number) {
    await vi.advanceTimersByTimeAsync(ms);
    await flush();
}

beforeEach(() => {
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

describe('enqueue', () => {
    it('rejects a requester who is not in voice', async () => {
        const t = await setup();
        await expect(
            t.music.enqueue(t.request('alice', 'song'))
        ).rejects.toThrow('You need to be in a voice channel first.');
        expect(t.discord.joinCalls).toEqual([]);
    });

    it('rejects when the transport is unavailable', async () => {
        const t = await setup();
        const music = new MusicService({
            transports: { discord: () => null, fluxer: () => null },
            bridge: () => null,
            resolver: t.resolver,
            player: t.player,
        });
        await expect(music.enqueue(t.request('alice', 'song'))).rejects.toThrow(
            MusicError
        );
    });

    it('propagates resolver errors without joining', async () => {
        const t = await setup();
        await t.enterDiscord('alice', 'music-vc');
        await expect(
            t.music.enqueue(t.request('alice', 'nothing'))
        ).rejects.toThrow('No results found.');
        expect(t.discord.joinCalls).toEqual([]);
        expect(t.music.queue('discord', DGUILD)).toBeNull();
    });

    it('joins the requester channel and plays into the session', async () => {
        const t = await setup();
        await t.enterDiscord('alice', 'music-vc');

        const result = await t.music.enqueue(t.request('alice', 'song-a'));

        expect(result.position).toBe(0);
        expect(result.track).toMatchObject({
            title: 'song-a',
            requestedBy: 'alice-name',
        });
        expect(t.discord.joinCalls).toEqual([
            { guildId: DGUILD, channelId: 'music-vc' },
        ]);
        expect(t.player.handles).toHaveLength(1);
        expect(t.player.last.paused).toBe(false);

        t.player.last.sink(pkt('frame1'));
        expect(t.discord.openSessions[0].sent).toEqual([pkt('frame1')]);
        // The command handler replies for the first track itself.
        expect(t.announcements).toEqual([]);
    });

    it('queues further tracks, auto-advances and announces each next track', async () => {
        const t = await setup();
        await t.enterDiscord('alice', 'music-vc');
        await t.enterDiscord('bob', 'music-vc');

        await t.music.enqueue(t.request('alice', 'a'));
        expect((await t.music.enqueue(t.request('bob', 'b'))).position).toBe(1);
        expect((await t.music.enqueue(t.request('alice', 'c'))).position).toBe(
            2
        );

        const view = t.music.queue('discord', DGUILD);
        expect(view).toMatchObject({
            channelId: 'music-vc',
            paused: false,
            nowPlaying: { title: 'a', elapsedSec: 12 },
        });
        expect(view?.upcoming.map((x) => x.title)).toEqual(['b', 'c']);

        t.player.last.finish();
        expect(t.player.last.track.title).toBe('b');
        expect(t.announcements).toEqual([
            '🎶 Now playing **b** (requested by bob-name)',
        ]);
        t.player.last.finish();
        expect(t.player.last.track.title).toBe('c');
        expect(t.music.queue('discord', DGUILD)?.upcoming).toEqual([]);
        // Only one session for the whole queue.
        expect(t.discord.joinCalls).toHaveLength(1);
    });

    it('rejects once the queue is full', async () => {
        const t = await setup();
        await t.enterDiscord('alice', 'music-vc');
        await t.music.enqueue(t.request('alice', 'now'));
        for (const q of ['1', '2', '3']) {
            await t.music.enqueue(t.request('alice', q));
        }
        await expect(t.music.enqueue(t.request('alice', '4'))).rejects.toThrow(
            'The queue is full'
        );
    });

    it('rejects a requester in another channel of the same guild', async () => {
        const t = await setup();
        await t.enterDiscord('alice', 'music-vc');
        await t.enterDiscord('bob', 'other-vc');
        await t.music.enqueue(t.request('alice', 'a'));

        await expect(t.music.enqueue(t.request('bob', 'b'))).rejects.toThrow(
            "I'm already playing music in <#music-vc>"
        );
    });

    it('keeps guilds and platforms apart', async () => {
        const t = await setup();
        await t.enterDiscord('alice', 'music-vc');
        await t.enterFluxer('fred', 'fluxer-music');
        await t.music.enqueue(t.request('alice', 'a'));
        const result = await t.music.enqueue(
            t.request('fred', 'f', { platform: 'fluxer', guildId: FGUILD })
        );
        expect(result.position).toBe(0);
        expect(t.fluxer.joinCalls).toEqual([
            { guildId: FGUILD, channelId: 'fluxer-music' },
        ]);
    });

    it('reports a failed join and forgets the queue', async () => {
        const t = await setup();
        await t.enterDiscord('alice', 'music-vc');
        t.discord.rejectNextJoins(1);
        await expect(t.music.enqueue(t.request('alice', 'a'))).rejects.toThrow(
            "I couldn't join <#music-vc>"
        );
        expect(t.music.queue('discord', DGUILD)).toBeNull();
        expect(t.player.handles).toHaveLength(0);
    });

    it('announces a playback error and moves on to the next track', async () => {
        const t = await setup();
        await t.enterDiscord('alice', 'music-vc');
        await t.music.enqueue(t.request('alice', 'broken'));
        await t.music.enqueue(t.request('alice', 'fine'));

        t.player.last.finish('error', new Error('ffmpeg exited'));

        expect(t.announcements).toEqual([
            "⚠️ Couldn't play **broken**. Skipping it.",
            '🎶 Now playing **fine** (requested by alice-name)',
        ]);
        expect(t.player.last.track.title).toBe('fine');
    });
});

describe('controls', () => {
    it('reject when nothing is playing', async () => {
        const t = await setup();
        await t.enterDiscord('alice', 'music-vc');
        expect(() => t.music.skip('discord', DGUILD, 'alice')).toThrow(
            'Nothing is playing right now.'
        );
        expect(() => t.music.stop('discord', DGUILD, 'alice')).toThrow(
            MusicError
        );
        expect(() => t.music.pause('discord', DGUILD, 'alice')).toThrow(
            MusicError
        );
        expect(() => t.music.resume('discord', DGUILD, 'alice')).toThrow(
            MusicError
        );
    });

    it('reject users who are not in the music channel', async () => {
        const t = await setup();
        await t.enterDiscord('alice', 'music-vc');
        await t.enterDiscord('bob', 'other-vc');
        await t.music.enqueue(t.request('alice', 'a'));

        for (const call of [
            () => t.music.skip('discord', DGUILD, 'bob'),
            () => t.music.stop('discord', DGUILD, 'bob'),
            () => t.music.pause('discord', DGUILD, 'bob'),
            () => t.music.resume('discord', DGUILD, 'bob'),
            () => t.music.skip('discord', DGUILD, 'carol'),
        ]) {
            expect(call).toThrow('You need to be in <#music-vc>');
        }
        expect(t.player.last.stopped).toBe(false);
    });

    it('skip plays the next track and returns the skipped one', async () => {
        const t = await setup();
        await t.enterDiscord('alice', 'music-vc');
        await t.music.enqueue(t.request('alice', 'a'));
        await t.music.enqueue(t.request('alice', 'b'));
        const first = t.player.last;

        expect(t.music.skip('discord', DGUILD, 'alice').title).toBe('a');
        expect(first.stopped).toBe(true);
        expect(t.player.last.track.title).toBe('b');
    });

    it('pause and resume the handle, rejecting repeats', async () => {
        const t = await setup();
        await t.enterDiscord('alice', 'music-vc');
        await t.music.enqueue(t.request('alice', 'a'));

        t.music.pause('discord', DGUILD, 'alice');
        expect(t.player.last.paused).toBe(true);
        expect(t.music.queue('discord', DGUILD)?.paused).toBe(true);
        expect(() => t.music.pause('discord', DGUILD, 'alice')).toThrow(
            'already paused'
        );

        t.music.resume('discord', DGUILD, 'alice');
        expect(t.player.last.paused).toBe(false);
        expect(() => t.music.resume('discord', DGUILD, 'alice')).toThrow(
            'not paused'
        );
    });

    it('stop clears the queue and leaves', async () => {
        const t = await setup();
        await t.enterDiscord('alice', 'music-vc');
        await t.music.enqueue(t.request('alice', 'a'));
        await t.music.enqueue(t.request('alice', 'b'));

        t.music.stop('discord', DGUILD, 'alice');
        await flush();

        expect(t.player.handles[0].stopped).toBe(true);
        expect(t.player.handles).toHaveLength(1);
        expect(t.discord.openSessions).toEqual([]);
        expect(t.music.queue('discord', DGUILD)).toBeNull();
        expect(t.announcements).toEqual([]);
    });

    it('stopAll ends every queue', async () => {
        const t = await setup();
        await t.enterDiscord('alice', 'music-vc');
        await t.enterFluxer('fred', 'fluxer-music');
        await t.music.enqueue(t.request('alice', 'a'));
        await t.music.enqueue(
            t.request('fred', 'f', { platform: 'fluxer', guildId: FGUILD })
        );

        await t.music.stopAll();

        expect(t.discord.openSessions).toEqual([]);
        expect(t.fluxer.openSessions).toEqual([]);
        expect(t.player.handles.every((h) => h.stopped)).toBe(true);
    });
});

describe('auto-leave', () => {
    it('leaves after idleLeaveMs once the queue is empty', async () => {
        const t = await setup();
        await t.enterDiscord('alice', 'music-vc');
        await t.music.enqueue(t.request('alice', 'a'));
        t.player.last.finish();

        await advance(900);
        expect(t.discord.openSessions).toHaveLength(1);
        // A new track in time keeps the session and starts right away.
        const result = await t.music.enqueue(t.request('alice', 'b'));
        expect(result.position).toBe(0);
        t.player.last.finish();

        await advance(1_000);
        expect(t.discord.openSessions).toEqual([]);
        expect(t.music.queue('discord', DGUILD)).toBeNull();
        expect(t.announcements.at(-1)).toContain('Nothing left to play');
    });

    it('leaves after aloneLeaveMs when no humans remain', async () => {
        const t = await setup();
        await t.enterDiscord('alice', 'music-vc');
        await t.music.enqueue(t.request('alice', 'a'));

        await t.enterDiscord('alice', null);
        await advance(300);
        // Coming back cancels it.
        await t.enterDiscord('alice', 'music-vc');
        await advance(400);
        expect(t.discord.openSessions).toHaveLength(1);

        await t.enterDiscord('alice', null);
        await advance(500);
        expect(t.discord.openSessions).toEqual([]);
        expect(t.player.last.stopped).toBe(true);
        expect(t.announcements.at(-1)).toContain('Everyone left');
    });

    it('stops and announces when the session closes unexpectedly', async () => {
        const t = await setup();
        await t.enterDiscord('alice', 'music-vc');
        await t.music.enqueue(t.request('alice', 'a'));

        t.discord.openSessions[0].simulateClose('kicked');
        await flush();

        expect(t.music.queue('discord', DGUILD)).toBeNull();
        expect(t.player.last.stopped).toBe(true);
        expect(t.announcements).toEqual([
            '⚠️ I got disconnected from voice, so the music stopped.',
        ]);
    });
});

describe('voice bridge coordination', () => {
    /** Populates both sides of the link, which makes the bridge go live. */
    const goLive = async (t: Awaited<ReturnType<typeof setup>>) => {
        await t.enterDiscord('alice', 'dvoice');
        await t.enterFluxer('fred', 'fvoice');
        await flush();
        expect(t.bridge?.status().live).toHaveLength(1);
    };

    it('injects into the live bridge when the requester channel is bridged', async () => {
        const t = await setup();
        await goLive(t);
        const [toFluxer, toDiscord] = t.mixers;

        const result = await t.music.enqueue(t.request('alice', 'a'));
        expect(result.position).toBe(0);
        // No own session: the bridge's sessions are the only ones.
        expect(t.discord.joinCalls).toHaveLength(1);

        t.player.last.sink(pkt('m1'));
        const pushed = (m: typeof toFluxer) =>
            m.pushes.filter((p) => p.sourceId.startsWith('injected:'));
        expect(pushed(toFluxer).map((p) => p.packet)).toEqual([pkt('m1')]);
        expect(pushed(toDiscord).map((p) => p.packet)).toEqual([pkt('m1')]);

        t.music.stop('discord', DGUILD, 'alice');
        await flush();
        expect(toFluxer.removed.some((id) => id.startsWith('injected:'))).toBe(
            true
        );
        expect(t.bridge?.status().live).toHaveLength(1);
    });

    it('works from the Fluxer side of a bridge too', async () => {
        const t = await setup();
        await goLive(t);
        await t.music.enqueue(
            t.request('fred', 'f', { platform: 'fluxer', guildId: FGUILD })
        );
        t.player.last.sink(pkt('m1'));
        expect(
            t.mixers[1].pushes.some((p) => p.sourceId.startsWith('injected:'))
        ).toBe(true);
        expect(t.fluxer.joinCalls).toHaveLength(1);
    });

    it('rejects when the bridge occupies another channel of the guild', async () => {
        const t = await setup();
        await goLive(t);
        await t.enterDiscord('bob', 'music-vc');

        await expect(t.music.enqueue(t.request('bob', 'a'))).rejects.toThrow(
            "I'm busy bridging voice in <#dvoice>."
        );
    });

    it('hands its session over to the bridge in the same channel and continues through it', async () => {
        const t = await setup();
        await t.enterDiscord('alice', 'dvoice');
        await t.music.enqueue(t.request('alice', 'a'));
        const own = t.discord.openSessions[0];
        expect(own.channelId).toBe('dvoice');

        // Someone on Fluxer makes the bridge want the same Discord channel.
        await t.enterFluxer('fred', 'fvoice');
        await flush();
        expect(own.left).toBe(true);
        expect(t.bridge?.status().live).toHaveLength(1);
        expect(t.player.last.paused).toBe(true);

        await advance(100);
        expect(t.player.last.paused).toBe(false);
        t.player.last.sink(pkt('m1'));
        expect(
            t.mixers[0].pushes.some((p) => p.sourceId.startsWith('injected:'))
        ).toBe(true);
        expect(t.announcements).toEqual([]);
    });

    it('stops with an announcement when the bridge needs another channel', async () => {
        const t = await setup();
        await t.enterDiscord('alice', 'music-vc');
        await t.music.enqueue(t.request('alice', 'a'));

        await t.enterDiscord('bob', 'dvoice');
        await t.enterFluxer('fred', 'fvoice');
        await flush();

        expect(t.player.last.stopped).toBe(true);
        expect(t.music.queue('discord', DGUILD)).toBeNull();
        expect(t.announcements).toEqual([
            '⏹️ Stopped the music: the voice bridge needs me in <#dvoice>.',
        ]);
        expect(t.bridge?.status().live).toHaveLength(1);
    });

    it('falls back to its own session when the bridge leaves mid-song', async () => {
        const t = await setup();
        await goLive(t);
        await t.music.enqueue(t.request('alice', 'a'));

        // The Fluxer side empties; the bridge leaves after its grace.
        await t.enterFluxer('fred', null);
        await advance(200);
        expect(t.bridge?.status().live).toEqual([]);

        await advance(100);
        const own = t.discord.openSessions;
        expect(own).toHaveLength(1);
        expect(own[0].channelId).toBe('dvoice');
        expect(t.player.last.paused).toBe(false);
        t.player.last.sink(pkt('m2'));
        expect(own[0].sent).toEqual([pkt('m2')]);
        expect(t.music.queue('discord', DGUILD)?.nowPlaying?.title).toBe('a');
    });

    it('stops with an announcement when rejoining after the bridge fails', async () => {
        const t = await setup();
        await goLive(t);
        await t.music.enqueue(t.request('alice', 'a'));

        await t.enterFluxer('fred', null);
        t.discord.rejectNextJoins(1);
        await advance(300);

        expect(t.music.queue('discord', DGUILD)).toBeNull();
        expect(t.announcements.at(-1)).toContain("I couldn't join <#dvoice>");
    });
});
