import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  ActivityType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  ChannelType,
} from 'discord.js';
import fs from 'node:fs/promises';
import path from 'node:path';

const TOKEN = process.env.DISCORD_TOKEN || process.env.TOKEN;
const PREFIX = process.env.PREFIX || '!';
if (!TOKEN) throw new Error('Missing DISCORD_TOKEN/TOKEN');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildModeration, GatewayIntentBits.GuildVoiceStates],
});

const commands = [
  new SlashCommandBuilder().setName('ping').setDescription('Check bot latency.'),
  new SlashCommandBuilder().setName('status').setDescription('Show bot status.'),
  new SlashCommandBuilder().setName('help').setDescription('Show Lounge commands.'),
  new SlashCommandBuilder().setName('sticky').setDescription('Create a sticky message.').setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages.toString()).addStringOption(o => o.setName('message').setDescription('Sticky message').setRequired(true).setMaxLength(2000)),
  new SlashCommandBuilder().setName('stickyremove').setDescription('Remove the sticky message.').setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages.toString()),
  new SlashCommandBuilder().setName('automod').setDescription('AutoMod settings.').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild.toString())
    .addSubcommand(s => s.setName('status').setDescription('Show AutoMod status.'))
    .addSubcommand(s => s.setName('on').setDescription('Enable AutoMod.'))
    .addSubcommand(s => s.setName('off').setDescription('Disable AutoMod.'))
    .addSubcommand(s => s.setName('gifonly').setDescription('Manage GIF-only bypass.')
      .addStringOption(o => o.setName('action').setDescription('add or remove').setRequired(true).addChoices({ name: 'add', value: 'add' }, { name: 'remove', value: 'remove' }))
      .addMentionableOption(o => o.setName('target').setDescription('Role or user').setRequired(true))),
  new SlashCommandBuilder().setName('logging').setDescription('Logging settings.').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild.toString())
    .addSubcommand(s => s.setName('setup').setDescription('Create Lounge logging channels.'))
    .addSubcommand(s => s.setName('status').setDescription('Show logging status.')),
].map(c => c.toJSON());

const stickies = new Map();
const guildSettings = new Map();
const startedAt = Date.now();
const dataDir = path.join(process.cwd(), 'data');
const dataFile = path.join(dataDir, 'guild-settings.json');

async function loadSettings() {
  try {
    const parsed = JSON.parse(await fs.readFile(dataFile, 'utf8'));
    for (const [id, value] of Object.entries(parsed)) guildSettings.set(id, value);
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('[Lounge] Settings load failed:', error);
  }
}
async function saveSettings() {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(dataFile, JSON.stringify(Object.fromEntries(guildSettings), null, 2));
}
function settings(guildId) {
  if (!guildSettings.has(guildId)) guildSettings.set(guildId, { automod: true, gifOnlyRoles: [], gifOnlyUsers: [], logging: {} });
  const cfg = guildSettings.get(guildId);
  cfg.gifOnlyRoles ??= [];
  cfg.gifOnlyUsers ??= [];
  cfg.logging ??= {};
  cfg.automod ??= true;
  return cfg;
}
function statusMessage() {
  return `🟢 **Lounge Online**\n🏓 Ping: **${client.ws.ping}ms**\n⏱️ Uptime: **${Math.floor((Date.now() - startedAt) / 1000)}s**\n🏠 Servers: **${client.guilds.cache.size}**`;
}
async function replyOnce(interaction, content, ephemeral = false) {
  const payload = typeof content === 'string' ? { content, ephemeral } : { ...content, ephemeral };
  return interaction.deferred || interaction.replied ? interaction.editReply(payload) : interaction.reply(payload);
}
async function registerGuild(guild) {
  try { await guild.commands.set(commands); console.log(`[Lounge] Registered ${commands.length} commands in ${guild.name} (${guild.id})`); }
  catch (error) { console.error(`[Lounge] Command registration failed in ${guild.id}:`, error); }
}
async function clearGlobalCommands() {
  try { await client.application.commands.set([]); console.log('[Lounge] Global commands cleared.'); }
  catch (error) { console.error('[Lounge] Global command cleanup failed:', error); }
}
function isGifUrl(url) {
  try {
    const u = new URL(url); const host = u.hostname.toLowerCase();
    const known = ['giphy.com', 'media.giphy.com', 'tenor.com', 'media.tenor.com', 'klipy.com', 'klipy.co', 'redgifs.com', 'gfycat.com', 'imgur.com', 'i.imgur.com', 'cdn.discordapp.com', 'media.discordapp.net'];
    return known.some(h => host === h || host.endsWith(`.${h}`)) || /\.gif(?:$|[?#])/i.test(u.pathname + u.search);
  } catch { return false; }
}
function hasGifOnlyAccess(message, cfg) {
  return cfg.gifOnlyUsers.includes(message.author.id) || Boolean(message.member?.roles.cache.some(r => cfg.gifOnlyRoles.includes(r.id)));
}
function extractUrls(text) { return text.match(/https?:\/\/[^\s<>]+/gi) || []; }
async function createLoggingChannels(guild) {
  const existingCategory = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === 'lounge logs');
  const category = existingCategory || await guild.channels.create({ name: 'Lounge Logs', type: ChannelType.GuildCategory, reason: 'Lounge logging setup' });
  const names = { messages: '📝・message-logs', moderation: '🛡️・moderation-logs', members: '👤・member-logs', voice: '🔊・voice-logs', server: '⚙️・server-logs', roles: '🎭・role-logs' };
  const created = {};
  for (const [key, name] of Object.entries(names)) {
    const existing = guild.channels.cache.find(c => c.parentId === category.id && c.name === name);
    const ch = existing || await guild.channels.create({ name, type: ChannelType.GuildText, parent: category.id, reason: 'Lounge logging setup' });
    created[key] = ch.id;
  }
  settings(guild.id).logging = created; await saveSettings(); return created;
}
async function handleSlash(interaction) {
  switch (interaction.commandName) {
    case 'ping': return replyOnce(interaction, `🏓 Pong! **${client.ws.ping}ms**`);
    case 'status': return replyOnce(interaction, statusMessage());
    case 'help': return replyOnce(interaction, ['**Lounge Commands**','`/ping` · `/status` · `/help`','`/sticky` · `/stickyremove`','`/automod status|on|off|gifonly`','`/logging setup|status`','',`Prefix: \`${PREFIX}ping\` · \`${PREFIX}status\` · \`${PREFIX}help\``].join('\n'));
    case 'sticky': {
      const content = interaction.options.getString('message', true); const old = stickies.get(interaction.channelId);
      if (old) await interaction.channel.messages.delete(old.messageId).catch(() => {});
      const sent = await interaction.channel.send({ content, allowedMentions: { parse: [] } }); stickies.set(interaction.channelId, { content, messageId: sent.id });
      return replyOnce(interaction, '📌 Sticky message set.');
    }
    case 'stickyremove': {
      const old = stickies.get(interaction.channelId); if (!old) return replyOnce(interaction, 'There is no sticky message here.');
      await interaction.channel.messages.delete(old.messageId).catch(() => {}); stickies.delete(interaction.channelId); return replyOnce(interaction, '🗑️ Sticky removed.');
    }
    case 'automod': {
      const cfg = settings(interaction.guildId); const sub = interaction.options.getSubcommand();
      if (sub === 'status') return replyOnce(interaction, `🛡️ AutoMod: **${cfg.automod ? 'ON' : 'OFF'}**\n🎞️ GIF-only roles: **${cfg.gifOnlyRoles.length}**\n👤 GIF-only users: **${cfg.gifOnlyUsers.length}**`);
      if (sub === 'on' || sub === 'off') { cfg.automod = sub === 'on'; await saveSettings(); return replyOnce(interaction, `🛡️ AutoMod **${cfg.automod ? 'enabled' : 'disabled'}**.`); }
      const action = interaction.options.getString('action', true); const target = interaction.options.getMentionable('target', true); const list = target.user ? cfg.gifOnlyUsers : cfg.gifOnlyRoles;
      if (action === 'add' && !list.includes(target.id)) list.push(target.id); if (action === 'remove') { const i = list.indexOf(target.id); if (i !== -1) list.splice(i, 1); }
      await saveSettings(); return replyOnce(interaction, `🎞️ GIF-only **${action}**: <@${target.id}>`);
    }
    case 'logging': {
      const sub = interaction.options.getSubcommand(); const cfg = settings(interaction.guildId);
      if (sub === 'status') return replyOnce(interaction, `📋 Logging: **${Object.keys(cfg.logging).length ? 'SET UP' : 'NOT SET UP'}**`);
      if (Object.keys(cfg.logging).length) return replyOnce(interaction, '📋 Logging is already set up.');
      await createLoggingChannels(interaction.guild); return replyOnce(interaction, '✅ Lounge logging channels created.');
    }
    default: return replyOnce(interaction, '❌ Unknown command.');
  }
}

client.once('ready', async () => {
  await loadSettings(); client.user.setPresence({ status: 'dnd', activities: [{ name: 'Lounge', type: ActivityType.Watching }] });
  console.log(`[Lounge] Logged in as ${client.user.tag} (${client.user.id})`); await clearGlobalCommands();
  for (const guild of client.guilds.cache.values()) await registerGuild(guild); console.log(`[Lounge] READY — ${client.guilds.cache.size} server(s).`);
});
client.on('guildCreate', async guild => { console.log(`[Lounge] Joined ${guild.name} (${guild.id})`); await registerGuild(guild); settings(guild.id); await saveSettings().catch(e => console.error('[Lounge] Settings save failed:', e)); });

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  console.log(`[Lounge] /${interaction.commandName} received in ${interaction.guildId || 'DM'}`);
  try {
    if (!interaction.inGuild()) return await replyOnce(interaction, '❌ This command can only be used in a server.', true);
    // Exactly ONE acknowledgement. All command handlers below use editReply after this point.
    await interaction.deferReply();
    await handleSlash(interaction);
  } catch (error) {
    console.error(`[Lounge] /${interaction.commandName} failed:`, error);
    await replyOnce(interaction, '❌ Something went wrong while running that command.', true).catch(e => console.error('[Lounge] Error reply failed:', e));
  }
});

client.on('messageCreate', async message => {
  if (!message.guild || message.author.bot) return; const cfg = settings(message.guild.id);
  if (cfg.automod && hasGifOnlyAccess(message, cfg)) {
    const urls = extractUrls(message.content); const gifAttachment = message.attachments.some(a => (a.contentType || '').toLowerCase() === 'image/gif' || /\.gif(?:$|[?#])/i.test(a.name || ''));
    const validGif = gifAttachment || (urls.length > 0 && urls.every(isGifUrl));
    if (!validGif) await message.delete().catch(() => {}); return;
  }
  if (!message.content.startsWith(PREFIX)) return;
  const [command, ...args] = message.content.slice(PREFIX.length).trim().split(/\s+/); if (!command) return;
  try {
    switch (command.toLowerCase()) {
      case 'ping': await message.reply(`🏓 Pong! **${client.ws.ping}ms**`); break;
      case 'status': await message.reply(statusMessage()); break;
      case 'help': await message.reply(`**Lounge:** \`${PREFIX}ping\` \`${PREFIX}status\` \`${PREFIX}help\` \`${PREFIX}sticky <message>\` \`${PREFIX}stickyremove\` \`${PREFIX}automod gifonly add|remove @user/@role\` \`${PREFIX}logging setup|status\``); break;
      case 'sticky': {
        if (!message.member.permissions.has(PermissionFlagsBits.ManageMessages)) return message.reply('❌ You need Manage Messages.'); const content = args.join(' '); if (!content) return message.reply(`Usage: ${PREFIX}sticky <message>`);
        const old = stickies.get(message.channelId); if (old) await message.channel.messages.delete(old.messageId).catch(() => {}); const sent = await message.channel.send({ content, allowedMentions: { parse: [] } }); stickies.set(message.channelId, { content, messageId: sent.id }); await message.reply('📌 Sticky message set.'); break;
      }
      case 'stickyremove': {
        if (!message.member.permissions.has(PermissionFlagsBits.ManageMessages)) return message.reply('❌ You need Manage Messages.'); const old = stickies.get(message.channelId); if (!old) return message.reply('There is no sticky message here.'); await message.channel.messages.delete(old.messageId).catch(() => {}); stickies.delete(message.channelId); await message.reply('🗑️ Sticky removed.'); break;
      }
      case 'automod': {
        if (!message.member.permissions.has(PermissionFlagsBits.ManageGuild)) return message.reply('❌ You need Manage Server.');
        if ((args[0] || '').toLowerCase() === 'gifonly') { const action = (args[1] || '').toLowerCase(); const target = message.mentions.roles.first() || message.mentions.members.first(); if (!['add','remove'].includes(action) || !target) return message.reply(`Usage: ${PREFIX}automod gifonly add|remove @user/@role`); const list = target.user ? cfg.gifOnlyUsers : cfg.gifOnlyRoles; if (action === 'add' && !list.includes(target.id)) list.push(target.id); if (action === 'remove') { const i = list.indexOf(target.id); if (i !== -1) list.splice(i,1); } await saveSettings(); await message.reply(`🎞️ GIF-only **${action}**: <@${target.id}>`);
        } else if (args[0] === 'on' || args[0] === 'off') { cfg.automod = args[0] === 'on'; await saveSettings(); await message.reply(`🛡️ AutoMod **${cfg.automod ? 'enabled' : 'disabled'}**.`); }
        else await message.reply(`🛡️ AutoMod: **${cfg.automod ? 'ON' : 'OFF'}** | GIF-only roles: **${cfg.gifOnlyRoles.length}** | users: **${cfg.gifOnlyUsers.length}**`); break;
      }
      case 'logging': {
        if (!message.member.permissions.has(PermissionFlagsBits.ManageGuild)) return message.reply('❌ You need Manage Server.'); if (args[0] === 'setup') { if (Object.keys(cfg.logging).length) return message.reply('📋 Logging is already set up.'); await createLoggingChannels(message.guild); await message.reply('✅ Lounge logging channels created.'); } else await message.reply(`📋 Logging: **${Object.keys(cfg.logging).length ? 'SET UP' : 'NOT SET UP'}**`); break;
      }
    }
  } catch (error) { console.error(`[Lounge] Prefix command ${command} failed:`, error); await message.reply('❌ Something went wrong while running that command.').catch(() => {}); }
});

client.on('error', error => console.error('[Lounge] Discord client error:', error));
client.on('warn', warning => console.warn('[Lounge] Discord warning:', warning));
client.on('shardError', error => console.error('[Lounge] Discord shard error:', error));
process.on('unhandledRejection', error => console.error('[Lounge] Unhandled rejection:', error));
await client.login(TOKEN);
