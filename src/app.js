import 'dotenv/config';
import { Client, Collection, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, ActivityType, PermissionFlagsBits } from 'discord.js';

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
const stickies = new Map();
const stickyLocks = new Set();

function isManageMessages(member) {
  return member?.permissions?.has(PermissionFlagsBits.ManageMessages) === true;
}

function statusEmbed() {
  const uptime = Math.floor((Date.now() - startedAt) / 1000);
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
      '`/sticky` — Create/update a sticky message',
      '`/stickyremove` — Remove the sticky message',
      '',
      '**Prefix commands**',
      `\`${PREFIX}ping\` — Check latency`,
      `\`${PREFIX}status\` — Bot health/status`,
      `\`${PREFIX}help\` — Show this menu`,
      `\`${PREFIX}sticky <message>\` — Create/update a sticky message`,
      `\`${PREFIX}stickyremove\` — Remove the sticky message`,
    ].join('\n'));
}

async function sendSticky(channel, sticky) {
  const existing = stickies.get(channel.id);
  if (existing?.messageId) await channel.messages.delete(existing.messageId).catch(() => {});
  const sent = await channel.send({ content: sticky.content, allowedMentions: { parse: [] } });
  stickies.set(channel.id, { ...sticky, messageId: sent.id });
  return sent;
}

async function setSticky(channel, content, userId) {
  if (!channel?.isTextBased?.()) throw new Error('This command can only be used in a text channel.');
  if (!content?.trim()) throw new Error('Sticky message cannot be empty.');
  if (content.length > 2000) throw new Error('Sticky message must be 2000 characters or less.');
  if (stickyLocks.has(channel.id)) return false;

  stickyLocks.add(channel.id);
  try {
    await sendSticky(channel, { content: content.trim(), userId });
    return true;
  } finally {
    stickyLocks.delete(channel.id);
  }
}

async function removeSticky(channel) {
  if (!channel?.isTextBased?.()) return false;
  if (stickyLocks.has(channel.id)) return false;

  stickyLocks.add(channel.id);
  try {
    const existing = stickies.get(channel.id);
    if (!existing) return false;
    if (existing.messageId) await channel.messages.delete(existing.messageId).catch(() => {});
    stickies.delete(channel.id);
    return true;
  } finally {
    stickyLocks.delete(channel.id);
  }
}

const commands = [
  {
    data: new SlashCommandBuilder().setName('ping').setDescription('Check the bot latency.'),
    execute: async (interaction) => interaction.reply(`🏓 Pong! ${client.ws.ping}ms`),
  },
  {
    data: new SlashCommandBuilder().setName('status').setDescription('Show bot status.'),
    execute: async (interaction) => interaction.reply({ embeds: [statusEmbed()] }),
  },
  {
    data: new SlashCommandBuilder().setName('help').setDescription('Show available commands.'),
    execute: async (interaction) => interaction.reply({ embeds: [helpEmbed()] }),
  },
  {
    data: new SlashCommandBuilder()
      .setName('sticky')
      .setDescription('Create or replace the sticky message in this channel.')
      .addStringOption(option => option
        .setName('message')
        .setDescription('The message to keep at the bottom of the channel.')
        .setRequired(true)
        .setMaxLength(2000))
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages.toString()),
    execute: async (interaction) => {
      if (!isManageMessages(interaction.member)) {
        return interaction.reply({ content: '❌ You need **Manage Messages** to use this command.', ephemeral: true });
      }
      await interaction.deferReply({ ephemeral: true });
      const created = await setSticky(interaction.channel, interaction.options.getString('message', true), interaction.user.id);
      await interaction.editReply(created ? '✅ Sticky message set for this channel.' : '⚠️ A sticky update is already in progress.');
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('stickyremove')
      .setDescription('Remove the sticky message from this channel.')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages.toString()),
    execute: async (interaction) => {
      if (!isManageMessages(interaction.member)) {
        return interaction.reply({ content: '❌ You need **Manage Messages** to use this command.', ephemeral: true });
      }
      await interaction.deferReply({ ephemeral: true });
      const removed = await removeSticky(interaction.channel);
      await interaction.editReply(removed ? '✅ Sticky message removed.' : 'ℹ️ There is no sticky message in this channel.');
    },
  },
];

for (const command of commands) client.commands.set(command.data.name, command);

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  const body = commands.map(command => command.data.toJSON());

  // Commands are intentionally guild-only. Clearing global commands prevents
  // old global registrations from appearing beside the current commands.
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body });
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: [] });

  console.log(`Registered ${body.length} guild slash commands.`);
  console.log(`Cleared global slash commands. Active: ${body.map(command => `/${command.name}`).join(', ')}`);
}

client.once('ready', async () => {
  client.user.setPresence({
    activities: [{ name: 'Lounge', type: ActivityType.Watching }],
    status: 'dnd',
  });

  console.log(`Logged in as ${client.user.tag} (${client.user.id})`);
  console.log('Presence: Do Not Disturb • Watching Lounge');

  try {
    await registerCommands();
    console.log('Slash command registration completed successfully.');
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
    if (interaction.replied || interaction.deferred) await interaction.editReply(response).catch(() => interaction.followUp(response).catch(() => {}));
    else await interaction.reply(response).catch(() => {});
  }
});

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;

  if (message.content.startsWith(PREFIX)) {
    const raw = message.content.slice(PREFIX.length).trim();
    const [name, ...args] = raw.split(/\s+/);
    const commandName = (name || '').toLowerCase();

    if (commandName === 'ping') {
      await message.reply(`🏓 Pong! ${client.ws.ping}ms`).catch(() => {});
      return;
    }
    if (commandName === 'status') {
      await message.reply({ embeds: [statusEmbed()] }).catch(() => {});
      return;
    }
    if (commandName === 'help') {
      await message.reply({ embeds: [helpEmbed()] }).catch(() => {});
      return;
    }
    if (commandName === 'sticky') {
      if (!isManageMessages(message.member)) {
        await message.reply('❌ You need **Manage Messages** to use this command.').catch(() => {});
        return;
      }
      const content = args.join(' ').trim();
      if (!content) {
        await message.reply(`❌ Usage: \`${PREFIX}sticky <message>\``).catch(() => {});
        return;
      }
      if (content.length > 2000) {
        await message.reply('❌ Sticky message must be 2000 characters or less.').catch(() => {});
        return;
      }
      const created = await setSticky(message.channel, content, message.author.id).catch(error => {
        console.error('Prefix sticky failed:', error);
        return false;
      });
      await message.reply(created ? '✅ Sticky message set for this channel.' : '⚠️ A sticky update is already in progress.').catch(() => {});
      return;
    }
    if (commandName === 'stickyremove') {
      if (!isManageMessages(message.member)) {
        await message.reply('❌ You need **Manage Messages** to use this command.').catch(() => {});
        return;
      }
      const removed = await removeSticky(message.channel).catch(error => {
        console.error('Prefix stickyremove failed:', error);
        return false;
      });
      await message.reply(removed ? '✅ Sticky message removed.' : 'ℹ️ There is no sticky message in this channel.').catch(() => {});
      return;
    }
    return;
  }

  const sticky = stickies.get(message.channel.id);
  if (!sticky || stickyLocks.has(message.channel.id)) return;

  stickyLocks.add(message.channel.id);
  try {
    if (sticky.messageId === message.id) return;
    await message.channel.messages.delete(sticky.messageId).catch(() => {});
    const sent = await message.channel.send({ content: sticky.content, allowedMentions: { parse: [] } });
    stickies.set(message.channel.id, { ...sticky, messageId: sent.id });
  } catch (error) {
    console.error(`Sticky bump failed in ${message.channel.id}:`, error);
  } finally {
    stickyLocks.delete(message.channel.id);
  }
});

process.on('unhandledRejection', error => console.error('Unhandled rejection:', error));
process.on('uncaughtException', error => console.error('Uncaught exception:', error));

await client.login(TOKEN);
