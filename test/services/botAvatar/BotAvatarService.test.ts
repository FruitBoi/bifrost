import { describe, expect, it, vi } from 'vitest';
import BotAvatarService, {
    AvatarEmoji,
    AvatarFluxerClient,
    AvatarFluxerGuild,
    AvatarScheduler,
    BotAvatarConfig,
    avatarMimeType,
    nextRunAt,
    pickEmoji,
    toDataUri,
} from '../../../src/services/botAvatar/BotAvatarService';

vi.mock('../../../src/utils/logging/logger', () => ({
    default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function emoji(id: string, animated = false): AvatarEmoji {
    return {
        id,
        name: `e${id}`,
        animated,
        url: `https://media.example/emojis/${id}.${animated ? 'gif' : 'png'}`,
    };
}

function guild(id: string, emojis: AvatarEmoji[]): AvatarFluxerGuild {
    return { id, fetchEmojis: vi.fn(async () => emojis) };
}

function fluxerClient(guilds: AvatarFluxerGuild[]) {
    const byId = new Map(guilds.map((g) => [g.id, g]));
    const patch = vi.fn(async () => ({}));
    const client: AvatarFluxerClient = {
        guilds: {
            values: () => byId.values(),
            fetch: vi.fn(async (id: string) => {
                const found = byId.get(id);
                if (!found) throw new Error(`unknown guild ${id}`);
                return found;
            }),
        },
        rest: { patch },
    };
    return { client, patch };
}

function config(overrides: Partial<BotAvatarConfig> = {}): BotAvatarConfig {
    return {
        hourUtc: 0,
        guildIds: [],
        discord: true,
        includeAnimated: false,
        ...overrides,
    };
}

/** Scheduler that records timers so tests can fire them by hand. */
function manualScheduler() {
    const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
    const scheduler: AvatarScheduler = {
        setTimeout: (fn, ms) => {
            const timer = { fn, ms, cleared: false };
            timers.push(timer);
            return timer;
        },
        clearTimeout: (handle) => {
            (handle as { cleared: boolean }).cleared = true;
        },
    };
    return { scheduler, timers };
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const download = vi.fn(async () => ({ bytes: PNG, contentType: 'image/png' }));

describe('nextRunAt', () => {
    const day = Date.UTC(2026, 9, 24);

    it('is later the same day when the hour has not come yet', () => {
        expect(nextRunAt(day + 5 * HOUR_MS + 1, 6)).toBe(day + 6 * HOUR_MS);
    });

    it('is the next day once the hour has passed', () => {
        expect(nextRunAt(day + 6 * HOUR_MS + 1, 6)).toBe(
            day + DAY_MS + 6 * HOUR_MS
        );
    });

    it('is the next day when exactly at the hour', () => {
        expect(nextRunAt(day + 6 * HOUR_MS, 6)).toBe(
            day + DAY_MS + 6 * HOUR_MS
        );
        expect(nextRunAt(day, 0)).toBe(day + DAY_MS);
    });

    it('rolls over month and year ends', () => {
        const nye = Date.UTC(2026, 11, 31, 23, 30);
        expect(nextRunAt(nye, 0)).toBe(Date.UTC(2027, 0, 1, 0));
        expect(nextRunAt(nye, 23)).toBe(Date.UTC(2027, 0, 1, 23));
    });
});

describe('pickEmoji', () => {
    const emojis = [emoji('1'), emoji('2'), emoji('3')];

    it('returns null for an empty list', () => {
        expect(pickEmoji([], null)).toBeNull();
    });

    it('picks uniformly by the random value', () => {
        expect(pickEmoji(emojis, null, () => 0)?.id).toBe('1');
        expect(pickEmoji(emojis, null, () => 0.5)?.id).toBe('2');
        expect(pickEmoji(emojis, null, () => 0.9999)?.id).toBe('3');
    });

    it('never picks the last emoji when there is a choice', () => {
        for (const r of [0, 0.3, 0.6, 0.9999]) {
            expect(pickEmoji(emojis, '1', () => r)?.id).not.toBe('1');
        }
        expect(pickEmoji(emojis, '2', () => 0.9999)?.id).toBe('3');
    });

    it('repeats the last emoji when it is the only one', () => {
        expect(pickEmoji([emoji('1')], '1', () => 0.5)?.id).toBe('1');
    });
});

describe('avatarMimeType / toDataUri', () => {
    it('uses the content type without parameters', () => {
        expect(
            avatarMimeType(
                { bytes: PNG, contentType: 'Image/GIF; charset=binary' },
                'x.png'
            )
        ).toBe('image/gif');
    });

    it('falls back to the URL extension', () => {
        const image = { bytes: PNG, contentType: null };
        expect(avatarMimeType(image, 'https://m/emojis/1.gif?size=128')).toBe(
            'image/gif'
        );
        expect(avatarMimeType(image, 'https://m/emojis/1.png')).toBe(
            'image/png'
        );
        expect(avatarMimeType(image, 'https://m/emojis/1')).toBe('image/png');
    });

    it('builds a base64 data URI', () => {
        expect(toDataUri(Buffer.from('hi'), 'image/png')).toBe(
            'data:image/png;base64,aGk='
        );
    });
});

describe('BotAvatarService.runOnce', () => {
    it('sets the same emoji as the avatar on Fluxer and Discord', async () => {
        const { client, patch } = fluxerClient([
            guild('g1', [emoji('1'), emoji('2')]),
        ]);
        const setAvatar = vi.fn(async () => undefined);
        const service = new BotAvatarService({
            config: config(),
            getFluxerClient: () => client,
            getDiscordClient: () => ({ user: { setAvatar } }),
            random: () => 0.75,
            downloadImage: download,
        });

        const result = await service.runOnce();

        expect(result).toEqual({
            emoji: emoji('2'),
            fluxer: 'updated',
            discord: 'updated',
        });
        expect(download).toHaveBeenCalledWith(emoji('2').url);
        expect(patch).toHaveBeenCalledWith('/users/@me', {
            body: { avatar: `data:image/png;base64,${PNG.toString('base64')}` },
        });
        expect(setAvatar).toHaveBeenCalledWith(PNG);
    });

    it('does not pick the same emoji on consecutive runs', async () => {
        const { client } = fluxerClient([
            guild('g1', [emoji('1'), emoji('2')]),
        ]);
        const service = new BotAvatarService({
            config: config({ discord: false }),
            getFluxerClient: () => client,
            random: () => 0,
            downloadImage: download,
        });

        const first = await service.runOnce();
        const second = await service.runOnce();
        const third = await service.runOnce();

        expect(first.emoji?.id).toBe('1');
        expect(second.emoji?.id).toBe('2');
        expect(third.emoji?.id).toBe('1');
    });

    it('skips animated emojis unless includeAnimated is on', async () => {
        const emojis = [emoji('1', true), emoji('2'), emoji('3', true)];
        const { client } = fluxerClient([guild('g1', emojis)]);
        const make = (includeAnimated: boolean) =>
            new BotAvatarService({
                config: config({ discord: false, includeAnimated }),
                getFluxerClient: () => client,
                random: () => 0.9999,
                downloadImage: download,
            });

        expect((await make(false).runOnce()).emoji?.id).toBe('2');
        expect((await make(true).runOnce()).emoji?.id).toBe('3');
    });

    it('only uses the configured guilds when guildIds is set', async () => {
        const g1 = guild('g1', [emoji('1')]);
        const g2 = guild('g2', [emoji('2')]);
        const { client } = fluxerClient([g1, g2]);
        const service = new BotAvatarService({
            config: config({ discord: false, guildIds: ['g2', 'missing'] }),
            getFluxerClient: () => client,
            random: () => 0,
            downloadImage: download,
        });

        const result = await service.runOnce();

        expect(result.emoji?.id).toBe('2');
        expect(result.fluxer).toBe('updated');
        expect(g1.fetchEmojis).not.toHaveBeenCalled();
    });

    it('uses every guild the bot is in when guildIds is empty', async () => {
        const { client } = fluxerClient([
            guild('g1', [emoji('1')]),
            guild('g2', [emoji('2')]),
        ]);
        const service = new BotAvatarService({
            config: config({ discord: false }),
            getFluxerClient: () => client,
            random: () => 0.9999,
            downloadImage: download,
        });

        expect((await service.runOnce()).emoji?.id).toBe('2');
    });

    it('skips when no usable emoji exists', async () => {
        const { client, patch } = fluxerClient([
            guild('g1', [emoji('1', true)]),
            guild('g2', []),
        ]);
        const setAvatar = vi.fn(async () => undefined);
        const downloadImage = vi.fn(download);
        const service = new BotAvatarService({
            config: config(),
            getFluxerClient: () => client,
            getDiscordClient: () => ({ user: { setAvatar } }),
            downloadImage,
        });

        expect(await service.runOnce()).toEqual({
            emoji: null,
            fluxer: 'skipped',
            discord: 'skipped',
        });
        expect(downloadImage).not.toHaveBeenCalled();
        expect(patch).not.toHaveBeenCalled();
        expect(setAvatar).not.toHaveBeenCalled();
    });

    it('skips when the Fluxer client is not connected', async () => {
        const service = new BotAvatarService({
            config: config(),
            getFluxerClient: () => null,
            downloadImage: download,
        });

        expect((await service.runOnce()).fluxer).toBe('skipped');
    });

    it('still updates Discord when Fluxer fails', async () => {
        const { client, patch } = fluxerClient([guild('g1', [emoji('1')])]);
        patch.mockRejectedValueOnce(new Error('Fluxer down'));
        const setAvatar = vi.fn(async () => undefined);
        const service = new BotAvatarService({
            config: config(),
            getFluxerClient: () => client,
            getDiscordClient: () => ({ user: { setAvatar } }),
            downloadImage: download,
        });

        const result = await service.runOnce();

        expect(result.fluxer).toBe('failed');
        expect(result.discord).toBe('updated');
        expect(setAvatar).toHaveBeenCalledOnce();
    });

    it('still updates Fluxer when Discord fails', async () => {
        const { client, patch } = fluxerClient([guild('g1', [emoji('1')])]);
        const setAvatar = vi.fn(async () => {
            throw new Error('You are changing your avatar too fast');
        });
        const service = new BotAvatarService({
            config: config(),
            getFluxerClient: () => client,
            getDiscordClient: () => ({ user: { setAvatar } }),
            downloadImage: download,
        });

        const result = await service.runOnce();

        expect(result.fluxer).toBe('updated');
        expect(result.discord).toBe('failed');
        expect(patch).toHaveBeenCalledOnce();
    });

    it('leaves Discord alone when discord is off', async () => {
        const { client } = fluxerClient([guild('g1', [emoji('1')])]);
        const setAvatar = vi.fn(async () => undefined);
        const service = new BotAvatarService({
            config: config({ discord: false }),
            getFluxerClient: () => client,
            getDiscordClient: () => ({ user: { setAvatar } }),
            downloadImage: download,
        });

        expect((await service.runOnce()).discord).toBe('skipped');
        expect(setAvatar).not.toHaveBeenCalled();
    });

    it('does not throw when the download fails', async () => {
        const { client, patch } = fluxerClient([guild('g1', [emoji('1')])]);
        const service = new BotAvatarService({
            config: config({ discord: false }),
            getFluxerClient: () => client,
            downloadImage: async () => {
                throw new Error('HTTP 404');
            },
        });

        expect((await service.runOnce()).fluxer).toBe('failed');
        expect(patch).not.toHaveBeenCalled();
    });

    it('does not throw when listing emojis fails', async () => {
        const broken: AvatarFluxerGuild = {
            id: 'g1',
            fetchEmojis: async () => {
                throw new Error('403');
            },
        };
        const { client } = fluxerClient([broken, guild('g2', [emoji('2')])]);
        const service = new BotAvatarService({
            config: config({ discord: false }),
            getFluxerClient: () => client,
            downloadImage: download,
        });

        expect((await service.runOnce()).emoji?.id).toBe('2');
    });
});

describe('BotAvatarService scheduling', () => {
    const day = Date.UTC(2026, 9, 24);

    it('does not change the avatar on start, only at the next hour', async () => {
        const { client, patch } = fluxerClient([guild('g1', [emoji('1')])]);
        const { scheduler, timers } = manualScheduler();
        let now = day + 10 * HOUR_MS;
        const service = new BotAvatarService({
            config: config({ discord: false, hourUtc: 6 }),
            getFluxerClient: () => client,
            downloadImage: download,
            now: () => now,
            scheduler,
        });

        service.start();

        expect(patch).not.toHaveBeenCalled();
        expect(timers).toHaveLength(1);
        expect(timers[0].ms).toBe(20 * HOUR_MS);
        expect(service.nextRunTime()).toBe(day + DAY_MS + 6 * HOUR_MS);

        now = day + DAY_MS + 6 * HOUR_MS;
        timers[0].fn();
        await vi.waitFor(() => expect(timers).toHaveLength(2));

        expect(patch).toHaveBeenCalledOnce();
        expect(timers[1].ms).toBe(DAY_MS);
        expect(service.nextRunTime()).toBe(day + 2 * DAY_MS + 6 * HOUR_MS);
    });

    it('does not run twice when the timer fires slightly early', async () => {
        const { client } = fluxerClient([guild('g1', [emoji('1')])]);
        const { scheduler, timers } = manualScheduler();
        let now = day - HOUR_MS;
        const service = new BotAvatarService({
            config: config({ discord: false }),
            getFluxerClient: () => client,
            downloadImage: download,
            now: () => now,
            scheduler,
        });

        service.start();
        now = day - 5;
        timers[0].fn();
        await vi.waitFor(() => expect(timers).toHaveLength(2));

        expect(service.nextRunTime()).toBe(day + DAY_MS);
        expect(timers[1].ms).toBe(DAY_MS + 5);
    });

    it('keeps scheduling after a failed run', async () => {
        const { client, patch } = fluxerClient([guild('g1', [emoji('1')])]);
        patch.mockRejectedValue(new Error('boom'));
        const { scheduler, timers } = manualScheduler();
        let now = day - HOUR_MS;
        const service = new BotAvatarService({
            config: config({ discord: false }),
            getFluxerClient: () => client,
            downloadImage: download,
            now: () => now,
            scheduler,
        });

        service.start();
        now = day;
        timers[0].fn();
        await vi.waitFor(() => expect(timers).toHaveLength(2));

        expect(service.nextRunTime()).toBe(day + DAY_MS);
    });

    it('stop clears the timer and prevents rescheduling', async () => {
        const { client } = fluxerClient([guild('g1', [emoji('1')])]);
        const { scheduler, timers } = manualScheduler();
        const service = new BotAvatarService({
            config: config({ discord: false }),
            getFluxerClient: () => client,
            downloadImage: download,
            now: () => day - HOUR_MS,
            scheduler,
        });

        service.start();
        service.start();
        expect(timers).toHaveLength(1);

        service.stop();

        expect(timers[0].cleared).toBe(true);
        expect(service.nextRunTime()).toBeNull();
    });
});
