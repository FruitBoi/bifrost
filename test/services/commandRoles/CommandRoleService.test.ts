import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MessagePlatform } from '../../../src/db/entities/MessageLink';
import { CommandRoleRepository } from '../../../src/db/repositories/CommandRoleRepository';
import CommandRoleService, {
    COMMAND_ROLE_GROUPS,
    CommandRoleGroup,
    CommandRoleLimitError,
    MAX_ROLES_PER_GROUP,
} from '../../../src/services/commandRoles/CommandRoleService';
import logger from '../../../src/utils/logging/logger';

vi.mock('../../../src/utils/logging/logger', () => ({
    default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/** In-memory CommandRoleRepository with the same semantics as the table. */
class MemoryCommandRoleRepository implements CommandRoleRepository {
    rows = new Map<string, Set<string>>();

    private set(platform: string, guildId: string, group: string) {
        const key = JSON.stringify([platform, guildId, group]);
        let set = this.rows.get(key);
        if (!set) this.rows.set(key, (set = new Set()));
        return set;
    }

    list = vi.fn(
        async (platform: MessagePlatform, guildId: string, group: string) =>
            [...this.set(platform, guildId, group)].sort()
    );

    add = vi.fn(
        async (
            platform: MessagePlatform,
            guildId: string,
            group: string,
            roleIds: readonly string[]
        ) => {
            for (const id of roleIds)
                this.set(platform, guildId, group).add(id);
        }
    );

    remove = vi.fn(
        async (
            platform: MessagePlatform,
            guildId: string,
            group: string,
            roleIds: readonly string[]
        ) => {
            for (const id of roleIds)
                this.set(platform, guildId, group).delete(id);
        }
    );

    replace = vi.fn(
        async (
            platform: MessagePlatform,
            guildId: string,
            group: string,
            roleIds: readonly string[]
        ) => {
            const set = this.set(platform, guildId, group);
            set.clear();
            for (const id of roleIds) set.add(id);
        }
    );
}

const defaults: Record<CommandRoleGroup, readonly string[]> = {
    moderator: ['mod-default'],
    identity: ['id-default-1', 'id-default-2'],
};

let repo: MemoryCommandRoleRepository;
let service: CommandRoleService;

beforeEach(() => {
    vi.clearAllMocks();
    repo = new MemoryCommandRoleRepository();
    service = new CommandRoleService(repo, defaults);
});

describe('CommandRoleService', () => {
    it('exposes both groups', () => {
        expect(COMMAND_ROLE_GROUPS).toEqual(['moderator', 'identity']);
        expect(MAX_ROLES_PER_GROUP).toBe(25);
    });

    it('falls back to the config defaults when the server has no list', async () => {
        expect(await service.getRoleIds('discord', 'g1', 'moderator')).toEqual([
            'mod-default',
        ]);
        expect(await service.getSettings('fluxer', 'g1', 'identity')).toEqual({
            roleIds: ['id-default-1', 'id-default-2'],
            custom: false,
        });
    });

    it('uses a custom list instead of the defaults', async () => {
        await repo.add('discord', 'g1', 'moderator', ['r2', 'r1']);
        expect(await service.getSettings('discord', 'g1', 'moderator')).toEqual(
            { roleIds: ['r1', 'r2'], custom: true }
        );
        // The other group of the same server still uses its defaults.
        expect(await service.getRoleIds('discord', 'g1', 'identity')).toEqual(
            defaults.identity
        );
    });

    it('starts a fresh list on the first add instead of copying the defaults', async () => {
        const settings = await service.addRoles('discord', 'g1', 'moderator', [
            'r1',
        ]);
        expect(settings).toEqual({ roleIds: ['r1'], custom: true });
        expect(await service.getRoleIds('discord', 'g1', 'moderator')).toEqual([
            'r1',
        ]);
    });

    it('dedupes and trims role IDs, ignoring already stored ones', async () => {
        await service.addRoles('discord', 'g1', 'moderator', [
            'r1',
            ' r1 ',
            '',
        ]);
        const settings = await service.addRoles('discord', 'g1', 'moderator', [
            'r1',
            'r2',
            'r2',
        ]);
        expect(settings.roleIds).toEqual(['r1', 'r2']);
        expect(repo.add).toHaveBeenLastCalledWith(
            'discord',
            'g1',
            'moderator',
            ['r2']
        );
        expect(
            (await service.setRoles('discord', 'g1', 'moderator', ['r3', 'r3']))
                .roleIds
        ).toEqual(['r3']);
    });

    it('reverts to the defaults when the last role is removed', async () => {
        await service.addRoles('fluxer', 'g1', 'identity', ['r1', 'r2']);
        expect(
            await service.removeRoles('fluxer', 'g1', 'identity', ['r1'])
        ).toEqual({ roleIds: ['r2'], custom: true });
        expect(
            await service.removeRoles('fluxer', 'g1', 'identity', [
                'r2',
                'unknown',
            ])
        ).toEqual({ roleIds: defaults.identity, custom: false });
        expect(await service.getRoleIds('fluxer', 'g1', 'identity')).toEqual(
            defaults.identity
        );
    });

    it('replaces the list with setRoles and resets it', async () => {
        await service.addRoles('discord', 'g1', 'moderator', ['r1']);
        expect(
            await service.setRoles('discord', 'g1', 'moderator', ['r2', 'r3'])
        ).toEqual({ roleIds: ['r2', 'r3'], custom: true });
        expect(await service.resetRoles('discord', 'g1', 'moderator')).toEqual({
            roleIds: defaults.moderator,
            custom: false,
        });
        expect(
            await service.setRoles('discord', 'g1', 'moderator', ['r4'])
        ).toEqual({ roleIds: ['r4'], custom: true });
        expect(
            await service.setRoles('discord', 'g1', 'moderator', [])
        ).toEqual({ roleIds: defaults.moderator, custom: false });
    });

    it('enforces the per-group limit without writing', async () => {
        const ids = (n: number, prefix = 'r') =>
            Array.from({ length: n }, (_, i) => `${prefix}${i}`);
        await service.setRoles('discord', 'g1', 'moderator', ids(25));
        repo.add.mockClear();

        await expect(
            service.addRoles('discord', 'g1', 'moderator', ['extra'])
        ).rejects.toBeInstanceOf(CommandRoleLimitError);
        expect(repo.add).not.toHaveBeenCalled();
        // Re-adding stored roles does not count against the limit.
        expect(
            (await service.addRoles('discord', 'g1', 'moderator', ['r0']))
                .roleIds
        ).toHaveLength(25);

        repo.replace.mockClear();
        await expect(
            service.setRoles('discord', 'g1', 'moderator', ids(26, 'x'))
        ).rejects.toBeInstanceOf(CommandRoleLimitError);
        expect(repo.replace).not.toHaveBeenCalled();
        // Duplicates do not count either.
        await expect(
            service.setRoles('discord', 'g1', 'moderator', [
                ...ids(25, 'x'),
                'x0',
            ])
        ).resolves.toMatchObject({ custom: true });
        expect(
            await service.getRoleIds('discord', 'g1', 'moderator')
        ).toHaveLength(25);
    });

    it('falls back to the defaults and logs when the database fails', async () => {
        repo.list.mockRejectedValueOnce(new Error('db down'));
        expect(await service.getRoleIds('discord', 'g1', 'moderator')).toEqual(
            defaults.moderator
        );
        expect(logger.warn).toHaveBeenCalledTimes(1);

        // A failed lookup is not cached: the next call reads the database.
        await repo.add('discord', 'g1', 'moderator', ['r1']);
        expect(await service.getRoleIds('discord', 'g1', 'moderator')).toEqual([
            'r1',
        ]);

        // getSettings (used by the admin command) reports the failure.
        service = new CommandRoleService(repo, defaults);
        repo.list.mockRejectedValueOnce(new Error('db down'));
        await expect(
            service.getSettings('discord', 'g1', 'moderator')
        ).rejects.toThrow('db down');
    });

    it('caches lookups and invalidates them on writes', async () => {
        await service.getRoleIds('discord', 'g1', 'moderator');
        await service.getRoleIds('discord', 'g1', 'moderator');
        await service.resolver('discord', 'moderator')('g1');
        expect(repo.list).toHaveBeenCalledTimes(1);

        await service.addRoles('discord', 'g1', 'moderator', ['r1']);
        expect(await service.getRoleIds('discord', 'g1', 'moderator')).toEqual([
            'r1',
        ]);
        await service.removeRoles('discord', 'g1', 'moderator', ['r1']);
        expect(await service.getRoleIds('discord', 'g1', 'moderator')).toEqual(
            defaults.moderator
        );
    });

    it('drops the cache entry even when a write fails', async () => {
        await service.getRoleIds('discord', 'g1', 'moderator');
        repo.replace.mockImplementationOnce(async (p, g, grp, ids) => {
            await repo.add(p, g, grp, ids);
            throw new Error('partial write');
        });
        await expect(
            service.setRoles('discord', 'g1', 'moderator', ['r1'])
        ).rejects.toThrow('partial write');
        expect(await service.getRoleIds('discord', 'g1', 'moderator')).toEqual([
            'r1',
        ]);
    });

    it('keeps platforms, guilds and groups apart', async () => {
        await service.addRoles('discord', 'g1', 'moderator', ['d1']);
        await service.addRoles('fluxer', 'g1', 'moderator', ['f1']);
        await service.addRoles('discord', 'g2', 'identity', ['d2']);

        const discordMod = service.resolver('discord', 'moderator');
        expect(await discordMod('g1')).toEqual(['d1']);
        expect(await discordMod('g2')).toEqual(defaults.moderator);
        expect(await service.resolver('fluxer', 'moderator')('g1')).toEqual([
            'f1',
        ]);
        expect(await service.getRoleIds('discord', 'g2', 'identity')).toEqual([
            'd2',
        ]);
        expect(await service.getRoleIds('fluxer', 'g2', 'identity')).toEqual(
            defaults.identity
        );

        await service.resetRoles('discord', 'g1', 'moderator');
        expect(await service.resolver('fluxer', 'moderator')('g1')).toEqual([
            'f1',
        ]);
    });
});
