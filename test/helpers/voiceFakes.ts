import { EventEmitter } from 'events';
import {
    AudioMixer,
    AudioMixerFactory,
} from '../../src/services/voice/AudioMixer';
import {
    OpusPacket,
    VoiceParticipant,
    VoicePlatform,
    VoiceSession,
    VoiceTransport,
} from '../../src/services/voice/VoiceTransport';

interface VoiceStateEntry {
    channelId: string;
    participant: VoiceParticipant;
}

/**
 * In-memory voice stack for one platform. Voice states are mutated with
 * {@link setParticipant}, which emits `participantUpdate` on the transport
 * and on every open session whose channel the user entered or left, the
 * way a real transport does.
 */
export class FakeVoiceTransport extends EventEmitter implements VoiceTransport {
    /** Every session ever handed out by join(), including ones that left. */
    readonly sessions: FakeVoiceSession[] = [];
    readonly joinCalls: { guildId: string; channelId: string }[] = [];

    private botId: string | null;
    private joinRejections = 0;
    private joinRejectionMessage = 'join failed';
    /** guildId -> userId -> state */
    private readonly states = new Map<string, Map<string, VoiceStateEntry>>();

    constructor(
        readonly platform: VoicePlatform,
        botUserId: string | null = `${platform}-bot`
    ) {
        super();
        this.botId = botUserId;
    }

    setBotUserId(id: string | null) {
        this.botId = id;
    }

    botUserId(): string | null {
        return this.botId;
    }

    /** Makes the next `count` join() calls reject. */
    rejectNextJoins(count: number, message = 'join failed') {
        this.joinRejections = count;
        this.joinRejectionMessage = message;
    }

    /** Sessions that have not left yet. */
    get openSessions(): FakeVoiceSession[] {
        return this.sessions.filter((s) => !s.left);
    }

    /**
     * Everyone in the channel, bots included. The bridge is expected to
     * filter bots itself, so the fake deliberately does not.
     */
    listParticipants(guildId: string, channelId: string): VoiceParticipant[] {
        const guild = this.states.get(guildId);
        if (!guild) return [];
        return [...guild.values()]
            .filter((s) => s.channelId === channelId)
            .map((s) => s.participant);
    }

    /**
     * Moves `participant` into `channelId` (or out of voice when null) and
     * emits the matching update everywhere.
     */
    setParticipant(
        guildId: string,
        channelId: string | null,
        participant: Partial<VoiceParticipant> & { userId: string }
    ) {
        const full: VoiceParticipant = {
            userId: participant.userId,
            isBot: participant.isBot ?? false,
            selfMute: participant.selfMute ?? false,
            selfDeaf: participant.selfDeaf ?? false,
        };

        let guild = this.states.get(guildId);
        if (!guild) {
            guild = new Map();
            this.states.set(guildId, guild);
        }
        const previousChannelId = guild.get(full.userId)?.channelId ?? null;
        if (channelId === null) {
            guild.delete(full.userId);
        } else {
            guild.set(full.userId, { channelId, participant: full });
        }

        const update = { ...full, guildId, channelId, previousChannelId };
        this.emit('participantUpdate', update);
        for (const session of this.sessions) {
            if (session.left || session.guildId !== guildId) continue;
            if (
                session.channelId === channelId ||
                session.channelId === previousChannelId
            ) {
                session.emit('participantUpdate', update);
            }
        }
    }

    async join(guildId: string, channelId: string): Promise<VoiceSession> {
        this.joinCalls.push({ guildId, channelId });
        if (this.joinRejections > 0) {
            this.joinRejections--;
            throw new Error(this.joinRejectionMessage);
        }
        if (this.openSessions.some((s) => s.guildId === guildId)) {
            throw new Error(
                `${this.platform} bot is already in a voice channel of guild ${guildId}`
            );
        }
        const session = new FakeVoiceSession(this, guildId, channelId);
        this.sessions.push(session);
        return session;
    }
}

export class FakeVoiceSession extends EventEmitter implements VoiceSession {
    readonly platform: VoicePlatform;
    /** Every packet passed to sendOpus(), in order. */
    readonly sent: OpusPacket[] = [];
    left = false;
    leaveCalls = 0;
    /**
     * When set, exposed as the optional `stats()` the bridge duck-types on
     * real sessions and appends to its periodic stats line.
     */
    statsOverride: {
        framesIn: number;
        packetsOut: number;
        participants: number;
    } | null = null;

    constructor(
        private readonly transport: FakeVoiceTransport,
        readonly guildId: string,
        readonly channelId: string
    ) {
        super();
        this.platform = transport.platform;
    }

    /** Only defined while `statsOverride` is set, like a transport that may or may not expose it. */
    get stats(): (() => NonNullable<typeof this.statsOverride>) | undefined {
        const stats = this.statsOverride;
        if (!stats) return undefined;
        return () => stats;
    }

    participants(): VoiceParticipant[] {
        return this.transport
            .listParticipants(this.guildId, this.channelId)
            .filter((p) => p.userId !== this.transport.botUserId());
    }

    sendOpus(packet: OpusPacket): void {
        this.sent.push(packet);
    }

    /** Leaves and emits `closed`, like a real session being destroyed. */
    async leave(): Promise<void> {
        this.leaveCalls++;
        if (this.left) return;
        this.left = true;
        this.emit('closed', 'left');
    }

    simulateAudio(userId: string, packet: OpusPacket) {
        this.emit('audio', userId, packet);
    }

    /** The connection dropped without us asking to leave. */
    simulateClose(reason: string) {
        if (this.left) return;
        this.left = true;
        this.emit('closed', reason);
    }
}

export class FakeMixer extends EventEmitter implements AudioMixer {
    readonly pushes: { sourceId: string; packet: OpusPacket }[] = [];
    readonly mutes: { sourceId: string; muted: boolean }[] = [];
    readonly removed: string[] = [];
    started = false;
    stopped = false;

    push(sourceId: string, packet: OpusPacket): void {
        this.pushes.push({ sourceId, packet });
    }

    removeSource(sourceId: string): void {
        this.removed.push(sourceId);
    }

    setSourceMuted(sourceId: string, muted: boolean): void {
        this.mutes.push({ sourceId, muted });
    }

    start(): void {
        this.started = true;
    }

    stop(): void {
        this.stopped = true;
    }

    /**
     * Emits one output frame. `silent` mirrors OpusMixer's second `frame`
     * argument; leaving it out emits a frame the bridge counts as voiced.
     */
    emitFrame(packet: OpusPacket, silent?: boolean) {
        if (silent === undefined) this.emit('frame', packet);
        else this.emit('frame', packet, silent);
    }

    /** Last mute state recorded for a source, or undefined if never set. */
    mutedState(sourceId: string): boolean | undefined {
        for (let i = this.mutes.length - 1; i >= 0; i--) {
            if (this.mutes[i].sourceId === sourceId) return this.mutes[i].muted;
        }
        return undefined;
    }
}

/**
 * Mixer factory that remembers every mixer it created. The bridge creates
 * the Discord→Fluxer mixer first and the Fluxer→Discord mixer second for
 * each bridge, so `mixers[0]` / `mixers[1]` are those for the first bridge.
 */
export function createFakeMixer(): {
    factory: AudioMixerFactory;
    mixers: FakeMixer[];
} {
    const mixers: FakeMixer[] = [];
    const factory: AudioMixerFactory = () => {
        const mixer = new FakeMixer();
        mixers.push(mixer);
        return mixer;
    };
    return { factory, mixers };
}
