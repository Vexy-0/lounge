import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';
import { getGuildConfig } from '../services/config/guildConfig.js';
import { getBotMessage, isBotOwner, isCommandCategoryEnabled, isMaintenanceMode } from '../config/bot.js';
import botConfig from '../config/bot.js';
import { handleInteractionError, createError, ErrorTypes } from '../utils/errorHandler.js';
import { InteractionHelper } from '../utils/interactionHelper.js';
import { enforceAbuseProtection, formatCooldownDuration } from '../utils/abuseProtection.js';
import { isCommandEnabled } from '../services/commandAccessService.js';
import { resolveSlashAccessKey } from '../utils/messageAdapter.js';
import { enforceDefaultCommandPermissions } from '../utils/permissionGuard.js';

export default {
  name: Events.InteractionCreate,
  async execute(interaction, client) {
    const isChatInput = interaction.isChatInputCommand?.();
    if (!isChatInput) return;

    // Claim chat-input interactions synchronously so the legacy dispatcher
    // cannot race this handler and execute the same command twice.
    const originalIsChatInputCommand = interaction.isChatInputCommand.bind(interaction);
    interaction.__loungeOriginalIsChatInputCommand = originalIsChatInputCommand;
    interaction.isChatInputCommand = () => false;
    interaction.__loungeSlashClaimed = true;

    try {
      if (interaction.__loungeAckPromise) {
        await interaction.__loungeAckPromise.catch(() => {});
      }

      InteractionHelper.patchInteractionResponses(interaction);
      const command = client.commands.get(interaction.commandName);
      if (!command) {
        throw createError(
          `No command matching ${interaction.commandName} was found.`,
          ErrorTypes.CONFIGURATION,
          'Sorry, that command is not available right now.'
        );
      }

      if (isMaintenanceMode() && !isBotOwner(interaction.user.id)) {
        throw createError('Bot is in maintenance mode', ErrorTypes.CONFIGURATION, getBotMessage('maintenanceMode'));
      }

      if (!isCommandCategoryEnabled(command.category)) {
        throw createError(`Feature disabled for category ${command.category}`, ErrorTypes.CONFIGURATION, getBotMessage('commandDisabled'));
      }

      const defaultCooldownSec = Number(botConfig.commands?.defaultCooldown) || 0;
      if (defaultCooldownSec > 0 && !isBotOwner(interaction.user.id)) {
        const key = `${interaction.user.id}:${interaction.commandName}`;
        const expiresAt = client.cooldowns.get(key);
        if (expiresAt && Date.now() < expiresAt) {
          const remaining = Math.ceil((expiresAt - Date.now()) / 1000);
          throw createError('Command cooldown active', ErrorTypes.RATE_LIMIT, getBotMessage('cooldownActive', { time: `${remaining}s` }));
        }
        client.cooldowns.set(key, Date.now() + defaultCooldownSec * 1000);
      }

      const abuse = await enforceAbuseProtection(interaction, command, interaction.commandName);
      if (!abuse.allowed) {
        throw createError(
          'Command cooldown active',
          ErrorTypes.RATE_LIMIT,
          `This command is on cooldown. Please wait ${formatCooldownDuration(abuse.remainingMs)}.`
        );
      }

      let guildConfig = null;
      if (interaction.guild) {
        guildConfig = await getGuildConfig(client, interaction.guild.id);
        const accessKey = resolveSlashAccessKey(interaction);
        if (!(await isCommandEnabled(client, interaction.guild.id, accessKey, command.category))) {
          throw createError('Command disabled', ErrorTypes.CONFIGURATION, 'This command has been disabled for this server.');
        }
      }

      const permissionAllowed = await enforceDefaultCommandPermissions(interaction, command, {
        source: 'slashCommandDispatcher',
        guildConfig,
      });
      if (!permissionAllowed) return;

      logger.info(`Executing slash command /${interaction.commandName}`, {
        event: 'slash.dispatch',
        guildId: interaction.guildId,
        userId: interaction.user?.id,
        command: interaction.commandName,
      });

      await command.execute(interaction, guildConfig, client);
    } catch (error) {
      logger.error(`Slash command /${interaction.commandName} failed:`, error);
      try {
        await handleInteractionError(interaction, error, {
          type: 'command',
          commandName: interaction.commandName,
          source: 'slashCommandDispatcher',
        });
      } catch (responseError) {
        logger.error(`Failed to respond to /${interaction.commandName}:`, responseError);
      }
    }
  },
};
