import {
    EmbedBuilder as DiscordEmbedBuilder,
    MessageReplyOptions,
} from 'discord.js';
import { COMMAND_PREFIX } from '../utils/env';
import {
    MessageSendOptions,
    EmbedBuilder as FluxerEmbedBuilder,
} from '@fluxerjs/core';
import { EmbedColors } from '../utils/embeds';

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
                "Bridges a Discord voice channel with a Fluxer voice channel (both by ID), immediately; link once and the bot joins automatically whenever someone is in either channel. `unlink <id>` removes a voice link after `confirm`, `on <id>` / `off <id>` enable or disable it, and with no arguments the server's voice links are listed.",
            usageArgs: [
                '<discordVoiceChannelId> <fluxerVoiceChannelId> | unlink <discordVoiceChannelId> | on <discordVoiceChannelId> | off <discordVoiceChannelId> | confirm',
            ],
        },
        fluxer: {
            description:
                "Bridges a Fluxer voice channel with a Discord voice channel (both by ID), immediately; link once and the bot joins automatically whenever someone is in either channel. `unlink <id>` removes a voice link after `confirm`, `on <id>` / `off <id>` enable or disable it, and with no arguments the server's voice links are listed.",
            usageArgs: [
                '<fluxerVoiceChannelId> <discordVoiceChannelId> | unlink <fluxerVoiceChannelId> | on <fluxerVoiceChannelId> | off <fluxerVoiceChannelId> | confirm',
            ],
        },
    },
    {
        name: 'role',
        fluxer: {
            description:
                'Treats the mentioned Fluxer member as the given Discord user: every Fluxer role with the same name as one of the Discord user’s roles is added, the two accounts are mapped to each other so pings of either are bridged to the other, and the member is added to every bridged thread the Discord user is in. Restricted to the roles configured in `roles.copyAllowedRoleIds`.',
            usageArgs: ['<@fluxerUser> <discordUserId>'],
        },
    },
    {
        name: 'map',
        fluxer: {
            description:
                'Records that the mentioned Fluxer member is the given Discord user, so pings of either account are bridged to the other. Only works when neither account is mapped yet; existing mappings are shown and left alone (`role` replaces them). Restricted to the roles configured in `roles.copyAllowedRoleIds`.',
            usageArgs: ['<@fluxerUser> <discordUserId>'],
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

export const getHelpMessage = (platform: CommandPlatform): string => {
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

    const helpMessage = `
**Available Commands:**
${commandList
    .map((cmd) => getHelpLine(cmd))
    .filter(Boolean)
    .join('\n')}

Use \`${COMMAND_PREFIX}<command>\` to execute a command.

-# [Privacy Policy](https://bifrost-bot.com/legal/privacy) | [Terms of Service](https://bifrost-bot.com/legal/tos) | [Support Server](https://fluxer.gg/TN8FkpdQ) | [GitHub](https://github.com/KartoffelChipss/bifrost)
    `;

    return helpMessage;
};
