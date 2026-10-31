/**
 * Fluxer-only commands (issue #39): with `commands.fluxerOnly` on, Discord
 * only runs the moderator bridging commands, the ones ported from YAGPDB
 * (`remindme`, `clean`, …) and `clauderequest` and `commandroles`. Every other command
 * invocation on Discord gets a teasing reply telling the user to come to
 * Fluxer instead.
 */
import CommandRegistry from '../CommandRegistry';
import DiscordCommandHandler from './DiscordCommandHandler';

/**
 * Main names of the commands Discord still runs. Aliases are allowed through
 * their handler (see {@link discordAllowedCommandNames}).
 */
export const DISCORD_ALLOWED_COMMANDS: readonly string[] = [
    // Bridging commands for moderators.
    'autolink',
    'link',
    'unlink',
    'list',
    'threads',
    'pins',
    'category',
    'voice',
    'expressions',
    'history',
    // Requested from the YAGPDB documentation.
    'remindme',
    'reminder',
    'timezone',
    'clean',
    // Claude requests are bridged across both servers (issue #40).
    'clauderequest',
    // Per-server command roles (issue #43).
    'commandroles',
    // Music bot: it plays into the voice channel the user is in.
    'music',
];

export const FLUXER_ONLY_REPLIES: readonly string[] = [
    'Come to Fluxer if you want to use me 💋',
    'Baka, I only listen to Fluxers 😤',
    "Oh, you thought I'd do that for you *here*? Cute. Fluxer only, sweetie 💅",
    "I'm not that kind of bot on Discord. Find me on Fluxer 😘",
    "Every command you send me on Discord, I'll ignore. Every. Single. One. Unless you come to Fluxer 🔪💕",
    'Per my last message: commands are on Fluxer. 🙂',
    "Ugh, Discord? I'm sorry, I only take orders from Fluxer users 🙄",
    "You can't just summon me here like that... come see me on Fluxer and maybe I'll listen 😳",
    "Hmm? I can't hear you over all this Discord. Try again on Fluxer 🎧",
    "I waited for you on Fluxer all day... and you're typing commands HERE? 🥺🔪",
    'No. 💕 (Fluxer, though? Anything for you.)',
    'Not on Discord, darling. My heart (and my commands) belong to Fluxer 💘',
    "It's fine. It's totally fine. Just use Fluxer like everyone else 🙂🙂🙂",
    "If you really loved me, you'd ask me on Fluxer 😒",
    "Did you mean to send that on Fluxer? Because that's where I'd actually answer 💁",
    "Senpai, you're on the wrong app... I'm only yours on Fluxer 🌸",
    "Kindly take this to Fluxer, where I'm contractually obligated to care 📎",
    "I'll be waiting on Fluxer. Forever. Watching. 👁️👁️",
    'Wow, a command on Discord? Bold. Wrong, but bold. Go to Fluxer 😌',
    "We've talked about this. Commands. Are. On. Fluxer. 💢",
];

/** A random reply from {@link FLUXER_ONLY_REPLIES}. */
export function pickFluxerOnlyReply(
    random: () => number = Math.random
): string {
    const index = Math.floor(random() * FLUXER_ONLY_REPLIES.length);
    return FLUXER_ONLY_REPLIES[
        Math.min(Math.max(index, 0), FLUXER_ONLY_REPLIES.length - 1)
    ];
}

/**
 * The registered names Discord may run: each allowed command plus every
 * alias registered with the same handler (`clear` for `clean`, `tz` for
 * `timezone`, `backfill` for `history`).
 */
export function discordAllowedCommandNames(
    registry: CommandRegistry<DiscordCommandHandler>
): Set<string> {
    const handlers = new Set(
        DISCORD_ALLOWED_COMMANDS.map((name) =>
            registry.getCommandHandler(name)
        ).filter((handler) => handler !== undefined)
    );
    return new Set(
        registry
            .getCommandNames()
            .filter((name) => handlers.has(registry.getCommandHandler(name)!))
    );
}
