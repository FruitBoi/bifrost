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
    /** One sentence for the `help` overview and the slash command menu. */
    summary: string;
    /** Other names that run the same command (and show its usage). */
    aliases?: string[];
    /** Omitted for commands that only exist on Fluxer. */
    discord?: CommandInfo;
    fluxer: CommandInfo;
}

export type CommandPlatform = 'discord' | 'fluxer';

const commandList: Command[] = [
    {
        name: 'help',
        summary:
            'Lists the commands, or shows the full documentation of one with `help <command>`.',
        discord: {
            description:
                "Lists every command with a one-sentence summary. `help <command>` (or an alias of it) shows that command's usage, full description and aliases.",
            usageArgs: ['[command]'],
        },
        fluxer: {
            description:
                "Lists every command with a one-sentence summary. `help <command>` (or an alias of it) shows that command's usage, full description and aliases.",
            usageArgs: ['[command]'],
        },
    },
    {
        name: 'autolink',
        summary:
            'Proposes channel links between both guilds by name similarity.',
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
        summary:
            'Links this server, channel or thread to its counterpart on the other platform.',
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
        summary: 'Removes a guild, channel or thread link.',
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
        summary:
            'Shows or sets whether new threads in a linked channel are bridged automatically.',
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
        name: 'directory',
        summary:
            'Posts and maintains a message listing the threads of a channel, with descriptions.',
        aliases: ['catalog', 'threaddir'],
        discord: {
            description:
                "Posts a threads directory in the current channel (or the parent channel when run in a thread): an embed listing the channel's threads, oldest first, with optional descriptions. It is edited in place when descriptions or the title change or a thread is created or deleted. Needs Manage Channels. `post [title]` posts it (replacing the old one), `refresh` re-renders it, `describe [thread] <text>` sets a thread's description (omit the text to clear it; the thread is optional inside a thread), `hide`/`show [thread]` leaves a thread out of or back in the list, `title <title>` renames it, `remove` deletes the message (descriptions are kept). With no argument the directory and every thread's description are shown. `thread` is a channel mention or an ID.",
            usageArgs: [
                '[post [title] | refresh | describe [thread] [description] | hide [thread] | show [thread] | title <title> | remove]',
            ],
        },
        fluxer: {
            description:
                "Posts a threads directory in the current channel (or the parent channel when run in a thread): an embed listing the channel's threads, oldest first, with optional descriptions. It is edited in place when descriptions or the title change or a thread is created or deleted. Needs Manage Channels. `post [title]` posts it (replacing the old one), `refresh` re-renders it, `describe [thread] <text>` sets a thread's description (omit the text to clear it; the thread is optional inside a thread), `hide`/`show [thread]` leaves a thread out of or back in the list, `title <title>` renames it, `remove` deletes the message (descriptions are kept). With no argument the directory and every thread's description are shown. `thread` is a channel mention or an ID.",
            usageArgs: [
                '[post [title] | refresh | describe [thread] [description] | hide [thread] | show [thread] | title <title> | remove]',
            ],
        },
    },
    {
        name: 'pins',
        summary:
            'Syncs the pinned messages of a linked channel or thread between Discord and Fluxer.',
        discord: {
            description:
                'Syncs the pinned messages of the current linked channel or thread with Fluxer: already-bridged messages are pinned on both sides and unbridged pins are copied over. Needs Manage Messages. New pins and unpins on bridged messages sync automatically.',
            usageArgs: ['sync'],
        },
        fluxer: {
            description:
                'Syncs the pinned messages of the current linked channel or thread with Discord: already-bridged messages are pinned on both sides and unbridged pins are copied over. Needs Manage Messages. New pins and unpins on bridged messages sync automatically.',
            usageArgs: ['sync'],
        },
    },
    {
        name: 'category',
        summary:
            'Bridges every text channel of a Discord category to threads in a Fluxer channel.',
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
        summary: 'Bridges a Discord voice channel with a Fluxer voice channel.',
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
        summary:
            'Maps a Fluxer member to a Discord user and copies their matching roles.',
        aliases: ['map'],
        fluxer: {
            description:
                'Treats the mentioned Fluxer member as the given Discord user: every Fluxer role with the same name as one of the Discord user’s roles is added, the two accounts are mapped to each other (replacing an existing mapping) so pings of either are bridged to the other, and the member is added to every bridged thread the Discord user is in. Alias `map`. Restricted to the roles configured in `roles.identity`.',
            usageArgs: ['<@fluxerUser> <discordUserId>'],
        },
    },
    {
        name: 'iam',
        summary:
            'Links your Discord and Fluxer accounts so pings reach you on both sides.',
        discord: {
            description:
                'Links your Discord account to your Fluxer account so pings of either reach you on both sides, built from a reply: reply `iam` to the bridged copy of a message you wrote on Fluxer, and the bot asks that Fluxer account (in reply to the original message) to confirm with `iam yes` within 10 minutes; `iam no` dismisses a request. Never replaces an existing link: run `iam remove` (alias `unlink`) first, or have an admin use `role` / `map` on Fluxer. `iam` alone shows your link and any request waiting for you; `yes` also works as `confirm`, `no` as `deny`. One request per minute. Open to everyone. The request itself must be a message reply, so `/iam` only answers, unlinks or shows the status.',
            usageArgs: ['[yes | no | remove]'],
        },
        fluxer: {
            description:
                'Links your Fluxer account to your Discord account so pings of either reach you on both sides, built from a reply: reply `iam` to the bridged copy of a message you wrote on Discord, and the bot asks that Discord account (in reply to the original message) to confirm with `iam yes` within 10 minutes; `iam no` dismisses a request. Never replaces an existing link: run `iam remove` (alias `unlink`) first, or have an admin use `role` / `map` on Fluxer. `iam` alone shows your link and any request waiting for you; `yes` also works as `confirm`, `no` as `deny`. One request per minute. Open to everyone.',
            usageArgs: ['[yes | no | remove]'],
        },
    },
    {
        name: 'expressions',
        summary: 'Copies custom emojis and stickers to the linked server.',
        aliases: ['emotes', 'emojis'],
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
        summary: 'Pings you with a message after a time or at a date and time.',
        aliases: ['remind'],
        discord: {
            description:
                'Schedules a reminder in this channel (or in the channel given with `-channel`) that pings you after the given time, e.g. `remindme 1h30min are you still alive?`. Time units: s, m/min, h, d, w, mo, y; a bare number is minutes. The time can also be a date and/or time of day in your time zone: `remindme Oct 26 20:15 ...`, `26 Oct`, `2026-10-26 9am`, `Monday 7pm`, `next fri`, `tomorrow`, `tomorrow at 7pm`, `today 5pm`, `tonight`, or just `7pm` / `20:15` (the next time it comes round); a date without a time means 09:00. The first time you use a date or time you are asked for your time zone (see `timezone`). At most 10 years ahead; 25 reminders per user. Also triggered by `?remindme` / `!remindme` (`? Remindme` works too) and the alias `remind`.',
            usageArgs: ['[-channel <channel>]', '<time | date>', '<message>'],
        },
        fluxer: {
            description:
                'Schedules a reminder in this channel (or in the channel given with `-channel`) that pings you after the given time, e.g. `remindme 1h30min are you still alive?`. Time units: s, m/min, h, d, w, mo, y; a bare number is minutes. The time can also be a date and/or time of day in your time zone: `remindme Oct 26 20:15 ...`, `26 Oct`, `2026-10-26 9am`, `Monday 7pm`, `next fri`, `tomorrow`, `tomorrow at 7pm`, `today 5pm`, `tonight`, or just `7pm` / `20:15` (the next time it comes round); a date without a time means 09:00. The first time you use a date or time you are asked for your time zone (see `timezone`). At most 10 years ahead; 25 reminders per user. Also triggered by `?remindme` / `!remindme` (`? Remindme` works too) and the alias `remind`.',
            usageArgs: ['[-channel <channel>]', '<time | date>', '<message>'],
        },
    },
    {
        name: 'timezone',
        summary: 'Shows or sets the time zone your date/time reminders use.',
        aliases: ['tz'],
        discord: {
            description:
                'Shows your time zone and the time there, sets it with `timezone <zone>`, or removes it with `timezone clear`. Dates and times in `remindme` (`Monday 7pm`, `Oct 26 20:15`) are read in this zone. Zones: IANA names such as `America/New_York` or `Europe/London` (any case), `UTC`, offsets such as `UTC+2` or `+05:30`, and common abbreviations such as `EST`, `PST` or `CET`. A reminder that was waiting for your time zone is set as soon as you give it. Alias `tz`; also triggered by `?timezone` / `!timezone`.',
            usageArgs: ['[zone | clear]'],
        },
        fluxer: {
            description:
                'Shows your time zone and the time there, sets it with `timezone <zone>`, or removes it with `timezone clear`. Dates and times in `remindme` (`Monday 7pm`, `Oct 26 20:15`) are read in this zone. Zones: IANA names such as `America/New_York` or `Europe/London` (any case), `UTC`, offsets such as `UTC+2` or `+05:30`, and common abbreviations such as `EST`, `PST` or `CET`. A reminder that was waiting for your time zone is set as soon as you give it. Alias `tz`; also triggered by `?timezone` / `!timezone`.',
            usageArgs: ['[zone | clear]'],
        },
    },
    {
        name: 'reminder',
        summary: 'Lists or deletes reminders.',
        aliases: ['reminders', 'creminders', 'delreminder'],
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
        summary: 'Bulk-deletes recent messages, with optional filters.',
        aliases: ['clear', 'cl'],
        discord: {
            description:
                'Deletes the last `num` messages (1–1000) in this channel, or only those by the given user (mention or ID, before or after the number). Switches: `-r <regex>` only messages matching the regex (`-im` inverts it, `-i` ignores case), `-ma <time>` / `-minage <time>` only messages younger / older than that (e.g. `1h30m`), `-nopin` skips pinned messages, `-a` only messages with attachments, `-bots` only bot messages, `-from <id>` / `-to <id>` only messages between those message IDs. Looks through the last 1000 messages; messages older than two weeks cannot be deleted. Aliases `clear`, `cl`; also triggered by `?clean` / `!clean`. Moderator command: restricted to the roles configured in `roles.moderator`.',
            usageArgs: [
                '<num> [user]',
                '[-r <regex>] [-im] [-i] [-ma <time>] [-minage <time>] [-nopin] [-a] [-bots] [-from <id>] [-to <id>]',
            ],
        },
        fluxer: {
            description:
                'Deletes the last `num` messages (1–1000) in this channel, or only those by the given user (mention or ID, before or after the number). Switches: `-r <regex>` only messages matching the regex (`-im` inverts it, `-i` ignores case), `-ma <time>` / `-minage <time>` only messages younger / older than that (e.g. `1h30m`), `-nopin` skips pinned messages, `-a` only messages with attachments, `-bots` only bot messages, `-from <id>` / `-to <id>` only messages between those message IDs. Looks through the last 1000 messages. Aliases `clear`, `cl`; also triggered by `?clean` / `!clean`. Moderator command: restricted to the roles configured in `roles.moderator`.',
            usageArgs: [
                '<num> [user]',
                '[-r <regex>] [-im] [-i] [-ma <time>] [-minage <time>] [-nopin] [-a] [-bots] [-from <id>] [-to <id>]',
            ],
        },
    },
    {
        name: 'history',
        summary:
            "Copies a linked channel's message history to its counterpart.",
        aliases: ['backfill'],
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
        summary: 'Files a request as a GitHub issue for Claude to work on.',
        discord: {
            description:
                "Files the rest of the message (newlines kept, up to 4000 characters) as an issue labelled `claude` in the bot's GitHub repository, for Claude to work on, and replies with the link. One request per minute per user. Needs `BF_GITHUB_TOKEN`. Restricted to the roles configured in `roles.claudeRequest`. The bot pings the requester in the channel when the issue is closed.",
            usageArgs: ['<request>'],
        },
        fluxer: {
            description:
                "Files the rest of the message (newlines kept, up to 4000 characters) as an issue labelled `claude` in the bot's GitHub repository, for Claude to work on, and replies with the link. One request per minute per user. Needs `BF_GITHUB_TOKEN`. Restricted to the roles configured in `roles.claudeRequest`. The bot pings the requester in the channel when the issue is closed.",
            usageArgs: ['<request>'],
        },
    },
    {
        name: 'lines',
        summary: 'Shows how many lines of code Claude has written for the bot.',
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
        name: 'fishtrade',
        summary: 'Lets your fish paper-trade the stock market.',
        aliases: ['fishtrading', 'stonks'],
        discord: {
            description:
                'Lets your fish paper-trade one session of a real stock (1-minute prices from Yahoo Finance, pretend money) with a trend-following algorithm (EMA crossover entries, ATR stops, risk-based position sizing, flat by the close), compared with its old random strategy and with buy-and-hold, plus progress toward fish financial independence (25x yearly fish-food expenses). `fishtrade Bubbles $AAPL` names the fish and the ticker (`-ticker <symbol>` works too; random well-known ticker by default), `-cash <amount>` sets the starting bankroll (default $100), `-sim` trades a simulated fish market instead and `-seed <n>` replays a simulated day. Aliases `fishtrading`, `stonks`. Open to everyone.',
            usageArgs: [
                '[fish name]',
                '[-ticker <symbol>]',
                '[-cash <amount>]',
                '[-sim]',
                '[-seed <n>]',
            ],
        },
        fluxer: {
            description:
                'Lets your fish paper-trade one session of a real stock (1-minute prices from Yahoo Finance, pretend money) with a trend-following algorithm (EMA crossover entries, ATR stops, risk-based position sizing, flat by the close), compared with its old random strategy and with buy-and-hold, plus progress toward fish financial independence (25x yearly fish-food expenses). `fishtrade Bubbles $AAPL` names the fish and the ticker (`-ticker <symbol>` works too; random well-known ticker by default), `-cash <amount>` sets the starting bankroll (default $100), `-sim` trades a simulated fish market instead and `-seed <n>` replays a simulated day. Aliases `fishtrading`, `stonks`. Open to everyone.',
            usageArgs: [
                '[fish name]',
                '[-ticker <symbol>]',
                '[-cash <amount>]',
                '[-sim]',
                '[-seed <n>]',
            ],
        },
    },
    {
        name: 'list',
        summary: 'Lists all channel, thread and voice links in this server.',
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
        summary: 'Shows statistics about the bot.',
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

/**
 * The Discord usage info of the command listed under `commandName` (its
 * primary name, not an alias), or undefined when no Discord command is
 * listed under that name.
 */
export function getDiscordCommandInfo(
    commandName: string
): CommandInfo | undefined {
    return commandList.find((cmd) => cmd.name === commandName)?.discord;
}

function getStringCommandUsage(
    commandName: string,
    platform: CommandPlatform
): string {
    const command = commandList.find(
        (cmd) => cmd.name === commandName || cmd.aliases?.includes(commandName)
    );
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

const HELP_LINKS =
    '-# [Privacy Policy](https://bifrost-bot.com/legal/privacy) | [Terms of Service](https://bifrost-bot.com/legal/tos) | [Support Server](https://fluxer.gg/TN8FkpdQ) | [GitHub](https://github.com/KartoffelChipss/bifrost)';

/**
 * The one-sentence summary of the command listed under `commandName` (its
 * primary name, not an alias), or undefined when no command has that name.
 */
export function getCommandSummary(commandName: string): string | undefined {
    return commandList.find((cmd) => cmd.name === commandName)?.summary;
}

/**
 * The command overview for `platform` (one line per command with its
 * summary), split into embed descriptions that each fit within the embed
 * description limit.
 */
export const getHelpPages = (platform: CommandPlatform): string[] => {
    const lines = [
        '**Available Commands:**',
        ...commandList
            .filter((cmd) =>
                platform === 'discord' ? cmd.discord : cmd.fluxer
            )
            .map((cmd) => `- \`${COMMAND_PREFIX}${cmd.name}\`: ${cmd.summary}`),
        '',
        `Use \`${COMMAND_PREFIX}help <command>\` for a command's usage and full description.`,
        '',
        HELP_LINKS,
    ];

    return chunkDescriptionLines(lines, '\n').map((chunk) =>
        chunk.join('\n').trim()
    );
};

export interface CommandHelp {
    title: string;
    description: string;
}

/**
 * The detailed help of one command on `platform` for `help <command>`:
 * usage, full description and aliases. `query` may be the primary name or
 * an alias, with or without the command prefix. Undefined when no such
 * command exists on `platform`.
 */
export function getCommandHelp(
    query: string,
    platform: CommandPlatform
): CommandHelp | undefined {
    let name = query.trim().toLowerCase();
    const prefix = COMMAND_PREFIX.toLowerCase();
    if (name.startsWith(prefix)) name = name.slice(prefix.length);
    name = name.replace(/^[!?/]/, '').trim();
    const command = commandList.find(
        (cmd) => cmd.name === name || cmd.aliases?.includes(name)
    );
    const info = platform === 'discord' ? command?.discord : command?.fluxer;
    if (!command || !info) return undefined;

    const usage = [command.name, ...info.usageArgs].join(' ');
    const lines = [
        `**Usage:** \`${COMMAND_PREFIX}${usage}\``,
        '',
        info.description,
    ];
    if (command.aliases && command.aliases.length > 0) {
        lines.push(
            '',
            `**Aliases:** ${command.aliases.map((alias) => `\`${alias}\``).join(', ')}`
        );
    }
    return {
        title: `Help: ${COMMAND_PREFIX}${command.name}`,
        description: lines.join('\n'),
    };
}
