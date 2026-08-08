import { Events, MessageFlags } from 'discord.js';
import { logger } from '../utils/logger.js';

/**
 * Acknowledge slash commands immediately, then make the normal reply API
 * complete the deferred interaction instead of leaving Discord's
 * "Lounge is thinking..." state visible forever.
 *
 * This listener deliberately runs before interactionCreate.js.
 */
export default {
  name: Events.InteractionCreate,
  async execute(interaction) {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.replied || interaction.deferred) return;

    // /apply submit must call showModal() as its first response.
    if (interaction.commandName === 'apply' && interaction.options.getSubcommand(false) === 'submit') return;

    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      interaction.__loungeSlashDeferred = true;
      logger.debug(`Slash command acknowledged: /${interaction.commandName}`);
    } catch (error) {
      logger.error(`Failed to acknowledge /${interaction.commandName}:`, error);
    }
  },
};
