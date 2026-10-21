/**
 * Short command triggers: besides the normal bot prefix (`!b clean 10`), a
 * few commands can be invoked with short prefixes such as `?clean 10` or
 * `!clean 10`, configured per feature (e.g. `clean.triggerPrefixes`). This is
 * the generic counterpart of `reminderTrigger.ts`: only the command names a
 * caller passes are reachable this way, every other command still needs the
 * bot prefix.
 */

export interface CommandTrigger<N extends string = string> {
    /** The matched command name, exactly as listed in `commandNames`. */
    command: N;
    /**
     * Everything after the command word, with leading whitespace removed and
     * the rest (including newlines) kept verbatim.
     */
    rawArgs: string;
}

/**
 * Recognises `<prefix><command>` at the start of `content` for any of the
 * given prefixes (checked in order; the first prefix that matches wins) and
 * any of `commandNames`, case-insensitively. Whitespace between the prefix
 * and the command word is allowed, so `? Clean 10` (what a phone keyboard
 * makes of `?clean`, with its automatic space and capital after punctuation)
 * works like `?clean 10`. The command word must be followed by whitespace or
 * the end of the message, so `?cleanup` is not a `clean` trigger. Returns
 * null when the message is not an invocation of one of the commands.
 */
export function parseCommandTrigger<N extends string>(
    content: string | null | undefined,
    prefixes: readonly string[],
    commandNames: readonly N[]
): CommandTrigger<N> | null {
    if (!content) return null;
    for (const prefix of prefixes) {
        if (!prefix || !content.startsWith(prefix)) continue;
        const rest = content.slice(prefix.length);
        const match = /^\s*(\S+)(?:\s+|$)/.exec(rest);
        if (!match) continue;
        const word = match[1].toLowerCase();
        const command = commandNames.find(
            (name) => name.toLowerCase() === word
        );
        if (command === undefined) continue;
        return { command, rawArgs: rest.slice(match[0].length) };
    }
    return null;
}

/**
 * Returns the raw argument text of an invocation of one of `commandNames`
 * written with any of `prefixes` (the bot prefix and the short trigger
 * prefixes), or null when `content` is not one. Handlers use it to read the
 * arguments exactly as typed (quotes and inner whitespace included) instead
 * of re-joining the whitespace-split args the command dispatcher hands them.
 */
export function stripCommandInvocation(
    content: string | null | undefined,
    prefixes: readonly string[],
    commandNames: readonly string[]
): string | null {
    return (
        parseCommandTrigger(content, prefixes, commandNames)?.rawArgs ?? null
    );
}
