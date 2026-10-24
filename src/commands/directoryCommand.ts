import { ThreadDirectoryPlatform } from '../db/entities/ThreadDirectory';
import ThreadDirectoryService, {
    DIRECTORY_DESCRIPTION_MAX,
    DIRECTORY_TITLE_MAX,
    ThreadDirectoryError,
} from '../services/threadDirectory/ThreadDirectoryService';
import { EmbedColors } from '../utils/embeds';
import logger from '../utils/logging/logger';
import { COMMAND_PREFIX } from '../utils/env';

/** What a `directory` invocation asks for. `usage` means it could not be parsed. */
export type DirectoryAction =
    | { kind: 'usage' }
    | { kind: 'status' }
    | { kind: 'post'; title?: string }
    | { kind: 'refresh' }
    | { kind: 'describe'; threadId: string; description: string | null }
    | { kind: 'hide'; threadId: string; hidden: boolean }
    | { kind: 'title'; title: string }
    | { kind: 'remove' };

/** The thread ID of a channel mention (`<#id>`) or a raw snowflake, else null. */
export function parseThreadRef(arg: string | undefined): string | null {
    if (!arg) return null;
    const mention = /^<#(\d{15,25})>$/.exec(arg);
    if (mention) return mention[1];
    return /^\d{15,25}$/.test(arg) ? arg : null;
}

/**
 * The raw text after the prefix and the first `skip` whitespace-separated
 * words (command, subcommand, ...), keeping newlines and spacing. Falls back
 * to the parsed `args` when the content does not start with the prefix.
 */
export function restAfterWords(
    content: string,
    prefix: string,
    skip: number,
    args: string[]
): string {
    if (!content.startsWith(prefix)) return args.slice(skip - 1).join(' ');
    let rest = content.slice(prefix.length).trimStart();
    for (let i = 0; i < skip; i++) {
        const match = /^\S+\s*/.exec(rest);
        if (!match) return '';
        rest = rest.slice(match[0].length);
    }
    return rest.trim();
}

/**
 * Parses `directory <subcommand> ...`. `args` are the words after the command
 * name; `currentThreadId` is set when the command runs inside a thread.
 */
export function parseDirectoryCommand(opts: {
    content: string;
    prefix: string;
    args: string[];
    currentThreadId?: string | null;
}): DirectoryAction {
    const { content, prefix, args, currentThreadId } = opts;
    const sub = args[0]?.toLowerCase();
    const rest = (words: number) =>
        restAfterWords(content, prefix, words, args);
    const usage: DirectoryAction = { kind: 'usage' };

    switch (sub) {
        case undefined:
            return { kind: 'status' };
        case 'post': {
            const title = rest(2);
            return { kind: 'post', title: title || undefined };
        }
        case 'refresh':
        case 'update':
            return args.length === 1 ? { kind: 'refresh' } : usage;
        case 'remove':
            return args.length === 1 ? { kind: 'remove' } : usage;
        case 'title': {
            const title = rest(2);
            return title ? { kind: 'title', title } : usage;
        }
        case 'hide':
        case 'show': {
            const hidden = sub === 'hide';
            if (args.length === 1)
                return currentThreadId
                    ? { kind: 'hide', threadId: currentThreadId, hidden }
                    : usage;
            const threadId = parseThreadRef(args[1]);
            return threadId && args.length === 2
                ? { kind: 'hide', threadId, hidden }
                : usage;
        }
        case 'describe': {
            const threadId = parseThreadRef(args[1]);
            if (threadId)
                return {
                    kind: 'describe',
                    threadId,
                    description: rest(3) || null,
                };
            if (currentThreadId && args.length > 1)
                return {
                    kind: 'describe',
                    threadId: currentThreadId,
                    description: rest(2) || null,
                };
            return usage;
        }
        default:
            return usage;
    }
}

export interface DirectoryReply {
    description: string;
    color: number;
}

export interface DirectoryStatusReply {
    status: true;
    header: string;
    /** One entry per thread, to be split across embeds. */
    lines: string[];
}

/** A friendly message for a ThreadDirectoryError, or null for other errors. */
export function directoryErrorMessage(
    err: unknown,
    channelId: string,
    threadId?: string
): string | null {
    if (!(err instanceof ThreadDirectoryError)) return null;
    switch (err.reason) {
        case 'no_directory':
            return `This channel has no threads directory yet. Run \`${COMMAND_PREFIX}directory post\` to post one.`;
        case 'message_missing':
            return `The directory message was deleted. Run \`${COMMAND_PREFIX}directory post\` to post it again.`;
        case 'unknown_thread':
            return `${threadId ? `<#${threadId}>` : 'That'} is not a thread of <#${channelId}>.`;
        case 'unsupported_channel':
            return 'Threads directories can only be posted in text channels.';
        case 'too_long':
            return `That is too long. Titles can have up to ${DIRECTORY_TITLE_MAX} characters and descriptions up to ${DIRECTORY_DESCRIPTION_MAX}.`;
        case 'unavailable':
            return 'Threads directories are not available on this platform right now.';
    }
}

/** Runs a parsed (non-usage) action; thrown errors become error replies. */
export async function runDirectoryAction(
    service: ThreadDirectoryService,
    platform: ThreadDirectoryPlatform,
    guildId: string,
    channelId: string,
    action: Exclude<DirectoryAction, { kind: 'usage' }>
): Promise<DirectoryReply | DirectoryStatusReply> {
    const ok = (description: string): DirectoryReply => ({
        description,
        color: EmbedColors.Success,
    });
    try {
        switch (action.kind) {
            case 'status': {
                const status = await service.getStatus(
                    platform,
                    guildId,
                    channelId
                );
                const header = status.directory
                    ? `The threads directory of <#${channelId}> is [here](${service.messageUrl(status.directory)}) (title: **${status.directory.title}**).`
                    : `<#${channelId}> has no threads directory posted. Run \`${COMMAND_PREFIX}directory post\` to post one.`;
                const lines = status.threads.map((thread) => {
                    const text = thread.description
                        ? ` — ${thread.description}`
                        : '';
                    return `${thread.hidden ? '🙈 ' : ''}<#${thread.id}>${text}`;
                });
                return { status: true, header, lines };
            }
            case 'post': {
                const dir = await service.post(
                    platform,
                    guildId,
                    channelId,
                    action.title
                );
                return ok(
                    `Posted the threads directory of <#${channelId}>: ${service.messageUrl(dir)}`
                );
            }
            case 'refresh': {
                const dir = await service.refresh(platform, channelId);
                return ok(
                    `Refreshed the threads directory: ${service.messageUrl(dir)}`
                );
            }
            case 'describe':
                await service.setDescription(
                    platform,
                    guildId,
                    channelId,
                    action.threadId,
                    action.description
                );
                return ok(
                    action.description
                        ? `Set the description of <#${action.threadId}>.`
                        : `Cleared the description of <#${action.threadId}>.`
                );
            case 'hide':
                await service.setHidden(
                    platform,
                    guildId,
                    channelId,
                    action.threadId,
                    action.hidden
                );
                return ok(
                    action.hidden
                        ? `<#${action.threadId}> is now hidden from the directory.`
                        : `<#${action.threadId}> is now shown in the directory.`
                );
            case 'title': {
                const dir = await service.setTitle(
                    platform,
                    channelId,
                    action.title
                );
                return ok(`Renamed the threads directory to **${dir.title}**.`);
            }
            case 'remove': {
                const removed = await service.remove(platform, channelId);
                return removed
                    ? ok(
                          'Deleted the threads directory message. Thread descriptions are kept.'
                      )
                    : {
                          description: `<#${channelId}> has no threads directory to remove.`,
                          color: EmbedColors.Error,
                      };
            }
        }
    } catch (err: unknown) {
        const threadId = 'threadId' in action ? action.threadId : undefined;
        const friendly = directoryErrorMessage(err, channelId, threadId);
        if (friendly)
            return { description: friendly, color: EmbedColors.Error };
        logger.error('❌ Threads directory command failed:', err);
        return {
            description:
                'Something went wrong while updating the threads directory.',
            color: EmbedColors.Error,
        };
    }
}
