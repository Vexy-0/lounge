import { Events, MessageFlags } from 'discord.js';
import { logger } from '../utils/logger.js';

function stripReplyOnlyFlags(options) {
  if (!options || typeof options !== 'object') return options;
  const { ephemeral, ...rest } = options;
  return rest;
}

/**
 * Acknowledge slash commands immediately and expose the acknowledgement promise
 * so later InteractionCreate listeners can wait for Discord's initial response.
 * EventEmitter does not await one listener before starting the next listener,
 * so storing the promise prevents a race where a command calls reply() before
 * deferReply() has completed.
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

      interaction.__loungeAckPromise = interaction.deferReply({ flags: MessageFlags.Ephemeral })
        .then(() => {
          interaction.__loungeSlashDeferred = true;
          logger.debug(`Slash command acknowledged: /${interaction.commandName}`);
        })
        .catch(error => {
          logger.error(`Failed to acknowledge /${interaction.commandName}:`, error);
          throw error;
        });

      await interaction.__loungeAckPromise;
    } catch (error) {
      // Keep the promise rejected/visible to downstream handlers, but do not
      // throw from the acknowledgement listener itself and create an unhandled
      // interaction event failure.
      interaction.__loungeAckPromise = Promise.resolve();
      logger.error(`Slash acknowledgement failed for /${interaction.commandName}:`, error);
    }
  },
};