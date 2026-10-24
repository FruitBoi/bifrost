import { describe, expect, it } from 'vitest';
import { Client } from 'discord.js';
import CommandRegistry from '../../../src/commands/CommandRegistry';
import DiscordCommandHandler from '../../../src/commands/discord/DiscordCommandHandler';
import {
    DISCORD_ALLOWED_COMMANDS,
    discordAllowedCommandNames,
    FLUXER_ONLY_REPLIES,
    pickFluxerOnlyReply,
} from '../../../src/commands/discord/fluxerOnly';
import { getDiscordCommandInfo } from '../../../src/commands/commandList';

const client = { user: { id: 'bot' } } as unknown as Client;

class FakeHandler extends DiscordCommandHandler {
    constructor() {
        super(client);
    }

    async handleCommand(): Promise<void> {}
}

describe('discordAllowedCommandNames', () => {
    it('allows the bridging and YAGPDB commands with their aliases', () => {
        const registry = new CommandRegistry<DiscordCommandHandler>();
        const clean = new FakeHandler();
        const history = new FakeHandler();
        const reminder = new FakeHandler();
        const help = new FakeHandler();
        const fishtrade = new FakeHandler();
        for (const name of ['clean', 'clear', 'cl']) {
            registry.registerCommand(name, clean);
        }
        for (const name of ['history', 'backfill']) {
            registry.registerCommand(name, history);
        }
        for (const name of ['reminder', 'reminders', 'delreminder']) {
            registry.registerCommand(name, reminder);
        }
        registry.registerCommand('link', new FakeHandler());
        registry.registerCommand('help', help);
        registry.registerCommand('fishtrade', fishtrade);
        registry.registerCommand('stonks', fishtrade);

        expect([...discordAllowedCommandNames(registry)].sort()).toEqual(
            [
                'backfill',
                'cl',
                'clean',
                'clear',
                'delreminder',
                'history',
                'link',
                'reminder',
                'reminders',
            ].sort()
        );
    });

    it('ignores allowed commands that are not registered', () => {
        const registry = new CommandRegistry<DiscordCommandHandler>();
        registry.registerCommand('lines', new FakeHandler());
        expect(discordAllowedCommandNames(registry).size).toBe(0);
    });

    it('leaves the threads directory to Fluxer', () => {
        expect(DISCORD_ALLOWED_COMMANDS).not.toContain('directory');
        expect(getDiscordCommandInfo('directory')).toBeUndefined();
        expect(getDiscordCommandInfo('lfg')).toBeUndefined();
    });

    it('only names documented Discord commands', () => {
        for (const name of DISCORD_ALLOWED_COMMANDS) {
            expect(getDiscordCommandInfo(name), name).toBeDefined();
        }
    });
});

describe('pickFluxerOnlyReply', () => {
    it('picks from the reply list', () => {
        expect(pickFluxerOnlyReply(() => 0)).toBe(FLUXER_ONLY_REPLIES[0]);
        expect(pickFluxerOnlyReply(() => 0.9999)).toBe(
            FLUXER_ONLY_REPLIES[FLUXER_ONLY_REPLIES.length - 1]
        );
        expect(FLUXER_ONLY_REPLIES).toContain(pickFluxerOnlyReply());
    });

    it('has a sizeable list of non-empty replies', () => {
        expect(FLUXER_ONLY_REPLIES.length).toBeGreaterThanOrEqual(10);
        for (const reply of FLUXER_ONLY_REPLIES) {
            expect(reply.trim().length).toBeGreaterThan(0);
            expect(reply.length).toBeLessThanOrEqual(2000);
        }
    });
});
