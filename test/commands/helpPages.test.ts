import { EmbedBuilder as DiscordEmbedBuilder } from 'discord.js';
import { EmbedBuilder as FluxerEmbedBuilder } from '@fluxerjs/core';
import { describe, expect, it } from 'vitest';
import { getCommandHelp, getHelpPages } from '../../src/commands/commandList';
import {
    batchEmbeds,
    EMBED_TOTAL_CHARS_MAX,
    embedCharCount,
} from '../../src/utils/embeds';

// Discord and Fluxer both reject embed descriptions longer than this.
const EMBED_DESCRIPTION_LIMIT = 4096;

describe('getHelpPages', () => {
    for (const platform of ['discord', 'fluxer'] as const) {
        describe(platform, () => {
            const pages = getHelpPages(platform);

            it('keeps every page within the embed description limit', () => {
                expect(pages.length).toBeGreaterThan(0);
                for (const page of pages) {
                    expect(page.length).toBeGreaterThan(0);
                    expect(page.length).toBeLessThanOrEqual(
                        EMBED_DESCRIPTION_LIMIT
                    );
                }
            });

            it('lists every command once, starting with the header and ending with the links', () => {
                const text = pages.join('\n');
                expect(pages[0].startsWith('**Available Commands:**')).toBe(
                    true
                );
                expect(pages[pages.length - 1]).toContain('[Privacy Policy]');
                for (const name of ['help', 'link', 'lines', 'stats']) {
                    expect(text).toContain(`\`!b ${name}`);
                }
                if (platform === 'fluxer') expect(text).toContain('`!b role');
            });

            it('shows one short summary per command instead of the full documentation', () => {
                expect(pages).toHaveLength(1);
                const text = pages[0];
                expect(text).toContain('`!b clean`: ');
                expect(text).not.toContain('-minage');
                expect(text).toContain('`!b help <command>`');
                const commandLines = text
                    .split('\n')
                    .filter((line) => line.startsWith('- `'));
                for (const line of commandLines) {
                    expect(line.length).toBeLessThanOrEqual(120);
                }
            });

            it('builds embeds that pass the builder checks and fit in messages', () => {
                const Builder =
                    platform === 'discord'
                        ? DiscordEmbedBuilder
                        : FluxerEmbedBuilder;
                const embeds = pages.map((page, i) =>
                    new Builder()
                        .setTitle(
                            i === 0
                                ? 'Bifröst Help'
                                : 'Bifröst Help (continued)'
                        )
                        .setDescription(page)
                );
                for (const batch of batchEmbeds(embeds)) {
                    const total = batch.reduce(
                        (sum, embed) => sum + embedCharCount(embed),
                        0
                    );
                    expect(total).toBeLessThanOrEqual(EMBED_TOTAL_CHARS_MAX);
                }
            });
        });
    }
});

describe('getCommandHelp', () => {
    it('shows usage, the full description and aliases', () => {
        const help = getCommandHelp('clean', 'discord');
        expect(help?.title).toBe('Help: !b clean');
        expect(help?.description).toContain(
            '**Usage:** `!b clean <num> [user]'
        );
        expect(help?.description).toContain('-minage');
        expect(help?.description).toContain('**Aliases:** `clear`, `cl`');
        expect(help!.description.length).toBeLessThanOrEqual(
            EMBED_DESCRIPTION_LIMIT
        );
    });

    it('resolves aliases, prefixes and case to the primary command', () => {
        for (const query of ['clear', '!clean', '/CL', '!b clean', ' Clean ']) {
            expect(getCommandHelp(query, 'fluxer')?.title).toBe(
                'Help: !b clean'
            );
        }
        expect(getCommandHelp('stonks', 'discord')?.title).toBe(
            'Help: !b fishtrade'
        );
    });

    it('returns undefined for unknown commands and other-platform-only ones', () => {
        expect(getCommandHelp('nope', 'discord')).toBeUndefined();
        expect(getCommandHelp('role', 'discord')).toBeUndefined();
        expect(getCommandHelp('role', 'fluxer')?.title).toBe('Help: !b role');
    });

    it('fits every command in an embed description', () => {
        for (const platform of ['discord', 'fluxer'] as const) {
            for (const name of ['help', 'history', 'fishtrade', 'voice']) {
                const help = getCommandHelp(name, platform);
                expect(help).toBeDefined();
                expect(help!.description.length).toBeLessThanOrEqual(
                    EMBED_DESCRIPTION_LIMIT
                );
            }
        }
    });
});
