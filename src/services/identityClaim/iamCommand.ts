import { GuildLink } from '../../db/entities/GuildLink';
import { EmbedColors } from '../../utils/embeds';
import IdentityClaimService, {
    escapeDisplayName,
    otherPlatform,
    Platform,
    PLATFORM_NAMES,
} from './IdentityClaimService';

/** Names the `iam` command is registered under. */
export const IAM_COMMAND_NAMES = ['iam'] as const;

/** One invocation of `iam`, already stripped of everything platform specific. */
export interface IamInvocation {
    platform: Platform;
    userId: string;
    displayName: string;
    /** The guild link of the server the command was used in. */
    guildLink: GuildLink | null;
    /** The message the invocation replies to, if any. */
    repliedMessageId: string | null;
    args: string[];
}

/** What to reply with: one embed description and its colour. */
export interface IamReply {
    description: string;
    color: number;
}

const SUBCOMMANDS: Record<string, 'confirm' | 'deny' | 'remove' | 'status'> = {
    yes: 'confirm',
    confirm: 'confirm',
    no: 'deny',
    deny: 'deny',
    remove: 'remove',
    unlink: 'remove',
    status: 'status',
};

/**
 * Runs `iam` for either platform and returns the reply. Returns null when the
 * arguments are not understood (the caller shows the usage).
 */
export async function runIamCommand(
    service: IdentityClaimService,
    inv: IamInvocation
): Promise<IamReply | null> {
    const p = service.commandPrefix;
    const here = PLATFORM_NAMES[inv.platform];
    const there = PLATFORM_NAMES[otherPlatform(inv.platform)];
    const error = (description: string) => ({
        description,
        color: EmbedColors.Error,
    });

    const word = inv.args[0]?.toLowerCase();
    let action: 'claim' | 'confirm' | 'deny' | 'remove' | 'status';
    if (word === undefined) {
        action = inv.repliedMessageId ? 'claim' : 'status';
    } else if (inv.args.length === 1 && SUBCOMMANDS[word]) {
        action = SUBCOMMANDS[word];
    } else {
        return null;
    }

    if (!inv.guildLink) {
        return error(`This server is not linked to a ${there} server.`);
    }
    const guildLinkId = inv.guildLink.id;
    const who = {
        guildLinkId,
        platform: inv.platform,
        userId: inv.userId,
    };
    const replyHint = `Reply with \`${p}iam\` to the bridged copy of a message you wrote on ${there}.`;
    const adminHint = `An admin can change existing links with \`${p}role\` / \`${p}map\` on Fluxer.`;

    switch (action) {
        case 'claim': {
            const result = await service.claim({
                guildLink: inv.guildLink,
                platform: inv.platform,
                userId: inv.userId,
                displayName: inv.displayName,
                repliedMessageId: inv.repliedMessageId ?? '',
            });
            switch (result.kind) {
                case 'sent':
                    return {
                        description:
                            `Asked ${there} user \`${result.claim.target.userId}\` to confirm, in reply to their original message. ` +
                            `Once they run \`${p}iam yes\` on ${there}, your accounts are linked and pings reach you on both sides. ` +
                            `The request expires in ${service.ttlMinutes} minutes.`,
                        color: EmbedColors.Success,
                    };
                case 'not_bridged':
                    return error(
                        `That message was not bridged from ${there}. ${replyHint}`
                    );
                case 'own_platform':
                    return error(
                        `That message was written here on ${here}, not on ${there}. ${replyHint}`
                    );
                case 'unknown_source':
                    return error(
                        `That message was bridged before the bot recorded who wrote it. ${replyHint}`
                    );
                case 'no_author':
                    return error(
                        `That message has no known author on ${there} (it was posted by a webhook). ${replyHint}`
                    );
                case 'already_linked':
                    return {
                        description: `Your ${here} account is already linked to ${there} user \`${result.target.userId}\`.`,
                        color: EmbedColors.Info,
                    };
                case 'claimer_mapped':
                    return error(
                        `Your ${here} account is already linked to ${there} user \`${result.mappedTo.userId}\`. ` +
                            `Run \`${p}iam remove\` first to unlink it. ${adminHint}`
                    );
                case 'target_mapped':
                    return error(
                        `That ${there} account is already linked to someone else. ` +
                            `Its owner can run \`${p}iam remove\` on ${there} first. ${adminHint}`
                    );
                case 'cooldown':
                    return error(
                        `Please wait ${Math.ceil(result.retryAfterMs / 1000)} seconds before sending another link request.`
                    );
                case 'prompt_failed':
                    return error(
                        `Could not post the confirmation request on ${there} (${result.error}). Nothing was changed.`
                    );
            }
            break;
        }
        case 'confirm': {
            const result = await service.confirm(who);
            switch (result.kind) {
                case 'linked':
                    return {
                        description: `Linked your ${here} account to **${escapeDisplayName(result.claim.claimer.displayName)}** (${there} user \`${result.claim.claimer.userId}\`). Pings now reach you on both sides.`,
                        color: EmbedColors.Success,
                    };
                case 'already_linked':
                    return {
                        description: `Your ${here} account is already linked to ${there} user \`${result.claim.claimer.userId}\`.`,
                        color: EmbedColors.Info,
                    };
                case 'conflict':
                    return error(
                        `Could not link: one of the accounts was linked to someone else in the meantime. ` +
                            `Run \`${p}iam remove\` first, or ask an admin. ${adminHint}`
                    );
                case 'no_pending':
                    return error(
                        `You have no pending link request (they expire after ${service.ttlMinutes} minutes).`
                    );
            }
            break;
        }
        case 'deny': {
            const result = await service.deny(who);
            if (result.kind === 'no_pending') {
                return error('You have no pending link request.');
            }
            return {
                description: `Dismissed the link request from **${escapeDisplayName(result.claim.claimer.displayName)}** on ${there}.`,
                color: EmbedColors.Success,
            };
        }
        case 'remove': {
            const result = await service.remove(who);
            if (result.kind === 'not_linked') {
                return {
                    description: `Your ${here} account is not linked to a ${there} account.`,
                    color: EmbedColors.Info,
                };
            }
            return {
                description: `Unlinked your ${here} account from ${there} user \`${result.was.userId}\`. Pings no longer bridge between them.`,
                color: EmbedColors.Success,
            };
        }
        case 'status': {
            const status = await service.status(who);
            const lines = [
                status.linkedTo
                    ? `Your ${here} account is linked to ${there} user \`${status.linkedTo.userId}\`; pings reach you on both sides. \`${p}iam remove\` unlinks it.`
                    : `Your ${here} account is not linked to a ${there} account.`,
            ];
            const pending = status.pendingForCaller;
            if (pending) {
                lines.push(
                    `**${escapeDisplayName(pending.claimer.displayName)}** on ${there} asked to link with you: run \`${p}iam yes\` to confirm or \`${p}iam no\` to dismiss (expires <t:${Math.floor(pending.expiresAt / 1000)}:R>).`
                );
            }
            if (!status.linkedTo) {
                lines.push(
                    `**How to link:** reply with \`${p}iam\` to the bridged copy of a message you wrote on ${there}` +
                        (inv.platform === 'discord'
                            ? ' (as a message reply; slash commands cannot reply to messages). '
                            : '. ') +
                        `The bot then asks that ${there} account to confirm with \`${p}iam yes\`.`
                );
            }
            return { description: lines.join('\n\n'), color: EmbedColors.Info };
        }
    }
    return null;
}
