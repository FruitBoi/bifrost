import {
    EmbedBuilder as DiscordEmbedBuilder,
    MessageReplyOptions,
} from 'discord.js';
import { COMMAND_PREFIX } from '../utils/env';
import {
    MessageSendOptions,
    EmbedBuilder as FluxerEmbedBuilder,
} from '@fluxerjs/core';
import { chunkDescriptionLines, EmbedColors } from '../utils/embeds';

export interface CommandInfo {
    description: string;
    usageArgs: string[];
}

export interface Command {
    name: string;
    /** Omitted for commands that only exist on Fluxer. */
    discord?: CommandInfo;
    fluxer: CommandInfo;
}

export type CommandPlatform = 'discord' | 'fluxer';

/** Shared by the Fluxer identity commands `role` and `map`. */
const IDENTITY_USAGE_ARGS = ['<@fluxerUser> <discordUserId>'];
const IDENTITY_RESTRICTION =
    'Restricted to the roles configured in `roles.identity`.';

const commandList: Command[] = [
    {
        name: 'help',
        discord: {
            description:
                'Displays a list of available commands and their descriptions.',
            usageArgs: [],
        },
        fluxer: {
            description:
                'Displays a list of available commands and their descriptions.',
            usageArgs: [],
        },
    },
    {
        name: 'autolink',
        discord: {
            description:
                'Compares unlinked channels across both guilds and proposes links based on name similarity. Run with `confirm` to execute all proposals.',
            usageArgs: ['[confirm]'],
        },
        fluxer: {
            description:
                'Compares unlinked channels across both guilds and proposes links based on name similarity. Run with `confirm` to execute all proposals.',
            usageArgs: ['[confirm]'],
        },
    },
    {
        name: 'link',
        discord: {
            description:
                'Links this server to a Fluxer guild (by guild ID), or links the channel or thread you run it in to a Fluxer channel or thread (by its ID). Channel↔channel, thread↔thread and channel↔thread links are all allowed. The link is created immediately.',
            usageArgs: ['<fluxerGuildId | fluxerChannelId | fluxerThreadId>'],
        },
        fluxer: {
            description:
                'Links this server to a Discord guild (by guild ID), or links the channel or thread you run it in to a Discord channel or thread (by its ID). Channel↔channel, thread↔thread and channel↔thread links are all allowed. The link is created immediately.',
            usageArgs: [
                '<discordGuildId | discordChannelId | discordThreadId>',
            ],
        },
    },
    {
        name: 'unlink',
        discord: {
            description:
                'Unlinks this Discord guild from its linked Fluxer guild, or removes a channel or thread link by the Fluxer channel or thread ID.',
            usageArgs: ['<fluxerGuildId | fluxerChannelId | fluxerThreadId>'],
        },
        fluxer: {
            description:
                'Unlinks this Fluxer guild from its linked Discord guild, or removes a channel or thread link by the Discord channel or thread ID.',
            usageArgs: [
                '<discordGuildId | discordChannelId | discordThreadId>',
            ],
        },
    },
    {
        name: 'threads',
        discord: {
            description:
                'Shows or sets whether new threads in the current channel↔channel link are bridged automatically. Run inside the channel (or one of its threads) with `on` or `off`; with no argument the current setting is shown.',
            usageArgs: ['[on | off]'],
        },
        fluxer: {
            description:
                'Shows or sets whether new threads in the current channel↔channel link are bridged automatically. Run inside the channel (or one of its threads) with `on` or `off`; with no argument the current setting is shown.',
            usageArgs: ['[on | off]'],
        },
    },
    {
        name: 'category',
        discord: {
            description:
                "Bridges every text channel of the current channel's category to threads in the given Fluxer channel, immediately (run inside a channel of the category). `unlink` removes the category link and its channel links after `confirm`.",
            usageArgs: ['<fluxerChannelId> | unlink | confirm'],
        },
        fluxer: {
            description:
                'Bridges every text channel of the given Discord category to threads in the current Fluxer channel, immediately. `unlink <id>` removes the category link and its channel links after `confirm`.',
            usageArgs: [
                '<discordCategoryId> | unlink <discordCategoryId> | confirm',
            ],
        },
    },
    {
        name: 'voice',
        discord: {
            description:
                "Bridges a Discord voice channel with a Fluxer voice channel (both by ID), immediately; link once and the bot joins automatically whenever people are in both channels. `unlink <id>` removes a voice link after `confirm`, `on <id>` / `off <id>` enable or disable it, and with no arguments the server's voice links are listed.",
            usageArgs: [
                '<discordVoiceChannelId> <fluxerVoiceChannelId> | unlink <discordVoiceChannelId> | on <discordVoiceChannelId> | off <discordVoiceChannelId> | confirm',
            ],
        },
        fluxer: {
            description:
                "Bridges a Fluxer voice channel with a Discord voice channel (both by ID), immediately; link once and the bot joins automatically whenever people are in both channels. `unlink <id>` removes a voice link after `confirm`, `on <id>` / `off <id>` enable or disable it, and with no arguments the server's voice links are listed.",
            usageArgs: [
                '<fluxerVoiceChannelId> <discordVoiceChannelId> | unlink <fluxerVoiceChannelId> | on <fluxerVoiceChannelId> | off <fluxerVoiceChannelId> | confirm',
            ],
        },
    },
    {
        name: 'role',
        fluxer: {
            description: `Treats the mentioned Fluxer member as the given Discord user: every Fluxer role with the same name as one of the Discord user’s roles is added, the two accounts are mapped to each other (replacing an existing mapping) so pings of either are bridged to the other, and the member is added to every bridged thread the Discord user is in. ${IDENTITY_RESTRICTION}`,
            usageArgs: IDENTITY_USAGE_ARGS,
        },
    },
    {
        name: 'map',
        fluxer: {
            description: `Records that the mentioned Fluxer member is the given Discord user, so pings of either account are bridged to the other. Only works when neither account is mapped yet; existing mappings are shown and left alone. \`role\` does the same and also copies roles and thread memberships, replacing an existing mapping. ${IDENTITY_RESTRICTION}`,
            usageArgs: IDENTITY_USAGE_ARGS,
        },
    },
    {
        name: 'expressions',
        discord: {
            description:
                "Copies this server's custom emojis and stickers to the linked Fluxer server under the same names, so bridged messages and reactions can show them; names that already exist there are skipped, so it can be re-run. Give `emojis` or `stickers` to copy only that kind. Aliases `emotes`, `emojis`. Requires the `Manage Expressions` permission.",
            usageArgs: ['[emojis | stickers]'],
        },
        fluxer: {
            description:
                "Copies the linked Discord server's custom emojis and stickers to this server under the same names, so bridged messages and reactions can show them; names that already exist here are skipped, so it can be re-run. Give `emojis` or `stickers` to copy only that kind. Aliases `emotes`, `emojis`. Requires the `Manage Expressions` permission.",
            usageArgs: ['[emojis | stickers]'],
        },
    },
    {
        name: 'remindme',
        discord: {
            description:
                'Schedules a reminder in this channel (or in the channel given with `-channel`) that pings you after the given time, e.g. `remindme 1h30min are you still alive?`. Time units: s, m/min, h, d, w, mo, y; a bare number is minutes; at most 10 years ahead; 25 reminders per user. Also triggered by `?remindme` / `!remindme` (`? Remindme` works too) and the alias `remind`.',
            usageArgs: ['[-channel <channel>]', '<time>', '<message>'],
        },
        fluxer: {
            description:
                'Schedules a reminder in this channel (or in the channel given with `-channel`) that pings you after the given time, e.g. `remindme 1h30min are you still alive?`. Time units: s, m/min, h, d, w, mo, y; a bare number is minutes; at most 10 years ahead; 25 reminders per user. Also triggered by `?remindme` / `!remindme` (`? Remindme` works too) and the alias `remind`.',
            usageArgs: ['[-channel <channel>]', '<time>', '<message>'],
        },
    },
    {
        name: 'reminder',
        discord: {
            description:
                "Manages your reminders: `list` shows your reminders in this server, `channel` shows every reminder set for the current channel (needs Manage Channels), `delete <id>` deletes one of yours (or someone else's with Manage Channels in its channel), `delete -a` deletes all of yours. Aliases: `reminders`, `creminders`, `delreminder`. Also triggered by `?reminder` / `!reminder`.",
            usageArgs: ['list | channel | delete <id> | delete -a'],
        },
        fluxer: {
            description:
                "Manages your reminders: `list` shows your reminders in this server, `channel` shows every reminder set for the current channel (needs Manage Channels), `delete <id>` deletes one of yours (or someone else's with Manage Channels in its channel), `delete -a` deletes all of yours. Aliases: `reminders`, `creminders`, `delreminder`. Also triggered by `?reminder` / `!reminder`.",
            usageArgs: ['list | channel | delete <id> | delete -a'],
        },
    },
    {
        name: 'clean',
        discord: {
            description:
                'Deletes the last `num` messages (1–100) in this channel, or only those by the given user (mention or ID, before or after the number). Switches: `-r <regex>` only messages matching the regex (`-im` inverts it, `-i` ignores case), `-ma <time>` / `-minage <time>` only messages younger / older than that (e.g. `1h30m`), `-nopin` skips pinned messages, `-a` only messages with attachments, `-bots` only bot messages, `-from <id>` / `-to <id>` only messages between those message IDs. Looks through the last 1000 messages; messages older than two weeks cannot be deleted. Aliases `clear`, `cl`; also triggered by `?clean` / `!clean`. Moderator command: restricted to the roles configured in `roles.moderator`.',
            usageArgs: [
                '<num> [user]',
                '[-r <regex>] [-im] [-i] [-ma <time>] [-minage <time>] [-nopin] [-a] [-bots] [-from <id>] [-to <id>]',
            ],
        },
        fluxer: {
            description:
                'Deletes the last `num` messages (1–100) in this channel, or only those by the given user (mention or ID, before or after the number). Switches: `-r <regex>` only messages matching the regex (`-im` inverts it, `-i` ignores case), `-ma <time>` / `-minage <time>` only messages younger / older than that (e.g. `1h30m`), `-nopin` skips pinned messages, `-a` only messages with attachments, `-bots` only bot messages, `-from <id>` / `-to <id>` only messages between those message IDs. Looks through the last 1000 messages. Aliases `clear`, `cl`; also triggered by `?clean` / `!clean`. Moderator command: restricted to the roles configured in `roles.moderator`.',
            usageArgs: [
                '<num> [user]',
                '[-r <regex>] [-im] [-i] [-ma <time>] [-minage <time>] [-nopin] [-a] [-bots] [-from <id>] [-to <id>]',
            ],
        },
    },
    {
        name: 'history',
        discord: {
            description:
                "Copies this linked channel's or thread's message history to its Fluxer counterpart, oldest first, in the style of bridged messages (each copy starts with a timestamp line). `history` copies the last `history.defaultCount` messages, `history 250` the last 250 (up to `history.maxCount`), `history all` the whole history after `history confirm`. Switches: `-ma <time>` only messages younger than that, `-after <id>` / `-before <id>` only messages between those IDs, `-digest` packs many messages into transcript posts (faster, but those copies get no per-message links), `-notime` drops the timestamp lines. Already bridged or transferred messages are skipped, so it is safe to re-run and resumes. Runs in the background, one transfer at a time with a pause between posts; copies never ping anyone. `status` shows the transfer for this channel, `stop` cancels it. Alias `backfill`. Moderator command: restricted to the roles configured in `roles.moderator`.",
            usageArgs: [
                '[num | all | confirm | status | stop]',
                '[-ma <time>] [-after <id>] [-before <id>] [-digest] [-notime]',
            ],
        },
        fluxer: {
            description:
                "Copies this linked channel's or thread's message history to its Discord counterpart, oldest first, in the style of bridged messages (each copy starts with a timestamp line). `history` copies the last `history.defaultCount` messages, `history 250` the last 250 (up to `history.maxCount`), `history all` the whole history after `history confirm`. Switches: `-ma <time>` only messages younger than that, `-after <id>` / `-before <id>` only messages between those IDs, `-digest` packs many messages into transcript posts (faster, but those copies get no per-message links), `-notime` drops the timestamp lines. Already bridged or transferred messages are skipped, so it is safe to re-run and resumes. Runs in the background, one transfer at a time with a pause between posts; copies never ping anyone. `status` shows the transfer for this channel, `stop` cancels it. Alias `backfill`. Moderator command: restricted to the roles configured in `roles.moderator`.",
            usageArgs: [
                '[num | all | confirm | status | stop]',
                '[-ma <time>] [-after <id>] [-before <id>] [-digest] [-notime]',
            ],
        },
    },
    {
        name: 'clauderequest',
        discord: {
            description:
                "Files the rest of the message (newlines kept, up to 4000 characters) as an issue labelled `claude` in the bot's GitHub repository, for Claude to work on, and replies with the link. One request per minute per user. Needs `BF_GITHUB_TOKEN`. Restricted to the roles configured in `roles.claudeRequest`.",
            usageArgs: ['<request>'],
        },
        fluxer: {
            description:
                "Files the rest of the message (newlines kept, up to 4000 characters) as an issue labelled `claude` in the bot's GitHub repository, for Claude to work on, and replies with the link. One request per minute per user. Needs `BF_GITHUB_TOKEN`. Restricted to the roles configured in `roles.claudeRequest`.",
            usageArgs: ['<request>'],
        },
    },
    {
        name: 'lines',
        discord: {
            description:
                "Shows how many lines of code Claude has written in the bot's GitHub repository: lines added and deleted in commits with a `Co-Authored-By: Claude` trailer, the number of those commits, their share of all lines added, and the biggest and latest one. Counted from the repository's default branch and cached for 10 minutes. Needs `BF_GITHUB_TOKEN`.",
            usageArgs: [],
        },
        fluxer: {
            description:
                "Shows how many lines of code Claude has written in the bot's GitHub repository: lines added and deleted in commits with a `Co-Authored-By: Claude` trailer, the number of those commits, their share of all lines added, and the biggest and latest one. Counted from the repository's default branch and cached for 10 minutes. Needs `BF_GITHUB_TOKEN`.",
            usageArgs: [],
        },
    },
    {
        name: 'list',
        discord: {
            description:
                'Lists all channel, thread and voice links in this server.',
            usageArgs: [],
        },
        fluxer: {
            description:
                'Lists all channel, thread and voice links in this server.',
            usageArgs: [],
        },
    },
    {
        name: 'stats',
        discord: {
            description:
                'Shows statistics about the bot, such as number of linked guilds and channels.',
            usageArgs: [],
        },
        fluxer: {
            description:
                'Shows statistics about the bot, such as number of linked guilds and channels.',
            usageArgs: [],
        },
    },
];

function getStringCommandUsage(
    commandName: string,
    platform: CommandPlatform
): string {
    const command = commandList.find((cmd) => cmd.name === commandName);
    if (!command) return `Command \`${commandName}\` not found.`;
    const commandInfo =
        platform === 'discord' ? command.discord : command.fluxer;
    if (!commandInfo) return `Command \`${commandName}\` not found.`;
    const baseMessage = `Usage: \`${COMMAND_PREFIX}${commandName} ${commandInfo.usageArgs.join(' ')}\``;
    return `${baseMessage}\n> ${commandInfo.description}`;
}

export function getDiscordCommandUsage(
    commandName: string
): MessageReplyOptions {
    const usageMessage = getStringCommandUsage(commandName, 'discord');
    return {
        embeds: [
            new DiscordEmbedBuilder()
                .setTitle('Command Usage')
                .setDescription(usageMessage)
                .setColor(EmbedColors.Info),
        ],
    };
}
export function getFluxerCommandUsage(commandName: string): MessageSendOptions {
    const usageMessage = getStringCommandUsage(commandName, 'fluxer');
    return {
        embeds: [
            new FluxerEmbedBuilder()
                .setTitle('Command Usage')
                .setDescription(usageMessage)
                .setColor(EmbedColors.Info),
        ],
    };
}

/**
 * The help text for `platform`, split into embed descriptions that each fit within the
 * embed description limit (the full list is longer than one embed allows).
 */
export const getHelpPages = (platform: CommandPlatform): string[] => {
    function getHelpLine(command: Command): string {
        const commandInfo =
            platform === 'discord' ? command.discord : command.fluxer;
        if (!commandInfo) return '';

        const usage =
            commandInfo.usageArgs && commandInfo.usageArgs.length > 0
                ? `${COMMAND_PREFIX}${command.name} ${commandInfo.usageArgs.join(' ')}`
                : `${COMMAND_PREFIX}${command.name}`;

        return `- \`${usage}\`: ${commandInfo.description}`;
    }

    const lines = [
        '**Available Commands:**',
        ...commandList.map((cmd) => getHelpLine(cmd)).filter(Boolean),
        '',
        `Use \`${COMMAND_PREFIX}<command>\` to execute a command.`,
        '',
        '-# [Privacy Policy](https://bifrost-bot.com/legal/privacy) | [Terms of Service](https://bifrost-bot.com/legal/tos) | [Support Server](https://fluxer.gg/TN8FkpdQ) | [GitHub](https://github.com/KartoffelChipss/bifrost)',
    ];

    return chunkDescriptionLines(lines, '\n').map((chunk) =>
        chunk.join('\n').trim()
    );
};
