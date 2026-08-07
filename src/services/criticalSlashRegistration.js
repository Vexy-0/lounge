import { SlashCommandBuilder } from 'discord.js';
import sticky from '../commands/Utility/sticky.js';
import stickyremove from '../commands/Utility/stickyremove.js';
import automod from '../commands/Moderation/automod.js';
import help from '../commands/Core/help.js';

const CRITICAL = [sticky, stickyremove, automod, help];

export async function registerCriticalSlashCommands(client, { clientId, guildId }) {
  if (!clientId) throw new Error('CLIENT_ID is required for slash commands.');
  if (!guildId) throw new Error('GUILD_ID is required for guild slash commands.');
  if (!client.user) throw new Error('Discord client is not logged in.');
  if (client.user.id !== clientId) {
    throw new Error(`CLIENT_ID mismatch: Railway CLIENT_ID is ${clientId}, but the logged-in bot is ${client.user.id}.`);
  }

  const commands = CRITICAL
    .filter(command => command?.data instanceof SlashCommandBuilder || typeof command?.data?.toJSON === 'function')
    .map(command => command.data.toJSON());

  const registered = await client.rest.put(
    `/applications/${clientId}/guilds/${guildId}/commands`,
    { body: commands },
  );

  const names = Array.isArray(registered) ? registered.map(command => command.name) : commands.map(command => command.name);
  const missing = ['sticky', 'stickyremove', 'automod', 'help'].filter(name => !names.includes(name));
  if (missing.length) throw new Error(`Discord did not return the critical commands after registration: ${missing.join(', ')}`);

  return names;
}
