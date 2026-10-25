import { describe, expect, it, vi } from 'vitest';
import {
    parseCommandRolesArgs,
    renderCommandRoleLine,
    resolveRoleRefs,
    runCommandRolesAction,
    splitRoleRefs,
} from '../../src/commands/commandRolesCommand';
import { CommandRoleLimitError } from '../../src/services/commandRoles/CommandRoleService';

const ROLE_A = '111111111111111111';
const ROLE_B = '222222222222222222';
const roles = [
    { id: ROLE_A, name: 'Server Mods' },
    { id: ROLE_B, name: 'Helpers' },
];

describe('parseCommandRolesArgs', () => {
    it('shows everything without arguments', () => {
        expect(parseCommandRolesArgs([])).toEqual({ kind: 'show-all' });
    });

    it('shows one group, case-insensitively and by alias', () => {
        expect(parseCommandRolesArgs(['MOD'])).toEqual({
            kind: 'show',
            group: 'moderator',
        });
        expect(parseCommandRolesArgs(['map'])).toEqual({
            kind: 'show',
            group: 'identity',
        });
    });

    it('parses add, remove (rm), set and reset', () => {
        expect(
            parseCommandRolesArgs(['moderator', 'ADD', `<@&${ROLE_A}>`, ROLE_B])
        ).toEqual({
            kind: 'add',
            group: 'moderator',
            roleRefs: [`<@&${ROLE_A}>`, ROLE_B],
        });
        expect(parseCommandRolesArgs(['mods', 'rm', ROLE_A])).toMatchObject({
            kind: 'remove',
        });
        expect(parseCommandRolesArgs(['mods', 'set', ROLE_A])).toMatchObject({
            kind: 'set',
        });
        expect(parseCommandRolesArgs(['identity', 'reset'])).toEqual({
            kind: 'reset',
            group: 'identity',
        });
    });

    it('reports usage errors', () => {
        for (const args of [
            ['nope'],
            ['moderator', 'dance'],
            ['moderator', 'add'],
            ['moderator', 'reset', ROLE_A],
        ]) {
            const action = parseCommandRolesArgs(args);
            expect(action.kind).toBe('error');
            expect(action).toHaveProperty(
                'message',
                expect.stringContaining('Usage')
            );
        }
    });
});

describe('splitRoleRefs', () => {
    it('joins words of a name and splits on commas and mentions', () => {
        expect(
            splitRoleRefs(['Server', 'Mods,', 'Helpers', `<@&${ROLE_A}>`])
        ).toEqual(['Server Mods', 'Helpers', `<@&${ROLE_A}>`]);
    });
});

describe('resolveRoleRefs', () => {
    it('resolves mentions, IDs and case-insensitive names without duplicates', () => {
        expect(
            resolveRoleRefs(
                [`<@&${ROLE_A}>`, 'server mods', '@Helpers', ROLE_B],
                roles
            )
        ).toEqual({ roleIds: [ROLE_A, ROLE_B], unknown: [] });
    });

    it('reports unknown roles, keeping deleted IDs only when allowed', () => {
        const gone = '333333333333333333';
        expect(resolveRoleRefs([gone, 'Nobody'], roles)).toEqual({
            roleIds: [],
            unknown: [gone, 'Nobody'],
        });
        expect(
            resolveRoleRefs([gone], roles, { allowUnknownIds: true })
        ).toEqual({ roleIds: [gone], unknown: [] });
    });
});

describe('renderCommandRoleLine', () => {
    it('lists custom roles with the gated commands', () => {
        expect(
            renderCommandRoleLine('moderator', {
                roleIds: [ROLE_A, ROLE_B],
                custom: true,
            })
        ).toBe(`**moderator** (clean, history): <@&${ROLE_A}>, <@&${ROLE_B}>`);
    });

    it('marks config defaults and empty defaults', () => {
        expect(
            renderCommandRoleLine('identity', {
                roleIds: [ROLE_A],
                custom: false,
            })
        ).toBe(`**identity** (role, map): config default: <@&${ROLE_A}>`);
        expect(
            renderCommandRoleLine('identity', { roleIds: [], custom: false })
        ).toContain('nobody (config default is empty)');
    });
});

describe('runCommandRolesAction', () => {
    function setup(admin = true) {
        const settings = { roleIds: [ROLE_A], custom: true };
        const service = {
            getSettings: vi.fn(async () => settings),
            addRoles: vi.fn(async () => settings),
            removeRoles: vi.fn(async () => settings),
            setRoles: vi.fn(async () => settings),
            resetRoles: vi.fn(async () => settings),
        };
        const requireAdmin = vi.fn(async () => admin);
        const run = (
            args: string[],
            platform: 'fluxer' | 'discord' = 'fluxer'
        ) =>
            runCommandRolesAction(parseCommandRolesArgs(args), {
                service: service as never,
                platform,
                guildId: 'g1',
                requireAdmin,
                fetchRoles: async () => roles,
            });
        return { service, requireAdmin, run };
    }

    it('shows without needing Administrator; Discord only lists moderator', async () => {
        const { requireAdmin, run, service } = setup();
        const fluxer = await run([]);
        expect(fluxer?.description).toContain('**identity**');
        service.getSettings.mockClear();
        const discord = await run([], 'discord');
        expect(discord?.description).not.toContain('**identity**');
        expect(requireAdmin).not.toHaveBeenCalled();
    });

    it('rejects identity on Discord', async () => {
        const { run } = setup();
        expect((await run(['identity'], 'discord'))?.kind).toBe('error');
    });

    it('changes roles for administrators', async () => {
        const { run, service } = setup();
        const outcome = await run(['mod', 'add', 'Helpers']);
        expect(outcome?.kind).toBe('success');
        expect(service.addRoles).toHaveBeenCalledWith(
            'fluxer',
            'g1',
            'moderator',
            [ROLE_B]
        );
        await run(['mod', 'reset']);
        expect(service.resetRoles).toHaveBeenCalledWith(
            'fluxer',
            'g1',
            'moderator'
        );
    });

    it('does nothing when the author is no administrator', async () => {
        const { run, service } = setup(false);
        expect(await run(['mod', 'add', 'Helpers'])).toBeNull();
        expect(service.addRoles).not.toHaveBeenCalled();
    });

    it('rejects unknown roles and reports the limit', async () => {
        const { run, service } = setup();
        expect((await run(['mod', 'add', 'Ghosts']))?.kind).toBe('error');
        expect(service.addRoles).not.toHaveBeenCalled();
        service.addRoles.mockRejectedValueOnce(new CommandRoleLimitError('x'));
        const outcome = await run(['mod', 'add', 'Helpers']);
        expect(outcome?.kind).toBe('error');
        expect(outcome?.description).toContain('25');
    });
});
