import { describe, expect, it } from 'vitest';
import {
    describeRoleIconPlan,
    formatRoleIconTransferReport,
    parseRoleIconsArgs,
    ROLE_ICONS_COMMAND_NAMES,
} from '../../../src/services/roleIconTransfer/roleIconsCommand';
import {
    DESCRIPTION_MAX,
    MAX_LISTED,
} from '../../../src/services/expressionTransfer/expressionsCommand';
import { RoleIconTransferReport } from '../../../src/services/roleIconTransfer/RoleIconTransferService';
import { EmbedColors } from '../../../src/utils/embeds';

function report(
    partial: Partial<RoleIconTransferReport> = {}
): RoleIconTransferReport {
    return { copied: [], skipped: [], failed: [], ...partial };
}

const names = (prefix: string, count: number) =>
    Array.from({ length: count }, (_, i) => `${prefix}${i + 1}`);

describe('ROLE_ICONS_COMMAND_NAMES', () => {
    it('covers the command and its aliases', () => {
        expect(ROLE_ICONS_COMMAND_NAMES).toEqual([
            'roleicons',
            'roleemotes',
            'roleemojis',
        ]);
    });
});

describe('parseRoleIconsArgs', () => {
    it('keeps existing icons without an argument', () => {
        expect(parseRoleIconsArgs([])).toEqual({ ok: true, overwrite: false });
    });

    it.each([['overwrite'], ['OVERWRITE'], ['Overwrite']])(
        'overwrites for %s',
        (arg) => {
            expect(parseRoleIconsArgs([arg])).toEqual({
                ok: true,
                overwrite: true,
            });
        }
    );

    it.each([[['force']], [['overwrite', 'now']], [['']]])(
        'rejects %j',
        (args) => {
            expect(parseRoleIconsArgs(args)).toEqual({ ok: false });
        }
    );
});

describe('describeRoleIconPlan', () => {
    it('is silent when there is nothing to update', () => {
        expect(describeRoleIconPlan({ roles: 0 })).toBeNull();
    });

    it('counts the roles about to be updated', () => {
        expect(describeRoleIconPlan({ roles: 1 })).toBe(
            'Setting 1 role icon on the Fluxer server… this can take a while.'
        );
        expect(describeRoleIconPlan({ roles: 3 })).toContain('3 role icons');
    });
});

describe('formatRoleIconTransferReport', () => {
    it('is green when everything was copied', () => {
        const formatted = formatRoleIconTransferReport(
            report({ copied: ['Mods', 'Artists'] })
        );
        expect(formatted).toEqual({
            title: 'Role icon transfer',
            description:
                'Set 2 role icons on the Fluxer server.\n\n- Copied: `Mods`, `Artists`',
            color: EmbedColors.Success,
        });
    });

    it('is yellow when some roles failed', () => {
        const formatted = formatRoleIconTransferReport(
            report({
                copied: ['A'],
                failed: [{ name: 'B', reason: 'Missing Permissions' }],
            })
        );
        expect(formatted.color).toBe(EmbedColors.Warning);
        expect(formatted.description).toBe(
            'Set 1 role icon on the Fluxer server; 1 failed.\n\n' +
                '- Copied: `A`\n' +
                '- Failed: `B` (Missing Permissions)'
        );
    });

    it('is red when everything attempted failed', () => {
        const formatted = formatRoleIconTransferReport(
            report({ failed: [{ name: 'B', reason: 'boom' }] })
        );
        expect(formatted.color).toBe(EmbedColors.Error);
        expect(formatted.description).toMatch(
            /^Could not set 1 role icon on the Fluxer server\./
        );
    });

    it('groups skipped roles by reason', () => {
        const formatted = formatRoleIconTransferReport(
            report({
                skipped: [
                    { name: 'A', reason: 'no Fluxer role with this name' },
                    { name: 'B', reason: 'already set' },
                    { name: 'C', reason: 'no Fluxer role with this name' },
                ],
            })
        );
        expect(formatted.color).toBe(EmbedColors.Info);
        expect(formatted.description).toBe(
            'Nothing to copy: every role icon of the Discord server was skipped.\n\n' +
                '- Skipped (no Fluxer role with this name): `A`, `C`\n' +
                '- Skipped (already set): `B`'
        );
    });

    it('says so when no Discord role has an icon', () => {
        expect(formatRoleIconTransferReport(report())).toEqual({
            title: 'Role icon transfer',
            description:
                'Nothing to copy: no role on the Discord server has an icon.',
            color: EmbedColors.Info,
        });
    });

    it('caps long name lists', () => {
        const copied = names('role', MAX_LISTED + 5);
        const { description } = formatRoleIconTransferReport(
            report({ copied })
        );
        expect(description).toContain(`\`role${MAX_LISTED}\` +5 more`);
        expect(description).not.toContain(`\`role${MAX_LISTED + 1}\``);
    });

    it('never exceeds the description limit', () => {
        const long = 'x'.repeat(90);
        const { description } = formatRoleIconTransferReport(
            report({
                skipped: names(long, 100).map((name, i) => ({
                    name,
                    reason: `reason ${i}`,
                })),
            })
        );
        expect(description.length).toBeLessThanOrEqual(DESCRIPTION_MAX);
        expect(description.endsWith('…')).toBe(true);
    });
});
