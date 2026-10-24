import { describe, expect, it } from 'vitest';
import CommandRegistry from '../../src/commands/CommandRegistry';
import { parseCommandTrigger } from '../../src/commands/commandTrigger';

describe('CommandRegistry.getCommandNames', () => {
    it('lists every registered name, aliases included', () => {
        const registry = new CommandRegistry<never>();
        expect(registry.getCommandNames()).toEqual([]);
        registry.registerCommand('help', {} as never);
        registry.registerCommand('link', {} as never);

        expect(registry.getCommandNames()).toEqual(['help', 'link']);
    });

    it('drives the generic !<command> trigger: only registered names match', () => {
        const registry = new CommandRegistry<never>();
        registry.registerCommand('help', {} as never);
        registry.registerCommand('link', {} as never);
        const names = registry.getCommandNames();

        expect(parseCommandTrigger('!link 123', ['!'], names)).toEqual({
            command: 'link',
            rawArgs: '123',
        });
        expect(parseCommandTrigger('!Help', ['!'], names)?.command).toBe(
            'help'
        );
        expect(parseCommandTrigger('!foo bar', ['!'], names)).toBeNull();
        expect(parseCommandTrigger('!link 1', [], names)).toBeNull();
    });
});
