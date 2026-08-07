import { Events, MessageFlags } from 'discord.js';
import { logger } from '../utils/logger.js';

/**
 * Discord requires an interaction acknowledgement within a few seconds.
 * The main interaction handler performs database/config/permission work first,
 * so slow requests could reach Discord's timeout and show "The application did
 * not respond". This listener runs before interactionCreate and defers normal
 * chat-input commands immediately.
 *
 * Commands that open a modal cannot be deferred. Add them here if more modal
 * commands are introduced.
 */
export default {
  name: Events.InteractionCreate,
  async execute(interaction) {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.replied || interaction.deferred) return;

    // /apply submit must call showModal() as its first acknowledgement.
    if (interaction.commandName === 'apply' && interaction.options.getSubcommand(false) === 'submit') return;

    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      logger.debug(`Early acknowledgement sent for /${interaction.commandName}`);
    } catch (error) {
      logger.error(`Failed to acknowledge /${interaction.commandName}:`, error);
    }
  },
};
