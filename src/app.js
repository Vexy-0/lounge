import 'dotenv/config';
import {
  ActivityType,
  ChannelType,
  Client,
  GatewayIntentBits,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import fs from 'node:fs/promises';
import path from 'node:path';

const TOKEN = process.env.DISCORD_TOKEN || process.env.TOKEN;
const PREFIX = (process.env.PREFIX || '!').trim() || '!';

if (!TOKEN) throw new Error('Missing DISCORD_TOKEN in Railway variables.');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const startedAt = Date.now();
const settingsFile = path.join(process.cwd(), 'data', 'guild-settings.json');
const settingsCache = new Map();
const stickies = new Map();

const commands = [
  new SlashCommandBuilder().setName('ping').setDescription('Check Lounge latency.'),
  new SlashCommandBuilder().setName('status').setDescription('Show Lounge status.'),
  new SlashCommandBuilder().setName('help').setDescription('Show Lounge commands.'),
  new SlashCommandBuilder()
    .setName('sticky')
    .setDescription('Create a sticky message in this channel.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages.toString())
    .addStringOption(o => o.setName('message').setDescription('Message to keep at the bottom.').setRequired(true).setMaxLength(2000)),
  new SlashCommandBuilder()
    .setName('stickyremove')
    .setDescription('Remove the sticky message from this channel.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages.toString()),
  new SlashCommandBuilder()
    .setName('automod')
    .setDescription('Manage Lounge AutoMod.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild.toString())
    .addSubcommand(s => s.setName('status').setDescription('Show AutoMod status.'))
    .addSubcommand(s => s.setName('on').setDescription('Enable AutoMod.'))
    .addSubcommand(s => s.setName('off').setDescription('Disable AutoMod.'))
    .addSubcommand(s => s.setName('gifonly').setDescription('Allow a user or role to send GIFs only.')
      .addStringOption(o => o.setName('action').setDescription('Add or remove.').setRequired(true)
        .addChoices({ name: 'add', value: 'add' }, { name: 'remove', value: 'remove' }))
      .addMentionableOption(o => o.setName('target').setDescription('User or role.').setRequired(true))),
  new SlashCommandBuilder()
    .setName('logging')
    .setDescription('Manage Lounge server logs.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild.toString())
    .addSubcommand(s => s.setName('setup').setDescription('Create the logging category and channels.'))
    .addSubcommand(s => s.setName('status').setDescription('Show logging status.')),
].map(c => c.toJSON());

function defaultSettings() {
  return {
    automod: true,
    gifOnlyRoles: [],
    gifOnlyUsers: [],
    logging: {},
  };
}

function getSettings(guildId) {
  if (!settingsCache.has(guildId)) settingsCache.set(guildId, defaultSettings());
  const cfg = settingsCache.get(guildId);
  cfg.gifOnlyRoles = Array.isArray(cfg.gifOnlyRoles) ? cfg.gifOnlyRoles : [];
  cfg.gifOnlyUsers = Array.isArray(cfg.gifOnlyUsers) ? cfg.gifOnlyUsers : [];
  cfg.logging = cfg.logging && typeof cfg.logging === 'object' ? cfg.logging : {};
  cfg.automod = cfg.automod !== false;
  return cfg;
}

async function loadSettings() {
  try {
    const raw = await fs.readFile(settingsFile, 'utf8');
    const parsed = JSON.parse(raw);
    for (const [guildId, cfg] of Object.entries(parsed)) settingsCache.set(guildId, { ...defaultSettings(), ...cfg });
    console.log(`[Lounge] Loaded settings for ${settingsCache.size} server(s).`);
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('[Lounge] Settings load error:', error);
  }
}

let saveTimer = null;
function saveSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await fs.mkdir(path.dirname(settingsFile), { recursive: true });
      await fs.writeFile(settingsFile, JSON.stringify(Object.fromEntries(settingsCache), null, 2));
    } catch (error) {
      console.error('[Lounge] Settings save error:', error);
    }
  }, 150);
}

function urls(text) {
  return text.match(/https?:\/\/[^\s<>]+/gi) || [];
}

function isGifUrl(value) {
  try {
    const u = new URL(value);
    const host = u.hostname.toLowerCase();
    const gifHosts = [
      'giphy.com', 'media.giphy.com',
      'tenor.com', 'media.tenor.com',
      'klipy.com', 'klipy.co',
      'redgifs.com', 'gfycat.com',
      'imgur.com', 'i.imgur.com',
      'cdn.discordapp.com', 'media.discordapp.net',
    ];
    return gifHosts.some(h => host === h || host.endsWith(`.${h}`)) || /\.gif(?:$|[?#])/i.test(u.pathname + u.search);
  } catch {
    return false;
  }
}

function gifOnlyMember(message, cfg) {
  if (cfg.gifOnlyUsers.includes(message.author.id)) return true;
  return Boolean(message.member?.roles.cache.some(role => cfg.gifOnlyRoles.includes(role.id)));
}

function invite(text) {
  return /(?:discord\.gg|discord(?:app)?\.com\/invite)\/[^\s]+/i.test(text);
}

function isGifMessage(message) {
  const attachments = [...message.attachments.values()];
  if (attachments.length) {
    if (!attachments.every(a => (a.contentType || '').toLowerCase() === 'image/gif' || /\.gif(?:$|[?#])/i.test(a.name || '') || isGifUrl(a.url))) return false;
  }
  const links = urls(message.content);
  return attachments.length > 0 || (links.length > 0 && links.every(isGifUrl));
}

async function safeDelete(message) {
  try { await message.delete(); } catch {}
}

async function sendInteraction(interaction, content, ephemeral = false) {
  const payload = typeof content === 'string' ? { content } : content;
  if (interaction.deferred || interaction.replied) return interaction.editReply(payload);
  return interaction.reply({ ...payload, ephemeral });
}

function statusText() {
  return [
    '🟢 **Lounge Online**',
    `🏓 Ping: **${client.ws.ping}ms**`,
    `⏱️ Uptime: **${Math.floor((Date.now() - startedAt) / 1000)}s**`,
    `🏠 Servers: **${client.guilds.cache.size}**`,
  ].join('\n');
}

async function registerCommandsForGuild(guild) {
  try {
    await guild.commands.set(commands);
    console.log(`[Lounge] Commands registered in ${guild.name} (${guild.id}).`);
  } catch (error) {
    console.error(`[Lounge] Could not register commands in ${guild.id}:`, error);
  }
}

async function clearGlobalCommands() {
  try {
    await client.application.commands.set([]);
    console.log('[Lounge] Global command registry cleared.');
  } catch (error) {
    console.error('[Lounge] Global command cleanup failed:', error);
  }
}

async function setupLogging(guild) {
  const cfg = getSettings(guild.id);
  const existingCategory = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === 'lounge logs');
  const category = existingCategory || await guild.channels.create({ name: 'Lounge Logs', type: ChannelType.GuildCategory, reason: 'Lounge logging setup' });
  const definitions = {
    messages: '📝・message-logs',
    moderation: '🛡️・moderation-logs',
    members: '👤・member-logs',
    voice: '🔊・voice-logs',
    server: '⚙️・server-logs',
    roles: '🎭・role-logs',
  };
  const result = {};
  for (const [key, name] of Object.entries(definitions)) {
    const existing = guild.channels.cache.find(c => c.parentId === category.id && c.name === name && c.type === ChannelType.GuildText);
    const channel = existing || await guild.channels.create({ name, type: ChannelType.GuildText, parent: category.id, reason: 'Lounge logging setup' });
    result[key] = channel.id;
  }
  cfg.logging = result;
  saveSettings();
  return result;
}

async function executeSlash(interaction) {
  const name = interaction.commandName;
  if (name === 'ping') return interaction.editReply(`🏓 Pong! **${client.ws.ping}ms**`);
  if (name === 'status') return interaction.editReply(statusText());
  if (name === 'help') return interaction.editReply([
    '**Lounge Commands**',
    '`/ping` · `/status` · `/help`',
    '`/sticky` · `/stickyremove`',
    '`/automod status|on|off|gifonly`',
    '`/logging setup|status`',
    '',
    `Prefix: \`${PREFIX}ping\` · \`${PREFIX}status\` · \`${PREFIX}help\``,
  ].join('\n'));

  if (name === 'sticky' || name === 'stickyremove') {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages)) return interaction.editReply('❌ You need **Manage Messages**.');
    const channel = interaction.channel;
    if (!channel?.isTextBased()) return interaction.editReply('❌ This command can only be used in a text channel.');
    if (name === 'stickyremove') {
      const old = stickies.get(channel.id);
      if (!old) return interaction.editReply('There is no sticky message here.');
      await channel.messages.delete(old.messageId).catch(() => {});
      stickies.delete(channel.id);
      return interaction.editReply('🗑️ Sticky removed.');
    }
    const content = interaction.options.getString('message', true);
    const old = stickies.get(channel.id);
    if (old) await channel.messages.delete(old.messageId).catch(() => {});
    const sent = await channel.send({ content, allowedMentions: { parse: [] } });
    stickies.set(channel.id, { content, messageId: sent.id });
    return interaction.editReply('📌 Sticky message set.');
  }

  if (name === 'automod') {
    const cfg = getSettings(interaction.guildId);
    const sub = interaction.options.getSubcommand();
    if (sub === 'status') return interaction.editReply(`🛡️ AutoMod: **${cfg.automod ? 'ON' : 'OFF'}**\n🎞️ GIF-only roles: **${cfg.gifOnlyRoles.length}**\n👤 GIF-only users: **${cfg.gifOnlyUsers.length}**`);
    if (sub === 'on' || sub === 'off') {
      cfg.automod = sub === 'on';
      saveSettings();
      return interaction.editReply(`🛡️ AutoMod **${cfg.automod ? 'enabled' : 'disabled'}**.`);
    }
    const target = interaction.options.getMentionable('target', true);
    const action = interaction.options.getString('action', true);
    const list = target.user ? cfg.gifOnlyUsers : cfg.gifOnlyRoles;
    if (action === 'add' && !list.includes(target.id)) list.push(target.id);
    if (action === 'remove') {
      const i = list.indexOf(target.id);
      if (i >= 0) list.splice(i, 1);
    }
    saveSettings();
    return interaction.editReply(`🎞️ GIF-only **${action}**: <@${target.id}>`);
  }

  if (name === 'logging') {
    const cfg = getSettings(interaction.guildId);
    const sub = interaction.options.getSubcommand();
    if (sub === 'status') return interaction.editReply(`📋 Logging: **${Object.keys(cfg.logging).length ? 'SET UP' : 'NOT SET UP'}**`);
    await setupLogging(interaction.guild);
    return interaction.editReply('✅ Lounge logging channels are ready.');
  }

  return interaction.editReply('❌ Unknown command.');
}

client.once('ready', async () => {
  await loadSettings();
  client.user.setPresence({ status: 'dnd', activities: [{ name: 'Lounge', type: ActivityType.Watching }] });
  console.log(`[Lounge] Logged in as ${client.user.tag} (${client.user.id}).`);
  await clearGlobalCommands();
  for (const guild of client.guilds.cache.values()) {
    await registerCommandsForGuild(guild);
    getSettings(guild.id);
  }
  saveSettings();
  console.log(`[Lounge] READY — ${client.guilds.cache.size} server(s).`);
});

client.on('guildCreate', async guild => {
  console.log(`[Lounge] Joined ${guild.name} (${guild.id}).`);
  getSettings(guild.id);
  saveSettings();
  await registerCommandsForGuild(guild);
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  console.log(`[Lounge] Interaction /${interaction.commandName} from ${interaction.user.tag} in ${interaction.guildId || 'DM'}.`);
  if (!interaction.inGuild()) {
    await interaction.reply({ content: '❌ This command can only be used in a server.', ephemeral: true }).catch(() => {});
    return;
  }
  try {
    // Acknowledge immediately. executeSlash ONLY edits the already-created reply.
    await interaction.deferReply();
    await executeSlash(interaction);
  } catch (error) {
    console.error(`[Lounge] Slash /${interaction.commandName} failed:`, error);
    await sendInteraction(interaction, { content: '❌ Something went wrong while running that command.' }).catch(() => {});
  }
});

client.on('messageCreate', async message => {
  if (!message.guild || message.author.bot) return;
  const cfg = getSettings(message.guild.id);

  // GIF-only is strictly opt-in. It never applies to ordinary members.
  if (cfg.automod && gifOnlyMember(message, cfg)) {
    if (!isGifMessage(message)) {
      await safeDelete(message);
      return;
    }
    // A valid GIF-only message is allowed and skips all other URL moderation.
  }

  // Prefix commands.
  if (message.content.startsWith(PREFIX)) {
    const parts = message.content.slice(PREFIX.length).trim().split(/\s+/);
    const command = (parts.shift() || '').toLowerCase();
    const args = parts;
    try {
      if (command === 'ping') await message.reply(`🏓 Pong! **${client.ws.ping}ms**`);
      else if (command === 'status') await message.reply(statusText());
      else if (command === 'help') await message.reply(`**Lounge:** \`${PREFIX}ping\` \`${PREFIX}status\` \`${PREFIX}help\` \`${PREFIX}sticky <message>\` \`${PREFIX}stickyremove\` \`${PREFIX}automod gifonly add|remove @user/@role\` \`${PREFIX}logging setup|status\``);
      else if (command === 'sticky') {
        if (!message.member.permissions.has(PermissionFlagsBits.ManageMessages)) return message.reply('❌ You need **Manage Messages**.');
        const content = args.join(' ');
        if (!content) return message.reply(`Usage: ${PREFIX}sticky <message>`);
        const old = stickies.get(message.channelId);
        if (old) await message.channel.messages.delete(old.messageId).catch(() => {});
        const sent = await message.channel.send({ content, allowedMentions: { parse: [] } });
        stickies.set(message.channelId, { content, messageId: sent.id });
        await message.reply('📌 Sticky message set.');
      } else if (command === 'stickyremove') {
        if (!message.member.permissions.has(PermissionFlagsBits.ManageMessages)) return message.reply('❌ You need **Manage Messages**.');
        const old = stickies.get(message.channelId);
        if (!old) return message.reply('There is no sticky message here.');
        await message.channel.messages.delete(old.messageId).catch(() => {});
        stickies.delete(message.channelId);
        await message.reply('🗑️ Sticky removed.');
      } else if (command === 'automod') {
        if (!message.member.permissions.has(PermissionFlagsBits.ManageGuild)) return message.reply('❌ You need **Manage Server**.');
        const sub = (args[0] || '').toLowerCase();
        if (sub === 'on' || sub === 'off') {
          cfg.automod = sub === 'on';
          saveSettings();
          await message.reply(`🛡️ AutoMod **${cfg.automod ? 'enabled' : 'disabled'}**.`);
        } else if (sub === 'gifonly') {
          const action = (args[1] || '').toLowerCase();
          const target = message.mentions.roles.first() || message.mentions.members.first();
          if (!target || !['add', 'remove'].includes(action)) return message.reply(`Usage: ${PREFIX}automod gifonly add|remove @user/@role`);
          const list = target.user ? cfg.gifOnlyUsers : cfg.gifOnlyRoles;
          if (action === 'add' && !list.includes(target.id)) list.push(target.id);
          if (action === 'remove') {
            const i = list.indexOf(target.id);
            if (i >= 0) list.splice(i, 1);
          }
          saveSettings();
          await message.reply(`🎞️ GIF-only **${action}**: <@${target.id}>`);
        } else {
          await message.reply(`🛡️ AutoMod: **${cfg.automod ? 'ON' : 'OFF'}** · GIF-only roles: **${cfg.gifOnlyRoles.length}** · users: **${cfg.gifOnlyUsers.length}**`);
        }
      } else if (command === 'logging') {
        if (!message.member.permissions.has(PermissionFlagsBits.ManageGuild)) return message.reply('❌ You need **Manage Server**.');
        if ((args[0] || '').toLowerCase() === 'setup') {
          await setupLogging(message.guild);
          await message.reply('✅ Lounge logging channels are ready.');
        } else {
          await message.reply(`📋 Logging: **${Object.keys(cfg.logging).length ? 'SET UP' : 'NOT SET UP'}**`);
        }
      }
    } catch (error) {
      console.error(`[Lounge] Prefix !${command} failed:`, error);
      await message.reply('❌ Something went wrong while running that command.').catch(() => {});
    }
  }

  // Keep a sticky at the bottom after ordinary user messages.
  const sticky = stickies.get(message.channelId);
  if (sticky && !message.content.startsWith(PREFIX)) {
    await message.channel.messages.delete(sticky.messageId).catch(() => {});
    try {
      const sent = await message.channel.send({ content: sticky.content, allowedMentions: { parse: [] } });
      stickies.set(message.channelId, { ...sticky, messageId: sent.id });
    } catch (error) {
      console.error('[Lounge] Sticky refresh failed:', error);
    }
  }
});

client.on('error', error => console.error('[Lounge] Client error:', error));
client.on('warn', warning => console.warn('[Lounge] Discord warning:', warning));
client.on('shardError', error => console.error('[Lounge] Shard error:', error));
process.on('unhandledRejection', error => console.error('[Lounge] Unhandled rejection:', error));
process.on('uncaughtException', error => console.error('[Lounge] Uncaught exception:', error));

console.log('[Lounge] Starting...');
client.login(TOKEN).catch(error => {
  console.error('[Lounge] Discord login failed:', error);
  process.exitCode = 1;
});
