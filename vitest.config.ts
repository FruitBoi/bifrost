import fs from 'fs';
import os from 'os';
import path from 'path';
import { defineConfig } from 'vitest/config';

// The bot's env module exits without tokens and the logger/sqlite modules
// write under BF_CONFIG_PATH, so tests get dummy tokens and a fresh temp dir.
const configPath = fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-vitest-'));

export default defineConfig({
    test: {
        include: ['test/**/*.test.ts'],
        env: {
            BF_FLUXER_TOKEN: 'test-token',
            BF_DISCORD_TOKEN: 'test-token',
            BF_CONFIG_PATH: configPath,
            NODE_ENV: 'test',
        },
        // The bridge logs expected failures in error-path tests; keep output readable.
        silent: 'passed-only',
        testTimeout: 30_000,
        hookTimeout: 60_000,
    },
});
