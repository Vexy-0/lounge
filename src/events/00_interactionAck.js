import { Events, MessageFlags } from 'discord.js';
import { logger } from '../utils/logger.js';

function stripReplyOnlyFlags(options) {
  if (!options || typeof options !== 'object') return options;
  const { ephemeral, ...rest } = options;
  // Ephemeral is selected when the interaction is deferred, so it must not be
  // sent again to editReply. Keeping components/embeds/content untouched.
  return rest;
}

/**
 * Acknowledge slash commands immediately and make every normal reply complete
 * the deferred interaction. Without this bridge Discord can remain on
 * "Lounge is thinking..." when a command calls interaction.reply() after the
 * interaction was already deferred.
 */
export default {
  name: Events.InteractionCreate,
  async execute(interaction) {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.replied || interaction.deferred) return;

    // /apply submit must call showModal() as its first response.
    if (interaction.commandName === 'apply' && interaction.options.getSubcommand(false) === 'submit') return;

    try {
      const originalReply = interaction.reply?.bind(interaction);
      if (originalReply && !interaction.__loungeReplyBridgeInstalled) {
        interaction.reply = async (options) => {
          if (interaction.deferred && !interaction.replied) {
            return interaction.editReply(stripReplyOnlyFlags(options));
          }
          if (interaction.replied) {
            return interaction.followUp(options);
          }
          return originalReply(options);
        };
        interaction.__loungeReplyBridgeInstalled = true;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      interaction.__loungeSlashDeferred = true;
      logger.debug(`Slash command acknowledged: /${interaction.commandName}`);
    } catch (error) {
      logger.error(`Failed to acknowledge /${interaction.commandName}:`, error);
    }
  },
};
