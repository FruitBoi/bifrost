import { parseDuration } from '../reminders/reminderArgs';
import logger from '../../utils/logging/logger';

export const OPSEC_COMMAND_NAMES = ['opsec', 'opsex'] as const;
export const OPSEC_DEFAULT_DURATION_MS = 30 * 60_000;
export const OPSEC_MAX_DURATION_MS = 24 * 60 * 60_000;

interface Pause {
    endsAt: number;
    timer: ReturnType<typeof setTimeout>;
    onEnd: () => void | Promise<void>;
}

/**
 * In-memory opsec pauses (issue #60): channels/threads whose Fluxer messages
 * are not bridged to Discord until the pause runs out or is stopped.
 */
export default class OpsecService {
    private readonly pauses = new Map<string, Pause>();

    /**
     * Pauses bridging of `channelId` to Discord for `durationMs`; when it runs
     * out (or `stop` is called) the entry is removed first, then `onEnd` is
     * called (errors from it are logged, never thrown). Calling start on an
     * active channel replaces its timer and onEnd and returns extended: true.
     */
    start(
        channelId: string,
        durationMs: number,
        onEnd: () => void | Promise<void>
    ): { endsAt: number; extended: boolean } {
        const previous = this.pauses.get(channelId);
        if (previous) clearTimeout(previous.timer);
        const endsAt = Date.now() + durationMs;
        const timer = setTimeout(() => this.end(channelId), durationMs);
        timer.unref?.();
        this.pauses.set(channelId, { endsAt, timer, onEnd });
        return { endsAt, extended: previous !== undefined };
    }

    /** Ends the pause now (removing it, then calling its onEnd). */
    stop(channelId: string): boolean {
        const pause = this.pauses.get(channelId);
        if (!pause) return false;
        clearTimeout(pause.timer);
        this.end(channelId);
        return true;
    }

    isActive(channelId: string): boolean {
        return this.pauses.has(channelId);
    }

    /** Epoch ms the pause ends, or null. */
    endsAt(channelId: string): number | null {
        return this.pauses.get(channelId)?.endsAt ?? null;
    }

    private end(channelId: string): void {
        const pause = this.pauses.get(channelId);
        if (!pause) return;
        this.pauses.delete(channelId);
        try {
            Promise.resolve(pause.onEnd()).catch((err: unknown) => {
                logger.error('❌ Opsec end callback failed:', err);
            });
        } catch (err: unknown) {
            logger.error('❌ Opsec end callback failed:', err);
        }
    }
}

export type OpsecArgs =
    | { action: 'on'; durationMs: number }
    | { action: 'off' }
    | { action: 'status' }
    | { action: 'invalid'; reason: string };

function parseOnDuration(parts: string[]): OpsecArgs {
    if (parts.length === 0) {
        return { action: 'on', durationMs: OPSEC_DEFAULT_DURATION_MS };
    }
    const durationMs = parseDuration(parts.join(' '));
    if (durationMs === null || durationMs === 0) {
        return {
            action: 'invalid',
            reason: `I could not read "${parts.join(' ')}" as a duration.`,
        };
    }
    if (durationMs > OPSEC_MAX_DURATION_MS) {
        return {
            action: 'invalid',
            reason: 'A session can last at most 24 hours.',
        };
    }
    return { action: 'on', durationMs };
}

export function parseOpsecArgs(args: string[]): OpsecArgs {
    if (args.length === 0) return { action: 'status' };
    const first = args[0].toLowerCase();
    if (first === 'on') return parseOnDuration(args.slice(1));
    if (first === 'off') return { action: 'off' };
    if (first === 'status') return { action: 'status' };
    if (/^[0-9]/.test(first)) return parseOnDuration(args);
    return {
        action: 'invalid',
        reason: `Unknown option "${args[0]}".`,
    };
}

export function opsecStartMessage(endsAt: number): string {
    const seconds = Math.floor(endsAt / 1000);
    return [
        '🚨🔒🤫🍆💦🔥🫣🙈🚫👀🕶️🚨🔒🤫🍆💦🔥🫣🙈🚫👀🕶️',
        '🍑😳💋🔞🥵😏🌶️🍌🛑🔐🤐🚷🍑😳💋🔞🥵😏🌶️🍌',
        '**A fluxer sex session is currently occurring that you are not privy to. Have a nice day Mr. Thiel.**',
        '🕶️👀🚫🙈🫣🔥💦🍆🤫🔒🚨🕶️👀🚫🙈🫣🔥💦🍆🤫🔒🚨',
        '🍌🌶️😏🥵🔞💋😳🍑🚷🤐🔐🛑🍌🌶️😏🥵🔞💋😳🍑',
        `-# Bridging to Discord resumes <t:${seconds}:R>.`,
    ].join('\n');
}

export function opsecEndMessage(): string {
    return [
        '🎉🥳🎊😮‍💨💦🍆🛌🚿🧻🎈🎉🥳🎊😮‍💨💦🍆🛌🚿🧻🎈',
        '🔓🌅🫡👏🥂🍾🍑😌💤🔔🔓🌅🫡👏🥂🍾🍑😌💤🔔',
        '**The sex session has ended.**',
        '🔔💤😌🍑🍾🥂👏🫡🌅🔓🔔💤😌🍑🍾🥂👏🫡🌅🔓',
        '🧻🚿🛌🍆💦😮‍💨🎊🥳🎉🧻🚿🛌🍆💦😮‍💨🎊🥳🎉',
    ].join('\n');
}
