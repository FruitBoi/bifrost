import { Client } from '@fluxerjs/core';
import {
    IdentityClaimPrompt,
    IdentityClaimPromptSender,
} from './IdentityClaimService';

/** HTTP status of a Fluxer error, duck-typed. */
function httpStatus(err: unknown): number | null {
    if (typeof err !== 'object' || err === null) return null;
    const { statusCode, status } = err as {
        statusCode?: unknown;
        status?: unknown;
    };
    if (typeof statusCode === 'number') return statusCode;
    if (typeof status === 'number') return status;
    return null;
}

/**
 * Posts `iam` confirmation prompts on Fluxer: a bot message in the linked
 * channel or thread, replying to the target's original message and pinging
 * only the target. Fluxer has no `failIfNotExists`, so a rejected reply
 * (e.g. the original was deleted) is retried once as a plain message.
 */
export default class FluxerIdentityClaimPromptSender implements IdentityClaimPromptSender {
    constructor(private readonly client: Client) {}

    async sendPrompt(prompt: IdentityClaimPrompt): Promise<void> {
        const payload = {
            content: prompt.content,
            allowedMentions: { parse: [], users: [prompt.targetUserId] },
        };
        try {
            await this.client.channels.send(prompt.locationId, {
                ...payload,
                replyTo: {
                    channelId: prompt.locationId,
                    messageId: prompt.messageId,
                    guildId: prompt.guildLink.fluxerGuildId,
                },
            });
        } catch (err) {
            const status = httpStatus(err);
            if (
                status === null ||
                status < 400 ||
                status >= 500 ||
                status === 429
            )
                throw err;
            await this.client.channels.send(prompt.locationId, payload);
        }
    }
}
