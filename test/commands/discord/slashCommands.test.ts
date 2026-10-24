import { describe, expect, it, vi } from 'vitest';
import {
    ApplicationCommandOptionType,
    ChatInputCommandInteraction,
    Client,
    MessageFlags,
} from 'discord.js';
import CommandRegistry from '../../../src/commands/CommandRegistry';
import DiscordCommandHandler, {
    DiscordCommandHandlerMessage,
} from '../../../src/commands/discord/DiscordCommandHandler';
import {
    buildSlashCommandDefinitions,
    handleSlashCommand,
    registerSlashCommands,
    SLASH_COMMANDS_MAX,
    toInteractionOptions,
} from '../../../src/commands/discord/slashCommands';
import { stripCommandInvocation } from '../../../src/commands/commandTrigger';
import { COMMAND_PREFIX } from '../../../src/utils/env';
import { EmbedColors } from '../../../src/utils/embeds';

const client = { user: { id: 'bot' } } as unknown as Client;

class FakeHandler extends DiscordCommandHandler {
    constructor(
        private readonly run: (
            message: DiscordCommandHandlerMessage,
            command: string,
            args: string[]
        ) => Promise<void>
    ) {
        super(client);
    }

    async handleCommand(
        message: DiscordCommandHandlerMessage,
        command: string,
        ...args: string[]
    ): Promise<void> {
        await this.run(message, command, args);
    }
}

function makeRegistry(
    entries: Record<string, DiscordCommandHandler>
): CommandRegistry<DiscordCommandHandler> {
    const registry = new CommandRegistry<DiscordCommandHandler>();
    for (const [name, handler] of Object.entries(entries)) {
        registry.registerCommand(name, handler);
    }
    return registry;
}

function makeInteraction(
    commandName: string,
    args: string | null = null,
    { cached = true, channel = { id: 'c', isTextBased: () => true } } = {}
) {
    const sent = (id: string) => ({ id });
    const interaction = {
        id: '999',
        commandName,
        user: { id: 'u', username: 'user', bot: false },
        member: { id: 'u' },
        guild: { id: 'g', name: 'G', channels: { fetch: vi.fn() } },
        guildId: 'g',
        channel,
        channelId: 'c',
        options: { getString: vi.fn().mockReturnValue(args) },
        inCachedGuild: () => cached,
        reply: vi.fn().mockResolvedValue(undefined),
        deferReply: vi.fn().mockResolvedValue(undefined),
        editReply: vi.fn().mockResolvedValue(sent('edited')),
        followUp: vi.fn().mockResolvedValue(sent('followup')),
        deleteReply: vi.fn().mockResolvedValue(undefined),
    };
    return {
        interaction,
        typed: interaction as unknown as ChatInputCommandInteraction,
    };
}

describe('buildSlashCommandDefinitions', () => {
    it('skips invalid names and duplicates', () => {
        const defs = buildSlashCommandDefinitions([
            'help',
            'help',
            'Bad',
            'has space',
            'x'.repeat(33),
            'custom-cmd_1',
        ]);
        expect(defs.map((d) => d.name)).toEqual(['help', 'custom-cmd_1']);
    });

    it('drops aliases that share a listed command handler', () => {
        const clean = {};
        const other = {};
        const handlers: Record<string, object> = {
            clear: clean,
            clean,
            cl: clean,
            extra: other,
        };
        const defs = buildSlashCommandDefinitions(
            ['clear', 'clean', 'cl', 'extra'],
            (name) => handlers[name]
        );
        expect(defs.map((d) => d.name)).toEqual(['clean', 'extra']);
    });

    it('keeps descriptions within 1-100 characters', () => {
        const defs = buildSlashCommandDefinitions([
            'help',
            'history',
            'voice',
            'unlisted',
        ]);
        for (const def of defs) {
            expect(def.description.length).toBeGreaterThan(0);
            expect(def.description.length).toBeLessThanOrEqual(100);
            for (const option of def.options ?? []) {
                expect(option.description.length).toBeGreaterThan(0);
                expect(option.description.length).toBeLessThanOrEqual(100);
            }
        }
        const unlisted = defs.find((d) => d.name === 'unlisted');
        expect(unlisted?.description).toBe('Runs the unlisted command.');
    });

    it('adds an optional string args option unless the command takes none', () => {
        const defs = buildSlashCommandDefinitions([
            'help',
            'clean',
            'unlisted',
        ]);
        const byName = Object.fromEntries(defs.map((d) => [d.name, d]));
        expect(byName.help.options ?? []).toEqual([]);
        for (const name of ['clean', 'unlisted']) {
            expect(byName[name].options).toHaveLength(1);
            expect(byName[name].options?.[0]).toMatchObject({
                name: 'args',
                type: ApplicationCommandOptionType.String,
                required: false,
            });
        }
        expect(byName.unlisted.options?.[0].description).toBe(
            'Arguments, as you would type them after the command'
        );
    });

    it('caps at the global limit, keeping listed commands', () => {
        const extra = Array.from({ length: 120 }, (_, i) => `cmd${i}`);
        const defs = buildSlashCommandDefinitions([...extra, 'help']);
        expect(defs).toHaveLength(SLASH_COMMANDS_MAX);
        expect(defs[0].name).toBe('help');
    });
});

describe('registerSlashCommands', () => {
    it('sets the definitions globally', async () => {
        const set = vi.fn().mockResolvedValue(undefined);
        const registry = makeRegistry({
            help: new FakeHandler(async () => {}),
        });
        await registerSlashCommands(
            { application: { commands: { set } } } as unknown as Client,
            registry,
            registry.getCommandNames()
        );
        expect(set).toHaveBeenCalledTimes(1);
        expect(
            set.mock.calls[0][0].map((d: { name: string }) => d.name)
        ).toEqual(['help']);
    });

    it('does not throw when registration fails', async () => {
        const set = vi.fn().mockRejectedValue(new Error('nope'));
        await expect(
            registerSlashCommands(
                { application: { commands: { set } } } as unknown as Client,
                makeRegistry({}),
                ['help']
            )
        ).resolves.toBeUndefined();
        await expect(
            registerSlashCommands(
                { application: null } as unknown as Client,
                makeRegistry({}),
                ['help']
            )
        ).resolves.toBeUndefined();
    });
});

describe('toInteractionOptions', () => {
    it('drops message-reply-only keys', () => {
        expect(toInteractionOptions('hi')).toBe('hi');
        expect(
            toInteractionOptions({
                content: 'x',
                failIfNotExists: false,
                allowedMentions: { repliedUser: false, users: ['u'] },
            })
        ).toEqual({ content: 'x', allowedMentions: { users: ['u'] } });
    });
});

describe('handleSlashCommand', () => {
    it('defers, then edits the reply first and follows up after', async () => {
        const replies: unknown[] = [];
        const handler = new FakeHandler(async (message) => {
            replies.push(await message.reply('one'));
            replies.push(
                await message.reply({
                    content: 'two',
                    allowedMentions: { repliedUser: false },
                })
            );
        });
        const { interaction, typed } = makeInteraction('stats');
        await handleSlashCommand(typed, makeRegistry({ stats: handler }));

        expect(interaction.deferReply).toHaveBeenCalledTimes(1);
        expect(interaction.editReply).toHaveBeenCalledWith('one');
        expect(interaction.followUp).toHaveBeenCalledWith({
            content: 'two',
            allowedMentions: {},
        });
        expect(replies).toEqual([{ id: 'edited' }, { id: 'followup' }]);
        expect(interaction.deleteReply).not.toHaveBeenCalled();
    });

    it('passes split args and the equivalent text invocation', async () => {
        const run = vi.fn().mockResolvedValue(undefined);
        const { typed } = makeInteraction('clean', '  10  -r  "a  b" ');
        await handleSlashCommand(
            typed,
            makeRegistry({ clean: new FakeHandler(run) })
        );

        const [message, command, args] = run.mock.calls[0];
        expect(command).toBe('clean');
        expect(args).toEqual(['10', '-r', '"a', 'b"']);
        expect(message.content).toBe(`${COMMAND_PREFIX}clean 10  -r  "a  b"`);
        expect(
            stripCommandInvocation(message.content, [COMMAND_PREFIX], ['clean'])
        ).toBe('10  -r  "a  b"');
        expect(message.inGuild()).toBe(true);
        expect(message.author.id).toBe('u');
        expect(message.guildId).toBe('g');
        expect(message.channelId).toBe('c');
        expect(message.id).toBe('999');
        expect(message.url).toBe('https://discord.com/channels/g/c');
        await expect(message.delete()).resolves.toBeDefined();
    });

    it('uses the bare invocation without args', async () => {
        const run = vi.fn().mockResolvedValue(undefined);
        const { typed } = makeInteraction('list');
        await handleSlashCommand(
            typed,
            makeRegistry({ list: new FakeHandler(run) })
        );
        expect(run.mock.calls[0][0].content).toBe(`${COMMAND_PREFIX}list`);
        expect(run.mock.calls[0][2]).toEqual([]);
    });

    it('deletes the deferred reply when the handler never replies', async () => {
        const { interaction, typed } = makeInteraction('clean', '5');
        await handleSlashCommand(
            typed,
            makeRegistry({ clean: new FakeHandler(async () => {}) })
        );
        expect(interaction.deleteReply).toHaveBeenCalledTimes(1);
        expect(interaction.editReply).not.toHaveBeenCalled();
    });

    it('answers unknown commands ephemerally without deferring', async () => {
        const { interaction, typed } = makeInteraction('gone');
        await handleSlashCommand(typed, makeRegistry({}));
        expect(interaction.deferReply).not.toHaveBeenCalled();
        const options = interaction.reply.mock.calls[0][0];
        expect(options.flags).toBe(MessageFlags.Ephemeral);
        expect(options.embeds[0].data.description).toContain('`gone`');
    });

    it('refuses interactions outside a cached guild', async () => {
        const run = vi.fn();
        const { interaction, typed } = makeInteraction('stats', null, {
            cached: false,
        });
        await handleSlashCommand(
            typed,
            makeRegistry({ stats: new FakeHandler(run) })
        );
        expect(run).not.toHaveBeenCalled();
        expect(interaction.reply.mock.calls[0][0].flags).toBe(
            MessageFlags.Ephemeral
        );
    });

    it('fetches an uncached channel', async () => {
        const run = vi.fn().mockResolvedValue(undefined);
        const fetched = { id: 'c', isTextBased: () => true };
        const { interaction, typed } = makeInteraction('stats', null, {
            channel: null as never,
        });
        interaction.guild.channels.fetch.mockResolvedValue(fetched);
        await handleSlashCommand(
            typed,
            makeRegistry({ stats: new FakeHandler(run) })
        );
        expect(run.mock.calls[0][0].channel).toBe(fetched);
    });

    it('shows an error embed when the handler throws', async () => {
        const { interaction, typed } = makeInteraction('stats');
        await handleSlashCommand(
            typed,
            makeRegistry({
                stats: new FakeHandler(async () => {
                    throw new Error('boom');
                }),
            })
        );
        const embed = interaction.editReply.mock.calls[0][0].embeds[0].data;
        expect(embed.color).toBe(EmbedColors.Error);
        expect(embed.description).toContain('`stats`');
        expect(interaction.deleteReply).not.toHaveBeenCalled();
    });

    it('follows up with the error when the handler already replied', async () => {
        const { interaction, typed } = makeInteraction('stats');
        await handleSlashCommand(
            typed,
            makeRegistry({
                stats: new FakeHandler(async (message) => {
                    await message.reply('partial');
                    throw new Error('boom');
                }),
            })
        );
        expect(interaction.editReply).toHaveBeenCalledWith('partial');
        const options = interaction.followUp.mock.calls[0][0];
        expect(options.flags).toBe(MessageFlags.Ephemeral);
        expect(options.embeds[0].data.color).toBe(EmbedColors.Error);
    });
});
