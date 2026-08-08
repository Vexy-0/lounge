import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import {
  ActivityType,
  ChannelType,
  Client,
  Collection,
  EmbedBuilder,
  GatewayIntentBits,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
} from 'discord.js';

const TOKEN = process.env.DISCORD_TOKEN || process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID || process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const PREFIX = process.env.PREFIX || '!';
if (!TOKEN) throw new Error('Missing DISCORD_TOKEN.');
if (!CLIENT_ID) throw new Error('Missing CLIENT_ID.');
if (!GUILD_ID) throw new Error('Missing GUILD_ID.');

const client = new Client({ intents: [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMembers,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.GuildModeration,
  GatewayIntentBits.GuildVoiceStates,
  GatewayIntentBits.MessageContent,
] });
client.commands = new Collection();
const startedAt = Date.now();
const stickies = new Map();
const stickyLocks = new Set();
const automod = new Map();
const gifOnly = new Map();
const spamTracker = new Map();
const gifCache = new Map();
const logging = new Map();

const DATA_DIR = path.join(process.cwd(), 'data');
const LOG_FILE = path.join(DATA_DIR, 'logging.json');
function loadLogging() {
  try {
    const raw = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
    for (const [guildId, value] of Object.entries(raw)) logging.set(guildId, value);
  } catch {}
}
function saveLogging() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(LOG_FILE, JSON.stringify(Object.fromEntries(logging), null, 2));
  } catch (error) { console.error('[logging] save failed:', error.message); }
}
loadLogging();

const DEFAULT_AUTOMOD = () => ({
  enabled: true, links: true, invites: true, caps: false, capsPercent: 80, capsMinLength: 12,
  mentionSpam: true, mentionLimit: 6, duplicate: true, duplicateCount: 3,
  spam: true, spamCount: 5, spamWindowMs: 7000, words: new Set(), exemptRoles: new Set(), exemptChannels: new Set(),
});
function getConfig(guildId) { if (!automod.has(guildId)) automod.set(guildId, DEFAULT_AUTOMOD()); return automod.get(guildId); }
function getGifBypass(guildId) { if (!gifOnly.has(guildId)) gifOnly.set(guildId, { roles: new Set(), users: new Set() }); return gifOnly.get(guildId); }
function isExempt(message, config) {
  if (message.member?.permissions?.has(PermissionFlagsBits.Administrator)) return true;
  if (config.exemptChannels.has(message.channel.id)) return true;
  return message.member?.roles?.cache?.some(role => config.exemptRoles.has(role.id)) === true;
}
function isGifOnlyMember(message) {
  const bypass = getGifBypass(message.guild.id);
  return bypass.users.has(message.author.id) || message.member?.roles?.cache?.some(role => bypass.roles.has(role.id)) === true;
}

const GIF_PAGE_HOSTS = new Set([
  'giphy.com', 'media.giphy.com', 'i.giphy.com', 'tenor.com', 'media.tenor.com', 'c.tenor.com', 'media1.tenor.com',
  'klipy.com', 'media.klipy.com', 'klipy.co', 'redgifs.com', 'media.redgifs.com', 'gfycat.com', 'giant.gfycat.com',
]);
const DIRECT_GIF_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net', 'images-ext-1.discordapp.net', 'i.imgur.com', 'i.redd.it', 'preview.redd.it']);
const URL_RE = /(?:https?:\/\/|www\.)[^\s<>()]+/gi;
const MARKDOWN_URL_RE = /\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/gi;
const INVITE_RE = /(?:discord(?:app)?\.com\/invite|discord\.gg)\/[A-Za-z0-9-]+/i;
function normalizeUrl(url) { return /^www\./i.test(url) ? `https://${url}` : url; }
function hostOf(url) { try { return new URL(normalizeUrl(url)).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } }
function extractUrls(text = '') {
  const urls = [];
  for (const match of text.matchAll(URL_RE)) urls.push(match[0].replace(/[),.!?]+$/g, ''));
  for (const match of text.matchAll(MARKDOWN_URL_RE)) urls.push(match[1]);
  return [...new Set(urls)];
}
function knownGifHost(host) { return [...GIF_PAGE_HOSTS].some(value => host === value || host.endsWith(`.${value}`)); }
function gifExtension(url) { try { const parsed = new URL(normalizeUrl(url)); return /\.gif(?:$|\/)/i.test(parsed.pathname) || /(?:^|[?&])(?:format|fm|ext)=gif(?:$|&)/i.test(parsed.search); } catch { return false; } }
function directGifHost(url) { const host = hostOf(url); return [...DIRECT_GIF_HOSTS].some(value => host === value || host.endsWith(`.${value}`)); }
async function isGifUrl(url) {
  const normalized = normalizeUrl(url);
  if (gifExtension(normalized) || knownGifHost(hostOf(normalized))) return true;
  const cached = gifCache.get(normalized);
  if (cached && cached.expires > Date.now()) return cached.value;
  try {
    const response = await fetch(normalized, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(1800), headers: { 'User-Agent': 'Lounge-AutoMod/1.0' } });
    const type = (response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
    const value = type === 'image/gif';
    gifCache.set(normalized, { value, expires: Date.now() + 300000 });
    return value;
  } catch {
    gifCache.set(normalized, { value: false, expires: Date.now() + 30000 });
    return false;
  }
}
function gifAttachment(file) {
  const type = (file.contentType || '').split(';', 1)[0].toLowerCase();
  return type === 'image/gif' || (file.name || '').toLowerCase().endsWith('.gif');
}

async function punish(message, reason) {
  await message.delete().catch(() => {});
  if (message.member?.moderatable) await message.member.timeout(60000, `Lounge AutoMod: ${reason}`).catch(() => {});
  const warning = await message.channel.send({ content: `⚠️ <@${message.author.id}> message removed: **${reason}**`, allowedMentions: { users: [message.author.id] } }).catch(() => null);
  if (warning) setTimeout(() => warning.delete().catch(() => {}), 5000).unref?.();
  await logEvent(message.guild, 'moderation', 'AutoMod action', `**User:** <@${message.author.id}>\n**Channel:** <#${message.channel.id}>\n**Reason:** ${reason}\n**Content:** ${message.content?.slice(0, 900) || '[attachment only]'}`).catch(() => {});
}
async function checkGifOnly(message) {
  if (!isGifOnlyMember(message)) return false; // CRITICAL: this rule applies ONLY to explicitly assigned users/roles.
  const urls = extractUrls(message.content);
  const attachments = [...message.attachments.values()];
  if (INVITE_RE.test(message.content)) { await punish(message, 'GIF-only: Discord invites are not allowed'); return true; }
  if (attachments.length) {
    const attachmentsOk = attachments.every(gifAttachment);
    const urlsOk = !urls.length || (await Promise.all(urls.map(isGifUrl))).every(Boolean);
    if (attachmentsOk && urlsOk) return false;
    await punish(message, 'GIF-only: only GIFs are allowed for this user/role'); return true;
  }
  if (!urls.length) { await punish(message, 'GIF-only: only GIFs are allowed for this user/role'); return true; }
  const results = await Promise.all(urls.map(isGifUrl));
  if (results.every(Boolean)) return false;
  await punish(message, 'GIF-only: only GIFs are allowed for this user/role'); return true;
}
function tooManyCaps(content, config) { const letters = content.replace(/[^A-Za-z]/g, ''); if (letters.length < config.capsMinLength) return false; return letters ? (letters.replace(/[^A-Z]/g, '').length / letters.length) * 100 >= config.capsPercent : false; }
function spamReason(message, config) {
  const now = Date.now(); const key = `${message.guild.id}:${message.author.id}`;
  const history = (spamTracker.get(key) || []).filter(item => now - item.time <= config.spamWindowMs);
  history.push({ time: now, content: message.content.trim().toLowerCase() }); spamTracker.set(key, history.slice(-10));
  if (config.spam && history.length >= config.spamCount) return 'message spam';
  if (config.duplicate && history.filter(item => item.content === message.content.trim().toLowerCase()).length >= config.duplicateCount) return 'duplicate messages';
  return null;
}
async function runAutoMod(message) {
  if (!message.guild || message.author.bot || message.webhookId) return;
  const config = getConfig(message.guild.id);
  if (!config.enabled || isExempt(message, config)) return;
  if (await checkGifOnly(message)) return;
  const urls = extractUrls(message.content);
  if (config.invites && INVITE_RE.test(message.content)) return punish(message, 'Discord invite links are not allowed');
  // Normal members are NOT treated as GIF-only. When link blocking is enabled, ALL links are blocked,
  // including GIF-provider links. Only explicitly assigned GIF-only users/roles may post GIF links.
  if (config.links && urls.length) return punish(message, 'links are not allowed');
  if (config.words.size) { const lowered = message.content.toLowerCase(); for (const word of config.words) if (lowered.includes(word.toLowerCase())) return punish(message, 'blocked word'); }
  if (config.mentionSpam && message.mentions.users.size + message.mentions.roles.size >= config.mentionLimit) return punish(message, 'mention spam');
  if (config.caps && tooManyCaps(message.content, config)) return punish(message, 'excessive caps');
  const spam = spamReason(message, config); if (spam) await punish(message, spam);
}

const LOG_TYPES = {
  message: 'message-logs', moderation: 'moderation-logs', member: 'member-logs', voice: 'voice-logs', server: 'server-logs', role: 'role-logs',
};
const LOG_META = {
  message: ['Message Logs', '📝'], moderation: ['Moderation Logs', '🛡️'], member: ['Member Logs', '👤'], voice: ['Voice Logs', '🔊'], server: ['Server Logs', '⚙️'], role: ['Role Logs', '🎭'],
};
async function logEvent(guild, type, title, description, color = 0x5865f2) {
  if (!guild) return;
  const config = logging.get(guild.id); const channelId = config?.channels?.[type]; if (!channelId) return;
  const channel = guild.channels.cache.get(channelId); if (!channel?.isTextBased?.()) return;
  const [label, emoji] = LOG_META[type] || ['Logs', '📋'];
  const embed = new EmbedBuilder().setColor(color).setAuthor({ name: `${emoji} ${label}` }).setTitle(title).setDescription(description?.slice(0, 4000) || 'No details available.').setTimestamp();
  await channel.send({ embeds: [embed] }).catch(() => {});
}
async function setupLogging(guild) {
  if (!guild.members.me?.permissions.has(PermissionFlagsBits.ManageChannels)) throw new Error('I need Manage Channels to create the logging channels.');
  let category = guild.channels.cache.find(channel => channel.type === ChannelType.GuildCategory && channel.name === 'Lounge Logs');
  if (!category) category = await guild.channels.create({ name: 'Lounge Logs', type: ChannelType.GuildCategory, reason: 'Lounge logging setup' });
  const channels = {};
  for (const [type, name] of Object.entries(LOG_TYPES)) {
    let channel = guild.channels.cache.find(item => item.parentId === category.id && item.name === name && item.type === ChannelType.GuildText);
    if (!channel) channel = await guild.channels.create({ name, type: ChannelType.GuildText, parent: category.id, reason: 'Lounge logging setup' });
    channels[type] = channel.id;
  }
  logging.set(guild.id, { categoryId: category.id, channels }); saveLogging();
  return category;
}

const commands = [
  { data: new SlashCommandBuilder().setName('ping').setDescription('Check bot latency.'), execute: async i => i.reply(`🏓 Pong! ${client.ws.ping}ms`) },
  { data: new SlashCommandBuilder().setName('status').setDescription('Show bot status.'), execute: async i => i.reply({ embeds: [new EmbedBuilder().setTitle('Lounge Status').setDescription('🟢 Online').addFields({ name: 'Latency', value: `${client.ws.ping}ms`, inline: true }, { name: 'Uptime', value: `${Math.floor((Date.now() - startedAt) / 1000)}s`, inline: true }, { name: 'Servers', value: `${client.guilds.cache.size}`, inline: true })] }) },
  { data: new SlashCommandBuilder().setName('help').setDescription('Show Lounge commands.'), execute: async i => i.reply({ embeds: [new EmbedBuilder().setTitle('Lounge Commands').setDescription(`**General**\n\`/ping\` · \`/status\` · \`/help\`\n\n**Sticky**\n\`/sticky\` · \`/stickyremove\`\n\n**AutoMod**\n\`/automod status\` · \`/automod on\` · \`/automod off\`\n\`/automod links\` · \`/automod invites\` · \`/automod word\`\n\`/automod exempt\` · \`/automod gifonly\`\n\n**Logging**\n\`/logging setup\` · \`/logging status\`\n\n**Prefix**\n\`${PREFIX}ping\` · \`${PREFIX}status\` · \`${PREFIX}help\` · \`${PREFIX}sticky <message>\` · \`${PREFIX}stickyremove\` · \`${PREFIX}automod ...\` · \`${PREFIX}logging setup\``)] }) },
  { data: new SlashCommandBuilder().setName('sticky').setDescription('Create or update a sticky message.').setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages.toString()).addStringOption(o => o.setName('message').setDescription('Sticky content.').setRequired(true).setMaxLength(2000)), execute: async i => { const content = i.options.getString('message', true); const existing = stickies.get(i.channelId); if (existing?.messageId) await i.channel.messages.delete(existing.messageId).catch(() => {}); const sent = await i.channel.send({ content, allowedMentions: { parse: [] } }); stickies.set(i.channelId, { messageId: sent.id, content }); await i.reply('📌 Sticky message set.'); } },
  { data: new SlashCommandBuilder().setName('stickyremove').setDescription('Remove the sticky message.').setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages.toString()), execute: async i => { const existing = stickies.get(i.channelId); if (!existing) return i.reply('There is no sticky message in this channel.'); await i.channel.messages.delete(existing.messageId).catch(() => {}); stickies.delete(i.channelId); await i.reply('🗑️ Sticky message removed.'); } },
  { data: new SlashCommandBuilder().setName('automod').setDescription('Configure Lounge AutoMod.').setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages.toString())
    .addSubcommand(s => s.setName('status').setDescription('View AutoMod settings.'))
    .addSubcommand(s => s.setName('on').setDescription('Enable AutoMod.'))
    .addSubcommand(s => s.setName('off').setDescription('Disable AutoMod.'))
    .addSubcommand(s => s.setName('links').setDescription('Allow or block all links.').addBooleanOption(o => o.setName('enabled').setDescription('Block links?').setRequired(true)))
    .addSubcommand(s => s.setName('invites').setDescription('Allow or block Discord invites.').addBooleanOption(o => o.setName('enabled').setDescription('Block invites?').setRequired(true)))
    .addSubcommand(s => s.setName('word').setDescription('Add or remove a blocked word.').addStringOption(o => o.setName('action').setDescription('Action').setRequired(true).addChoices({ name: 'add', value: 'add' }, { name: 'remove', value: 'remove' })).addStringOption(o => o.setName('word').setDescription('Word or phrase').setRequired(true).setMaxLength(100)))
    .addSubcommand(s => s.setName('exempt').setDescription('Exempt a role or channel.').addStringOption(o => o.setName('action').setDescription('Action').setRequired(true).addChoices({ name: 'add', value: 'add' }, { name: 'remove', value: 'remove' })).addStringOption(o => o.setName('target').setDescription('Role or channel ID/mention').setRequired(true)))
    .addSubcommand(s => s.setName('gifonly').setDescription('Allow only GIFs for a specific role or user.').addStringOption(o => o.setName('action').setDescription('Action').setRequired(true).addChoices({ name: 'add', value: 'add' }, { name: 'remove', value: 'remove' })).addStringOption(o => o.setName('target').setDescription('Role or user ID/mention').setRequired(true))), execute: async i => {
      const c = getConfig(i.guildId); const sub = i.options.getSubcommand();
      if (sub === 'status') return i.reply({ embeds: [new EmbedBuilder().setTitle('Lounge AutoMod').setDescription(`**Status:** ${c.enabled ? '🟢 Enabled' : '🔴 Disabled'}\n**Links:** ${c.links ? 'Blocked' : 'Allowed'}\n**Invites:** ${c.invites ? 'Blocked' : 'Allowed'}\n**Blocked words:** ${c.words.size}\n**GIF-only roles:** ${getGifBypass(i.guildId).roles.size}\n**GIF-only users:** ${getGifBypass(i.guildId).users.size}`)] });
      if (sub === 'on' || sub === 'off') { c.enabled = sub === 'on'; return i.reply(`AutoMod ${c.enabled ? 'enabled' : 'disabled'}.`); }
      if (sub === 'links' || sub === 'invites') { c[sub] = i.options.getBoolean('enabled', true); return i.reply(`${sub} are now ${c[sub] ? 'blocked' : 'allowed'}.`); }
      if (sub === 'word') { const action = i.options.getString('action', true); const word = i.options.getString('word', true).toLowerCase(); action === 'add' ? c.words.add(word) : c.words.delete(word); return i.reply(`Blocked word ${action === 'add' ? 'added' : 'removed'}: \`${word}\``); }
      if (sub === 'exempt') { const action = i.options.getString('action', true); const target = i.options.getString('target', true).replace(/[<@#&>]/g, ''); const memberRole = i.guild.roles.cache.get(target); const channel = i.guild.channels.cache.get(target); if (memberRole) action === 'add' ? c.exemptRoles.add(target) : c.exemptRoles.delete(target); else if (channel) action === 'add' ? c.exemptChannels.add(target) : c.exemptChannels.delete(target); else return i.reply('Could not find that role or channel.'); return i.reply(`AutoMod exemption ${action === 'add' ? 'added' : 'removed'}.`); }
      if (sub === 'gifonly') { const action = i.options.getString('action', true); const raw = i.options.getString('target', true); const target = raw.replace(/[<@!&>]/g, ''); const bypass = getGifBypass(i.guildId); const role = i.guild.roles.cache.get(target); const user = i.guild.members.cache.get(target); if (role) action === 'add' ? bypass.roles.add(target) : bypass.roles.delete(target); else if (user) action === 'add' ? bypass.users.add(target) : bypass.users.delete(target); else return i.reply('Could not find that role or member.'); return i.reply(`GIF-only ${action === 'add' ? 'enabled for' : 'removed from'} ${role ? `<@&${target}>` : `<@${target}>`}.`); }
    } },
  { data: new SlashCommandBuilder().setName('logging').setDescription('Configure server logging.').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild.toString()).addSubcommand(s => s.setName('setup').setDescription('Create all Lounge logging channels.')).addSubcommand(s => s.setName('status').setDescription('Show logging channels.')), execute: async i => { const sub = i.options.getSubcommand(); if (sub === 'setup') { const category = await setupLogging(i.guild); return i.reply(`✅ Logging is ready in ${category}.\nCreated/verified: message, moderation, member, voice, server and role logs.`); } const config = logging.get(i.guildId); if (!config) return i.reply('Logging is not configured. Use `/logging setup` first.'); return i.reply(`📋 Logging is active in <#${config.channels.message}> and 5 other log channels.`); } },
];

for (const command of commands) client.commands.set(command.data.name, command);

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  const body = commands.map(command => command.data.toJSON());
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body });
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: [] });
  console.log(`[commands] registered ${body.length} guild commands and cleared global commands`);
}

async function handlePrefix(message) {
  if (!message.content.startsWith(PREFIX) || message.author.bot) return false;
  const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const name = (args.shift() || '').toLowerCase();
  if (!name) return true;
  if (name === 'ping') return void message.reply(`🏓 Pong! ${client.ws.ping}ms`);
  if (name === 'status') return void message.reply({ embeds: [new EmbedBuilder().setTitle('Lounge Status').setDescription('🟢 Online').addFields({ name: 'Latency', value: `${client.ws.ping}ms`, inline: true }, { name: 'Uptime', value: `${Math.floor((Date.now() - startedAt) / 1000)}s`, inline: true }, { name: 'Servers', value: `${client.guilds.cache.size}`, inline: true })] });
  if (name === 'help') return void message.reply({ embeds: [new EmbedBuilder().setTitle('Lounge Commands').setDescription(`Use \`/help\` for the full command list.\nPrefix: \`${PREFIX}\``)] });
  if (name === 'sticky') { if (!message.member?.permissions.has(PermissionFlagsBits.ManageMessages)) return void message.reply('❌ You need Manage Messages.'); const content = args.join(' ').trim(); if (!content) return void message.reply(`Usage: \`${PREFIX}sticky <message>\``); const old = stickies.get(message.channel.id); if (old?.messageId) await message.channel.messages.delete(old.messageId).catch(() => {}); const sent = await message.channel.send({ content: content.slice(0, 2000), allowedMentions: { parse: [] } }); stickies.set(message.channel.id, { messageId: sent.id, content }); return; }
  if (name === 'stickyremove') { if (!message.member?.permissions.has(PermissionFlagsBits.ManageMessages)) return void message.reply('❌ You need Manage Messages.'); const old = stickies.get(message.channel.id); if (!old) return void message.reply('There is no sticky message in this channel.'); await message.channel.messages.delete(old.messageId).catch(() => {}); stickies.delete(message.channel.id); return void message.reply('🗑️ Sticky removed.'); }
  if (name === 'automod') { if (!message.member?.permissions.has(PermissionFlagsBits.ManageMessages)) return void message.reply('❌ You need Manage Messages.'); const sub = (args.shift() || 'status').toLowerCase(); const c = getConfig(message.guild.id); if (sub === 'status') return void message.reply(`AutoMod: ${c.enabled ? 'ON' : 'OFF'} | Links: ${c.links ? 'BLOCKED' : 'ALLOWED'} | GIF-only roles: ${getGifBypass(message.guild.id).roles.size} | users: ${getGifBypass(message.guild.id).users.size}`); if (sub === 'on' || sub === 'off') { c.enabled = sub === 'on'; return void message.reply(`AutoMod ${c.enabled ? 'enabled' : 'disabled'}.`); } if (sub === 'links') { c.links = (args.shift() || '').toLowerCase() === 'on'; return void message.reply(`Links are now ${c.links ? 'blocked' : 'allowed'}.`); } if (sub === 'invites') { c.invites = (args.shift() || '').toLowerCase() === 'on'; return void message.reply(`Invites are now ${c.invites ? 'blocked' : 'allowed'}.`); } if (sub === 'gifonly') { const action = (args.shift() || '').toLowerCase(); const raw = args.shift(); const target = raw?.replace(/[<@!&>]/g, ''); const bypass = getGifBypass(message.guild.id); const role = target && message.guild.roles.cache.get(target); const user = target && message.guild.members.cache.get(target); if (!role && !user) return void message.reply(`Usage: \`${PREFIX}automod gifonly add|remove @role|@user\``); if (action === 'add') role ? bypass.roles.add(target) : bypass.users.add(target); else if (action === 'remove') role ? bypass.roles.delete(target) : bypass.users.delete(target); else return void message.reply(`Usage: \`${PREFIX}automod gifonly add|remove @role|@user\``); return void message.reply(`GIF-only ${action === 'add' ? 'enabled for' : 'removed from'} ${role ? `<@&${target}>` : `<@${target}>`}.`); } return void message.reply(`Unknown AutoMod option. Use \`${PREFIX}automod status\`.`); }
  if (name === 'logging') { if (!message.member?.permissions.has(PermissionFlagsBits.ManageGuild)) return void message.reply('❌ You need Manage Server.'); const sub = (args.shift() || 'status').toLowerCase(); if (sub === 'setup') { const category = await setupLogging(message.guild); return void message.reply(`✅ Logging setup complete in ${category}.`); } return void message.reply(logging.has(message.guild.id) ? '📋 Logging is enabled.' : `Logging is not configured. Use \`${PREFIX}logging setup\`.`); }
  return false;
}

client.on('messageCreate', async message => {
  try {
    if (await handlePrefix(message)) return;
    await runAutoMod(message);
    if (message.author.bot || !message.guild) return;
    const sticky = stickies.get(message.channel.id);
    if (sticky && !stickyLocks.has(message.channel.id)) {
      stickyLocks.add(message.channel.id);
      try { await message.channel.messages.delete(sticky.messageId).catch(() => {}); const sent = await message.channel.send({ content: sticky.content, allowedMentions: { parse: [] } }); stickies.set(message.channel.id, { ...sticky, messageId: sent.id }); } finally { stickyLocks.delete(message.channel.id); }
    }
  } catch (error) { console.error('[messageCreate]', error); }
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const command = client.commands.get(interaction.commandName);
  if (!command) return interaction.reply({ content: 'This command is no longer available. Please wait a moment and try again.', ephemeral: true }).catch(() => {});
  try { await command.execute(interaction); } catch (error) { console.error(`[command:${interaction.commandName}]`, error); const payload = { content: '❌ Something went wrong while running that command.', ephemeral: true }; if (interaction.replied || interaction.deferred) await interaction.followUp(payload).catch(() => {}); else await interaction.reply(payload).catch(() => {}); }
});

client.on('messageDelete', async message => { if (!message.guild || message.author?.bot) return; await logEvent(message.guild, 'message', 'Message deleted', `**Author:** ${message.author ? `<@${message.author.id}>` : 'Unknown'}\n**Channel:** <#${message.channel.id}>\n**Content:** ${message.content?.slice(0, 3000) || '[unavailable]'}`, 0xed4245); });
client.on('messageUpdate', async (oldMessage, newMessage) => { if (!newMessage.guild || newMessage.author?.bot || oldMessage.content === newMessage.content) return; await logEvent(newMessage.guild, 'message', 'Message edited', `**Author:** <@${newMessage.author.id}>\n**Channel:** <#${newMessage.channel.id}>\n**Before:** ${oldMessage.content?.slice(0, 1500) || '[empty]'}\n**After:** ${newMessage.content?.slice(0, 1500) || '[empty]'}`, 0xfee75c); });
client.on('guildMemberAdd', member => logEvent(member.guild, 'member', 'Member joined', `**Member:** <@${member.id}>\n**Account:** <t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`, 0x57f287));
client.on('guildMemberRemove', member => logEvent(member.guild, 'member', 'Member left', `**Member:** ${member.user?.tag || member.id}\n**ID:** ${member.id}`, 0xed4245));
client.on('voiceStateUpdate', (oldState, newState) => { if (oldState.channelId === newState.channelId) return; const channel = newState.channel || oldState.channel; return logEvent(newState.guild, 'voice', 'Voice state updated', `**Member:** <@${newState.id}>\n**From:** ${oldState.channelId ? `<#${oldState.channelId}>` : 'None'}\n**To:** ${newState.channelId ? `<#${newState.channelId}>` : 'None'}${channel ? `\n**Channel:** ${channel.name}` : ''}`); });
client.on('roleCreate', role => logEvent(role.guild, 'role', 'Role created', `**Role:** <@&${role.id}>\n**Name:** ${role.name}\n**ID:** ${role.id}`, 0x57f287));
client.on('roleDelete', role => logEvent(role.guild, 'role', 'Role deleted', `**Role:** ${role.name}\n**ID:** ${role.id}`, 0xed4245));
client.on('roleUpdate', (oldRole, newRole) => logEvent(newRole.guild, 'role', 'Role updated', `**Role:** <@&${newRole.id}>\n**Before:** ${oldRole.name}\n**After:** ${newRole.name}`, 0xfee75c));
client.on('channelCreate', channel => channel.guild && logEvent(channel.guild, 'server', 'Channel created', `**Channel:** <#${channel.id}>\n**Name:** ${channel.name}`));
client.on('channelDelete', channel => channel.guild && logEvent(channel.guild, 'server', 'Channel deleted', `**Channel:** ${channel.name}\n**ID:** ${channel.id}`, 0xed4245));
client.on('guildBanAdd', ban => logEvent(ban.guild, 'moderation', 'Member banned', `**User:** ${ban.user.tag}\n**ID:** ${ban.user.id}`, 0xed4245));
client.on('guildBanRemove', ban => logEvent(ban.guild, 'moderation', 'Member unbanned', `**User:** ${ban.user.tag}\n**ID:** ${ban.user.id}`, 0x57f287));

client.once('ready', async () => {
  client.user.setPresence({ status: 'dnd', activities: [{ name: 'Lounge', type: ActivityType.Watching }] });
  try { await registerCommands(); } catch (error) { console.error('[commands] registration failed:', error); }
  console.log(`Lounge online as ${client.user.tag}`);
});

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  const body = commands.map(command => command.data.toJSON());
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body });
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: [] });
  console.log(`[commands] ${body.length} guild commands registered; global commands cleared`);
}

process.on('unhandledRejection', error => console.error('[unhandledRejection]', error));
process.on('uncaughtException', error => console.error('[uncaughtException]', error));

client.login(TOKEN).catch(error => { console.error('[login] failed:', error); process.exit(1); });
