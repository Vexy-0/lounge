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
    throw new Error(`CLIENT_ID mismatch: configured ${clientId}, logged-in bot is ${client.user.id}.`);
  }

  const criticalCommands = CRITICAL
    .filter(command => command?.data && typeof command.data.toJSON === 'function')
    .map(command => command.data.toJSON());

  // The Discord PUT endpoint is a BULK OVERWRITE endpoint. Sending only the
  // four critical commands here would delete every other command registered
  // by commandLoader. Merge with the existing guild command set first.
  const existing = await client.rest.get(
    `/applications/${clientId}/guilds/${guildId}/commands`,
  );

  const byName = new Map(
    (Array.isArray(existing) ? existing : []).map(command => [command.name, command]),
  );

  for (const command of criticalCommands) {
    byName.set(command.name, command);
  }

  const merged = [...byName.values()];
  if (merged.length > 100) {
    throw new Error(`Discord allows at most 100 top-level application commands per guild; ${merged.length} are configured.`);
  }

  const registered = await client.rest.put(
    `/applications/${clientId}/guilds/${guildId}/commands`,
    { body: merged },
  );

  const names = Array.isArray(registered) ? registered.map(command => command.name) : merged.map(command => command.name);
  const missing = ['sticky', 'stickyremove', 'automod', 'help'].filter(name => !names.includes(name));
  if (missing.length) {
    throw new Error(`Discord did not return the critical commands after registration: ${missing.join(', ')}`);
  }

  return names;
}
