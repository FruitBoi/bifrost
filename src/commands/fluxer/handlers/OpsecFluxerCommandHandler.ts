import { Client, EmbedBuilder, Message } from '@fluxerjs/core';
import FluxerCommandHandler from '../FluxerCommandHandler';
import OpsecService, {
    opsecEndMessage,
    opsecStartMessage,
    parseOpsecArgs,
} from '../../../services/opsec/OpsecService';
import { EmbedColors } from '../../../utils/embeds';
import logger from '../../../utils/logging/logger';

const USAGE = '`opsec on [duration]` / `opsec off` (alias `opsex`)';

/**
 * `opsec` / `opsex` (issue #60): pauses bridging of this channel or thread to
 * Discord for a while. The announcements are posted on Fluxer and bridged to
 * Discord, the start one before the pause begins and the end one after it
 * was removed, since the relay skips paused channels.
 */
export default class OpsecFluxerCommandHandler extends FluxerCommandHandler {
    constructor(
        private readonly fluxerClient: Client,
        private readonly opsecService: OpsecService,
        private readonly relayReply:
            | ((sent: Message) => Promise<void>)
            | null = null
    ) {
        super(fluxerClient);
    }

    private async reply(
        message: Message,
        color: number,
        description: string
    ): Promise<void> {
        await message.reply({
            embeds: [
                new EmbedBuilder()
                    .setDescription(description)
                    .setColor(color)
                    .setFooter(this.footer(message))
                    .setTimestamp(),
            ],
        });
    }

    /** Posts plain content to the channel and bridges it, never throwing from the bridge. */
    private async announce(channelId: string, content: string): Promise<void> {
        const sent = await this.fluxerClient.channels.send(channelId, {
            content,
            allowedMentions: { parse: [] },
        });
        if (!sent || !this.relayReply) return;
        try {
            await this.relayReply(sent);
        } catch (err: unknown) {
            logger.error('❌ Failed to bridge an opsec announcement:', err);
        }
    }

    public async handleCommand(
        message: Message,
        _command: string,
        ...args: string[]
    ): Promise<void> {
        if (message.author.bot) {
            await this.reply(
                message,
                EmbedColors.Error,
                'Bots cannot use this command.'
            );
            return;
        }
        if (!message.guildId) {
            await this.reply(
                message,
                EmbedColors.Error,
                'This only works in a server channel or thread.'
            );
            return;
        }

        const channelId = message.channelId;
        const parsed = parseOpsecArgs(args);

        switch (parsed.action) {
            case 'invalid':
                await this.reply(
                    message,
                    EmbedColors.Error,
                    `${parsed.reason}\nUsage: ${USAGE}`
                );
                return;
            case 'status': {
                const endsAt = this.opsecService.endsAt(channelId);
                await this.reply(
                    message,
                    EmbedColors.Info,
                    endsAt !== null
                        ? `A sex session is running here. Bridging to Discord resumes <t:${Math.floor(endsAt / 1000)}:R>.`
                        : `No sex session is running here.\nUsage: ${USAGE}`
                );
                return;
            }
            case 'off':
                if (!this.opsecService.stop(channelId)) {
                    await this.reply(
                        message,
                        EmbedColors.Info,
                        'No sex session is running here.'
                    );
                }
                return;
            case 'on': {
                const onEnd = () =>
                    this.announce(channelId, opsecEndMessage()).catch(
                        (err: unknown) => {
                            logger.error(
                                '❌ Failed to post the opsec end message:',
                                err
                            );
                        }
                    );
                if (this.opsecService.isActive(channelId)) {
                    const { endsAt } = this.opsecService.start(
                        channelId,
                        parsed.durationMs,
                        onEnd
                    );
                    await this.reply(
                        message,
                        EmbedColors.Info,
                        `The sex session was extended. Bridging to Discord resumes <t:${Math.floor(endsAt / 1000)}:R>.`
                    );
                    return;
                }
                await this.announce(
                    channelId,
                    opsecStartMessage(Date.now() + parsed.durationMs)
                );
                this.opsecService.start(channelId, parsed.durationMs, onEnd);
                return;
            }
        }
    }
}
