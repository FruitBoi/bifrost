import { afterEach, describe, expect, it, vi } from 'vitest';
import { transports } from 'winston';
import logger, { serializeLogValue } from '../../src/utils/logging/logger';

/** Shaped like FluxerAPIError from @fluxerjs/rest, without importing it. */
class FakeFluxerAPIError extends Error {
    readonly code = 'INVALID_FORM_BODY';
    readonly statusCode = 400;
    readonly method = 'POST';
    readonly path = '/channels/123/messages';
    readonly errors = [
        {
            path: 'embeds',
            code: 'BASE_TYPE_MAX_LENGTH',
            message: 'Embeds must be 6000 or fewer in total length',
        },
    ];
    readonly rawBody = {
        code: 'INVALID_FORM_BODY',
        message: 'Invalid form body.',
        errors: this.errors,
    };

    constructor() {
        super('Invalid form body.');
        this.name = 'FluxerAPIError';
    }
}

describe('serializeLogValue', () => {
    it('returns just the stack for a plain Error', () => {
        const err = new Error('boom');
        expect(serializeLogValue(err)).toBe(err.stack);
    });

    it('appends the structured detail of an API error after the stack', () => {
        const err = new FakeFluxerAPIError();
        const out = serializeLogValue(err);

        expect(out.startsWith(err.stack as string)).toBe(true);
        const detail = JSON.parse(out.slice((err.stack as string).length + 1));
        expect(detail).toEqual({
            code: 'INVALID_FORM_BODY',
            statusCode: 400,
            method: 'POST',
            path: '/channels/123/messages',
            errors: err.errors,
            rawBody: err.rawBody,
        });
    });

    it('includes discord.js-style status/url/rawError fields', () => {
        const err = Object.assign(new Error('Missing Access'), {
            code: 50001,
            status: 403,
            method: 'GET',
            url: 'https://discord.com/api/v10/channels/1',
            rawError: { message: 'Missing Access', code: 50001 },
        });

        expect(serializeLogValue(err)).toContain('"rawError": {');
        expect(serializeLogValue(err)).toContain('"status": 403');
    });

    it('prints a value shared between fields in both places', () => {
        const err = new FakeFluxerAPIError();
        const out = serializeLogValue(err);
        expect(out).not.toContain('[Circular]');
        expect(out.split('BASE_TYPE_MAX_LENGTH')).toHaveLength(3);
    });

    it('survives cycles in the detail', () => {
        const rawError: Record<string, unknown> = { message: 'x' };
        rawError.self = rawError;
        const err = Object.assign(new Error('cyclic'), { rawError });

        expect(serializeLogValue(err)).toContain('[Circular]');
    });

    it('serializes strings, objects and primitives as before', () => {
        expect(serializeLogValue('hi')).toBe('hi');
        expect(serializeLogValue({ a: 1 })).toBe('{\n  "a": 1\n}');
        expect(serializeLogValue(42)).toBe('42');
    });
});

describe('logger.error with an error argument', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('prints the API error detail once on the console', () => {
        const consoleTransport = logger.transports.find(
            (t) => t instanceof transports.Console
        ) as InstanceType<typeof transports.Console>;
        const lines: string[] = [];
        vi.spyOn(consoleTransport, 'log').mockImplementation(
            (info: Record<string | symbol, unknown>, next: () => void) => {
                lines.push(String(info[Symbol.for('message')]));
                next();
            }
        );

        logger.error(
            '❌ Error listing channel links:',
            new FakeFluxerAPIError()
        );

        expect(lines).toHaveLength(1);
        const line = lines[0];
        expect(line).toContain(
            '❌ Error listing channel links: Invalid form body.'
        );
        expect(line).toContain('BASE_TYPE_MAX_LENGTH');
        expect(line).toContain('"statusCode": 400');
        expect(line.split('FluxerAPIError: Invalid form body.')).toHaveLength(
            2
        );
        expect(line.split('BASE_TYPE_MAX_LENGTH')).toHaveLength(3); // errors + rawBody.errors
    });
});
