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
    /**
     * Role-based command permissions, all in one place (issue #12). Each
     * list names the role IDs whose members may run the commands of that
     * group; a member needs at least one of them on the platform the command
     * is run on (Fluxer role IDs only ever match Fluxer members, Discord
     * role IDs only Discord members). IDs must be quoted strings: unquoted
     * they are parsed as numbers and lose precision.
     */
    roles: {
        /** Moderator commands: `clean` and `history`. */
        moderator: string[];
        /**
         * Identity command `role`, alias `map` (copies a Discord user's
         * roles to a Fluxer member and maps the accounts). Formerly
         * `roles.copyAllowedRoleIds`, which is still accepted as an alias.
         */
        identity: string[];
        /**
         * Relay role mentions as real pings: a `<@&role>` mention written on
         * one platform pings the role with the same name on the other
         * (issue #15). Roles without a namesake, and roles the author could
         * not ping on their own platform, stay plaintext. @everyone and
         * @here are never bridged. See `services/mentionBridge/`.
         */
        bridgeMentions: boolean;
        /**
         * `clauderequest`: files the given text as a GitHub issue labelled
         * for Claude (issue #18). See `claudeRequests`.
         */
        claudeRequest: string[];
    };
    claudeRequests: {
        /**
         * Enable the `clauderequest` command, which opens an issue in
         * `repo` with `label` from a chat message. Needs `BF_GITHUB_TOKEN`
         * (a token allowed to create issues in the repository); without it
         * the command replies that it is not configured. See
         * `services/claudeRequest/`.
         */
        enabled: boolean;
        /** Repository the issues are opened in, as `owner/name`. */
        repo: string;
        /** Label put on every issue (the one the Claude request template uses). */
        label: string;
        /**
         * When the issue filed by `clauderequest` is closed, the bot replies
         * to the request in its channel, pinging the requester.
         */
        notifyOnClose: boolean;
        /** How often (ms) tracked issues are checked for being closed. */
        notifyPollMs: number;
    };
    commands: {
        /**
         * Prefixes that run any command directly, without the bot prefix
         * (`!help`, `!link 123`, `!list`). Only registered command names
         * match, so other `!foo` messages are bridged like any chat message.
         * `BF_COMMAND_PREFIX` keeps working too (`!b help`). An empty list
         * disables the shortcuts.
         */
        triggerPrefixes: string[];
        /**
         * Register every command as a Discord slash command (`/link
         * args:123`) on startup. Fluxer has no slash commands. Needs the
         * `applications.commands` scope on the bot invite.
         */
        slashCommands: boolean;
    };
    clean: {
        /**
         * Enable the YAGPDB-style `clean` command (aliases `clear`, `cl`),
         * which bulk-deletes recent messages in the current channel. See
         * `services/clean/`.
         */
        enabled: boolean;
        /**
         * Prefixes that trigger `clean` directly, without the bot prefix
         * (`?clean 10`, `!clean 10 -bots`). `BF_COMMAND_PREFIX` keeps
         * working too (`!b clean 10`). An empty list disables the shortcuts.
         */
        triggerPrefixes: string[];
    };
    history: {
        /**
         * Enable the `history` command (alias `backfill`), which copies a
         * linked channel's history to the other platform (issue #16). See
         * `services/history/`.
         */
        enabled: boolean;
        /** Messages transferred when no count is given. */
        defaultCount: number;
        /** Largest count accepted without `all`. */
        maxCount: number;
        /**
         * Pause between two destination posts, in ms (keeps the bot inside
         * both platforms' rate limits; Fluxer IP-bans bots that exceed them).
         */
        delayMs: number;
    };
    meow: {
        /**
         * Answer messages that consist only of cat noises (meow, mrrp, nya,
         * purr and their stretched or decorated variants) with a cat noise,
         * as if chatting back. See `services/meow/MeowService.ts`.
         */
        enabled: boolean;
    };
    reminders: {
        /**
         * Enable the YAGPDB-style `remindme` / `reminder` commands (issue #9).
         * See `services/reminders/ReminderService.ts`.
         */
        enabled: boolean;
        /**
         * Prefixes that trigger the reminder commands directly, without the
         * bot prefix: with the defaults `?remindme 1h30m text` and
         * `!remindme 1h30m text` both work (so do `?reminders`,
         * `?reminder delete 3`, ... and `? Remindme 1h30m text` with the
         * space and capital phone keyboards add). `BF_COMMAND_PREFIX` keeps
         * working too
         * (`!b remindme ...`). An empty list disables the shortcuts.
         */
        triggerPrefixes: string[];
    };
    reactions: {
        /**
         * Mirror reactions on bridged messages onto the counterpart message
         * on the other platform, as a single reaction from the bot per emoji
         * (webhooks cannot react). Custom emojis are mirrored only when the
         * other server has one with the same name. Needs Add Reactions on
         * both platforms. See `services/reactionBridge/`.
         */
        enabled: boolean;
    };
    typing: {
        /**
         * Show the typing indicator on the other platform while someone types
         * in a bridged channel or thread. Webhooks cannot type, so it appears
         * as the bot ("<bot name> is typing…"), throttled to one trigger per
         * channel every few seconds. On Discord it needs the Guild Message
         * Typing gateway intent, which is requested only while this is on.
         * See `services/typingBridge/`.
         */
        enabled: boolean;
    };
}

export const DEFAULT_BOT_CONFIG: BotConfig = {
    permissions: { manageThreads: false },
    threads: { mirrorRenames: true, mirrorDeletes: false },
    categories: { mirrorChannelRenames: true, unlinkWhenChannelLeaves: true },
    roles: {
        moderator: ['1561105750388908139'],
        identity: ['1561105750388908139', '1561105750388908112'],
        bridgeMentions: true,
        claudeRequest: ['1561105750388908139', '1561105750388908112'],
    },
    claudeRequests: {
        enabled: true,
        repo: 'FruitBoi/bifrost',
        label: 'claude',
        notifyOnClose: true,
        notifyPollMs: 120_000,
    },
    commands: { triggerPrefixes: ['!'], slashCommands: true },
    clean: { enabled: true, triggerPrefixes: ['?', '!'] },
    history: {
        enabled: true,
        defaultCount: 100,
        maxCount: 1000,
        delayMs: 1000,
    },
    meow: { enabled: true },
    reminders: { enabled: true, triggerPrefixes: ['?', '!'] },
    reactions: { enabled: true },
    typing: { enabled: true },
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
 * Renamed keys that are still accepted: the old dotted path maps to the new
 * one. An old key is moved to its new path unless the new path is also
 * given, in which case the old key is ignored. Either way it is reported.
 */
export const DEPRECATED_CONFIG_KEYS: Record<string, string> = {
    'roles.copyAllowedRoleIds': 'roles.identity',
};

/** A deprecated key found in the config file and the key that replaces it. */
export interface DeprecatedConfigKey {
    key: string;
    replacement: string;
    /** False when the replacement was given as well, so the old key was ignored. */
    applied: boolean;
}

function getPath(obj: Plain, path: string[]): unknown {
    let current: unknown = obj;
    for (const part of path) {
        if (!isPlainObject(current) || !(part in current)) return undefined;
        current = current[part];
    }
    return current;
}

/**
 * Moves deprecated keys to their replacements on a copy of `raw` (only the
 * mappings along the touched paths are copied).
 */
function applyDeprecatedKeys(raw: Plain): {
    raw: Plain;
    deprecatedKeys: DeprecatedConfigKey[];
} {
    const deprecatedKeys: DeprecatedConfigKey[] = [];
    let out = raw;
    for (const [oldKey, newKey] of Object.entries(DEPRECATED_CONFIG_KEYS)) {
        const oldPath = oldKey.split('.');
        if (getPath(out, oldPath) === undefined) continue;
        const newPath = newKey.split('.');
        const applied = getPath(out, newPath) === undefined;
        deprecatedKeys.push({ key: oldKey, replacement: newKey, applied });

        const value = getPath(out, oldPath);
        out = { ...out };
        // Remove the old key.
        let parent = out;
        for (const part of oldPath.slice(0, -1)) {
            parent[part] = { ...(parent[part] as Plain) };
            parent = parent[part] as Plain;
        }
        delete parent[oldPath[oldPath.length - 1]];
        if (!applied) continue;
        // Insert the value at the new path, creating mappings as needed.
        parent = out;
        for (const part of newPath.slice(0, -1)) {
            parent[part] = isPlainObject(parent[part])
                ? { ...(parent[part] as Plain) }
                : {};
            parent = parent[part] as Plain;
        }
        parent[newPath[newPath.length - 1]] = value;
    }
    return { raw: out, deprecatedKeys };
}

/**
 * Deep-merges `raw` over `defaults`, validating that every provided value has
 * the same type as the default. Returns the merged config, the dotted paths
 * of keys that are not part of the schema, and the deprecated keys that were
 * translated (see {@link DEPRECATED_CONFIG_KEYS}).
 */
export function mergeBotConfig(
    raw: unknown,
    defaults: BotConfig = DEFAULT_BOT_CONFIG
): {
    config: BotConfig;
    unknownKeys: string[];
    deprecatedKeys: DeprecatedConfigKey[];
} {
    if (raw === null || raw === undefined) {
        return {
            config: structuredClone(defaults),
            unknownKeys: [],
            deprecatedKeys: [],
        };
    }
    if (!isPlainObject(raw)) {
        throw new BotConfigError(
            'Config file must contain a mapping at the top level'
        );
    }

    const translated = applyDeprecatedKeys(raw);
    const input = translated.raw;
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

    const config = merge(
        structuredClone(defaults) as unknown as Plain,
        input,
        ''
    ) as unknown as BotConfig;
    validateHistoryConfig(config.history);
    validateClaudeRequestsConfig(config.claudeRequests);

    return {
        config,
        unknownKeys,
        deprecatedKeys: translated.deprecatedKeys,
    };
}

/**
 * The `history` numbers must be positive integers, and the default count
 * cannot exceed the maximum (`history 50` with a `maxCount` of 10 would be
 * refused while the bare `history` would silently ask for more).
 */
function validateHistoryConfig(history: BotConfig['history']): void {
    for (const key of ['defaultCount', 'maxCount', 'delayMs'] as const) {
        const value = history[key];
        if (!Number.isInteger(value) || value <= 0) {
            throw new BotConfigError(
                `Config "history.${key}" must be a positive whole number, got ${value}`
            );
        }
    }
    if (history.defaultCount > history.maxCount) {
        throw new BotConfigError(
            `Config "history.defaultCount" (${history.defaultCount}) must not exceed "history.maxCount" (${history.maxCount})`
        );
    }
}

/** `claudeRequests.repo` must look like `owner/name`; the label must not be empty. */
function validateClaudeRequestsConfig(
    claudeRequests: BotConfig['claudeRequests']
): void {
    if (!/^[\w.-]+\/[\w.-]+$/.test(claudeRequests.repo)) {
        throw new BotConfigError(
            `Config "claudeRequests.repo" must be "owner/name", got "${claudeRequests.repo}"`
        );
    }
    if (!claudeRequests.label.trim()) {
        throw new BotConfigError(
            'Config "claudeRequests.label" must not be empty'
        );
    }
    if (
        !Number.isInteger(claudeRequests.notifyPollMs) ||
        claudeRequests.notifyPollMs < 30_000
    ) {
        throw new BotConfigError(
            `Config "claudeRequests.notifyPollMs" must be a whole number of at least 30000, got ${claudeRequests.notifyPollMs}`
        );
    }
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
    deprecatedKeys: DeprecatedConfigKey[];
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
            deprecatedKeys: [],
        };
    }
    const raw = parseBotConfigText(fs.readFileSync(source, 'utf8'), source);
    const { config, unknownKeys, deprecatedKeys } = mergeBotConfig(raw);
    return { config, source, unknownKeys, deprecatedKeys };
}

// Discord and Fluxer use the same permission bit values. The masks exceed 32
// bits, so they are combined with addition rather than bitwise operators
// (each flag is a distinct power of two, and the sum stays well below 2^53).
const PERMISSION_BITS = {
    viewChannel: 2 ** 10,
    sendMessages: 2 ** 11,
    embedLinks: 2 ** 14,
    addReactions: 2 ** 6,
    readMessageHistory: 2 ** 16,
    manageWebhooks: 2 ** 29,
    connect: 2 ** 20,
    speak: 2 ** 21,
    useVoiceActivity: 2 ** 25,
    manageThreads: 2 ** 34,
    createPublicThreads: 2 ** 35,
    sendMessagesInThreads: 2 ** 38,
    createExpressions: 2 ** 43,
};

/**
 * Permission mask for the bot invite links. The base set is what channel
 * bridging always needed plus the voice bridge bits (Connect, Speak, Use
 * Voice Activity); thread bridging adds Create Public Threads and Send
 * Messages in Threads, and reaction bridging adds Add Reactions (requested
 * even when `reactions.enabled` is off, so turning it on later needs no
 * re-invite). Emoji and sticker transfer (`expressions` command) adds Create
 * Expressions, which the bot needs on Fluxer to upload the copies. Manage
 * Threads is only requested when enabled in the config, because it also
 * grants deleting and archiving threads.
 */
export function inviteBotPermissions(config: BotConfig): string {
    const flags = [
        PERMISSION_BITS.viewChannel,
        PERMISSION_BITS.sendMessages,
        PERMISSION_BITS.embedLinks,
        PERMISSION_BITS.addReactions,
        PERMISSION_BITS.readMessageHistory,
        PERMISSION_BITS.manageWebhooks,
        PERMISSION_BITS.connect,
        PERMISSION_BITS.speak,
        PERMISSION_BITS.useVoiceActivity,
        PERMISSION_BITS.createPublicThreads,
        PERMISSION_BITS.sendMessagesInThreads,
        PERMISSION_BITS.createExpressions,
    ];
    if (config.permissions.manageThreads) {
        flags.push(PERMISSION_BITS.manageThreads);
    }
    const mask = flags.reduce((sum, flag) => sum + flag, 0);
    return mask.toString();
}
