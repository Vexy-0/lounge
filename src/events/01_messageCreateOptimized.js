import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';
import { getGuildConfig } from '../services/config/guildConfig.js';
import { getCommandPrefix, getBotMessage, isBotOwner, isCommandCategoryEnabled, isMaintenanceMode } from '../config/bot.js';
import { enforceAbuseProtection, formatCooldownDuration } from '../utils/abuseProtection.js';
import { createEmbed } from '../utils/embeds.js';
import { isCommandEnabled } from '../services/commandAccessService.js';
import { parsePrefixCommand } from '../utils/prefixParser.js';
import { supportsPrefixExecution, executePrefixCommand, resolvePrefixAccessKey } from '../utils/messageAdapter.js';
import { resolveCommandAlias, resolveSubcommandAlias } from '../config/commands/commandAliases.js';
import { getPrefixRestriction } from '../config/commands/prefixRestrictions.js';
import { refreshSticky } from '../services/stickyMessageService.js';
import { checkAutomod } from '../services/automodEngine.js';

export default {
  name: Events.MessageCreate,
  async execute(message, client) {
    if (message.author.bot || !message.guild) return;
    try {
      // Prefix commands get first priority and no longer wait for AutoMod/sticky.
      if (await handlePrefixCommand(message, client)) return;

      const automod = await checkAutomod(client, message);
      if (automod.blocked) return;

      // Sticky maintenance is intentionally last.
      await handleSticky(message, client);
    } catch (error) {
      logger.error('Error in optimized messageCreate:', error);
    }
  },
};

async function handlePrefixCommand(message, client) {
  const prefix = getCommandPrefix();
  const parsed = parsePrefixCommand(message.content, prefix);
  if (!parsed) return false;

  try {
    const guildConfig = await getGuildConfig(client, message.guild.id);
    const effectivePrefix = guildConfig?.prefix || prefix;
    const reparsed = effectivePrefix === prefix ? parsed : parsePrefixCommand(message.content, effectivePrefix);
    if (!reparsed) return false;

    const commandName = resolveCommandAlias(reparsed.commandName).toLowerCase();
    const args = reparsed.args;
    const command = client.commands.get(commandName);
    if (!command) return false;

    if (isMaintenanceMode() && !isBotOwner(message.author.id)) {
      await message.channel.send({ embeds: [createEmbed({ title: 'Maintenance Mode', description: getBotMessage('maintenanceMode'), color: 'warning' })] }).catch(() => {});
      return true;
    }
    if (!isCommandCategoryEnabled(command.category)) {
      await message.channel.send({ embeds: [createEmbed({ title: 'Feature Disabled', description: getBotMessage('commandDisabled'), color: 'error' })] }).catch(() => {});
      return true;
    }

    const restriction = getPrefixRestriction(command, args, resolveSubcommandAlias);
    if (!supportsPrefixExecution(command) || restriction.blocked) {
      if (restriction.blocked && restriction.reason) {
        await message.channel.send({ embeds: [createEmbed({ title: 'Slash Command Only', description: `${restriction.reason}\nUse \`/${commandName}\` instead.`, color: 'info' })] }).catch(() => {});
      }
      return true;
    }

    if (!(await isCommandEnabled(client, message.guild.id, resolvePrefixAccessKey(command.data, args), command.category))) {
      await message.channel.send({ embeds: [createEmbed({ title: 'Command Disabled', description: 'This command has been disabled for this server.', color: 'error' })] }).catch(() => {});
      return true;
    }

    const protection = await enforceAbuseProtection({ guildId: message.guild.id, user: message.author }, command, commandName);
    if (!protection.allowed) {
      await message.channel.send({ embeds: [createEmbed({ title: 'Command Cooldown', description: `This command is on cooldown. Please wait ${formatCooldownDuration(protection.remainingMs)} before trying again.`, color: 'error' })] }).catch(() => {});
      return true;
    }

    await executePrefixCommand(command, message, args, client, effectivePrefix, guildConfig);
    return true;
  } catch (error) {
    logger.error(`Error executing prefix command ${reparsedName(message, prefix)}:`, error);
    return true;
  }
}

function reparsedName(message, prefix) {
  try { return parsePrefixCommand(message.content, prefix)?.commandName || 'unknown'; } catch { return 'unknown'; }
}

async function handleSticky(message, client) {
  try {
    const parsed = parsePrefixCommand(message.content, getCommandPrefix());
    if (parsed) {
      const commandName = resolveCommandAlias(parsed.commandName).toLowerCase();
      if (commandName === 'sticky' || commandName === 'stickyremove') return;
    }
    await refreshSticky(client, message);
  } catch (error) {
    logger.error('Error handling sticky maintenance:', error);
  }
}
