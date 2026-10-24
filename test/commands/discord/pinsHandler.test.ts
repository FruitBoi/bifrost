import { describe, expect, it, vi } from 'vitest';
import { Client } from 'discord.js';
import PinsDiscordCommandHandler from '../../../src/commands/discord/handlers/PinsDiscordCommandHandler';
import { DiscordCommandHandlerMessage } from '../../../src/commands/discord/DiscordCommandHandler';
import { LinkService } from '../../../src/services/LinkService';
import PinBridgeService, {
    PinSyncError,
    PinSyncResult,
} from '../../../src/services/pinBridge/PinBridgeService';
import { EmbedColors } from '../../../src/utils/embeds';
import { makeChannelLink } from '../../helpers/fakes';

vi.mock('../../../src/utils/logging/logger', () => ({
    default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const client = { user: { id: 'bot' } } as unknown as Client;

const EMPTY: PinSyncResult = {
    pinnedOnDiscord: 0,
    pinnedOnFluxer: 0,
    copiedToDiscord: 0,
    copiedToFluxer: 0,
    alreadyInSync: 0,
    failed: 0,
};

function setup(
    options: {
        inGuild?: boolean;
        canManage?: boolean;
        link?: ReturnType<typeof makeChannelLink> | null;
        sync?: () => Promise<PinSyncResult>;
    } = {}
) {
    const {
        inGuild = true,
        canManage = true,
        link = makeChannelLink(),
        sync = async () => EMPTY,
    } = options;
    const member = { permissions: { has: vi.fn().mockReturnValue(canManage) } };
    const reply = vi.fn().mockResolvedValue(undefined);
    const message = {
        content: '?pins sync',
        channelId: 'chan-1',
        author: {
            id: 'author',
            username: 'tester',
            displayAvatarURL: () => '',
        },
        inGuild: () => inGuild,
        guild: { members: { fetch: vi.fn().mockResolvedValue(member) } },
        reply,
    } as unknown as DiscordCommandHandlerMessage;
    const linkService = {
        getChannelLinkByDiscordLocation: vi.fn().mockResolvedValue(link),
    };
    const pinBridge = { syncPastPins: vi.fn(sync) };
    const handler = new PinsDiscordCommandHandler(
        client,
        linkService as unknown as LinkService,
        pinBridge as unknown as PinBridgeService
    );
    return { handler, message, reply, linkService, pinBridge, link };
}

/** The embed description and colour of the n-th reply. */
function embedOf(reply: ReturnType<typeof vi.fn>, n: number) {
    const embed = reply.mock.calls[n][0].embeds[0].toJSON();
    return { text: embed.description as string, color: embed.color as number };
}

describe('PinsDiscordCommandHandler', () => {
    it.each([[[]], [['bogus']], [['sync', 'extra']]])(
        'replies with usage for args %j',
        async (args: string[]) => {
            const t = setup();
            await t.handler.handleCommand(t.message, 'pins', ...args);
            expect(t.reply).toHaveBeenCalledTimes(1);
            expect(embedOf(t.reply, 0).text).toContain('pins sync');
            expect(t.pinBridge.syncPastPins).not.toHaveBeenCalled();
        }
    );

    it('rejects use outside a server', async () => {
        const t = setup({ inGuild: false });
        await t.handler.handleCommand(t.message, 'pins', 'sync');
        expect(embedOf(t.reply, 0).text).toContain('must be used in a server');
        expect(t.pinBridge.syncPastPins).not.toHaveBeenCalled();
    });

    it('rejects an unlinked channel', async () => {
        const t = setup({ link: null });
        await t.handler.handleCommand(t.message, 'pins', 'sync');
        expect(embedOf(t.reply, 0).text).toContain('not linked');
        expect(embedOf(t.reply, 0).color).toBe(EmbedColors.Error);
        expect(t.pinBridge.syncPastPins).not.toHaveBeenCalled();
    });

    it('denies users without Manage Messages', async () => {
        const t = setup({ canManage: false });
        await t.handler.handleCommand(t.message, 'pins', 'sync');
        expect(embedOf(t.reply, 0).text).toContain('Manage Messages');
        expect(t.pinBridge.syncPastPins).not.toHaveBeenCalled();
    });

    it('syncs and summarises non-zero counters', async () => {
        const t = setup({
            sync: async () => ({
                ...EMPTY,
                pinnedOnFluxer: 2,
                copiedToDiscord: 1,
            }),
        });
        await t.handler.handleCommand(t.message, 'pins', 'SYNC');
        expect(t.pinBridge.syncPastPins).toHaveBeenCalledWith(t.link);
        expect(embedOf(t.reply, 0).text).toContain('Syncing pinned messages');
        expect(embedOf(t.reply, 0).color).toBe(EmbedColors.Info);
        const done = embedOf(t.reply, 1);
        expect(done.color).toBe(EmbedColors.Success);
        expect(done.text).toContain('Pinned on Fluxer: **2**');
        expect(done.text).toContain('Copied to Discord: **1**');
        expect(done.text).not.toContain('Failed');
    });

    it('says pins were already in sync when nothing happened', async () => {
        const t = setup();
        await t.handler.handleCommand(t.message, 'pins', 'sync');
        expect(embedOf(t.reply, 1).text).toBe('Pins were already in sync.');
    });

    it('uses the warning colour when some pins failed', async () => {
        const t = setup({ sync: async () => ({ ...EMPTY, failed: 3 }) });
        await t.handler.handleCommand(t.message, 'pins', 'sync');
        expect(embedOf(t.reply, 1).color).toBe(EmbedColors.Warning);
        expect(embedOf(t.reply, 1).text).toContain('Failed: **3**');
    });

    it('reports an already running sync', async () => {
        const t = setup({
            sync: async () => {
                throw new PinSyncError('already_running', 'busy');
            },
        });
        await t.handler.handleCommand(t.message, 'pins', 'sync');
        expect(embedOf(t.reply, 1).text).toBe(
            'A pin sync for this channel is already running.'
        );
        expect(embedOf(t.reply, 1).color).toBe(EmbedColors.Error);
    });

    it('reports a generic error', async () => {
        const t = setup({
            sync: async () => {
                throw new Error('boom');
            },
        });
        await t.handler.handleCommand(t.message, 'pins', 'sync');
        expect(embedOf(t.reply, 1).text).toContain('boom');
        expect(embedOf(t.reply, 1).color).toBe(EmbedColors.Error);
    });
});
