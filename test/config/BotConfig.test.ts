import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    BotConfigError,
    DEFAULT_BOT_CONFIG,
    inviteBotPermissions,
    loadBotConfig,
    mergeBotConfig,
    parseBotConfigText,
    resolveBotConfigFile,
} from '../../src/config/BotConfig';

let dir: string;

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-botconfig-'));
});

afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
});

function write(name: string, text: string): string {
    const file = path.join(dir, name);
    fs.writeFileSync(file, text);
    return file;
}

describe('loadBotConfig without a file', () => {
    it('returns the defaults, no source and no unknown keys', () => {
        const loaded = loadBotConfig({}, dir);

        expect(loaded).toEqual({
            config: DEFAULT_BOT_CONFIG,
            source: null,
            unknownKeys: [],
        });
    });

    it('returns a copy of the defaults, not the shared object', () => {
        const loaded = loadBotConfig({}, dir);

        expect(loaded.config).not.toBe(DEFAULT_BOT_CONFIG);
        expect(loaded.config.threads).not.toBe(DEFAULT_BOT_CONFIG.threads);
        loaded.config.threads.mirrorRenames = false;
        expect(DEFAULT_BOT_CONFIG.threads.mirrorRenames).toBe(true);
    });
});

describe('resolveBotConfigFile', () => {
    it('returns null when no candidate exists', () => {
        expect(resolveBotConfigFile({}, dir)).toBeNull();
    });

    it('prefers config.yml over config.yaml over config.json', () => {
        const json = write('config.json', '{}');
        const yaml = write('config.yaml', '');
        const yml = write('config.yml', '');

        expect(resolveBotConfigFile({}, dir)).toBe(yml);
        fs.rmSync(yml);
        expect(resolveBotConfigFile({}, dir)).toBe(yaml);
        fs.rmSync(yaml);
        expect(resolveBotConfigFile({}, dir)).toBe(json);
    });

    it('lets BF_CONFIG_FILE override the candidates in the config dir', () => {
        write('config.yml', 'threads: { mirrorRenames: false }');
        const other = path.join(dir, 'elsewhere', 'bot.yaml');
        fs.mkdirSync(path.dirname(other));
        fs.writeFileSync(other, 'threads: { mirrorDeletes: true }');

        expect(resolveBotConfigFile({ BF_CONFIG_FILE: other }, dir)).toBe(
            other
        );

        const loaded = loadBotConfig({ BF_CONFIG_FILE: other }, dir);
        expect(loaded.source).toBe(other);
        expect(loaded.config.threads).toEqual({
            mirrorRenames: true,
            mirrorDeletes: true,
        });
    });

    it('throws BotConfigError when BF_CONFIG_FILE points to a missing file', () => {
        const missing = path.join(dir, 'nope.yml');

        expect(() =>
            resolveBotConfigFile({ BF_CONFIG_FILE: missing }, dir)
        ).toThrow(BotConfigError);
        expect(() => loadBotConfig({ BF_CONFIG_FILE: missing }, dir)).toThrow(
            missing
        );
    });

    it('ignores an empty BF_CONFIG_FILE', () => {
        const yml = write('config.yml', '');

        expect(resolveBotConfigFile({ BF_CONFIG_FILE: '' }, dir)).toBe(yml);
    });
});

describe('loadBotConfig parsing', () => {
    it('reads YAML', () => {
        const file = write(
            'config.yml',
            [
                'permissions:',
                '  manageThreads: true',
                'threads:',
                '  mirrorRenames: false',
                '  mirrorDeletes: true',
                'categories:',
                '  mirrorChannelRenames: false',
                '  unlinkWhenChannelLeaves: false',
            ].join('\n')
        );

        const loaded = loadBotConfig({}, dir);

        expect(loaded.source).toBe(file);
        expect(loaded.unknownKeys).toEqual([]);
        expect(loaded.config).toEqual({
            permissions: { manageThreads: true },
            threads: { mirrorRenames: false, mirrorDeletes: true },
            categories: {
                mirrorChannelRenames: false,
                unlinkWhenChannelLeaves: false,
            },
            roles: DEFAULT_BOT_CONFIG.roles,
            meow: DEFAULT_BOT_CONFIG.meow,
        });
    });

    it('reads JSON', () => {
        const file = write(
            'config.json',
            JSON.stringify({
                permissions: { manageThreads: true },
                categories: { unlinkWhenChannelLeaves: false },
            })
        );

        const loaded = loadBotConfig({}, dir);

        expect(loaded.source).toBe(file);
        expect(loaded.config).toEqual({
            permissions: { manageThreads: true },
            threads: { mirrorRenames: true, mirrorDeletes: false },
            categories: {
                mirrorChannelRenames: true,
                unlinkWhenChannelLeaves: false,
            },
            roles: DEFAULT_BOT_CONFIG.roles,
            meow: DEFAULT_BOT_CONFIG.meow,
        });
    });

    it('treats an empty file as defaults', () => {
        const file = write('config.yml', '');

        const loaded = loadBotConfig({}, dir);

        expect(loaded.source).toBe(file);
        expect(loaded.config).toEqual(DEFAULT_BOT_CONFIG);
        expect(loaded.unknownKeys).toEqual([]);
    });

    it('merges a partial file over the defaults', () => {
        write('config.yml', 'permissions:\n  manageThreads: true\n');

        const { config, unknownKeys } = loadBotConfig({}, dir);

        expect(unknownKeys).toEqual([]);
        expect(config).toEqual({
            ...DEFAULT_BOT_CONFIG,
            permissions: { manageThreads: true },
        });
    });

    it('reports a parse error naming the JSON file', () => {
        const file = write('config.json', '{ "permissions": ');

        expect(() => loadBotConfig({}, dir)).toThrow(BotConfigError);
        expect(() => loadBotConfig({}, dir)).toThrow(file);
    });

    it('reports a parse error naming the YAML file', () => {
        const file = write('config.yml', 'threads: {\n');

        expect(() => loadBotConfig({}, dir)).toThrow(BotConfigError);
        expect(() => loadBotConfig({}, dir)).toThrow(file);
    });
});

describe('parseBotConfigText', () => {
    it('parses JSON for .json and YAML otherwise', () => {
        expect(parseBotConfigText('{"a": 1}', 'x.json')).toEqual({ a: 1 });
        expect(parseBotConfigText('a: 1', 'x.yml')).toEqual({ a: 1 });
        expect(parseBotConfigText('a: 1', 'x.yaml')).toEqual({ a: 1 });
        // YAML is a JSON superset, so JSON text in a .yml file works too.
        expect(parseBotConfigText('{"a": 1}', 'x.yml')).toEqual({ a: 1 });
    });

    it('wraps parser failures in BotConfigError with the file name', () => {
        expect(() => parseBotConfigText('{', 'broken.json')).toThrow(
            BotConfigError
        );
        expect(() => parseBotConfigText('{', 'broken.json')).toThrow(
            'broken.json'
        );
        expect(() => parseBotConfigText('a: [', 'broken.yml')).toThrow(
            BotConfigError
        );
        expect(() => parseBotConfigText('a: [', 'broken.yml')).toThrow(
            'broken.yml'
        );
    });
});

describe('mergeBotConfig', () => {
    it('returns a copy of the defaults for null or undefined input', () => {
        for (const raw of [null, undefined]) {
            const { config, unknownKeys } = mergeBotConfig(raw);
            expect(config).toEqual(DEFAULT_BOT_CONFIG);
            expect(config).not.toBe(DEFAULT_BOT_CONFIG);
            expect(unknownKeys).toEqual([]);
        }
    });

    it('does not mutate the defaults it merges over', () => {
        const defaults = structuredClone(DEFAULT_BOT_CONFIG);

        mergeBotConfig({ threads: { mirrorRenames: false } }, defaults);

        expect(defaults).toEqual(DEFAULT_BOT_CONFIG);
    });

    it('reports unknown top-level and nested keys without merging them', () => {
        const { config, unknownKeys } = mergeBotConfig({
            voice: { enabled: true },
            threads: { mirrorRenames: false, mirrorArchive: true },
        });

        expect(unknownKeys).toEqual(['voice', 'threads.mirrorArchive']);
        expect(config).toEqual({
            ...DEFAULT_BOT_CONFIG,
            threads: { mirrorRenames: false, mirrorDeletes: false },
        });
        expect(config).not.toHaveProperty('voice');
        expect(config.threads).not.toHaveProperty('mirrorArchive');
    });

    it('rejects a string where a boolean is expected, naming the dotted path', () => {
        const attempt = () =>
            mergeBotConfig({ threads: { mirrorRenames: 'yes' } });

        expect(attempt).toThrow(BotConfigError);
        expect(attempt).toThrow('threads.mirrorRenames');
        expect(attempt).toThrow('boolean');
    });

    it('rejects null where a boolean is expected', () => {
        const attempt = () =>
            mergeBotConfig({ permissions: { manageThreads: null } });

        expect(attempt).toThrow(BotConfigError);
        expect(attempt).toThrow('permissions.manageThreads');
    });

    it('rejects a scalar or list where a mapping is expected', () => {
        expect(() => mergeBotConfig({ threads: true })).toThrow(BotConfigError);
        expect(() => mergeBotConfig({ threads: true })).toThrow(
            'Config "threads" must be a mapping'
        );
        expect(() => mergeBotConfig({ categories: [] })).toThrow(
            'Config "categories" must be a mapping'
        );
        expect(() => mergeBotConfig({ categories: null })).toThrow(
            'Config "categories" must be a mapping'
        );
    });

    it('rejects a non-mapping top level', () => {
        for (const raw of ['text', 42, true, ['a']]) {
            expect(() => mergeBotConfig(raw)).toThrow(BotConfigError);
            expect(() => mergeBotConfig(raw)).toThrow('top level');
        }
    });

    it('rejects a wrong type coming from a file, with the dotted path', () => {
        write('config.yml', 'threads:\n  mirrorDeletes: "true"\n');

        expect(() => loadBotConfig({}, dir)).toThrow(BotConfigError);
        expect(() => loadBotConfig({}, dir)).toThrow('threads.mirrorDeletes');
    });

    it('rejects a non-mapping top level coming from a file', () => {
        write('config.yml', '- just\n- a list\n');

        expect(() => loadBotConfig({}, dir)).toThrow(BotConfigError);
        expect(() => loadBotConfig({}, dir)).toThrow('top level');
    });
});

describe('inviteBotPermissions', () => {
    const MANAGE_THREADS = 1n << 34n;

    it('requests the base set without Manage Threads by default', () => {
        const mask = inviteBotPermissions(DEFAULT_BOT_CONFIG);

        expect(mask).toBe('309811301376');
        expect(BigInt(mask) & MANAGE_THREADS).toBe(0n);
    });

    it('adds Manage Threads when permissions.manageThreads is on', () => {
        const mask = inviteBotPermissions({
            ...DEFAULT_BOT_CONFIG,
            permissions: { manageThreads: true },
        });

        expect(mask).toBe('326991170560');
        expect(BigInt(mask) & MANAGE_THREADS).toBe(MANAGE_THREADS);
        expect(BigInt(mask) - MANAGE_THREADS).toBe(
            BigInt(inviteBotPermissions(DEFAULT_BOT_CONFIG))
        );
    });

    it('returns a decimal string', () => {
        expect(inviteBotPermissions(DEFAULT_BOT_CONFIG)).toMatch(/^\d+$/);
    });
});

describe('roles.copyAllowedRoleIds', () => {
    it('defaults to the two documented Fluxer role IDs', () => {
        expect(DEFAULT_BOT_CONFIG.roles.copyAllowedRoleIds).toEqual([
            '1561105750388908139',
            '1561105750388908112',
        ]);
    });

    it('replaces the default list with the configured strings', () => {
        const raw = parseBotConfigText(
            'roles:\n  copyAllowedRoleIds:\n    - "42"\n',
            'config.yml'
        );
        const { config, unknownKeys } = mergeBotConfig(raw);

        expect(config.roles.copyAllowedRoleIds).toEqual(['42']);
        expect(unknownKeys).toEqual([]);
    });

    it('rejects unquoted numeric IDs and non-lists', () => {
        expect(() =>
            mergeBotConfig({ roles: { copyAllowedRoleIds: [42] } })
        ).toThrow(BotConfigError);
        expect(() =>
            mergeBotConfig({ roles: { copyAllowedRoleIds: 'abc' } })
        ).toThrow(BotConfigError);
    });
});
