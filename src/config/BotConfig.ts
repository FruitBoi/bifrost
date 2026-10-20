import fs from 'fs';
import path from 'path';
import { parse as parseYaml } from 'yaml';
import { CONFIG_PATH } from '../utils/env';

/**
 * Optional startup configuration, read once from a YAML or JSON file.
 *
 * Lookup order: `BF_CONFIG_FILE` if set, otherwise `config.yml`,
 * `config.yaml` or `config.json` inside `BF_CONFIG_PATH` (the directory that
 * also holds the SQLite database). Missing file = defaults. Unknown keys are
 * reported as warnings; wrong types abort startup with the offending path.
 */
export interface BotConfig {
    permissions: {
        /**
         * Request Manage Threads in the bot invite links. It lets the bot rename
         * threads it does not own, but also lets it delete and archive any
         * thread, so it is off by default. Threads the bridge creates are owned
         * by the bot and can be renamed without it.
         */
        manageThreads: boolean;
    };
    threads: {
        /** Mirror thread renames between linked threads. */
        mirrorRenames: boolean;
        /**
         * When a linked thread is deleted on one side, delete its counterpart
         * too. Requires `permissions.manageThreads` on Discord and the matching
         * right on Fluxer; the counterpart is otherwise left in place and only
         * the link is removed.
         */
        mirrorDeletes: boolean;
    };
    categories: {
        /** Mirror Discord channel renames to the category-created Fluxer thread. */
        mirrorChannelRenames: boolean;
        /** Drop the link when a channel is moved out of a linked category. */
        unlinkWhenChannelLeaves: boolean;
    };
    roles: {
        /**
         * Fluxer role IDs whose members may run the `role` command, which
         * copies a Discord user's roles to a Fluxer member. IDs must be quoted
         * strings: unquoted they are parsed as numbers and lose precision.
         */
        copyAllowedRoleIds: string[];
    };
    meow: {
        /**
         * Answer messages that consist only of cat noises (meow, mrrp, nya,
         * purr and their stretched or decorated variants) with a cat noise,
         * as if chatting back. See `services/meow/MeowService.ts`.
         */
        enabled: boolean;
    };
}

export const DEFAULT_BOT_CONFIG: BotConfig = {
    permissions: { manageThreads: false },
    threads: { mirrorRenames: true, mirrorDeletes: false },
    categories: { mirrorChannelRenames: true, unlinkWhenChannelLeaves: true },
    roles: {
        copyAllowedRoleIds: ['1561105750388908139', '1561105750388908112'],
    },
    meow: { enabled: true },
};

export const CONFIG_FILE_CANDIDATES = [
    'config.yml',
    'config.yaml',
    'config.json',
];

export class BotConfigError extends Error {}

type Plain = Record<string, unknown>;

function isPlainObject(value: unknown): value is Plain {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Deep-merges `raw` over `defaults`, validating that every provided value has
 * the same type as the default. Returns the merged config and the dotted
 * paths of keys that are not part of the schema.
 */
export function mergeBotConfig(
    raw: unknown,
    defaults: BotConfig = DEFAULT_BOT_CONFIG
): { config: BotConfig; unknownKeys: string[] } {
    if (raw === null || raw === undefined) {
        return { config: structuredClone(defaults), unknownKeys: [] };
    }
    if (!isPlainObject(raw)) {
        throw new BotConfigError(
            'Config file must contain a mapping at the top level'
        );
    }

    const unknownKeys: string[] = [];

    function merge<T extends Plain>(base: T, input: Plain, prefix: string): T {
        const out = { ...base } as Plain;
        for (const [key, value] of Object.entries(input)) {
            const dotted = prefix ? `${prefix}.${key}` : key;
            if (!(key in base)) {
                unknownKeys.push(dotted);
                continue;
            }
            const expected = base[key];
            if (isPlainObject(expected)) {
                if (!isPlainObject(value)) {
                    throw new BotConfigError(
                        `Config "${dotted}" must be a mapping`
                    );
                }
                out[key] = merge(expected, value, dotted);
            } else if (Array.isArray(expected)) {
                if (
                    !Array.isArray(value) ||
                    value.some((item) => typeof item !== 'string')
                ) {
                    throw new BotConfigError(
                        `Config "${dotted}" must be a list of strings (quote numeric IDs)`
                    );
                }
                out[key] = [...value];
            } else if (typeof value !== typeof expected) {
                throw new BotConfigError(
                    `Config "${dotted}" must be a ${typeof expected}, got ${value === null ? 'null' : typeof value}`
                );
            } else {
                out[key] = value;
            }
        }
        return out as T;
    }

    return {
        config: merge(
            structuredClone(defaults) as unknown as Plain,
            raw,
            ''
        ) as unknown as BotConfig,
        unknownKeys,
    };
}

/** Parses YAML (a JSON superset) or JSON according to the file extension. */
export function parseBotConfigText(text: string, fileName: string): unknown {
    try {
        return fileName.endsWith('.json') ? JSON.parse(text) : parseYaml(text);
    } catch (err) {
        throw new BotConfigError(
            `Could not parse ${fileName}: ${(err as Error).message}`
        );
    }
}

export interface LoadedBotConfig {
    config: BotConfig;
    /** Absolute path of the file used, or null when defaults apply. */
    source: string | null;
    unknownKeys: string[];
}

/** Resolves which config file to read, or null when none exists. */
export function resolveBotConfigFile(
    env: NodeJS.ProcessEnv = process.env,
    configDir: string = CONFIG_PATH
): string | null {
    if (env.BF_CONFIG_FILE) {
        const explicit = path.resolve(env.BF_CONFIG_FILE);
        if (!fs.existsSync(explicit)) {
            throw new BotConfigError(
                `BF_CONFIG_FILE points to a missing file: ${explicit}`
            );
        }
        return explicit;
    }
    for (const name of CONFIG_FILE_CANDIDATES) {
        const candidate = path.resolve(configDir, name);
        if (fs.existsSync(candidate)) return candidate;
    }
    return null;
}

export function loadBotConfig(
    env: NodeJS.ProcessEnv = process.env,
    configDir: string = CONFIG_PATH
): LoadedBotConfig {
    const source = resolveBotConfigFile(env, configDir);
    if (!source) {
        return {
            config: structuredClone(DEFAULT_BOT_CONFIG),
            source: null,
            unknownKeys: [],
        };
    }
    const raw = parseBotConfigText(fs.readFileSync(source, 'utf8'), source);
    const { config, unknownKeys } = mergeBotConfig(raw);
    return { config, source, unknownKeys };
}

// Discord and Fluxer use the same permission bit values. The masks exceed 32
// bits, so they are combined with addition rather than bitwise operators
// (each flag is a distinct power of two, and the sum stays well below 2^53).
const PERMISSION_BITS = {
    viewChannel: 2 ** 10,
    sendMessages: 2 ** 11,
    embedLinks: 2 ** 14,
    readMessageHistory: 2 ** 16,
    manageWebhooks: 2 ** 29,
    connect: 2 ** 20,
    speak: 2 ** 21,
    useVoiceActivity: 2 ** 25,
    manageThreads: 2 ** 34,
    createPublicThreads: 2 ** 35,
    sendMessagesInThreads: 2 ** 38,
};

/**
 * Permission mask for the bot invite links. The base set is what channel
 * bridging always needed plus the voice bridge bits (Connect, Speak, Use
 * Voice Activity); thread bridging adds Create Public Threads and Send
 * Messages in Threads. Manage Threads is only requested when enabled in the
 * config, because it also grants deleting and archiving threads.
 */
export function inviteBotPermissions(config: BotConfig): string {
    const flags = [
        PERMISSION_BITS.viewChannel,
        PERMISSION_BITS.sendMessages,
        PERMISSION_BITS.embedLinks,
        PERMISSION_BITS.readMessageHistory,
        PERMISSION_BITS.manageWebhooks,
        PERMISSION_BITS.connect,
        PERMISSION_BITS.speak,
        PERMISSION_BITS.useVoiceActivity,
        PERMISSION_BITS.createPublicThreads,
        PERMISSION_BITS.sendMessagesInThreads,
    ];
    if (config.permissions.manageThreads) {
        flags.push(PERMISSION_BITS.manageThreads);
    }
    const mask = flags.reduce((sum, flag) => sum + flag, 0);
    return mask.toString();
}
