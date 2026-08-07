import { Events } from 'discord.js';
import { logger, startupLog } from '../utils/logger.js';
import config from '../config/application.js';
import { reconcileReactionRoleMessages } from '../services/reactionRoleService.js';
import { reconcileVerificationPanels, reconcileReactionRolePanelHealth } from '../services/panelHealthService.js';

export default {
  name: Events.ClientReady,
  once: true,
  async execute(client) {
    try {
      client.user.setPresence(config.bot.presence);
      startupLog(`Ready! Logged in as ${client.user.tag}`);
      startupLog(`Serving ${client.guilds.cache.size} guild(s)`);
      startupLog(`Loaded ${client.commands.size} commands`);

      // Run health reconciliation independently so one broken panel cannot
      // prevent the bot from becoming ready.
      try {
        const summary = await reconcileReactionRoleMessages(client);
        startupLog(`Reaction roles: scanned ${summary.scannedMessages}, removed ${summary.removedMessages}, errors ${summary.errors}`);
      } catch (error) {
        logger.warn(`Reaction role reconciliation skipped: ${error.message}`);
      }

      try {
        const summary = await reconcileVerificationPanels(client);
        startupLog(`Verification panels: scanned ${summary.scannedGuilds}, healthy ${summary.healthyPanels}, deleted ${summary.deletedPanels}, errors ${summary.errors}`);
      } catch (error) {
        logger.warn(`Verification reconciliation skipped: ${error.message}`);
      }

      try {
        const summary = await reconcileReactionRolePanelHealth(client);
        startupLog(`Reaction role health: scanned ${summary.scannedPanels}, healthy ${summary.healthyPanels}, deleted ${summary.deletedPanels}, errors ${summary.errors}`);
      } catch (error) {
        logger.warn(`Reaction role health check skipped: ${error.message}`);
      }
    } catch (error) {
      logger.error('Error in optimized ready event:', error);
    }
  },
};
