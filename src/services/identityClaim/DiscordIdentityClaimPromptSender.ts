import { Client } from 'discord.js';
import {
    IdentityClaimPrompt,
    IdentityClaimPromptSender,
} from './IdentityClaimService';

/**
 * Posts `iam` confirmation prompts on Discord: a bot message in the linked
 * channel or thread, replying to the target's original message and pinging
 * only the target.
 */
export default class DiscordIdentityClaimPromptSender implements IdentityClaimPromptSender {
    constructor(private readonly client: Client) {}

    async sendPrompt(prompt: IdentityClaimPrompt): Promise<void> {
        const channel = await this.client.channels.fetch(prompt.locationId);
        if (
            !channel ||
            !channel.isTextBased() ||
            channel.isDMBased() ||
            !channel.isSendable()
        ) {
            throw new Error(
                `Discord channel ${prompt.locationId} is missing or not a text channel`
            );
        }
        await channel.send({
            content: prompt.content,
            allowedMentions: { parse: [], users: [prompt.targetUserId] },
            // A deleted original turns this into a plain message.
            reply: {
                messageReference: prompt.messageId,
                failIfNotExists: false,
            },
        });
    }
}
