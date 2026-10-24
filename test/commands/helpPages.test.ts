import { EmbedBuilder as DiscordEmbedBuilder } from 'discord.js';
import { EmbedBuilder as FluxerEmbedBuilder } from '@fluxerjs/core';
import { describe, expect, it } from 'vitest';
import { getHelpPages } from '../../src/commands/commandList';
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
