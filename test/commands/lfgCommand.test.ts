import { describe, expect, it, vi } from 'vitest';
import { Client, Message } from '@fluxerjs/core';
import {
    lfgRoleLine,
    parseLfgCommand,
    runLfgAction,
} from '../../src/commands/lfgCommand';
import LfgFluxerCommandHandler from '../../src/commands/fluxer/handlers/LfgFluxerCommandHandler';
import ThreadDirectoryService, {
    ThreadDirectoryError,
} from '../../src/services/threadDirectory/ThreadDirectoryService';
import { COMMAND_PREFIX } from '../../src/utils/env';
import { EmbedColors } from '../../src/utils/embeds';

vi.mock('../../src/utils/logging/logger', () => ({
    default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const T1 = '111111111111111111';
const R1 = '333333333333333333';
const R2 = '444444444444444444';

function parse(text: string) {
    const words = text.trim().split(/\s+/);
    return parseLfgCommand({
        content: `${COMMAND_PREFIX}${text}`,
        prefix: COMMAND_PREFIX,
        args: words.slice(1),
    });
}

const role = (roleId: string, description: string | null = null) => ({
    roleId,
    roleName: `name-${roleId}`,
    channelId: 'chan',
    threadId: T1,
    description,
});

describe('parseLfgCommand', () => {
    it('lists with no argument or list', () => {
        expect(parse('lfg')).toEqual({ kind: 'list' });
        expect(parse('lfg LIST')).toEqual({ kind: 'list' });
    });

    it('toggles by role or channel reference', () => {
        expect(parse(`lfg <@&${R1}>`)).toEqual({ kind: 'toggle', target: R1 });
        expect(parse(`lfg ${R1}`)).toEqual({ kind: 'toggle', target: R1 });
        expect(parse(`lfg <#${T1}>`)).toEqual({ kind: 'toggle', target: T1 });
        expect(
            parse(`lfg https://fluxer.app/channels/555555555555555555/${T1}`)
        ).toEqual({ kind: 'toggle', target: T1 });
    });

    it('toggles by name, spaces included', () => {
        expect(parse('lfg Data  Miners')).toEqual({
            kind: 'toggle',
            target: 'Data  Miners',
        });
        expect(parse('lfg gamers')).toEqual({
            kind: 'toggle',
            target: 'gamers',
        });
    });
});

describe('lfgRoleLine', () => {
    it('shows the role, the thread, the description and a check', () => {
        expect(lfgRoleLine(role(R1), false)).toBe(`<@&${R1}> — <#${T1}>`);
        expect(lfgRoleLine(role(R1, 'Tech\nstuff'), true)).toBe(
            `✅ <@&${R1}> — <#${T1}> (Tech stuff)`
        );
    });
});

describe('runLfgAction', () => {
    const service = (overrides: Record<string, unknown>) =>
        overrides as unknown as ThreadDirectoryService;

    it('lists the roles, marking the member ones', async () => {
        const svc = service({
            listLfgRoles: vi.fn().mockResolvedValue([role(R1), role(R2)]),
            memberLfgRoleIds: vi.fn().mockResolvedValue([R2]),
        });
        const result = await runLfgAction(svc, 'fluxer', 'g', 'u', {
            kind: 'list',
        });
        expect(result).toMatchObject({
            list: true,
            lines: [`<@&${R1}> — <#${T1}>`, `✅ <@&${R2}> — <#${T1}>`],
        });
        expect((result as { header: string }).header).toContain('lfg <role>');
    });

    it('says when there are no roles', async () => {
        const svc = service({
            listLfgRoles: vi.fn().mockResolvedValue([]),
            memberLfgRoleIds: vi.fn().mockResolvedValue([]),
        });
        const result = await runLfgAction(svc, 'fluxer', 'g', 'u', {
            kind: 'list',
        });
        expect((result as { description: string }).description).toContain(
            'directory role'
        );
    });

    it('gives and removes roles', async () => {
        const toggleLfgRole = vi
            .fn()
            .mockResolvedValueOnce({ role: { id: R1, name: 'r' }, added: true })
            .mockResolvedValueOnce({
                role: { id: R1, name: 'r' },
                added: false,
            });
        const svc = service({ toggleLfgRole });
        const action = { kind: 'toggle', target: 'r' } as const;
        const given = await runLfgAction(svc, 'fluxer', 'g', 'u', action);
        expect(toggleLfgRole).toHaveBeenCalledWith('fluxer', 'g', 'u', 'r');
        expect(given).toEqual({
            description: `Gave you <@&${R1}>.`,
            color: EmbedColors.Success,
        });
        const removed = await runLfgAction(svc, 'fluxer', 'g', 'u', action);
        expect((removed as { description: string }).description).toBe(
            `Removed <@&${R1}> from you.`
        );
    });

    it('maps errors to friendly messages', async () => {
        const svc = service({
            toggleLfgRole: vi
                .fn()
                .mockRejectedValueOnce(
                    new ThreadDirectoryError('not_lfg_role', 'x')
                )
                .mockRejectedValueOnce(new Error('boom')),
        });
        const action = { kind: 'toggle', target: 'x' } as const;
        const friendly = await runLfgAction(svc, 'fluxer', 'g', 'u', action);
        expect(friendly).toMatchObject({ color: EmbedColors.Error });
        expect((friendly as { description: string }).description).toContain(
            'not an LFG role'
        );
        const generic = await runLfgAction(svc, 'fluxer', 'g', 'u', action);
        expect((generic as { description: string }).description).toContain(
            'Something went wrong'
        );
    });
});

describe('LfgFluxerCommandHandler', () => {
    function setup(guildId: string | null = 'guild') {
        const reply = vi.fn().mockResolvedValue(undefined);
        const message = {
            content: `${COMMAND_PREFIX}lfg gamers`,
            channelId: 'chan',
            guildId,
            author: { id: 'a', username: 'u', bot: false },
            reply,
            send: vi.fn(),
        } as unknown as Message;
        const svc = {
            toggleLfgRole: vi.fn().mockResolvedValue({
                role: { id: R1, name: 'r' },
                added: true,
            }),
            listLfgRoles: vi.fn().mockResolvedValue([role(R1)]),
            memberLfgRoleIds: vi.fn().mockResolvedValue([]),
        };
        const handler = new LfgFluxerCommandHandler(
            { user: { id: 'bot' } } as unknown as Client,
            svc as unknown as ThreadDirectoryService
        );
        return { handler, message, reply, svc };
    }

    it('toggles the named role for the author', async () => {
        const t = setup();
        await t.handler.handleCommand(t.message, 'lfg', 'gamers');
        expect(t.svc.toggleLfgRole).toHaveBeenCalledWith(
            'fluxer',
            'guild',
            'a',
            'gamers'
        );
        expect(t.reply.mock.calls[0][0].embeds[0].toJSON().description).toBe(
            `Gave you <@&${R1}>.`
        );
    });

    it('lists the roles across embeds', async () => {
        const t = setup();
        t.message.content = `${COMMAND_PREFIX}lfg`;
        await t.handler.handleCommand(t.message, 'lfg');
        const embeds = t.reply.mock.calls[0][0].embeds;
        expect(embeds).toHaveLength(2);
        expect(embeds[1].toJSON().description).toContain(`<@&${R1}>`);
    });

    it('needs a server', async () => {
        const t = setup(null);
        await t.handler.handleCommand(t.message, 'lfg', 'gamers');
        expect(t.svc.toggleLfgRole).not.toHaveBeenCalled();
        expect(t.reply).toHaveBeenCalledTimes(1);
    });
});
