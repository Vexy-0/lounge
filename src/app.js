import 'dotenv/config';
import { Client, GatewayIntentBits, ActivityType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';

const TOKEN = process.env.DISCORD_TOKEN || process.env.TOKEN;
const PREFIX = process.env.PREFIX || '!';
if (!TOKEN) throw new Error('Missing DISCORD_TOKEN/TOKEN');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

const commands = [
  new SlashCommandBuilder().setName('ping').setDescription('Check bot latency.'),
  new SlashCommandBuilder().setName('status').setDescription('Show bot status.'),
  new SlashCommandBuilder().setName('help').setDescription('Show Lounge commands.'),
  new SlashCommandBuilder().setName('sticky').setDescription('Create a sticky message.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages.toString())
    .addStringOption(o => o.setName('message').setDescription('Sticky message').setRequired(true).setMaxLength(2000)),
  new SlashCommandBuilder().setName('stickyremove').setDescription('Remove the sticky message.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages.toString()),
  new SlashCommandBuilder().setName('automod').setDescription('AutoMod settings.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages.toString())
    .addSubcommand(s => s.setName('status').setDescription('Show AutoMod status.'))
    .addSubcommand(s => s.setName('on').setDescription('Enable AutoMod.'))
    .addSubcommand(s => s.setName('off').setDescription('Disable AutoMod.')),
  new SlashCommandBuilder().setName('logging').setDescription('Logging settings.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild.toString())
    .addSubcommand(s => s.setName('status').setDescription('Show logging status.')),
].map(c => c.toJSON());

const stickies = new Map();
const guildSettings = new Map();
const startedAt = Date.now();

function settings(guildId) {
  if (!guildSettings.has(guildId)) guildSettings.set(guildId, { automod: true, logging: false });
  return guildSettings.get(guildId);
}

function statusMessage() {
  return `🟢 **Lounge Online**\n🏓 Ping: **${client.ws.ping}ms**\n⏱️ Uptime: **${Math.floor((Date.now() - startedAt) / 1000)}s**\n🏠 Servers: **${client.guilds.cache.size}**`;
}

async function safeReply(interaction, payload) {
  if (interaction.replied) return interaction.editReply(payload);
  if (interaction.deferred) return interaction.editReply(payload);
  return interaction.reply(payload);
}

async function handleSlash(interaction) {
  if (!interaction.inGuild()) return safeReply(interaction, '❌ This command can only be used in a server.');

  switch (interaction.commandName) {
    case 'ping':
      return safeReply(interaction, `🏓 Pong! **${client.ws.ping}ms**`);
    case 'status':
      return safeReply(interaction, statusMessage());
    case 'help':
      return safeReply(interaction, [
        '**Lounge Commands**',
        '`/ping` · `/status` · `/help`',
        '`/sticky` · `/stickyremove`',
        '`/automod status|on|off`',
        '`/logging status`',
        '',
        `Prefix: \`${PREFIX}ping\` · \`${PREFIX}status\` · \`${PREFIX}help\``
      ].join('\n'));
    case 'sticky': {
      const content = interaction.options.getString('message', true);
      const old = stickies.get(interaction.channelId);
      if (old) await interaction.channel.messages.delete(old).catch(() => {});
      const sent = await interaction.channel.send({ content, allowedMentions: { parse: [] } });
      stickies.set(interaction.channelId, sent.id);
      return safeReply(interaction, '📌 Sticky message set.');
    }
    case 'stickyremove': {
      const old = stickies.get(interaction.channelId);
      if (!old) return safeReply(interaction, 'There is no sticky message here.');
      await interaction.channel.messages.delete(old).catch(() => {});
      stickies.delete(interaction.channelId);
      return safeReply(interaction, '🗑️ Sticky removed.');
    }
    case 'automod': {
      const cfg = settings(interaction.guildId);
      const sub = interaction.options.getSubcommand();
      if (sub === 'status') return safeReply(interaction, `🛡️ AutoMod: **${cfg.automod ? 'ON' : 'OFF'}**`);
      cfg.automod = sub === 'on';
      return safeReply(interaction, `🛡️ AutoMod **${cfg.automod ? 'enabled' : 'disabled'}**.`);
    }
    case 'logging': {
      const cfg = settings(interaction.guildId);
      return safeReply(interaction, `📋 Logging: **${cfg.logging ? 'ON' : 'OFF'}**`);
    }
    default:
      return safeReply(interaction, '❌ Unknown command.');
  }
}

client.once('ready', async () => {
  console.log(`[Lounge] Logged in as ${client.user.tag} (${client.user.id})`);
  client.user.setPresence({ status: 'dnd', activities: [{ name: 'Lounge', type: ActivityType.Watching }] });

  // Register commands PER SERVER. This avoids stale global commands and makes new commands available immediately.
  for (const guild of client.guilds.cache.values()) {
    try {
      await guild.commands.set(commands);
      console.log(`[Lounge] Registered ${commands.length} guild commands in ${guild.name} (${guild.id})`);
    } catch (error) {
      console.error(`[Lounge] Failed registering commands in ${guild.id}:`, error);
    }
  }

  // Remove old global commands so they cannot conflict with the guild commands.
  try {
    await client.application.commands.set([]);
    console.log('[Lounge] Cleared global commands.');
  } catch (error) {
    console.error('[Lounge] Failed clearing global commands:', error);
  }

  console.log(`[Lounge] Ready in ${client.guilds.cache.size} server(s).`);
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  console.log(`[Lounge] Interaction received: /${interaction.commandName} from ${interaction.user.tag} in ${interaction.guildId}`);
  try {
    // Acknowledge immediately. This is intentionally before any command work.
    await interaction.deferReply();
    await handleSlash(interaction);
  } catch (error) {
    console.error(`[Lounge] Slash command /${interaction.commandName} failed:`, error);
    try {
      await safeReply(interaction, '❌ Something went wrong while running that command.');
    } catch (replyError) {
      console.error('[Lounge] Could not send slash-command error:', replyError);
    }
  }
});

client.on('messageCreate', async message => {
  if (!message.guild || message.author.bot || !message.content.startsWith(PREFIX)) return;
  const [command, ...args] = message.content.slice(PREFIX.length).trim().split(/\s+/);
  if (!command) return;
  try {
    switch (command.toLowerCase()) {
      case 'ping': await message.reply(`🏓 Pong! **${client.ws.ping}ms**`); break;
      case 'status': await message.reply(statusMessage()); break;
      case 'help': await message.reply('**Lounge:** `!ping` `!status` `!help` `!sticky <message>` `!stickyremove`'); break;
      case 'sticky': {
        const content = args.join(' ');
        if (!content) return message.reply(`Usage: ${PREFIX}sticky <message>`);
        const old = stickies.get(message.channelId);
        if (old) await message.channel.messages.delete(old).catch(() => {});
        const sent = await message.channel.send({ content, allowedMentions: { parse: [] } });
        stickies.set(message.channelId, sent.id);
        await message.reply('📌 Sticky message set.');
        break;
      }
      case 'stickyremove': {
        const old = stickies.get(message.channelId);
        if (!old) return message.reply('There is no sticky message here.');
        await message.channel.messages.delete(old).catch(() => {});
        stickies.delete(message.channelId);
        await message.reply('🗑️ Sticky removed.');
        break;
      }
      default: break;
    }
  } catch (error) {
    console.error(`[Lounge] Prefix command ${command} failed:`, error);
    await message.reply('❌ Something went wrong while running that command.').catch(() => {});
  }

  const sticky = stickies.get(message.channelId);
  if (sticky && message.id !== sticky) {
    await message.channel.messages.delete(sticky).catch(() => {});
    const sent = await message.channel.send({ content: (await message.channel.messages.fetch(sticky).catch(() => null))?.content || '', allowedMentions: { parse: [] } }).catch(() => null);
    if (sent) stickies.set(message.channelId, sent.id);
  }
});

client.on('error', error => console.error('[Lounge] Discord client error:', error));
client.on('warn', warning => console.warn('[Lounge] Discord warning:', warning));
client.on('shardError', error => console.error('[Lounge] Discord shard error:', error));
process.on('unhandledRejection', error => console.error('[Lounge] Unhandled rejection:', error));
process.on('uncaughtException', error => console.error('[Lounge] Uncaught exception:', error));

client.login(TOKEN).catch(error => {
  console.error('[Lounge] Login failed:', error);
  process.exit(1);
});
