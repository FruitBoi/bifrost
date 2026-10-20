import { createLogger, format, transports } from 'winston';
import path from 'path';
import { LoggerColors as Colors, getLevelColor } from './LoggerColors';
import { CONFIG_PATH, isProduction } from '../env';

const splatSymbol = Symbol.for('splat');
// Set once the splat has been folded into `info.message`. The logger's format runs first and each
// transport's format runs again on a shallow copy (symbol keys included), so without this the
// console would print every serialized argument twice.
const splatEnrichedSymbol = Symbol('bifrost.splatEnriched');

/**
 * JSON.stringify that replaces only true cycles with '[Circular]'. A value reached twice through
 * different paths (FluxerAPIError's `errors` is also `rawBody.errors`) is printed both times.
 */
const stringifySafe = (value: unknown): string => {
    const ancestors: object[] = [];

    return JSON.stringify(
        value,
        function (this: unknown, _key, currentValue: unknown) {
            if (typeof currentValue !== 'object' || currentValue === null)
                return currentValue;

            // `this` is the object holding currentValue; unwind to it so only its ancestors remain.
            while (
                ancestors.length > 0 &&
                ancestors[ancestors.length - 1] !== this
            )
                ancestors.pop();
            if (ancestors.includes(currentValue)) return '[Circular]';
            ancestors.push(currentValue);

            return currentValue;
        },
        2
    );
};

/**
 * Properties API errors carry beyond `message`/`stack`: FluxerAPIError (@fluxerjs/rest) has
 * code/statusCode/errors/rawBody/method/path, discord.js DiscordAPIError has
 * code/status/method/url/rawError. The server's field-level detail lives in `errors`/`rawBody`/
 * `rawError`, so logging only the stack loses it.
 */
const ERROR_DETAIL_KEYS = [
    'code',
    'statusCode',
    'status',
    'method',
    'path',
    'url',
    'errors',
    'rawBody',
    'rawError',
] as const;

const errorDetail = (error: Error): Record<string, unknown> | undefined => {
    const source = error as unknown as Record<string, unknown>;
    const detail: Record<string, unknown> = {};
    for (const key of ERROR_DETAIL_KEYS) {
        if (key in source && source[key] !== undefined)
            detail[key] = source[key];
    }

    return Object.keys(detail).length > 0 ? detail : undefined;
};

export const serializeLogValue = (value: unknown): string => {
    if (value instanceof Error) {
        const base = value.stack || `${value.name}: ${value.message}`;
        const detail = errorDetail(value);
        return detail ? `${base}\n${stringifySafe(detail)}` : base;
    }
    if (typeof value === 'string') return value;
    if (typeof value === 'object' && value !== null)
        return stringifySafe(value);

    return String(value);
};

const enrichMessageWithSplat = format((info) => {
    if (info[splatEnrichedSymbol]) return info;
    info[splatEnrichedSymbol] = true;

    const splatValues = info[splatSymbol] as unknown[] | undefined;
    if (!splatValues || splatValues.length === 0) return info;

    const serializedValues = splatValues
        .map((value) => serializeLogValue(value))
        .filter((value) => value.length > 0);
    if (serializedValues.length === 0) return info;

    info.message = `${info.message}\n${serializedValues.join('\n')}`;
    return info;
});

const fileLogFormat = format.printf(({ level, message, timestamp }) => {
    return `${timestamp || ''} [${level ? level.toUpperCase() : 'INFO'}]: ${message || ''}`;
});

const consoleLogFormat = format.combine(
    format.errors({ stack: true }),
    enrichMessageWithSplat(),
    format.label({ label: '[LOGGER]' }),
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    format.printf(
        (info) =>
            `${Colors.FgDarkGray}${info.timestamp} ${Colors.Reset}[${getLevelColor(
                info.level
            )}${info.level.toUpperCase()}${Colors.Reset}]: ${
                info.level === 'info' ? Colors.Reset : getLevelColor(info.level)
            }${info.message}${Colors.Reset}`
    ),
    format.colorize({ all: true })
);

const logger = createLogger({
    level: isProduction ? 'info' : 'debug',
    format: format.combine(
        format.errors({ stack: true }),
        enrichMessageWithSplat(),
        format.timestamp(),
        fileLogFormat
    ),

    transports: [
        new transports.Console({
            format: consoleLogFormat,
        }),

        new transports.File({
            filename: path.join(CONFIG_PATH, 'logs/error.log'),
            level: 'error',
        }),
        new transports.File({
            filename: path.join(CONFIG_PATH, 'logs/combined.log'),
        }),
    ],
});

// Override console.log, console.error, console.warn, console.debug
// console.log = (...args: any[]) => logger.info(args.join(' '));
// console.error = (...args: any[]) => logger.error(args.join(' '));
// console.warn = (...args: any[]) => logger.warn(args.join(' '));
// console.debug = (...args: any[]) => logger.debug(args.join(' '));

export default logger;
