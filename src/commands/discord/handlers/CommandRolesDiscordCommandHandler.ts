import { Client, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import DiscordCommandHandler, {
    DiscordCommandHandlerMessage,
} from '../DiscordCommandHandler';
import CommandRoleService from '../../../services/commandRoles/CommandRoleService';
import {
    parseCommandRolesArgs,
    runCommandRolesAction,
} from '../../commandRolesCommand';
import logger from '../../../utils/logging/logger';
import { EmbedColors } from '../../../utils/embeds';

/**
 * `commandroles`: shows and, for administrators, changes which roles of this
 * server may use the role-gated commands (issue #43).
 */
export default class CommandRolesDiscordCommandHandler extends DiscordCommandHandler {
    constructor(
        client: Client,
        private readonly commandRoleService: CommandRoleService
    ) {
        super(client);
    }

    private async reply(
        message: DiscordCommandHandlerMessage,
        description: string,
        color: number,
        title?: string
    ): Promise<void> {
        const embed = new EmbedBuilder()
            .setDescription(description)
            .setColor(color)
            .setFooter(this.footer(message))
            .setTimestamp();
        if (title) embed.setTitle(title);
        await message.reply({ embeds: [embed] });
    }

    public async handleCommand(
        message: DiscordCommandHandlerMessage,
        _command: string,
        ...args: string[]
    ): Promise<void> {
        if (!message.inGuild()) {
            await this.reply(
                message,
                'This command only works in a server.',
                EmbedColors.Error
            );
            return;
        }

        try {
            const outcome = await runCommandRolesAction(
                parseCommandRolesArgs(args),
                {
                    service: this.commandRoleService,
                    platform: 'discord',
                    guildId: message.guildId,
                    requireAdmin: () =>
                        this.requirePermission(
                            message,
                            PermissionFlagsBits.Administrator,
                            'Administrator'
                        ),
                    fetchRoles: async () => {
                        const roles = await message.guild!.roles.fetch();
                        return [...roles.values()].map((r) => ({
                            id: r.id,
                            name: r.name,
                        }));
                    },
                }
            );
            if (!outcome) return;
            await this.reply(
                message,
                outcome.description,
                outcome.kind === 'error'
                    ? EmbedColors.Error
                    : outcome.kind === 'success'
                      ? EmbedColors.Success
                      : EmbedColors.Info,
                outcome.title
            );
        } catch (err) {
            logger.error('❌ Error handling commandroles:', err);
            await this.reply(
                message,
                'Could not read or change the command roles right now. Try again later.',
                EmbedColors.Error
            );
        }
    }
}
