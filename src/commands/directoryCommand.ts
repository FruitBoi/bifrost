import { ThreadDirectoryPlatform } from '../db/entities/ThreadDirectory';
import ThreadDirectoryService, {
    DIRECTORY_DESCRIPTION_MAX,
    DIRECTORY_TITLE_MAX,
    DirectoryStatusThread,
    ThreadDirectoryError,
} from '../services/threadDirectory/ThreadDirectoryService';
import { parseDirectoryImport } from '../services/threadDirectory/directoryImport';
import {
    parseChannelRef,
    parseMessageRef,
    parseRoleRef,
} from '../utils/channelRef';
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
    | { kind: 'remove' }
    | { kind: 'add'; targetId: string; description: string | null }
    | { kind: 'unlist'; targetId: string }
    /** `role` is a role ID or name, or null to clear the linked role. */
    | { kind: 'role'; threadId: string; role: string | null }
    | { kind: 'import'; source: DirectoryImportSource };

/** Where `directory import` reads the hand-made directory from. */
export type DirectoryImportSource =
    /** A message; `channelId` is null for a bare ID (the current channel). */
    | { kind: 'message'; channelId: string | null; messageId: string }
    | { kind: 'text'; text: string };

/** Role arguments of `directory role` that clear the linked role. */
const CLEAR_ROLE_WORDS = new Set(['none', 'clear', 'off']);

/** How many skipped import lines are named in the reply. */
const IMPORT_SKIPPED_SHOWN = 15;

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
 * The role of `directory role`: null for `none`/`clear`/`off`, the ID of a
 * role mention, else the text itself (a raw ID or a role name).
 */
function parseRoleArg(text: string): string | null {
    if (CLEAR_ROLE_WORDS.has(text.toLowerCase())) return null;
    return parseRoleRef(text) ?? text;
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
            const threadId = parseChannelRef(args[1]);
            return threadId && args.length === 2
                ? { kind: 'hide', threadId, hidden }
                : usage;
        }
        case 'describe': {
            const threadId = parseChannelRef(args[1]);
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
        case 'add': {
            const targetId = parseChannelRef(args[1]);
            return targetId
                ? { kind: 'add', targetId, description: rest(3) || null }
                : usage;
        }
        case 'unlist':
        case 'drop': {
            const targetId = parseChannelRef(args[1]);
            return targetId && args.length === 2
                ? { kind: 'unlist', targetId }
                : usage;
        }
        case 'role': {
            const threadId = parseChannelRef(args[1]);
            if (threadId && args.length > 2)
                return { kind: 'role', threadId, role: parseRoleArg(rest(3)) };
            // Inside a thread the thread may be omitted: a lone raw ID is then
            // a role ID, while a lone channel mention or link lacks the role.
            if (
                currentThreadId &&
                args.length > 1 &&
                (!threadId || parseRoleRef(args[1]) === args[1])
            )
                return {
                    kind: 'role',
                    threadId: currentThreadId,
                    role: parseRoleArg(rest(2)),
                };
            return usage;
        }
        case 'import': {
            const text = rest(2);
            if (!text) return usage;
            const message = args.length === 2 ? parseMessageRef(args[1]) : null;
            return {
                kind: 'import',
                source: message
                    ? { kind: 'message', ...message }
                    : { kind: 'text', text },
            };
        }
        default:
            return usage;
    }
}

/** One status line: markers, then `description: #thread - @role`. */
export function directoryStatusLine(thread: DirectoryStatusThread): string {
    const markers = `${thread.hidden ? '🙈 ' : ''}${thread.added ? '➕ ' : ''}`;
    const description = thread.description
        ? `${thread.description.replace(/\s*\n\s*/g, ' ')}: `
        : '';
    const role = thread.roleId ? ` - <@&${thread.roleId}>` : '';
    return `${markers}${description}<#${thread.id}>${role}`;
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
            return `${threadId ? `<#${threadId}>` : 'That'} is not a thread of <#${channelId}> or an entry added to its directory.`;
        case 'unknown_channel':
            return `${threadId ? `<#${threadId}>` : 'That'} is not a channel or thread of this server.`;
        case 'unknown_role':
            return 'That role does not exist in this server. Give a role mention, an ID or its exact name.';
        case 'unsafe_role':
            return 'That role cannot be used as an LFG role: it is @everyone, managed by an integration, or grants moderator permissions.';
        case 'not_lfg_role':
            return `That is not an LFG role. Run \`${COMMAND_PREFIX}lfg\` to see the roles you can give yourself.`;
        case 'role_forbidden':
            return 'I cannot give or remove that role: I need the Manage Roles permission and a role above it.';
        case 'message_not_found':
            return 'I could not fetch that message. Give a link to it, or run the command in its channel when giving only its ID.';
        case 'unsupported_channel':
            return 'Threads directories can only be posted in text channels.';
        case 'too_long':
            return `That is too long. Titles can have up to ${DIRECTORY_TITLE_MAX} characters and descriptions up to ${DIRECTORY_DESCRIPTION_MAX}.`;
        case 'unavailable':
            return 'Threads directories are not available on this platform right now.';
    }
}

/**
 * Runs a parsed (non-usage) action; thrown errors become error replies.
 * `channelId` is the directory channel; `currentChannelId` is where the
 * command was run (a thread of it, say), used to fetch `import` messages
 * given by bare ID.
 */
export async function runDirectoryAction(
    service: ThreadDirectoryService,
    platform: ThreadDirectoryPlatform,
    guildId: string,
    channelId: string,
    action: Exclude<DirectoryAction, { kind: 'usage' }>,
    currentChannelId: string = channelId
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
                const lines = status.threads.map(directoryStatusLine);
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
            case 'add': {
                const { alreadyListed } = await service.addEntry(
                    platform,
                    guildId,
                    channelId,
                    action.targetId,
                    action.description
                );
                if (!alreadyListed)
                    return ok(
                        `Added <#${action.targetId}> to the threads directory of <#${channelId}>.`
                    );
                return {
                    description: `<#${action.targetId}> is already listed in the threads directory of <#${channelId}>${action.description ? '; its description was updated' : ''}.`,
                    color: action.description
                        ? EmbedColors.Success
                        : EmbedColors.Warning,
                };
            }
            case 'unlist': {
                const removed = await service.unlistEntry(
                    platform,
                    channelId,
                    action.targetId
                );
                return removed
                    ? ok(
                          `Removed <#${action.targetId}> from the threads directory of <#${channelId}>.`
                      )
                    : {
                          description: `<#${action.targetId}> was not added to the directory of <#${channelId}>: only entries added with \`${COMMAND_PREFIX}directory add\` can be unlisted. Use \`${COMMAND_PREFIX}directory hide\` for the threads of <#${channelId}>.`,
                          color: EmbedColors.Error,
                      };
            }
            case 'role': {
                const role = await service.setRole(
                    platform,
                    guildId,
                    channelId,
                    action.threadId,
                    action.role
                );
                return ok(
                    role
                        ? `Linked <@&${role.id}> to <#${action.threadId}>. Members can give it to themselves with \`${COMMAND_PREFIX}lfg\`.`
                        : `Cleared the LFG role of <#${action.threadId}>.`
                );
            }
            case 'import':
                return await runImport(
                    service,
                    platform,
                    guildId,
                    channelId,
                    currentChannelId,
                    action.source
                );
        }
    } catch (err: unknown) {
        const threadId =
            'threadId' in action
                ? action.threadId
                : 'targetId' in action
                  ? action.targetId
                  : undefined;
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

/** Joins `names` for a reply, naming at most IMPORT_SKIPPED_SHOWN of them. */
function listNames(names: string[]): string {
    const shown = names
        .slice(0, IMPORT_SKIPPED_SHOWN)
        .map((name) => (name.length > 60 ? `${name.slice(0, 59)}…` : name))
        .map((name) => `\`${name.replace(/`/g, "'")}\``);
    const more = names.length - shown.length;
    return `${shown.join(', ')}${more > 0 ? ` …and ${more} more` : ''}`;
}

/** `directory import`: reads, parses and applies a hand-made directory. */
async function runImport(
    service: ThreadDirectoryService,
    platform: ThreadDirectoryPlatform,
    guildId: string,
    channelId: string,
    currentChannelId: string,
    source: DirectoryImportSource
): Promise<DirectoryReply> {
    const text =
        source.kind === 'message'
            ? await service.fetchMessageText(
                  platform,
                  guildId,
                  source.channelId ?? currentChannelId,
                  source.messageId
              )
            : source.text;
    const items = parseDirectoryImport(text);
    if (items.length === 0)
        return {
            description: [
                'I found no directory lines to import. Put each thread on its own line, as a thread link or mention (or its exact name) with an optional description and role mention, for example:',
                '`***[The Data Mine](https://…/channels/…)*** - Computer Tech`',
                '`Computer Tech: #the-data-mine - @Techies`',
                '`The Data Mine - Computer Tech`',
                'Give a message link, a message ID (from the same channel) or paste the text after the command.',
            ].join('\n'),
            color: EmbedColors.Error,
        };

    const result = await service.importEntries(
        platform,
        guildId,
        channelId,
        items
    );
    const lines = [
        `Imported ${items.length} line${items.length === 1 ? '' : 's'} into the threads directory of <#${channelId}>: ${result.updated.length} updated, ${result.added.length} added, ${result.skipped.length} skipped.`,
    ];
    if (result.skipped.length > 0)
        lines.push(
            '',
            `Skipped (no matching thread or channel): ${listNames(result.skipped)}`
        );
    const applied = result.updated.length + result.added.length;
    return {
        description: lines.join('\n'),
        color:
            applied === 0
                ? EmbedColors.Error
                : result.skipped.length > 0
                  ? EmbedColors.Warning
                  : EmbedColors.Success,
    };
}
