import 'dotenv/config';
import { Client, Collection, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder } from 'discord.js';

const TOKEN = process.env.DISCORD_TOKEN || process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID || process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const PREFIX = process.env.PREFIX || '!';

if (!TOKEN) throw new Error('Missing DISCORD_TOKEN (or TOKEN).');
if (!CLIENT_ID) throw new Error('Missing CLIENT_ID (Discord Application ID).');
if (!GUILD_ID) throw new Error('Missing GUILD_ID (Discord Server ID).');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

client.commands = new Collection();
const startedAt = Date.now();

// This is the complete command allowlist for the fresh bot.
// Discord's bulk overwrite endpoint removes stale commands that are not here.
const commands = [
  {
    data: new SlashCommandBuilder().setName('ping').setDescription('Check the bot latency.'),
    execute: async (interaction) => interaction.reply(`🏓 Pong! ${client.ws.ping}ms`),
  },
  {
    data: new SlashCommandBuilder().setName('status').setDescription('Show bot status.'),
    execute: async (interaction) => {
      const uptime = Math.floor((Date.now() - startedAt) / 1000);
      await interaction.reply({ embeds: [statusEmbed(uptime)] });
    },
  },
  {
    data: new SlashCommandBuilder().setName('help').setDescription('Show available commands.'),
    execute: async (interaction) => interaction.reply({ embeds: [helpEmbed()] }),
  },
];

for (const command of commands) client.commands.set(command.data.name, command);

function statusEmbed(uptime) {
  return new EmbedBuilder()
    .setTitle('Lounge Status')
    .setDescription('The bot is online and responding normally.')
    .addFields(
      { name: 'Status', value: '🟢 Online', inline: true },
      { name: 'Latency', value: `${client.ws.ping}ms`, inline: true },
      { name: 'Uptime', value: `${uptime}s`, inline: true },
      { name: 'Servers', value: `${client.guilds.cache.size}`, inline: true },
      { name: 'Memory', value: `${Math.round(process.memoryUsage().rss / 1024 / 1024)} MB`, inline: true },
    );
}

function helpEmbed() {
  return new EmbedBuilder()
    .setTitle('Lounge Commands')
    .setDescription([
      '**Slash commands**',
      '`/ping` — Check latency',
      '`/status` — Bot health/status',
      '`/help` — Show this menu',
      '',
      '**Prefix commands**',
      '`!ping` — Check latency',
      '`!status` — Bot health/status',
      '`!help` — Show this menu',
    ].join('\n'));
}

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  const body = commands.map(command => command.data.toJSON());

  // Clear stale guild commands immediately.
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body });

  // Older versions of Lounge registered commands globally. Clear that old
  // global command set too, otherwise Discord can continue showing them.
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body });

  console.log(`Registered exactly ${body.length} slash commands in the guild and globally.`);
  console.log(`Active slash commands: ${body.map(command => `/${command.name}`).join(', ')}`);
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag} (${client.user.id})`);
  try {
    await registerCommands();
    console.log('Slash command cleanup/registration completed successfully.');
  } catch (error) {
    console.error('Slash command registration failed:', error);
  }
  console.log(`Lounge is online. Prefix: ${PREFIX}`);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const command = client.commands.get(interaction.commandName);
  if (!command) {
    await interaction.reply({ content: '❌ That command is no longer available.', ephemeral: true }).catch(() => {});
    return;
  }

  try {
    await command.execute(interaction);
  } catch (error) {
    console.error(`Command /${interaction.commandName} failed:`, error);
    const response = { content: '❌ Something went wrong while running that command.', ephemeral: true };
    if (interaction.replied || interaction.deferred) await interaction.followUp(response).catch(() => {});
    else await interaction.reply(response).catch(() => {});
  }
});

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;
  if (!message.content.startsWith(PREFIX)) return;

  const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const name = (args.shift() || '').toLowerCase();
  if (!name) return;

  const command = client.commands.get(name);
  if (!command) return;

  try {
    if (name === 'ping') await message.reply(`🏓 Pong! ${client.ws.ping}ms`);
    else if (name === 'status') await message.reply({ embeds: [statusEmbed(Math.floor((Date.now() - startedAt) / 1000))] });
    else if (name === 'help') await message.reply({ embeds: [helpEmbed()] });
  } catch (error) {
    console.error(`Prefix command ${PREFIX}${name} failed:`, error);
  }
});

process.on('unhandledRejection', error => console.error('Unhandled rejection:', error));
process.on('uncaughtException', error => console.error('Uncaught exception:', error));

await client.login(TOKEN);
