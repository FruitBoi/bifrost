/**
 * Discord slash commands: every text command is also offered as `/<name>`
 * with one optional free-text `args` option, so `/clean args:10 -bots` runs
 * exactly what `!b clean 10 -bots` runs. The handlers stay message-based; a
 * slash invocation is handed to them as a Message-like adapter whose
 * `reply` answers the interaction instead.
 */
import {
    ApplicationIntegrationType,
    ChatInputCommandInteraction,
    Client,
    EmbedBuilder,
    GuildTextBasedChannel,
    InteractionContextType,
    InteractionEditReplyOptions,
    InteractionReplyOptions,
    Message,
    MessageFlags,
    MessagePayload,
    MessageReplyOptions,
    RESTPostAPIChatInputApplicationCommandsJSONBody,
    SlashCommandBuilder,
} from 'discord.js';
import CommandRegistry from '../CommandRegistry';
import { getCommandSummary, getDiscordCommandInfo } from '../commandList';
import DiscordCommandHandler, {
    DiscordCommandHandlerMessage,
} from './DiscordCommandHandler';
import { COMMAND_PREFIX } from '../../utils/env';
import { EmbedColors } from '../../utils/embeds';
import logger from '../../utils/logging/logger';

/** Discord allows at most this many global chat input commands. */
export const SLASH_COMMANDS_MAX = 100;
/** Name of the single free-text option every slash command takes. */
export const SLASH_ARGS_OPTION = 'args';

const SLASH_NAME_PATTERN = /^[-_a-z0-9]{1,32}$/;
const DESCRIPTION_MAX = 100;
const GENERIC_ARGS_DESCRIPTION =
    'Arguments, as you would type them after the command';

/** Cuts `text` to Discord's 100-character description limit. */
function fitDescription(text: string): string {
    const clean = text.replace(/\s+/g, ' ').trim();
    if (clean.length <= DESCRIPTION_MAX) return clean;
    // Prefer the first sentence when it fits on its own.
    const sentence = /^(.+?[.!?])(?:\s|$)/.exec(clean)?.[1];
    if (sentence && sentence.length <= DESCRIPTION_MAX) return sentence;
    return `${clean.slice(0, DESCRIPTION_MAX - 1).trimEnd()}…`;
}

/**
 * Builds the slash command definitions for the registered text command
 * names. Names Discord does not accept (`^[-_a-z0-9]{1,32}$`) and duplicates
 * are dropped. When `getHandler` is given, a name whose handler is also
 * registered under a name from the command list (`clear` for `clean`,
 * `backfill` for `history`) is an alias and gets no slash command of its own,
 * which keeps the slash menu to one entry per command. Listed commands come
 * first, so they win when more than
 * {@link SLASH_COMMANDS_MAX} remain; the rest are logged and left out.
 */
export function buildSlashCommandDefinitions(
    commandNames: readonly string[],
    getHandler?: (name: string) => unknown
): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
    const unique = [...new Set(commandNames)];
    const invalid = unique.filter((name) => !SLASH_NAME_PATTERN.test(name));
    if (invalid.length > 0) {
        logger.debug(
            `Skipping slash commands with invalid names: ${invalid.join(', ')}`
        );
    }
    const valid = unique.filter((name) => SLASH_NAME_PATTERN.test(name));

    const listed = valid.filter(
        (name) => getDiscordCommandInfo(name) !== undefined
    );
    const listedHandlers = new Set(
        getHandler ? listed.map((name) => getHandler(name)) : []
    );
    const unlisted = valid.filter(
        (name) =>
            getDiscordCommandInfo(name) === undefined &&
            !(getHandler && listedHandlers.has(getHandler(name)))
    );
    const ordered = [...listed, ...unlisted];

    if (ordered.length > SLASH_COMMANDS_MAX) {
        logger.warn(
            `⚠️ Discord allows ${SLASH_COMMANDS_MAX} slash commands; not registering: ${ordered.slice(SLASH_COMMANDS_MAX).join(', ')}`
        );
    }

    return ordered.slice(0, SLASH_COMMANDS_MAX).map((name) => {
        const info = getDiscordCommandInfo(name);
        const builder = new SlashCommandBuilder()
            .setName(name)
            .setDescription(
                fitDescription(
                    (info && getCommandSummary(name)) ??
                        info?.description ??
                        `Runs the ${name} command.`
                )
            )
            // Handlers are written for guild messages (most refuse DMs).
            .setContexts(InteractionContextType.Guild)
            .setIntegrationTypes(ApplicationIntegrationType.GuildInstall);
        // Commands documented as taking no arguments get no option.
        if (!info || info.usageArgs.length > 0) {
            builder.addStringOption((option) =>
                option
                    .setName(SLASH_ARGS_OPTION)
                    .setDescription(
                        info
                            ? fitDescription(
                                  `Arguments: ${info.usageArgs.join(' ')}`
                              )
                            : GENERIC_ARGS_DESCRIPTION
                    )
                    .setRequired(false)
            );
        }
        return builder.toJSON();
    });
}

/**
 * Registers (overwrites) the bot's global slash commands with one per
 * registered text command. Call once the client is ready. Failures are
 * logged, never thrown: the text commands keep working without them.
 */
export async function registerSlashCommands(
    client: Client,
    registry: CommandRegistry<DiscordCommandHandler>,
    commandNames: readonly string[]
): Promise<void> {
    try {
        if (!client.application) {
            throw new Error('the client application is not available yet');
        }
        const definitions = buildSlashCommandDefinitions(commandNames, (name) =>
            registry.getCommandHandler(name)
        );
        await client.application.commands.set(definitions);
        logger.info(
            `✅ Registered ${definitions.length} Discord slash commands`
        );
    } catch (error) {
        logger.error('❌ Failed to register Discord slash commands:', error);
    }
}

type ReplyInput = string | MessagePayload | MessageReplyOptions;

/** Message options interactions reject or ignore. */
const MESSAGE_ONLY_KEYS = [
    'reply',
    'failIfNotExists',
    'stickers',
    'nonce',
    'enforceNonce',
    'messageReference',
] as const;

/**
 * Turns what a handler passes to `message.reply` into options an interaction
 * accepts: message-reply-only keys (`reply`, `failIfNotExists`,
 * `allowedMentions.repliedUser`, stickers, nonces) are dropped.
 */
export function toInteractionOptions(
    input: ReplyInput
): string | InteractionReplyOptions {
    if (typeof input === 'string') return input;
    if (input instanceof MessagePayload) {
        return toInteractionOptions(input.options as MessageReplyOptions);
    }
    const options: Record<string, unknown> = { ...input };
    for (const key of MESSAGE_ONLY_KEYS) delete options[key];
    if (input.allowedMentions) {
        const mentions = { ...input.allowedMentions };
        delete mentions.repliedUser;
        options.allowedMentions = mentions;
    }
    return options as InteractionReplyOptions;
}

function errorEmbed(description: string): EmbedBuilder {
    return new EmbedBuilder()
        .setDescription(description)
        .setColor(EmbedColors.Error)
        .setTimestamp();
}

/**
 * Runs the text command handler for a slash command. The reply is deferred
 * at once (Discord allows three seconds for the first response), then the
 * handler gets a Message-like adapter: its first `reply` edits the deferred
 * reply, later ones are follow-ups. If the handler never replies (`clean`
 * posts a self-deleting notice, `list all` answers by DM) the "thinking…"
 * placeholder is deleted. Handler errors are logged and shown as an error
 * embed. Interactions outside a cached guild are refused.
 */
export async function handleSlashCommand(
    interaction: ChatInputCommandInteraction,
    registry: CommandRegistry<DiscordCommandHandler>
): Promise<void> {
    const command = interaction.commandName;
    const handler = registry.getCommandHandler(command);
    if (!handler) {
        await interaction
            .reply({
                embeds: [
                    errorEmbed(
                        `Unknown command: \`${command}\`\nUse \`${COMMAND_PREFIX}help\` to see available commands.`
                    ),
                ],
                flags: MessageFlags.Ephemeral,
            })
            .catch((err) =>
                logger.error(
                    '❌ Failed to answer an unknown slash command:',
                    err
                )
            );
        return;
    }

    if (!interaction.inCachedGuild()) {
        await interaction
            .reply({
                embeds: [errorEmbed('This command must be used in a server.')],
                flags: MessageFlags.Ephemeral,
            })
            .catch((err) =>
                logger.error('❌ Failed to answer a slash command:', err)
            );
        return;
    }

    try {
        await interaction.deferReply();
    } catch (error) {
        logger.error(`❌ Failed to defer slash command "${command}":`, error);
        return;
    }

    // Threads the bot has not seen yet are not cached; handlers need one.
    const channel =
        interaction.channel ??
        (await interaction.guild.channels
            .fetch(interaction.channelId)
            .catch(() => null));
    if (!channel?.isTextBased()) {
        await interaction
            .editReply({
                embeds: [errorEmbed('Could not access this channel.')],
            })
            .catch((err) =>
                logger.error('❌ Failed to answer a slash command:', err)
            );
        return;
    }

    const rawArgs = (
        interaction.options.getString(SLASH_ARGS_OPTION) ?? ''
    ).trim();
    const adapter = createSlashMessageAdapter(interaction, channel, rawArgs);

    try {
        await handler.handleCommand(
            adapter.message,
            command,
            ...rawArgs.split(/\s+/).filter(Boolean)
        );
        if (!adapter.replied()) {
            await interaction.deleteReply();
        }
    } catch (error) {
        logger.error(
            `❌ Error executing discord slash command "${command}":`,
            error
        );
        const options = {
            embeds: [
                errorEmbed(
                    `Something went wrong while running \`${command}\`.`
                ),
            ],
        };
        await (
            adapter.replied()
                ? interaction.followUp({
                      ...options,
                      flags: MessageFlags.Ephemeral,
                  })
                : interaction.editReply(options)
        ).catch((err) =>
            logger.error('❌ Failed to report a slash command error:', err)
        );
    }
}

/**
 * Wraps a deferred slash command interaction as the Message a text command
 * handler expects. It covers what the handlers use: `author`, `member`,
 * `guild`, `guildId`, `channel`, `channelId`, `inGuild()`, `content` (the
 * equivalent text invocation, so raw-argument parsing via
 * `stripCommandInvocation` works), `id` (the interaction's snowflake, which
 * sorts after every earlier message), `url` (the channel, there being no
 * invoking message), `delete()` (a no-op: there is nothing to delete) and
 * `reply()`. Everything else a Message has is missing, so a handler that
 * starts using other Message members needs them added here.
 */
export function createSlashMessageAdapter(
    interaction: ChatInputCommandInteraction<'cached'>,
    channel: GuildTextBasedChannel,
    rawArgs: string
): { message: DiscordCommandHandlerMessage; replied: () => boolean } {
    let replied = false;
    const content = rawArgs
        ? `${COMMAND_PREFIX}${interaction.commandName} ${rawArgs}`
        : `${COMMAND_PREFIX}${interaction.commandName}`;

    const adapter = {
        id: interaction.id,
        content,
        author: interaction.user,
        member: interaction.member,
        guild: interaction.guild,
        guildId: interaction.guildId,
        channel,
        channelId: interaction.channelId,
        url: `https://discord.com/channels/${interaction.guildId}/${interaction.channelId}`,
        inGuild: () => true,
        delete: async () => adapter,
        reply: async (input: ReplyInput): Promise<Message> => {
            const options = toInteractionOptions(input);
            // Set before awaiting so concurrent replies cannot both edit.
            if (!replied) {
                replied = true;
                return interaction.editReply(
                    options as string | InteractionEditReplyOptions
                );
            }
            return interaction.followUp(options);
        },
    };

    return {
        message: adapter as unknown as DiscordCommandHandlerMessage,
        replied: () => replied,
    };
}
