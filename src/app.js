import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import {
  ActivityType,
  ChannelType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
} from 'discord.js';

const TOKEN = process.env.DISCORD_TOKEN || process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID || process.env.DISCORD_CLIENT_ID;
const PREFIX = process.env.PREFIX || '!';
if (!TOKEN) throw new Error('Missing DISCORD_TOKEN.');
if (!CLIENT_ID) throw new Error('Missing CLIENT_ID.');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.MessageContent],
});
const startedAt = Date.now();
const stickies = new Map();
const configs = new Map();
const logs = new Map();
const spam = new Map();
const DATA_DIR = path.join(process.cwd(), 'data');
const AUTOMOD_FILE = path.join(DATA_DIR, 'automod.json');
const LOG_FILE = path.join(DATA_DIR, 'logging.json');

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } }
function writeJson(file, value) { try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2)); } catch (error) { console.error(`[data] ${path.basename(file)}: ${error.message}`); } }
function defaultConfig() { return { enabled: true, links: true, invites: true, words: [], mentionSpam: true, mentionLimit: 6, spam: true, spamCount: 5, spamWindow: 7000, gifOnly: { roles: [], users: [] } }; }
function loadConfig() { const raw = readJson(AUTOMOD_FILE); for (const [guildId, value] of Object.entries(raw)) { const cfg = { ...defaultConfig(), ...(value || {}) }; cfg.words = Array.isArray(value?.words) ? value.words : []; cfg.gifOnly = { roles: Array.isArray(value?.gifOnly?.roles) ? value.gifOnly.roles : [], users: Array.isArray(value?.gifOnly?.users) ? value.gifOnly.users : [] }; configs.set(guildId, cfg); } }
function saveConfig() { writeJson(AUTOMOD_FILE, Object.fromEntries(configs)); }
function getConfig(guildId) { if (!configs.has(guildId)) configs.set(guildId, defaultConfig()); return configs.get(guildId); }
function loadLogs() { for (const [guildId, value] of Object.entries(readJson(LOG_FILE))) logs.set(guildId, value); }
function saveLogs() { writeJson(LOG_FILE, Object.fromEntries(logs)); }
loadConfig();
loadLogs();

const URL_RE = /(?:https?:\/\/|www\.)[^\s<>()]+/gi;
const INVITE_RE = /(?:discord(?:app)?\.com\/invite|discord\.gg)\/[A-Za-z0-9-]+/i;
const GIF_HOSTS = ['giphy.com', 'tenor.com', 'klipy.com', 'klipy.co', 'redgifs.com', 'gfycat.com', 'media.tenor.com', 'c.tenor.com', 'media.giphy.com', 'i.giphy.com', 'media.klipy.com'];
const DISCORD_MEDIA = ['cdn.discordapp.com', 'media.discordapp.net', 'images-ext-1.discordapp.net', 'images-ext-2.discordapp.net', 'images-ext-3.discordapp.net'];
function normalizeUrl(value) { return /^www\./i.test(value) ? `https://${value}` : value; }
function getHost(value) { try { return new URL(normalizeUrl(value)).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } }
function extractUrls(text = '') { return [...new Set((text.match(URL_RE) || []).map(v => v.replace(/[),.!?]+$/g, '')))]; }
function isGifUrl(value) { const url = normalizeUrl(value); const host = getHost(url); if (!host) return false; if (GIF_HOSTS.some(h => host === h || host.endsWith(`.${h}`))) return true; if (/\.gif(?:$|[?#])/i.test(url)) return true; return DISCORD_MEDIA.some(h => host === h || host.endsWith(`.${h}`)) && /(?:format=gif|fm=gif|ext=gif|type=gif|\.gif(?:$|[?#]))/i.test(url); }
function embedIsGif(embed) { const values = [embed.url, embed.image?.url, embed.thumbnail?.url, embed.video?.url, embed.provider?.url, embed.provider?.name, embed.title, embed.description].filter(Boolean).join(' '); return /klipy|giphy|tenor|redgifs|gfycat/i.test(values) || /\.gif(?:$|[?#])/i.test(values); }
function isGifMessage(message) { const attachments = [...message.attachments.values()]; if (attachments.length) return attachments.every(file => (file.contentType || '').split(';')[0].toLowerCase() === 'image/gif' || /\.gif(?:$|[?#])/i.test(file.name || '') || isGifUrl(file.url || '')); if (message.embeds.some(embedIsGif)) return true; const links = extractUrls(message.content); return links.length > 0 && links.every(isGifUrl); }
function isGifOnlyMember(message) { const cfg = getConfig(message.guild.id).gifOnly; return cfg.users.includes(message.author.id) || Boolean(message.member?.roles.cache.some(role => cfg.roles.includes(role.id))); }
function isAdmin(message) { return Boolean(message.member?.permissions.has(PermissionFlagsBits.Administrator)); }

const LOG_TYPES = { message: ['📝 Message Logs', 'message-logs'], moderation: ['🛡️ Moderation Logs', 'moderation-logs'], member: ['👤 Member Logs', 'member-logs'], voice: ['🔊 Voice Logs', 'voice-logs'], server: ['⚙️ Server Logs', 'server-logs'], role: ['🎭 Role Logs', 'role-logs'] };
async function logEvent(guild, type, title, description) { const entry = logs.get(guild?.id); const channel = entry?.channels?.[type] ? guild.channels.cache.get(entry.channels[type]) : null; if (!channel?.isTextBased()) return; await channel.send({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(title).setDescription(String(description || '').slice(0, 4000)).setTimestamp()] }).catch(() => {}); }
async function punish(message, reason) { await message.delete().catch(() => {}); if (message.member?.moderatable) await message.member.timeout(60_000, `Lounge AutoMod: ${reason}`).catch(() => {}); await logEvent(message.guild, 'moderation', 'AutoMod action', `**User:** <@${message.author.id}>\n**Channel:** <#${message.channel.id}>\n**Reason:** ${reason}`); }
async function runAutoMod(message) { if (!message.guild || message.author.bot || message.webhookId) return; const cfg = getConfig(message.guild.id); if (!cfg.enabled || isAdmin(message)) return; if (isGifOnlyMember(message)) { if (!isGifMessage(message) || INVITE_RE.test(message.content)) await punish(message, 'GIF-only: only GIFs are allowed'); return; } if (cfg.invites && INVITE_RE.test(message.content)) return punish(message, 'Discord invites are not allowed'); if (cfg.links && extractUrls(message.content).length) return punish(message, 'Links are not allowed'); const lower = message.content.toLowerCase(); for (const word of cfg.words) if (word && lower.includes(word)) return punish(message, 'Blocked word'); if (cfg.mentionSpam && message.mentions.users.size + message.mentions.roles.size >= cfg.mentionLimit) return punish(message, 'Mention spam'); if (cfg.spam) { const key = `${message.guild.id}:${message.author.id}`; const now = Date.now(); const history = (spam.get(key) || []).filter(t => now - t < cfg.spamWindow); history.push(now); spam.set(key, history.slice(-10)); if (history.length >= cfg.spamCount) return punish(message, 'Message spam'); } }
async function setupLogging(guild) { const me = guild.members.me; if (!me?.permissions.has(PermissionFlagsBits.ManageChannels)) throw new Error('I need Manage Channels permission.'); let category = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name === 'Lounge Logs'); if (!category) category = await guild.channels.create({ name: 'Lounge Logs', type: ChannelType.GuildCategory, reason: 'Lounge logging setup' }); const channels = {}; for (const [type, [, name]] of Object.entries(LOG_TYPES)) { let channel = guild.channels.cache.find(c => c.parentId === category.id && c.type === ChannelType.GuildText && c.name === name); if (!channel) channel = await guild.channels.create({ name, type: ChannelType.GuildText, parent: category.id, reason: 'Lounge logging setup' }); channels[type] = channel.id; } logs.set(guild.id, { categoryId: category.id, channels }); saveLogs(); return category; }
function helpText() { return ['**General**', '`/ping` · `/status` · `/help`', '', '**Sticky**', '`/sticky` · `/stickyremove`', '', '**AutoMod**', '`/automod status` · `/automod on` · `/automod off`', '`/automod links` · `/automod invites` · `/automod word` · `/automod gifonly`', '', '**Logging**', '`/logging setup` · `/logging status`', '', '**Prefix**', `\`${PREFIX}ping\` · \`${PREFIX}status\` · \`${PREFIX}help\``, `\`${PREFIX}sticky <message>\` · \`${PREFIX}stickyremove\``, `\`${PREFIX}automod ...\` · \`${PREFIX}logging setup\``].join('\n'); }
function statusPayload() { return { embeds: [new EmbedBuilder().setTitle('Lounge Status').setDescription('🟢 Online').addFields({ name: 'Latency', value: `${client.ws.ping}ms`, inline: true }, { name: 'Uptime', value: `${Math.floor((Date.now() - startedAt) / 1000)}s`, inline: true }, { name: 'Servers', value: `${client.guilds.cache.size}`, inline: true })] }; }

const slash = [
  new SlashCommandBuilder().setName('ping').setDescription('Check bot latency.'),
  new SlashCommandBuilder().setName('status').setDescription('Show bot status.'),
  new SlashCommandBuilder().setName('help').setDescription('Show Lounge commands.'),
  new SlashCommandBuilder().setName('sticky').setDescription('Create or update a sticky.').setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages.toString()).addStringOption(o => o.setName('message').setDescription('Sticky content.').setRequired(true).setMaxLength(2000)),
  new SlashCommandBuilder().setName('stickyremove').setDescription('Remove the sticky.').setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages.toString()),
  new SlashCommandBuilder().setName('automod').setDescription('Configure AutoMod.').setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages.toString())
    .addSubcommand(s => s.setName('status').setDescription('Show AutoMod status.'))
    .addSubcommand(s => s.setName('on').setDescription('Enable AutoMod.'))
    .addSubcommand(s => s.setName('off').setDescription('Disable AutoMod.'))
    .addSubcommand(s => s.setName('links').setDescription('Configure link blocking.').addBooleanOption(o => o.setName('enabled').setDescription('Block links?').setRequired(true)))
    .addSubcommand(s => s.setName('invites').setDescription('Configure invite blocking.').addBooleanOption(o => o.setName('enabled').setDescription('Block invites?').setRequired(true)))
    .addSubcommand(s => s.setName('word').setDescription('Add or remove a blocked word.').addStringOption(o => o.setName('action').setDescription('Action.').setRequired(true).addChoices({ name: 'add', value: 'add' }, { name: 'remove', value: 'remove' })).addStringOption(o => o.setName('word').setDescription('Word.').setRequired(true).setMaxLength(100)))
    .addSubcommand(s => s.setName('gifonly').setDescription('Assign GIF-only access.').addStringOption(o => o.setName('action').setDescription('Action.').setRequired(true).addChoices({ name: 'add', value: 'add' }, { name: 'remove', value: 'remove' })).addStringOption(o => o.setName('target').setDescription('Role/user mention or ID.').setRequired(true))),
  new SlashCommandBuilder().setName('logging').setDescription('Configure server logging.').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild.toString()).addSubcommand(s => s.setName('setup').setDescription('Create all Lounge log channels.')).addSubcommand(s => s.setName('status').setDescription('Show logging status.')),
].map(c => c.toJSON());

function getTargetId(raw) { return String(raw).replace(/[<@!&>]/g, ''); }
function resolveTarget(guild, raw) { const id = getTargetId(raw); const role = guild.roles.cache.get(id); if (role) return { type: 'role', id: role.id, name: role.name }; const member = guild.members.cache.get(id); if (member) return { type: 'user', id: member.id, name: member.user.tag }; return null; }
async function respond(i, payload) { return i.deferred || i.replied ? i.editReply(payload) : i.reply(payload); }

async function handleSlash(i) {
  if (i.commandName === 'ping') return respond(i, `🏓 Pong! ${client.ws.ping}ms`);
  if (i.commandName === 'status') return respond(i, statusPayload());
  if (i.commandName === 'help') return respond(i, { embeds: [new EmbedBuilder().setTitle('Lounge Commands').setDescription(helpText())] });
  if (i.commandName === 'sticky') { const content = i.options.getString('message', true); const old = stickies.get(i.channelId); if (old?.messageId) await i.channel.messages.delete(old.messageId).catch(() => {}); const sent = await i.channel.send({ content, allowedMentions: { parse: [] } }); stickies.set(i.channelId, { messageId: sent.id, content }); return respond(i, '📌 Sticky message set.'); }
  if (i.commandName === 'stickyremove') { const old = stickies.get(i.channelId); if (!old) return respond(i, 'There is no sticky message here.'); await i.channel.messages.delete(old.messageId).catch(() => {}); stickies.delete(i.channelId); return respond(i, '🗑️ Sticky removed.'); }
  if (i.commandName === 'logging') { const sub = i.options.getSubcommand(); if (sub === 'status') return respond(i, logs.has(i.guildId) ? `🟢 Logging is configured. **${Object.keys(logs.get(i.guildId).channels || {}).length}** channels active.` : '⚪ Logging is not configured.'); try { await setupLogging(i.guild); return respond(i, '✅ Lounge Logs setup complete.'); } catch (error) { return respond(i, `❌ ${error.message}`); } }
  if (i.commandName === 'automod') {
    const cfg = getConfig(i.guildId); const sub = i.options.getSubcommand();
    if (sub === 'status') return respond(i, `AutoMod: **${cfg.enabled ? 'ON' : 'OFF'}** | Links: **${cfg.links ? 'BLOCKED' : 'ALLOWED'}** | Invites: **${cfg.invites ? 'BLOCKED' : 'ALLOWED'}** | GIF-only roles: **${cfg.gifOnly.roles.length}** | users: **${cfg.gifOnly.users.length}**`);
    if (sub === 'on' || sub === 'off') { cfg.enabled = sub === 'on'; saveConfig(); return respond(i, `AutoMod ${cfg.enabled ? 'enabled' : 'disabled'}.`); }
    if (sub === 'links' || sub === 'invites') { cfg[sub] = i.options.getBoolean('enabled', true); saveConfig(); return respond(i, `${sub} are now ${cfg[sub] ? 'blocked' : 'allowed'}.`); }
    if (sub === 'word') { const action = i.options.getString('action', true); const word = i.options.getString('word', true).trim().toLowerCase(); if (action === 'add' && !cfg.words.includes(word)) cfg.words.push(word); if (action === 'remove') cfg.words = cfg.words.filter(w => w !== word); saveConfig(); return respond(i, `Blocked word ${action === 'add' ? 'added' : 'removed'}: \`${word}\``); }
    const action = i.options.getString('action', true); const target = resolveTarget(i.guild, i.options.getString('target', true)); if (!target) return respond(i, '❌ I could not find that role/user in this server. Use a role/user mention or ID.');
    if (target.type === 'role') { if (action === 'add' && !cfg.gifOnly.roles.includes(target.id)) cfg.gifOnly.roles.push(target.id); if (action === 'remove') cfg.gifOnly.roles = cfg.gifOnly.roles.filter(id => id !== target.id); }
    else { if (action === 'add' && !cfg.gifOnly.users.includes(target.id)) cfg.gifOnly.users.push(target.id); if (action === 'remove') cfg.gifOnly.users = cfg.gifOnly.users.filter(id => id !== target.id); }
    saveConfig(); return respond(i, `✅ GIF-only ${action === 'add' ? 'enabled for' : 'removed from'} **${target.name}**.`);
  }
  return respond(i, 'Unknown command.');
}

async function handlePrefix(message) {
  if (!message.guild || message.author.bot || !message.content.startsWith(PREFIX)) return false;
  const body = message.content.slice(PREFIX.length).trim(); if (!body) return false; const [cmd, ...args] = body.split(/\s+/); const command = cmd.toLowerCase();
  if (command === 'ping') await message.reply(`🏓 Pong! ${client.ws.ping}ms`);
  else if (command === 'status') await message.reply(statusPayload());
  else if (command === 'help') await message.reply({ embeds: [new EmbedBuilder().setTitle('Lounge Commands').setDescription(helpText())] });
  else if (command === 'sticky') { const content = body.slice(command.length).trim(); if (!content) return message.reply(`Usage: ${PREFIX}sticky <message>`); const old = stickies.get(message.channelId); if (old?.messageId) await message.channel.messages.delete(old.messageId).catch(() => {}); const sent = await message.channel.send({ content, allowedMentions: { parse: [] } }); stickies.set(message.channelId, { messageId: sent.id, content }); await message.reply('📌 Sticky message set.'); }
  else if (command === 'stickyremove') { const old = stickies.get(message.channelId); if (!old) return message.reply('There is no sticky message here.'); await message.channel.messages.delete(old.messageId).catch(() => {}); stickies.delete(message.channelId); await message.reply('🗑️ Sticky removed.'); }
  else if (command === 'logging') { const sub = (args[0] || '').toLowerCase(); if (sub === 'setup') { try { await setupLogging(message.guild); await message.reply('✅ Lounge Logs setup complete.'); } catch (e) { await message.reply(`❌ ${e.message}`); } } else if (sub === 'status') await message.reply(logs.has(message.guild.id) ? '🟢 Logging is configured.' : '⚪ Logging is not configured.'); else await message.reply(`Usage: ${PREFIX}logging setup`); }
  else if (command === 'automod') { const sub = (args[0] || '').toLowerCase(); const cfg = getConfig(message.guild.id); if (sub === 'status') await message.reply(`AutoMod: **${cfg.enabled ? 'ON' : 'OFF'}** | Links: **${cfg.links ? 'BLOCKED' : 'ALLOWED'}** | Invites: **${cfg.invites ? 'BLOCKED' : 'ALLOWED'}** | GIF-only roles: **${cfg.gifOnly.roles.length}** | users: **${cfg.gifOnly.users.length}**`); else if (sub === 'on' || sub === 'off') { cfg.enabled = sub === 'on'; saveConfig(); await message.reply(`AutoMod ${cfg.enabled ? 'enabled' : 'disabled'}.`); } else if (sub === 'links' || sub === 'invites') { const value = (args[1] || '').toLowerCase(); if (!['on', 'off'].includes(value)) return message.reply(`Usage: ${PREFIX}automod ${sub} <on|off>`); cfg[sub] = value === 'on'; saveConfig(); await message.reply(`${sub} are now ${cfg[sub] ? 'blocked' : 'allowed'}.`); } else if (sub === 'word') { const action = (args[1] || '').toLowerCase(); const word = args.slice(2).join(' ').trim().toLowerCase(); if (!['add', 'remove'].includes(action) || !word) return message.reply(`Usage: ${PREFIX}automod word <add|remove> <word>`); if (action === 'add' && !cfg.words.includes(word)) cfg.words.push(word); if (action === 'remove') cfg.words = cfg.words.filter(w => w !== word); saveConfig(); await message.reply(`Blocked word ${action === 'add' ? 'added' : 'removed'}: \`${word}\``); } else if (sub === 'gifonly') { const action = (args[1] || '').toLowerCase(); const target = resolveTarget(message.guild, args.slice(2).join(' ')); if (!['add', 'remove'].includes(action) || !target) return message.reply(`Usage: ${PREFIX}automod gifonly <add|remove> <@role|@user>`); if (target.type === 'role') { if (action === 'add' && !cfg.gifOnly.roles.includes(target.id)) cfg.gifOnly.roles.push(target.id); if (action === 'remove') cfg.gifOnly.roles = cfg.gifOnly.roles.filter(id => id !== target.id); } else { if (action === 'add' && !cfg.gifOnly.users.includes(target.id)) cfg.gifOnly.users.push(target.id); if (action === 'remove') cfg.gifOnly.users = cfg.gifOnly.users.filter(id => id !== target.id); } saveConfig(); await message.reply(`✅ GIF-only ${action === 'add' ? 'enabled for' : 'removed from'} **${target.name}**.`); } else await message.reply(`Usage: ${PREFIX}automod <status|on|off|links|invites|word|gifonly> ...`); }
  return true;
}

client.once('ready', async () => {
  console.log(`[Lounge] Logged in as ${client.user.tag} (${client.user.id})`);
  client.user.setPresence({ status: 'dnd', activities: [{ name: 'Lounge', type: ActivityType.Watching }] });
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try { await rest.put(Routes.applicationCommands(CLIENT_ID), { body: slash }); for (const guild of client.guilds.cache.values()) await rest.put(Routes.applicationGuildCommands(CLIENT_ID, guild.id), { body: [] }); console.log(`[Lounge] Registered ${slash.length} global commands and cleared guild duplicates in ${client.guilds.cache.size} guild(s).`); }
  catch (error) { console.error('[Lounge] Command registration failed:', error); }
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  try { await interaction.deferReply(); await handleSlash(interaction); }
  catch (error) { console.error(`[Lounge] /${interaction.commandName} failed:`, error); const payload = { content: '❌ Something went wrong while running that command.', ephemeral: true }; try { if (interaction.deferred || interaction.replied) await interaction.editReply(payload); else await interaction.reply(payload); } catch {} }
});

client.on('messageCreate', async message => { try { if (await handlePrefix(message)) return; await runAutoMod(message); const sticky = stickies.get(message.channelId); if (sticky && message.id !== sticky.messageId) { await message.channel.messages.delete(sticky.messageId).catch(() => {}); const sent = await message.channel.send({ content: sticky.content, allowedMentions: { parse: [] } }); sticky.messageId = sent.id; } } catch (error) { console.error('[Lounge] message handler error:', error); } });
client.on('guildMemberAdd', member => logEvent(member.guild, 'member', 'Member joined', `<@${member.id}> joined the server.`));
client.on('guildMemberRemove', member => logEvent(member.guild, 'member', 'Member left', `<@${member.id}> left the server.`));
client.on('voiceStateUpdate', (oldState, newState) => { if (oldState.channelId === newState.channelId) return; const channel = newState.channel || oldState.channel; if (channel) logEvent(channel.guild, 'voice', 'Voice update', `<@${newState.id}> voice state changed.`); });
client.on('channelCreate', channel => { if (channel.guild) logEvent(channel.guild, 'server', 'Channel created', `<#${channel.id}>`); });
client.on('channelDelete', channel => { if (channel.guild) logEvent(channel.guild, 'server', 'Channel deleted', `#${channel.name}`); });
client.on('roleCreate', role => logEvent(role.guild, 'role', 'Role created', `<@&${role.id}>`));
client.on('roleDelete', role => logEvent(role.guild, 'role', 'Role deleted', `**${role.name}**`));
client.on('error', error => console.error('[Lounge] Discord client error:', error));
client.on('warn', warning => console.warn('[Lounge] Discord warning:', warning));
process.on('unhandledRejection', error => console.error('[Lounge] Unhandled rejection:', error));
process.on('uncaughtException', error => console.error('[Lounge] Uncaught exception:', error));

client.login(TOKEN).catch(error => { console.error('[Lounge] Login failed:', error); process.exit(1); });
