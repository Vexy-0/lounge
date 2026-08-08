import 'dotenv/config';
import {
  Client, Collection, GatewayIntentBits, REST, Routes, SlashCommandBuilder,
  EmbedBuilder, ActivityType, PermissionFlagsBits,
} from 'discord.js';

const TOKEN = process.env.DISCORD_TOKEN || process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID || process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const PREFIX = process.env.PREFIX || '!';
if (!TOKEN) throw new Error('Missing DISCORD_TOKEN (or TOKEN).');
if (!CLIENT_ID) throw new Error('Missing CLIENT_ID (Discord Application ID).');
if (!GUILD_ID) throw new Error('Missing GUILD_ID (Discord Server ID).');

const client = new Client({ intents: [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
  GatewayIntentBits.GuildMembers,
] });
client.commands = new Collection();
const startedAt = Date.now();
const stickies = new Map();
const stickyLocks = new Set();
const automod = new Map();
const gifOnly = new Map();
const spamTracker = new Map();
const gifUrlCache = new Map();

const DEFAULT_AUTOMOD = () => ({
  enabled: true,
  links: true,
  invites: true,
  caps: false,
  capsPercent: 80,
  capsMinLength: 12,
  mentionSpam: true,
  mentionLimit: 6,
  duplicate: true,
  duplicateCount: 3,
  spam: true,
  spamCount: 5,
  spamWindowMs: 7000,
  words: new Set(),
  exemptRoles: new Set(),
  exemptChannels: new Set(),
});

// Known GIF providers. Provider page URLs are valid GIF content even when
// their URL does not end in .gif (for example Tenor/Giphy share URLs).
const GIF_PAGE_HOSTS = new Set([
  'giphy.com', 'media.giphy.com', 'i.giphy.com',
  'tenor.com', 'media.tenor.com', 'c.tenor.com', 'media1.tenor.com',
  'redgifs.com', 'media.redgifs.com',
  'gfycat.com', 'giant.gfycat.com',
]);
const DIRECT_GIF_HOSTS = new Set([
  'cdn.discordapp.com', 'media.discordapp.net', 'images-ext-1.discordapp.net',
  'i.imgur.com', 'imgur.com', 'i.redd.it', 'preview.redd.it',
]);
const URL_RE = /(?:https?:\/\/|www\.)[^\s<>()]+/gi;
const MARKDOWN_URL_RE = /\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/gi;
const INVITE_RE = /(?:discord(?:app)?\.com\/invite|discord\.gg)\/[A-Za-z0-9-]+/i;

function getConfig(guildId) { if (!automod.has(guildId)) automod.set(guildId, DEFAULT_AUTOMOD()); return automod.get(guildId); }
function getGifBypass(guildId) { if (!gifOnly.has(guildId)) gifOnly.set(guildId, { roles: new Set(), users: new Set() }); return gifOnly.get(guildId); }
function isManageMessages(member) { return member?.permissions?.has(PermissionFlagsBits.ManageMessages) === true; }
function extractUrls(text) {
  const urls = [];
  for (const m of text.matchAll(URL_RE)) urls.push(m[0].replace(/[),.!?]+$/g, ''));
  for (const m of text.matchAll(MARKDOWN_URL_RE)) urls.push(m[1]);
  return [...new Set(urls)];
}
function normalizeUrl(url) { return /^www\./i.test(url) ? `https://${url}` : url; }
function getHost(url) { try { return new URL(normalizeUrl(url)).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } }
function isKnownGifHost(host) {
  return [...GIF_PAGE_HOSTS].some(h => host === h || host.endsWith(`.${h}`));
}
function isGifExtension(url) {
  try {
    const parsed = new URL(normalizeUrl(url));
    const path = parsed.pathname.toLowerCase();
    return /\.gif(?:$|\/)/.test(path) || /(?:^|[?&])(?:format|fm)=gif(?:$|&)/i.test(parsed.search);
  } catch { return false; }
}
function isDirectGifHost(url) {
  const host = getHost(url);
  return [...DIRECT_GIF_HOSTS].some(h => host === h || host.endsWith(`.${h}`));
}

// Unknown GIF hosts are checked by Content-Type. This is what makes the
// bypass work with arbitrary GIF/CDN URLs instead of maintaining a fragile
// hard-coded list of websites. Results are cached briefly to avoid latency.
async function isGifUrl(url) {
  const normalized = normalizeUrl(url);
  if (isGifExtension(normalized) || isKnownGifHost(getHost(normalized))) return true;
  if (gifUrlCache.has(normalized)) {
    const cached = gifUrlCache.get(normalized);
    if (cached.expires > Date.now()) return cached.value;
    gifUrlCache.delete(normalized);
  }
  try {
    const response = await fetch(normalized, {
      method: 'HEAD',
      redirect: 'follow',
      signal: AbortSignal.timeout(2500),
      headers: { 'User-Agent': 'Lounge-AutoMod/1.0' },
    });
    const type = (response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
    const value = type === 'image/gif';
    gifUrlCache.set(normalized, { value, expires: Date.now() + 5 * 60_000 });
    return value;
  } catch {
    return false;
  }
}

function isGifAttachment(file) {
  const type = (file.contentType || '').toLowerCase().split(';', 1)[0].trim();
  const name = (file.name || '').toLowerCase();
  return type === 'image/gif' || name.endsWith('.gif');
}
function isGifOnlyMember(message) {
  const bypass = getGifBypass(message.guild.id);
  return bypass.users.has(message.author.id) || message.member?.roles?.cache?.some(role => bypass.roles.has(role.id)) === true;
}
function isExempt(message, config) {
  if (message.member?.permissions?.has(PermissionFlagsBits.Administrator)) return true;
  if (config.exemptChannels.has(message.channel.id)) return true;
  return message.member?.roles?.cache?.some(role => config.exemptRoles.has(role.id)) === true;
}
async function punish(message, reason) {
  await message.delete().catch(() => {});
  if (message.member?.moderatable) await message.member.timeout(60_000, `Lounge AutoMod: ${reason}`).catch(() => {});
  const warning = await message.channel.send({ content: `⚠️ <@${message.author.id}> message removed: **${reason}**`, allowedMentions: { users: [message.author.id] } }).catch(() => null);
  if (warning) setTimeout(() => warning.delete().catch(() => {}), 5000).unref?.();
}
function tooManyCaps(content, config) {
  const letters = content.replace(/[^A-Za-z]/g, '');
  if (letters.length < config.capsMinLength) return false;
  return (letters.replace(/[^A-Z]/g, '').length / letters.length) * 100 >= config.capsPercent;
}
function spamReason(message, config) {
  const now = Date.now();
  const key = `${message.guild.id}:${message.author.id}`;
  const history = (spamTracker.get(key) || []).filter(e => now - e.time <= config.spamWindowMs);
  history.push({ time: now, content: message.content.trim().toLowerCase() });
  spamTracker.set(key, history.slice(-10));
  if (config.spam && history.length >= config.spamCount) return 'message spam';
  if (config.duplicate && history.filter(e => e.content === message.content.trim().toLowerCase()).length >= config.duplicateCount) return 'duplicate messages';
  return null;
}
async function checkGifOnly(message) {
  if (!isGifOnlyMember(message)) return false;

  const urls = extractUrls(message.content);
  const attachments = [...message.attachments.values()];

  // GIF-only members may send a GIF attachment, including Discord-hosted
  // uploads, without needing a URL in the message content.
  if (attachments.length > 0) {
    const allGifAttachments = attachments.every(isGifAttachment);
    const contentUrls = urls.length ? await Promise.all(urls.map(isGifUrl)) : [];
    const allUrlsGif = contentUrls.every(Boolean);
    if (allGifAttachments && allUrlsGif && !INVITE_RE.test(message.content)) return false;
    await punish(message, 'GIF-only: only GIF links or GIF files are allowed');
    return true;
  }

  if (!urls.length) {
    await punish(message, 'GIF-only: only GIF links or GIF files are allowed');
    return true;
  }

  if (INVITE_RE.test(message.content)) {
    await punish(message, 'GIF-only: Discord invites are not allowed');
    return true;
  }

  const results = await Promise.all(urls.map(isGifUrl));
  if (results.every(Boolean)) return false;

  await punish(message, 'GIF-only: only GIF links or GIF files are allowed');
  return true;
}
async function runAutoMod(message) {
  if (!message.guild || message.author.bot || message.webhookId) return;
  const config = getConfig(message.guild.id);
  if (!config.enabled || isExempt(message, config)) return;
  if (await checkGifOnly(message)) return;
  const urls = extractUrls(message.content);
  if (config.invites && INVITE_RE.test(message.content)) return punish(message, 'Discord invite links are not allowed');
  if (config.links && urls.length) {
    const allowed = await Promise.all(urls.map(isGifUrl));
    if (allowed.some(value => !value)) return punish(message, 'links are not allowed');
  }
  if (config.words.size) {
    const lowered = message.content.toLowerCase();
    for (const word of config.words) if (lowered.includes(word.toLowerCase())) return punish(message, 'blocked word');
  }
  if (config.mentionSpam && message.mentions.users.size + message.mentions.roles.size >= config.mentionLimit) return punish(message, 'mention spam');
  if (config.caps && tooManyCaps(message.content, config)) return punish(message, 'excessive caps');
  const spam = spamReason(message, config);
  if (spam) await punish(message, spam);
}

function statusEmbed() {
  const uptime = Math.floor((Date.now() - startedAt) / 1000);
  return new EmbedBuilder().setTitle('Lounge Status').setDescription('The bot is online and responding normally.').addFields(
    { name: 'Status', value: '🟢 Online', inline: true }, { name: 'Latency', value: `${client.ws.ping}ms`, inline: true },
    { name: 'Uptime', value: `${uptime}s`, inline: true }, { name: 'Servers', value: `${client.guilds.cache.size}`, inline: true },
    { name: 'Memory', value: `${Math.round(process.memoryUsage().rss / 1024 / 1024)} MB`, inline: true },
  );
}
function automodStatus(guildId) {
  const c = getConfig(guildId); const b = getGifBypass(guildId);
  return new EmbedBuilder().setTitle('Lounge AutoMod').setDescription([
    `**Status:** ${c.enabled ? '🟢 Enabled' : '🔴 Disabled'}`, `**Links:** ${c.links ? 'Blocked' : 'Allowed'}`,
    `**Invites:** ${c.invites ? 'Blocked' : 'Allowed'}`, `**Caps:** ${c.caps ? `Blocked above ${c.capsPercent}%` : 'Off'}`,
    `**Mention spam:** ${c.mentionSpam ? `Blocked at ${c.mentionLimit}+ mentions` : 'Off'}`, `**Spam:** ${c.spam ? 'On' : 'Off'}`,
    `**Blocked words:** ${c.words.size}`, `**GIF-only roles:** ${b.roles.size}`, `**GIF-only users:** ${b.users.size}`,
  ].join('\n'));
}
function helpEmbed() {
  return new EmbedBuilder().setTitle('Lounge Commands').setDescription([
    '**General**', '`/ping` — Check latency', '`/status` — Bot health/status', '`/help` — Show this menu', '',
    '**Sticky**', '`/sticky` — Create/update a sticky message', '`/stickyremove` — Remove the sticky message', '',
    '**AutoMod**', '`/automod status` — View settings', '`/automod on|off` — Enable/disable', '`/automod links on|off` — Normal links',
    '`/automod invites on|off` — Discord invites', '`/automod word add|remove` — Blocked words', '`/automod exempt add|remove` — Exempt role/channel',
    '`/automod gifonly add|remove` — GIF-only role/user', '', '**Prefix**',
    `\`${PREFIX}ping\` · \`${PREFIX}status\` · \`${PREFIX}help\``, `\`${PREFIX}sticky <message>\` · \`${PREFIX}stickyremove\``,
    `\`${PREFIX}automod status\` · \`${PREFIX}automod on\` · \`${PREFIX}automod off\``,
    `\`${PREFIX}automod links on|off\` · \`${PREFIX}automod invites on|off\``,
    `\`${PREFIX}automod word add|remove <word>\``, `\`${PREFIX}automod gifonly add|remove @role|@user\``,
  ].join('\n'));
}
async function sendSticky(channel, sticky) {
  const existing = stickies.get(channel.id); if (existing?.messageId) await channel.messages.delete(existing.messageId).catch(() => {});
  const sent = await channel.send({ content: sticky.content, allowedMentions: { parse: [] } }); stickies.set(channel.id, { ...sticky, messageId: sent.id }); return sent;
}
async function setSticky(channel, content, userId) {
  if (!channel?.isTextBased?.()) throw new Error('This command can only be used in a text channel.');
  if (!content?.trim()) throw new Error('Sticky message cannot be empty.'); if (content.length > 2000) throw new Error('Sticky message must be 2000 characters or less.');
  if (stickyLocks.has(channel.id)) return false; stickyLocks.add(channel.id); try { await sendSticky(channel, { content: content.trim(), userId }); return true; } finally { stickyLocks.delete(channel.id); }
}
async function removeSticky(channel) {
  if (!channel?.isTextBased?.() || stickyLocks.has(channel.id)) return false; stickyLocks.add(channel.id);
  try { const existing = stickies.get(channel.id); if (!existing) return false; if (existing.messageId) await channel.messages.delete(existing.messageId).catch(() => {}); stickies.delete(channel.id); return true; } finally { stickyLocks.delete(channel.id); }
}
function targetId(value) { return value?.match(/^<@!?([0-9]+)>$/)?.[1] || value?.match(/^<@&([0-9]+)>$/)?.[1] || value; }

const automodData = new SlashCommandBuilder().setName('automod').setDescription('Configure Lounge AutoMod.').setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages.toString())
  .addSubcommand(s => s.setName('status').setDescription('View AutoMod settings.'))
  .addSubcommand(s => s.setName('on').setDescription('Enable AutoMod.'))
  .addSubcommand(s => s.setName('off').setDescription('Disable AutoMod.'))
  .addSubcommand(s => s.setName('links').setDescription('Allow or block normal links.').addBooleanOption(o => o.setName('enabled').setDescription('Block normal links?').setRequired(true)))
  .addSubcommand(s => s.setName('invites').setDescription('Allow or block Discord invites.').addBooleanOption(o => o.setName('enabled').setDescription('Block Discord invites?').setRequired(true)))
  .addSubcommand(s => s.setName('word').setDescription('Add or remove a blocked word.').addStringOption(o => o.setName('action').setDescription('Add or remove.').setRequired(true).addChoices({ name: 'add', value: 'add' }, { name: 'remove', value: 'remove' })).addStringOption(o => o.setName('word').setDescription('Word or phrase.').setRequired(true).setMaxLength(100)))
  .addSubcommand(s => s.setName('exempt').setDescription('Exempt a role or channel.').addStringOption(o => o.setName('action').setDescription('Add or remove.').setRequired(true).addChoices({ name: 'add', value: 'add' }, { name: 'remove', value: 'remove' })).addStringOption(o => o.setName('target').setDescription('Role or channel mention/ID.').setRequired(true)))
  .addSubcommand(s => s.setName('gifonly').setDescription('Allow a role or user to post GIFs only.').addStringOption(o => o.setName('action').setDescription('Add or remove.').setRequired(true).addChoices({ name: 'add', value: 'add' }, { name: 'remove', value: 'remove' })).addStringOption(o => o.setName('target').setDescription('Role or user mention/ID.').setRequired(true)));

const commands = [
  { data: new SlashCommandBuilder().setName('ping').setDescription('Check the bot latency.'), execute: async i => i.reply(`🏓 Pong! ${client.ws.ping}ms`) },
  { data: new SlashCommandBuilder().setName('status').setDescription('Show bot status.'), execute: async i => i.reply({ embeds: [statusEmbed()] }) },
  { data: new SlashCommandBuilder().setName('help').setDescription('Show available commands.'), execute: async i => i.reply({ embeds: [helpEmbed()] }) },
  { data: new SlashCommandBuilder().setName('sticky').setDescription('Create or replace the sticky message in this channel.').addStringOption(o => o.setName('message').setDescription('Message to keep at the bottom.').setRequired(true).setMaxLength(2000)).setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages.toString()), execute: async i => { if (!isManageMessages(i.member)) return i.reply({ content: '❌ Manage Messages is required.', ephemeral: true }); const ok = await setSticky(i.channel, i.options.getString('message', true), i.user.id).catch(() => false); return i.reply(ok ? '✅ Sticky message set.' : '⚠️ Sticky update already in progress.'); } },
  { data: new SlashCommandBuilder().setName('stickyremove').setDescription('Remove the sticky message in this channel.').setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages.toString()), execute: async i => { if (!isManageMessages(i.member)) return i.reply({ content: '❌ Manage Messages is required.', ephemeral: true }); const ok = await removeSticky(i.channel).catch(() => false); return i.reply(ok ? '✅ Sticky removed.' : 'ℹ️ No sticky is set here.'); } },
  { data: automodData, execute: async i => {
    if (!isManageMessages(i.member)) return i.reply({ content: '❌ Manage Messages is required.', ephemeral: true });
    const c = getConfig(i.guildId); const sub = i.options.getSubcommand();
    if (sub === 'status') return i.reply({ embeds: [automodStatus(i.guildId)], ephemeral: true });
    if (sub === 'on' || sub === 'off') { c.enabled = sub === 'on'; return i.reply(`✅ AutoMod is now **${c.enabled ? 'enabled' : 'disabled'}**.`); }
    if (sub === 'links' || sub === 'invites') { c[sub] = i.options.getBoolean('enabled', true); return i.reply(`✅ ${sub} are now **${c[sub] ? 'blocked' : 'allowed'}**.`); }
    if (sub === 'word') { const action = i.options.getString('action', true); const word = i.options.getString('word', true).trim().toLowerCase(); if (action === 'add') c.words.add(word); else c.words.delete(word); return i.reply(`✅ Blocked word **${word}** ${action === 'add' ? 'added' : 'removed'}.`); }
    if (sub === 'exempt') { const action = i.options.getString('action', true); const raw = i.options.getString('target', true); const id = targetId(raw); const isRole = /^<@&\d+>$/.test(raw) || Boolean(i.guild.roles.cache.get(id)); const set = isRole ? c.exemptRoles : c.exemptChannels; if (action === 'add') set.add(id); else set.delete(id); return i.reply({ content: `✅ ${isRole ? 'Role' : 'channel'} exemption ${action === 'add' ? 'added' : 'removed'}.`, ephemeral: true }); }
    if (sub === 'gifonly') { const action = i.options.getString('action', true); const raw = i.options.getString('target', true); const id = targetId(raw); const b = getGifBypass(i.guildId); const isRole = /^<@&\d+>$/.test(raw) || Boolean(i.guild.roles.cache.get(id)); const set = isRole ? b.roles : b.users; if (action === 'add') set.add(id); else set.delete(id); return i.reply({ content: `✅ GIF-only ${isRole ? 'role' : 'user'} ${action === 'add' ? 'added' : 'removed'}.`, ephemeral: true }); }
  } },
];
for (const c of commands) client.commands.set(c.data.name, c);

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN); const body = commands.map(c => c.data.toJSON());
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body });
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: [] });
  console.log(`Registered ${body.length} guild slash commands.`); console.log(`Cleared global commands. Active: ${body.map(c => `/${c.name}`).join(', ')}`);
}
client.once('ready', async () => {
  client.user.setPresence({ activities: [{ name: 'Lounge', type: ActivityType.Watching }], status: 'dnd' });
  console.log(`Logged in as ${client.user.tag} (${client.user.id})`); console.log('Presence: Do Not Disturb • Watching Lounge');
  try { await registerCommands(); console.log('Slash command registration completed successfully.'); } catch (e) { console.error('Slash command registration failed:', e); }
  console.log(`Lounge is online. Prefix: ${PREFIX}`);
});
client.on('interactionCreate', async i => {
  if (!i.isChatInputCommand()) return; const c = client.commands.get(i.commandName);
  if (!c) return i.reply({ content: '❌ That command is no longer available.', ephemeral: true }).catch(() => {});
  try { await c.execute(i); } catch (e) { console.error(`Command /${i.commandName} failed:`, e); const r = { content: '❌ Something went wrong while running that command.', ephemeral: true }; if (i.replied || i.deferred) await i.editReply(r).catch(() => i.followUp(r).catch(() => {})); else await i.reply(r).catch(() => {}); }
});
async function runPrefix(message) {
  const raw = message.content.slice(PREFIX.length).trim(); const [name, ...args] = raw.split(/\s+/); const n = (name || '').toLowerCase();
  if (n === 'ping') return message.reply(`🏓 Pong! ${client.ws.ping}ms`).catch(() => {});
  if (n === 'status') return message.reply({ embeds: [statusEmbed()] }).catch(() => {});
  if (n === 'help') return message.reply({ embeds: [helpEmbed()] }).catch(() => {});
  if (n === 'sticky') { if (!isManageMessages(message.member)) return message.reply('❌ Manage Messages is required.').catch(() => {}); const content = args.join(' ').trim(); if (!content) return message.reply(`❌ Usage: ${PREFIX}sticky <message>`).catch(() => {}); const ok = await setSticky(message.channel, content, message.author.id).catch(() => false); return message.reply(ok ? '✅ Sticky message set.' : '⚠️ Sticky update already in progress.').catch(() => {}); }
  if (n === 'stickyremove') { if (!isManageMessages(message.member)) return message.reply('❌ Manage Messages is required.').catch(() => {}); const ok = await removeSticky(message.channel).catch(() => false); return message.reply(ok ? '✅ Sticky removed.' : 'ℹ️ No sticky is set here.').catch(() => {}); }
  if (n !== 'automod') return;
  if (!isManageMessages(message.member)) return message.reply('❌ Manage Messages is required.').catch(() => {});
  const c = getConfig(message.guild.id); const sub = (args.shift() || 'status').toLowerCase();
  if (sub === 'status') return message.reply({ embeds: [automodStatus(message.guild.id)] }).catch(() => {});
  if (sub === 'on' || sub === 'off') { c.enabled = sub === 'on'; return message.reply(`✅ AutoMod is now **${c.enabled ? 'enabled' : 'disabled'}**.`).catch(() => {}); }
  if (sub === 'links' || sub === 'invites') { const value = (args.shift() || '').toLowerCase(); if (!['on', 'off'].includes(value)) return message.reply(`❌ Usage: ${PREFIX}automod ${sub} on|off`).catch(() => {}); c[sub] = value === 'on'; return message.reply(`✅ ${sub} are now **${c[sub] ? 'blocked' : 'allowed'}**.`).catch(() => {}); }
  if (sub === 'word') { const action = (args.shift() || '').toLowerCase(); const word = args.join(' ').trim().toLowerCase(); if (!['add', 'remove'].includes(action) || !word) return message.reply(`❌ Usage: ${PREFIX}automod word add|remove <word>`).catch(() => {}); if (action === 'add') c.words.add(word); else c.words.delete(word); return message.reply(`✅ Word ${action === 'add' ? 'added' : 'removed'}.`).catch(() => {}); }
  if (sub === 'gifonly') { const action = (args.shift() || '').toLowerCase(); const raw = args.shift(); const id = targetId(raw); if (!['add', 'remove'].includes(action) || !id) return message.reply(`❌ Usage: ${PREFIX}automod gifonly add|remove @role|@user`).catch(() => {}); const b = getGifBypass(message.guild.id); const isRole = /^<@&\d+>$/.test(raw) || Boolean(message.guild.roles.cache.get(id)); const set = isRole ? b.roles : b.users; if (action === 'add') set.add(id); else set.delete(id); return message.reply(`✅ GIF-only ${isRole ? 'role' : 'user'} ${action === 'add' ? 'added' : 'removed'}.`).catch(() => {}); }
  return message.reply(`❌ Unknown AutoMod option. Use ${PREFIX}automod status`).catch(() => {});
}
client.on('messageCreate', async message => {
  if (message.author.bot || !message.guild) return;
  if (message.content.startsWith(PREFIX)) { await runPrefix(message); return; }
  await runAutoMod(message).catch(e => console.error('AutoMod failed:', e));
  const sticky = stickies.get(message.channel.id); if (!sticky || stickyLocks.has(message.channel.id)) return;
  stickyLocks.add(message.channel.id);
  try { if (sticky.messageId === message.id) return; await message.channel.messages.delete(sticky.messageId).catch(() => {}); const sent = await message.channel.send({ content: sticky.content, allowedMentions: { parse: [] } }); stickies.set(message.channel.id, { ...sticky, messageId: sent.id }); }
  catch (e) { console.error(`Sticky bump failed in ${message.channel.id}:`, e); } finally { stickyLocks.delete(message.channel.id); }
});
setInterval(() => { const now = Date.now(); for (const [key, entries] of spamTracker) { const recent = entries.filter(e => now - e.time <= 10_000); if (recent.length) spamTracker.set(key, recent); else spamTracker.delete(key); } for (const [url, entry] of gifUrlCache) { if (entry.expires <= now) gifUrlCache.delete(url); } }, 30_000).unref();
process.on('unhandledRejection', e => console.error('Unhandled rejection:', e)); process.on('uncaughtException', e => console.error('Uncaught exception:', e));
await client.login(TOKEN);
