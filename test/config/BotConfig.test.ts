import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    BotConfigError,
    DEFAULT_BOT_CONFIG,
    DEPRECATED_CONFIG_KEYS,
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
    it('returns the defaults, no source and no unknown or deprecated keys', () => {
        const loaded = loadBotConfig({}, dir);

        expect(loaded).toEqual({
            config: DEFAULT_BOT_CONFIG,
            source: null,
            unknownKeys: [],
            deprecatedKeys: [],
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
            claudeRequests: DEFAULT_BOT_CONFIG.claudeRequests,
            commands: DEFAULT_BOT_CONFIG.commands,
            clean: DEFAULT_BOT_CONFIG.clean,
            history: DEFAULT_BOT_CONFIG.history,
            meow: DEFAULT_BOT_CONFIG.meow,
            reminders: DEFAULT_BOT_CONFIG.reminders,
            reactions: DEFAULT_BOT_CONFIG.reactions,
            typing: DEFAULT_BOT_CONFIG.typing,
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
            claudeRequests: DEFAULT_BOT_CONFIG.claudeRequests,
            commands: DEFAULT_BOT_CONFIG.commands,
            clean: DEFAULT_BOT_CONFIG.clean,
            history: DEFAULT_BOT_CONFIG.history,
            meow: DEFAULT_BOT_CONFIG.meow,
            reminders: DEFAULT_BOT_CONFIG.reminders,
            reactions: DEFAULT_BOT_CONFIG.reactions,
            typing: DEFAULT_BOT_CONFIG.typing,
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
            const { config, unknownKeys, deprecatedKeys } = mergeBotConfig(raw);
            expect(config).toEqual(DEFAULT_BOT_CONFIG);
            expect(config).not.toBe(DEFAULT_BOT_CONFIG);
            expect(unknownKeys).toEqual([]);
            expect(deprecatedKeys).toEqual([]);
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

        expect(mask).toBe('9105904323648');
        expect(BigInt(mask) & MANAGE_THREADS).toBe(0n);
    });

    it('adds Manage Threads when permissions.manageThreads is on', () => {
        const mask = inviteBotPermissions({
            ...DEFAULT_BOT_CONFIG,
            permissions: { manageThreads: true },
        });

        expect(mask).toBe('9123084192832');
        expect(BigInt(mask) & MANAGE_THREADS).toBe(MANAGE_THREADS);
        expect(BigInt(mask) - MANAGE_THREADS).toBe(
            BigInt(inviteBotPermissions(DEFAULT_BOT_CONFIG))
        );
    });

    it('always requests Add Reactions for reaction bridging', () => {
        const ADD_REACTIONS = 1n << 6n;
        const off = inviteBotPermissions({
            ...DEFAULT_BOT_CONFIG,
            reactions: { enabled: false },
        });

        expect(
            BigInt(inviteBotPermissions(DEFAULT_BOT_CONFIG)) & ADD_REACTIONS
        ).toBe(ADD_REACTIONS);
        expect(BigInt(off) & ADD_REACTIONS).toBe(ADD_REACTIONS);
    });

    it('always requests Create Expressions for emoji and sticker transfer', () => {
        const CREATE_EXPRESSIONS = 1n << 43n;
        const withThreads = inviteBotPermissions({
            ...DEFAULT_BOT_CONFIG,
            permissions: { manageThreads: true },
        });

        expect(
            BigInt(inviteBotPermissions(DEFAULT_BOT_CONFIG)) &
                CREATE_EXPRESSIONS
        ).toBe(CREATE_EXPRESSIONS);
        expect(BigInt(withThreads) & CREATE_EXPRESSIONS).toBe(
            CREATE_EXPRESSIONS
        );
    });

    it('returns a decimal string', () => {
        expect(inviteBotPermissions(DEFAULT_BOT_CONFIG)).toMatch(/^\d+$/);
    });
});

describe('DEFAULT_BOT_CONFIG', () => {
    it('lists the sections in file order', () => {
        expect(Object.keys(DEFAULT_BOT_CONFIG)).toEqual([
            'permissions',
            'threads',
            'categories',
            'roles',
            'claudeRequests',
            'commands',
            'clean',
            'history',
            'meow',
            'reminders',
            'reactions',
            'typing',
        ]);
    });
});

describe('roles', () => {
    it('defaults the moderator and identity groups to the documented Fluxer role IDs', () => {
        expect(DEFAULT_BOT_CONFIG.roles).toEqual({
            moderator: ['1561105750388908139'],
            identity: ['1561105750388908139', '1561105750388908112'],
            bridgeMentions: true,
            claudeRequest: ['1561105750388908139', '1561105750388908112'],
        });
    });

    it('replaces the default lists with the configured strings', () => {
        const { config, unknownKeys, deprecatedKeys } = mergeBotConfig({
            roles: { moderator: ['1', '2'], identity: ['3'] },
        });

        expect(config.roles).toEqual({
            moderator: ['1', '2'],
            identity: ['3'],
            bridgeMentions: true,
            claudeRequest: DEFAULT_BOT_CONFIG.roles.claudeRequest,
        });
        expect(unknownKeys).toEqual([]);
        expect(deprecatedKeys).toEqual([]);
    });

    it('keeps the other group at its default when only one is given', () => {
        const { config } = mergeBotConfig({ roles: { moderator: ['1'] } });

        expect(config.roles).toEqual({
            moderator: ['1'],
            identity: DEFAULT_BOT_CONFIG.roles.identity,
            bridgeMentions: true,
            claudeRequest: DEFAULT_BOT_CONFIG.roles.claudeRequest,
        });
    });

    it('rejects unquoted numeric IDs and non-lists', () => {
        for (const key of ['moderator', 'identity']) {
            for (const value of [[42], 'abc', 42, { a: '1' }]) {
                const attempt = () =>
                    mergeBotConfig({ roles: { [key]: value } });
                expect(attempt).toThrow(BotConfigError);
                expect(attempt).toThrow(`roles.${key}`);
            }
        }
    });

    it('round-trips through YAML', () => {
        const raw = parseBotConfigText(
            [
                'roles:',
                '    moderator:',
                '        - "42"',
                '    identity:',
                '        - "43"',
                '        - "44"',
            ].join('\n'),
            'config.yml'
        );
        const { config, unknownKeys, deprecatedKeys } = mergeBotConfig(raw);

        expect(config.roles).toEqual({
            moderator: ['42'],
            identity: ['43', '44'],
            bridgeMentions: true,
            claudeRequest: DEFAULT_BOT_CONFIG.roles.claudeRequest,
        });
        expect(unknownKeys).toEqual([]);
        expect(deprecatedKeys).toEqual([]);
    });
});

describe('roles.bridgeMentions', () => {
    it('defaults to true', () => {
        expect(DEFAULT_BOT_CONFIG.roles.bridgeMentions).toBe(true);
    });

    it('can be turned off without touching the role groups', () => {
        const { config, unknownKeys, deprecatedKeys } = mergeBotConfig({
            roles: { bridgeMentions: false },
        });

        expect(config.roles).toEqual({
            moderator: DEFAULT_BOT_CONFIG.roles.moderator,
            identity: DEFAULT_BOT_CONFIG.roles.identity,
            bridgeMentions: false,
            claudeRequest: DEFAULT_BOT_CONFIG.roles.claudeRequest,
        });
        expect(unknownKeys).toEqual([]);
        expect(deprecatedKeys).toEqual([]);
    });

    it('merges roles.bridgeMentions: false from a YAML file', () => {
        write('config.yml', 'roles:\n  bridgeMentions: false\n');

        const { config, unknownKeys } = loadBotConfig({}, dir);

        expect(unknownKeys).toEqual([]);
        expect(config).toEqual({
            ...DEFAULT_BOT_CONFIG,
            roles: { ...DEFAULT_BOT_CONFIG.roles, bridgeMentions: false },
        });
    });

    it('rejects a non-boolean value', () => {
        const attempt = () =>
            mergeBotConfig({ roles: { bridgeMentions: 'no' } });

        expect(attempt).toThrow(BotConfigError);
        expect(attempt).toThrow('roles.bridgeMentions');
        expect(attempt).toThrow('boolean');
    });
});

describe('roles.copyAllowedRoleIds (deprecated alias of roles.identity)', () => {
    it('is listed as a deprecated key', () => {
        expect(DEPRECATED_CONFIG_KEYS).toEqual({
            'roles.copyAllowedRoleIds': 'roles.identity',
        });
    });

    it('is moved to roles.identity and reported', () => {
        const { config, unknownKeys, deprecatedKeys } = mergeBotConfig({
            roles: { copyAllowedRoleIds: ['42'] },
        });

        expect(config.roles.identity).toEqual(['42']);
        expect(config.roles.moderator).toEqual(
            DEFAULT_BOT_CONFIG.roles.moderator
        );
        expect(config.roles).not.toHaveProperty('copyAllowedRoleIds');
        expect(unknownKeys).toEqual([]);
        expect(deprecatedKeys).toEqual([
            {
                key: 'roles.copyAllowedRoleIds',
                replacement: 'roles.identity',
                applied: true,
            },
        ]);
    });

    it('is ignored when roles.identity is given too', () => {
        const { config, unknownKeys, deprecatedKeys } = mergeBotConfig({
            roles: { copyAllowedRoleIds: ['42'], identity: ['7'] },
        });

        expect(config.roles.identity).toEqual(['7']);
        expect(unknownKeys).toEqual([]);
        expect(deprecatedKeys).toEqual([
            {
                key: 'roles.copyAllowedRoleIds',
                replacement: 'roles.identity',
                applied: false,
            },
        ]);
    });

    it('does not disturb roles.moderator in the same mapping', () => {
        const { config } = mergeBotConfig({
            roles: { moderator: ['9'], copyAllowedRoleIds: ['42'] },
        });

        expect(config.roles).toEqual({
            moderator: ['9'],
            identity: ['42'],
            bridgeMentions: true,
            claudeRequest: DEFAULT_BOT_CONFIG.roles.claudeRequest,
        });
    });

    it('does not mutate the raw input', () => {
        const raw = { roles: { copyAllowedRoleIds: ['42'] } };

        mergeBotConfig(raw);

        expect(raw).toEqual({ roles: { copyAllowedRoleIds: ['42'] } });
    });

    it('still goes through type validation', () => {
        expect(() =>
            mergeBotConfig({ roles: { copyAllowedRoleIds: [42] } })
        ).toThrow(BotConfigError);
        expect(() =>
            mergeBotConfig({ roles: { copyAllowedRoleIds: 'abc' } })
        ).toThrow(BotConfigError);
    });

    it('is reported by loadBotConfig when read from a YAML file', () => {
        write('config.yml', 'roles:\n  copyAllowedRoleIds:\n    - "42"\n');

        const loaded = loadBotConfig({}, dir);

        expect(loaded.config.roles.identity).toEqual(['42']);
        expect(loaded.unknownKeys).toEqual([]);
        expect(loaded.deprecatedKeys).toEqual([
            {
                key: 'roles.copyAllowedRoleIds',
                replacement: 'roles.identity',
                applied: true,
            },
        ]);
    });
});

describe('commands', () => {
    it('defaults to the ! and / trigger prefixes with slash commands on', () => {
        expect(DEFAULT_BOT_CONFIG.commands).toEqual({
            triggerPrefixes: ['!', '/'],
            slashCommands: true,
        });
    });

    it('merges custom prefixes and the slash toggle', () => {
        const { config } = mergeBotConfig({
            commands: { triggerPrefixes: ['.', '$'], slashCommands: false },
        });

        expect(config.commands).toEqual({
            triggerPrefixes: ['.', '$'],
            slashCommands: false,
        });
    });

    it('accepts an empty trigger prefix list', () => {
        const { config } = mergeBotConfig({
            commands: { triggerPrefixes: [] },
        });

        expect(config.commands.triggerPrefixes).toEqual([]);
        expect(config.commands.slashCommands).toBe(true);
    });

    it('rejects invalid values', () => {
        expect(() =>
            mergeBotConfig({ commands: { slashCommands: 'yes' } })
        ).toThrow(BotConfigError);
        expect(() =>
            mergeBotConfig({ commands: { triggerPrefixes: '!' } })
        ).toThrow(BotConfigError);
    });
});

describe('clean', () => {
    it('defaults to enabled with the ? and ! trigger prefixes', () => {
        expect(DEFAULT_BOT_CONFIG.clean).toEqual({
            enabled: true,
            triggerPrefixes: ['?', '!'],
        });
    });

    it('merges the clean section from a YAML file', () => {
        write(
            'config.yml',
            'clean: { enabled: false, triggerPrefixes: ["?"] }\n'
        );

        const { config, unknownKeys, deprecatedKeys } = loadBotConfig({}, dir);

        expect(unknownKeys).toEqual([]);
        expect(deprecatedKeys).toEqual([]);
        expect(config).toEqual({
            ...DEFAULT_BOT_CONFIG,
            clean: { enabled: false, triggerPrefixes: ['?'] },
        });
    });

    it('accepts an empty trigger prefix list', () => {
        const { config } = mergeBotConfig({ clean: { triggerPrefixes: [] } });

        expect(config.clean).toEqual({ enabled: true, triggerPrefixes: [] });
    });

    it('rejects a non-boolean enabled flag', () => {
        const attempt = () => mergeBotConfig({ clean: { enabled: 'no' } });

        expect(attempt).toThrow(BotConfigError);
        expect(attempt).toThrow('clean.enabled');
        expect(attempt).toThrow('boolean');
    });

    it('rejects non-string trigger prefixes', () => {
        const attempt = () =>
            mergeBotConfig({ clean: { triggerPrefixes: [1] } });

        expect(attempt).toThrow(BotConfigError);
        expect(attempt).toThrow('clean.triggerPrefixes');
        expect(attempt).toThrow('list of strings');
    });

    it('reports unknown keys inside the section', () => {
        const { unknownKeys } = mergeBotConfig({ clean: { maxCount: 50 } });

        expect(unknownKeys).toEqual(['clean.maxCount']);
    });
});

describe('history', () => {
    it('defaults to enabled, 100 messages, at most 1000, one post per second', () => {
        expect(DEFAULT_BOT_CONFIG.history).toEqual({
            enabled: true,
            defaultCount: 100,
            maxCount: 1000,
            delayMs: 1000,
        });
    });

    it('merges the history section from a YAML file', () => {
        write(
            'config.yml',
            'history: { enabled: false, defaultCount: 50, maxCount: 500, delayMs: 2000 }\n'
        );

        const { config, unknownKeys, deprecatedKeys } = loadBotConfig({}, dir);

        expect(unknownKeys).toEqual([]);
        expect(deprecatedKeys).toEqual([]);
        expect(config).toEqual({
            ...DEFAULT_BOT_CONFIG,
            history: {
                enabled: false,
                defaultCount: 50,
                maxCount: 500,
                delayMs: 2000,
            },
        });
    });

    it('keeps the other keys at their defaults when only one is given', () => {
        const { config } = mergeBotConfig({ history: { delayMs: 1500 } });

        expect(config.history).toEqual({
            ...DEFAULT_BOT_CONFIG.history,
            delayMs: 1500,
        });
    });

    it('rejects a non-boolean enabled flag', () => {
        const attempt = () => mergeBotConfig({ history: { enabled: 'no' } });

        expect(attempt).toThrow(BotConfigError);
        expect(attempt).toThrow('history.enabled');
        expect(attempt).toThrow('boolean');
    });

    it('rejects strings where numbers are expected', () => {
        for (const key of ['defaultCount', 'maxCount', 'delayMs']) {
            const attempt = () => mergeBotConfig({ history: { [key]: '100' } });

            expect(attempt).toThrow(BotConfigError);
            expect(attempt).toThrow(`history.${key}`);
            expect(attempt).toThrow('number');
        }
    });

    it('rejects zero, negative and fractional numbers', () => {
        for (const key of ['defaultCount', 'maxCount', 'delayMs']) {
            for (const value of [0, -5, 2.5]) {
                const attempt = () =>
                    mergeBotConfig({ history: { [key]: value } });

                expect(attempt).toThrow(BotConfigError);
                expect(attempt).toThrow(`history.${key}`);
                expect(attempt).toThrow('positive whole number');
            }
        }
    });

    it('rejects a default count above the maximum', () => {
        const attempt = () =>
            mergeBotConfig({ history: { defaultCount: 20, maxCount: 10 } });

        expect(attempt).toThrow(BotConfigError);
        expect(attempt).toThrow('history.defaultCount');
        expect(attempt).toThrow('history.maxCount');
    });

    it('accepts a default count equal to the maximum', () => {
        const { config } = mergeBotConfig({
            history: { defaultCount: 10, maxCount: 10 },
        });

        expect(config.history.defaultCount).toBe(10);
        expect(config.history.maxCount).toBe(10);
    });

    it('reports unknown keys inside the section', () => {
        const { unknownKeys } = mergeBotConfig({
            history: { triggerPrefixes: ['?'] },
        });

        expect(unknownKeys).toEqual(['history.triggerPrefixes']);
    });
});

describe('config.example.yml', () => {
    it('parses to exactly the defaults with no unknown or deprecated keys', () => {
        const file = path.resolve(__dirname, '../../config.example.yml');
        const raw = parseBotConfigText(fs.readFileSync(file, 'utf8'), file);

        const { config, unknownKeys, deprecatedKeys } = mergeBotConfig(raw);

        expect(unknownKeys).toEqual([]);
        expect(deprecatedKeys).toEqual([]);
        expect(config).toEqual(DEFAULT_BOT_CONFIG);
        expect(Object.keys(raw as object)).toEqual(
            Object.keys(DEFAULT_BOT_CONFIG)
        );
    });
});

describe('reminders', () => {
    it('defaults to enabled with the ? and ! trigger prefixes', () => {
        expect(DEFAULT_BOT_CONFIG.reminders).toEqual({
            enabled: true,
            triggerPrefixes: ['?', '!'],
        });
    });

    it('merges the reminders section from a YAML file', () => {
        write(
            'config.yml',
            'reminders: { enabled: false, triggerPrefixes: ["?"] }\n'
        );

        const { config, unknownKeys } = loadBotConfig({}, dir);

        expect(unknownKeys).toEqual([]);
        expect(config).toEqual({
            ...DEFAULT_BOT_CONFIG,
            reminders: { enabled: false, triggerPrefixes: ['?'] },
        });
    });

    it('accepts an empty trigger prefix list', () => {
        const { config } = mergeBotConfig({
            reminders: { triggerPrefixes: [] },
        });

        expect(config.reminders).toEqual({
            enabled: true,
            triggerPrefixes: [],
        });
    });

    it('rejects non-string trigger prefixes', () => {
        const attempt = () =>
            mergeBotConfig({ reminders: { triggerPrefixes: [1] } });

        expect(attempt).toThrow(BotConfigError);
        expect(attempt).toThrow('reminders.triggerPrefixes');
        expect(attempt).toThrow('list of strings');
    });
});

describe('reactions', () => {
    it('defaults to enabled', () => {
        expect(DEFAULT_BOT_CONFIG.reactions).toEqual({ enabled: true });
    });

    it('merges reactions.enabled: false from a YAML file', () => {
        write('config.yml', 'reactions:\n  enabled: false\n');

        const { config, unknownKeys } = loadBotConfig({}, dir);

        expect(unknownKeys).toEqual([]);
        expect(config).toEqual({
            ...DEFAULT_BOT_CONFIG,
            reactions: { enabled: false },
        });
    });

    it('rejects a non-boolean enabled flag', () => {
        const attempt = () => mergeBotConfig({ reactions: { enabled: 'no' } });

        expect(attempt).toThrow(BotConfigError);
        expect(attempt).toThrow('reactions.enabled');
        expect(attempt).toThrow('boolean');
    });
});

describe('typing', () => {
    it('defaults to enabled', () => {
        expect(DEFAULT_BOT_CONFIG.typing).toEqual({ enabled: true });
    });

    it('merges typing.enabled: false from a YAML file', () => {
        write('config.yml', 'typing:\n  enabled: false\n');

        const { config, unknownKeys } = loadBotConfig({}, dir);

        expect(unknownKeys).toEqual([]);
        expect(config).toEqual({
            ...DEFAULT_BOT_CONFIG,
            typing: { enabled: false },
        });
    });

    it('rejects a non-boolean enabled flag', () => {
        const attempt = () => mergeBotConfig({ typing: { enabled: 'no' } });

        expect(attempt).toThrow(BotConfigError);
        expect(attempt).toThrow('typing.enabled');
        expect(attempt).toThrow('boolean');
    });
});

describe('claudeRequests', () => {
    it('defaults to issues labelled claude in FruitBoi/bifrost', () => {
        expect(DEFAULT_BOT_CONFIG.claudeRequests).toEqual({
            enabled: true,
            repo: 'FruitBoi/bifrost',
            label: 'claude',
            notifyOnClose: true,
            notifyPollMs: 120_000,
        });
    });

    it('merges a custom repository and label', () => {
        const { config, unknownKeys } = mergeBotConfig({
            claudeRequests: { repo: 'someone/fork', label: 'ai' },
            roles: { claudeRequest: ['123'] },
        });

        expect(unknownKeys).toEqual([]);
        expect(config.claudeRequests).toEqual({
            enabled: true,
            repo: 'someone/fork',
            label: 'ai',
            notifyOnClose: true,
            notifyPollMs: 120_000,
        });
        expect(config.roles.claudeRequest).toEqual(['123']);
    });

    it.each(['bifrost', 'a/b/c', 'https://github.com/a/b', ''])(
        'rejects the repository %j',
        (repo) => {
            const attempt = () => mergeBotConfig({ claudeRequests: { repo } });

            expect(attempt).toThrow(BotConfigError);
            expect(attempt).toThrow('claudeRequests.repo');
        }
    );

    it.each([29_999, 1.5, 0])('rejects notifyPollMs %j', (notifyPollMs) => {
        const attempt = () =>
            mergeBotConfig({ claudeRequests: { notifyPollMs } });

        expect(attempt).toThrow(BotConfigError);
        expect(attempt).toThrow('claudeRequests.notifyPollMs');
    });

    it('rejects an empty label', () => {
        const attempt = () =>
            mergeBotConfig({ claudeRequests: { label: '  ' } });

        expect(attempt).toThrow(BotConfigError);
        expect(attempt).toThrow('claudeRequests.label');
    });
});
