import { describe, expect, it, vi } from 'vitest';
import { Client } from 'discord.js';
import { DiscordCommandHandlerMessage } from '../../../src/commands/discord/DiscordCommandHandler';
import LinesDiscordCommandHandler from '../../../src/commands/discord/handlers/LinesDiscordCommandHandler';
import ClaudeLinesService, {
    ClaudeLinesResult,
} from '../../../src/services/claudeLines/ClaudeLinesService';
import { EmbedColors } from '../../../src/utils/embeds';

const client = { user: { id: 'bot' } } as unknown as Client;

function makeMessage(bot = false, inGuild = true) {
    const reply = vi.fn().mockResolvedValue(undefined);
    const message = {
        id: '1',
        content: '!b lines',
        guildId: inGuild ? 'g' : null,
        author: { id: 'a', bot, username: 'a' },
        guild: inGuild ? { id: 'g', name: 'G' } : null,
        inGuild: () => inGuild,
        reply,
    };
    return {
        message: message as unknown as DiscordCommandHandlerMessage,
        reply,
    };
}

const okResult: ClaudeLinesResult = {
    ok: true,
    stats: {
        repo: 'o/r',
        commits: 2,
        additions: 100,
        deletions: 40,
        totalCommits: 4,
        totalAdditions: 400,
        firstCommitAt: '2026-01-01T00:00:00Z',
        latest: null,
        biggest: null,
        truncated: false,
        fetchedAt: 0,
    },
};

function makeService(result: ClaudeLinesResult = okResult, configured = true) {
    const getStats = vi.fn().mockResolvedValue(result);
    const service = {
        isConfigured: () => configured,
        getStats,
    } as unknown as ClaudeLinesService;
    return { service, getStats };
}

function embed(reply: ReturnType<typeof vi.fn>) {
    expect(reply).toHaveBeenCalledTimes(1);
    return reply.mock.calls[0][0].embeds[0].data as {
        title?: string;
        description?: string;
        color?: number;
        fields?: { name: string; value: string }[];
    };
}

describe('LinesDiscordCommandHandler', () => {
    it('rejects bots', async () => {
        const { service, getStats } = makeService();
        const { message, reply } = makeMessage(true);
        await new LinesDiscordCommandHandler(client, service).handleCommand(
            message,
            'lines'
        );
        expect(embed(reply).color).toBe(EmbedColors.Error);
        expect(getStats).not.toHaveBeenCalled();
    });

    it('reports a missing GitHub token', async () => {
        const { service, getStats } = makeService(okResult, false);
        const { message, reply } = makeMessage();
        await new LinesDiscordCommandHandler(client, service).handleCommand(
            message,
            'lines'
        );
        expect(embed(reply).description).toBe(
            'The lines counter is not configured on this bot (BF_GITHUB_TOKEN is not set).'
        );
        expect(getStats).not.toHaveBeenCalled();
    });

    it('replies with the stats embed, also in DMs', async () => {
        const { service } = makeService();
        const { message, reply } = makeMessage(false, false);
        await new LinesDiscordCommandHandler(client, service).handleCommand(
            message,
            'lines'
        );
        const e = embed(reply);
        expect(e.color).toBe(EmbedColors.Info);
        expect(e.title).toBe('🤖 Lines of code written by Claude');
        expect(e.description).toContain('**100**');
        expect(e.fields?.find((f) => f.name === 'Net')?.value).toBe('+60');
    });

    it('explains a GitHub error', async () => {
        const { service } = makeService({
            ok: false,
            reason: 'github_error',
            detail: 'Bad credentials',
        });
        const { message, reply } = makeMessage();
        await new LinesDiscordCommandHandler(client, service).handleCommand(
            message,
            'lines'
        );
        const e = embed(reply);
        expect(e.color).toBe(EmbedColors.Error);
        expect(e.description).toBe(
            'Could not fetch the commit history from GitHub: Bad credentials'
        );
    });

    it('reports a throwing service', async () => {
        const { service, getStats } = makeService();
        getStats.mockRejectedValue(new Error('boom'));
        const { message, reply } = makeMessage();
        await new LinesDiscordCommandHandler(client, service).handleCommand(
            message,
            'lines'
        );
        expect(embed(reply).description).toContain('boom');
    });
});
