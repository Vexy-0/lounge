import 'dotenv/config';
import {
  Client,
  Collection,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ActivityType,
  PermissionFlagsBits,
} from 'discord.js';

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

// Lightweight in-memory AutoMod configuration. This intentionally avoids a
// database so moderation checks stay fast. Restarting Railway resets settings.
const automod = new Map();
const gifOnly = new Map(); // guildId -> { roles: Set, users: Set }
const spamTracker = new Map();
const cooldowns = new Map();

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

const GIF_HOSTS = new Set([
  'giphy.com', 'media.giphy.com', 'giphy.gif', 'tenor.com', 'c.tenor.com',
  'media.tenor.com', 'discord.com', 'cdn.discordapp.com', 'images-ext-1.discordapp.net',
  'imgur.com', 'i.imgur.com', 'redgifs.com', 'media.redgifs.com', 'gyazo.com',
]);

const URL_RE = /(?:https?:\/\/|www\.)[^\s<>()]+/gi;
const INVITE_RE = /(?:discord(?:app)?\.com\/invite|discord\.gg)\/[A-Za-z0-9-]+/i;
const MARKDOWN_URL_RE = /\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/gi;

function getConfig(guildId) {
  if (!automod.has(guildId)) automod.set(guildId, DEFAULT_AUTOMOD());
  return automod.get(guildId);
}

function getGifBypass(guildId) {
  if (!gifOnly.has(guildId)) gifOnly.set(guildId, { roles: new Set(), users: new Set() });
  return gifOnly.get(guildId);
}

function isManageMessages(member) {
  return member?.permissions?.has(PermissionFlagsBits.ManageMessages) === true;
}

function isManageGuild(member) {
  return member?.permissions?.has(PermissionFlagsBits.ManageGuild) === true || isManageMessages(member);
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
      '**General**',
      '`/ping` — Check latency',
      '`/status` — Bot health/status',
      '`/help` — Show this menu',
      '',
      '**Sticky**',
      '`/sticky` — Create/update a sticky message',
      '`/stickyremove` — Remove the sticky message',
      '',
      '**AutoMod**',
      '`/automod status` — View AutoMod settings',
      '`/automod on` — Enable AutoMod',
      '`/automod off` — Disable AutoMod',
      '`/automod links` — Toggle normal-link blocking',
      '`/automod invites` — Toggle Discord-invite blocking',
      '`/automod word` — Add/remove a blocked word',
      '`/automod exempt` — Add/remove an exempt role or channel',
      '`/automod gifonly` — Allow a role/user to post GIF links only',
      '',
      '**Prefix**',
      `\`${PREFIX}ping\` · \`${PREFIX}status\` · \`${PREFIX}help\``,
      `\`${PREFIX}sticky <message>\` · \`${PREFIX}stickyremove\``,
      `\`${PREFIX}automod status\` · \`${PREFIX}automod on\` · \`${PREFIX}automod off\``,
      `\`${PREFIX}automod links on|off\` · \`${PREFIX}automod invites on|off\``,
      `\`${PREFIX}automod word add|remove <word>\``,
      `\`${PREFIX}automod gifonly add|remove @role|@user\``,
    ].join('\n'));
}

function extractUrls(text) {
  const urls = [];
  for (const match of text.matchAll(URL_RE)) urls.push(match[0].replace(/[),.!?]+$/g, ''));
  for (const match of text.matchAll(MARKDOWN_URL_RE)) urls.push(match[1]);
  return [...new Set(urls)];
}

function normalizeHost(url) {
  try {
    const value = url.startsWith('www.') ? `https://${url}` : url;
    return new URL(value).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function isGifUrl(url) {
  const host = normalizeHost(url);
  if (!host) return false;
  const pathname = (() => { try { return new URL(url.startsWith('www.') ? `https://${url}` : url).pathname.toLowerCase(); } catch { return ''; } })();
  if (pathname.endsWith('.gif') || pathname.includes('.gif/')) return true;
  return [...GIF_HOSTS].some(allowed => host === allowed || host.endsWith(`.${allowed}`));
}

function hasGifAttachment(message) {
  return message.attachments.some(file => {
    const type = (file.contentType || '').toLowerCase();
    const name = (file.name || '').toLowerCase();
    return type === 'image/gif' || name.endsWith('.gif');
  });
}

function isGifOnlyMember(message) {
  const bypass = getGifBypass(message.guild.id);
  if (bypass.users.has(message.author.id)) return true;
  return message.member?.roles?.cache?.some(role => bypass.roles.has(role.id)) === true;
}

function isExempt(message, config) {
  if (message.member?.permissions?.has(PermissionFlagsBits.Administrator)) return true;
  if (config.exemptChannels.has(message.channel.id)) return true;
  return message.member?.roles?.cache?.some(role => config.exemptRoles.has(role.id)) === true;
}

async function punish(message, reason) {
  await message.delete().catch(() => {});
  const member = message.member;
  if (member?.moderatable) await member.timeout(60_000, `Lounge AutoMod: ${reason}`).catch(() => {});
  const warning = await message.channel.send({
    content: `⚠️ <@${message.author.id}> message removed: **${reason}**`,
    allowedMentions: { users: [message.author.id] },
  }).catch(() => null);
  if (warning) setTimeout(() => warning.delete().catch(() => {}), 5000);
}

function tooManyCaps(content, config) {
  const letters = content.replace(/[^A-Za-z]/g, '');
  if (letters.length < config.capsMinLength) return false;
  const upper = letters.replace(/[^A-Z]/g, '').length;
  return (upper / letters.length) * 100 >= config.capsPercent;
}

function spamReason(message, config) {
  const now = Date.now();
  const key = `${message.guild.id}:${message.author.id}`;
  const history = spamTracker.get(key) || [];
  const recent = history.filter(entry => now - entry.time <= config.spamWindowMs);
  recent.push({ time: now, content: message.content.trim().toLowerCase() });
  spamTracker.set(key, recent.slice(-10));
  if (config.spam && recent.length >= config.spamCount) return 'message spam';
  if (config.duplicate && recent.filter(entry => entry.content === message.content.trim().toLowerCase()).length >= config.duplicateCount) return 'duplicate messages';
  return null;
}

async function checkGifOnly(message) {
  if (!isGifOnlyMember(message)) return false;
  const urls = extractUrls(message.content);
  const gifOk = urls.length > 0 && urls.every(isGifUrl) && !INVITE_RE.test(message.content);
  const attachmentOk = message.attachments.size > 0 && [...message.attachments.values()].every(file => {
    const type = (file.contentType || '').toLowerCase();
    const name = (file.name || '').toLowerCase();
    return type === 'image/gif' || name.endsWith('.gif');
  });
  const hasOnlyGif = gifOk || attachmentOk;
  if (!hasOnlyGif) {
    await punish(message, 'GIF-only bypass: only GIF links or GIF files are allowed');
    return true;
  }
  return false;
}

async function runAutoMod(message) {
  if (!message.guild || message.author.bot || message.webhookId) return;
  const config = getConfig(message.guild.id);
  if (!config.enabled || isExempt(message, config)) return;

  if (await checkGifOnly(message)) return;

  const urls = extractUrls(message.content);
  if (config.invites && INVITE_RE.test(message.content)) {
    await punish(message, 'Discord invite links are not allowed');
    return;
  }
  if (config.links && urls.some(url => !isGifUrl(url))) {
    await punish(message, 'links are not allowed');
    return;
  }
  if (config.words.size && [...config.words].some(word => new RegExp(`(?:^|\\s)${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|\\s)`, 'i').test(message.content))) {
    await punish(message, 'blocked word');
    return;
  }
  if (config.mentionSpam && message.mentions.users.size + message.mentions.roles.size >= config.mentionLimit) {
    await punish(message, 'mention spam');
    return;
  }
  if (config.caps && tooManyCaps(message.content, config)) {
    await punish(message, 'excessive caps');
    return;
  }
  const spam = spamReason(message, config);
  if (spam) await punish(message, spam);
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
  try { await sendSticky(channel, { content: content.trim(), userId }); return true; }
  finally { stickyLocks.delete(channel.id); }
}

async function removeSticky(channel) {
  if (!channel?.isTextBased?.() || stickyLocks.has(channel.id)) return false;
  stickyLocks.add(channel.id);
  try {
    const existing = stickies.get(channel.id);
    if (!existing) return false;
    if (existing.messageId) await channel.messages.delete(existing.messageId).catch(() => {});
    stickies.delete(channel.id);
    return true;
  } finally { stickyLocks.delete(channel.id); }
}

function automodStatus(guildId) {
  const config = getConfig(guildId);
  const bypass = getGifBypass(guildId);
  return new EmbedBuilder().setTitle('Lounge AutoMod').setDescription([
    `**Status:** ${config.enabled ? '🟢 Enabled' : '🔴 Disabled'}`,
    `**Links:** ${config.links ? 'Blocked' : 'Allowed'}`,
    `**Invites:** ${config.invites ? 'Blocked' : 'Allowed'}`,
    `**Caps:** ${config.caps ? `Blocked above ${config.capsPercent}%` : 'Off'}`,
    `**Mention spam:** ${config.mentionSpam ? `Blocked at ${config.mentionLimit}+ mentions` : 'Off'}`,
    `**Spam:** ${config.spam ? 'On' : 'Off'}`,
    `**Blocked words:** ${config.words.size}`,
    `**GIF-only roles:** ${bypass.roles.size}`,
    `**GIF-only users:** ${bypass.users.size}`,
  ].join('\n'));
}

function parseTarget(value) {
  return value?.match(/^<@!?([0-9]+)>$/)?.[1] || value?.match(/^<@&([0-9]+)>$/)?.[1] || null;
}

const automodCommand = new SlashCommandBuilder()
  .setName('automod')
  .setDescription('Configure Lounge AutoMod.')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages.toString())
  .addSubcommand(s => s.setName('status').setDescription('View AutoMod settings.'))
  .addSubcommand(s => s.setName('on').setDescription('Enable AutoMod.'))
  .addSubcommand(s => s.setName('off').setDescription('Disable AutoMod.'))
  .addSubcommand(s => s.setName('links').setDescription('Allow or block normal links.').addBooleanOption(o => o.setName('enabled').setDescription('Block normal links?').setRequired(true)))
  .addSubcommand(s => s.setName('invites').setDescription('Allow or block Discord invites.').addBooleanOption(o => o.setName('enabled').setDescription('Block Discord invites?').setRequired(true)))
  .addSubcommand(s => s.setName('word').setDescription('Add or remove a blocked word.').addStringOption(o => o.setName('action').setDescription('Add or remove.').setRequired(true).addChoices({ name: 'add', value: 'add' }, { name: 'remove', value: 'remove' })).addStringOption(o => o.setName('word').setDescription('Word or phrase.').setRequired(true).setMaxLength(100)))
  .addSubcommand(s => s.setName('exempt').setDescription('Exempt a role or channel.').addStringOption(o => o.setName('action').setDescription('Add or remove.').setRequired(true).addChoices({ name: 'add', value: 'add' }, { name: 'remove', value: 'remove' })).addStringOption(o => o.setName('target').setDescription('Role or channel mention/ID.').setRequired(true)))
  .addSubcommand(s => s.setName('gifonly').setDescription('Give a role or user GIF-only link bypass.').addStringOption(o => o.setName('action').setDescription('Add or remove.').setRequired(true).addChoices({ name: 'add', value: 'add' }, { name: 'remove', value: 'remove' })).addStringOption(o => o.setName('target').setDescription('Role or user mention/ID.').setRequired(true)));

const commands = [
  { data: new SlashCommandBuilder().setName('ping').setDescription('Check the bot latency.'), execute: async i => i.reply(`🏓 Pong! ${client.ws.ping}ms`) },
  { data: new SlashCommandBuilder().setName('status').setDescription('Show bot status.'), execute: async i => i.reply({ embeds: [statusEmbed()] }) },
  { data: new SlashCommandBuilder().setName('help').setDescription('Show available commands.'), execute: async i => i.reply({ embeds: [helpEmbed()] }) },
  { data: new SlashCommandBuilder().setName('sticky').setDescription('Create or replace the sticky message in this channel.').addStringOption(o => o.setName('message').setDescription('Message to keep at the bottom.').setRequired(true).setMaxLength(2000)).setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages.toString()), execute: async i => { if (!isManageMessages(i.member)) return i.reply({ content: '❌ Manage Messages is required.', ephemeral: true }); await i.deferReply({ ephemeral: true }); const created = await setSticky(i.channel, i.options.getString('message', true), i.user.id); return i.editReply(created ? '✅ Sticky message set.' : '⚠️ Sticky update already in progress.'); } },
  { data: new SlashCommandBuilder().setName('stickyremove').setDescription('Remove the sticky message from this channel.').setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages.toString()), execute: async i => { if (!isManageMessages(i.member)) return i.reply({ content: '❌ Manage Messages is required.', ephemeral: true }); await i.deferReply({ ephemeral: true }); const removed = await removeSticky(i.channel); return i.editReply(removed ? '✅ Sticky removed.' : 'ℹ️ No sticky is set here.'); } },
  { data: automodCommand, execute: async i => {
    if (!isManageMessages(i.member)) return i.reply({ content: '❌ Manage Messages is required.', ephemeral: true });
    const config = getConfig(i.guildId); const sub = i.options.getSubcommand();
    if (sub === 'status') return i.reply({ embeds: [automodStatus(i.guildId)], ephemeral: true });
    if (sub === 'on' || sub === 'off') { config.enabled = sub === 'on'; return i.reply(`✅ AutoMod is now **${config.enabled ? 'enabled' : 'disabled'}**.`); }
    if (sub === 'links' || sub === 'invites') { config[sub] = i.options.getBoolean('enabled', true); return i.reply(`✅ ${sub} are now **${config[sub] ? 'blocked' : 'allowed'}**.`); }
    if (sub === 'word') { const word = i.options.getString('word', true).trim().toLowerCase(); const action = i.options.getString('action', true); if (action === 'add') config.words.add(word); else config.words.delete(word); return i.reply(`✅ Blocked word **${word}** ${action === 'add' ? 'added' : 'removed'}.`); }
    if (sub === 'exempt') { const target = i.options.getString('target', true); const id = parseTarget(target) || target; const isRole = /^<@&\d+>$/.test(target) || Boolean(i.guild.roles.cache.get(id)); const set = isRole ? config.exemptRoles : config.exemptChannels; if (action === 'add') set.add(id); else set.delete(id); return i.reply(`✅ ${isRole ? 'Role' : 'Channel'} exemption updated.`); }
    if (sub === 'gifonly') { const target = i.options.getString('target', true); const id = parseTarget(target) || target; const bypass = getGifBypass(i.guildId); const isRole = /^<@&\d+>$/.test(target) || Boolean(i.guild.roles.cache.get(id)); const set = isRole ? bypass.roles : bypass.users; const action = i.options.getString('action', true); if (action === 'add') set.add(id); else set.delete(id); return i.reply(`✅ GIF-only ${isRole ? 'role' : 'user'} ${action === 'add' ? 'added' : 'removed'}.`); }
  } },
];

// Correct the exemption subcommand action lookup without duplicating command objects.
const originalAutomodExecute = commands.find(c => c.data.name === 'automod').execute;
commands.find(c => c.data.name === 'automod').execute = async i => {
  if (i.options.getSubcommand() === 'exempt') {
    if (!isManageMessages(i.member)) return i.reply({ content: '❌ Manage Messages is required.', ephemeral: true });
    const config = getConfig(i.guildId); const target = i.options.getString('target', true); const id = parseTarget(target) || target;
    const action = i.options.getString('action', true); const isRole = /^<@&\d+>$/.test(target) || Boolean(i.guild.roles.cache.get(id));
    const set = isRole ? config.exemptRoles : config.exemptChannels;
    if (action === 'add') set.add(id); else set.delete(id);
    return i.reply({ content: `✅ ${isRole ? 'Role' : 'Channel'} exemption ${action === 'add' ? 'added' : 'removed'}.`, ephemeral: true });
  }
  return originalAutomodExecute(i);
};

for (const command of commands) client.commands.set(command.data.name, command);

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  const body = commands.map(command => command.data.toJSON());
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body });
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: [] });
  console.log(`Registered ${body.length} guild slash commands.`);
  console.log(`Cleared global commands. Active: ${body.map(c => `/${c.name}`).join(', ')}`);
}

client.once('ready', async () => {
  client.user.setPresence({ activities: [{ name: 'Lounge', type: ActivityType.Watching }], status: 'dnd' });
  console.log(`Logged in as ${client.user.tag} (${client.user.id})`);
  try { await registerCommands(); console.log('Slash command registration completed successfully.'); }
  catch (error) { console.error('Slash command registration failed:', error); }
  console.log(`Lounge is online. Prefix: ${PREFIX}`);
});

async function runSlash(interaction) {
  const command = client.commands.get(interaction.commandName);
  if (!command) return interaction.reply({ content: '❌ That command is no longer available.', ephemeral: true }).catch(() => {});
  try { await command.execute(interaction); }
  catch (error) {
    console.error(`Command /${interaction.commandName} failed:`, error);
    const response = { content: '❌ Something went wrong while running that command.', ephemeral: true };
    if (interaction.replied || interaction.deferred) await interaction.editReply(response).catch(() => interaction.followUp(response).catch(() => {}));
    else await interaction.reply(response).catch(() => {});
  }
}

client.on('interactionCreate', async interaction => { if (interaction.isChatInputCommand()) await runSlash(interaction); });

async function runPrefix(message) {
  const raw = message.content.slice(PREFIX.length).trim();
  const [name, ...args] = raw.split(/\s+/); const commandName = (name || '').toLowerCase();
  if (commandName === 'ping') return message.reply(`🏓 Pong! ${client.ws.ping}ms`).catch(() => {});
  if (commandName === 'status') return message.reply({ embeds: [statusEmbed()] }).catch(() => {});
  if (commandName === 'help') return message.reply({ embeds: [helpEmbed()] }).catch(() => {});
  if (commandName === 'sticky') { if (!isManageMessages(message.member)) return message.reply('❌ Manage Messages is required.').catch(() => {}); const content = args.join(' ').trim(); if (!content) return message.reply(`❌ Usage: ${PREFIX}sticky <message>`).catch(() => {}); const created = await setSticky(message.channel, content, message.author.id).catch(() => false); return message.reply(created ? '✅ Sticky message set.' : '⚠️ Sticky update already in progress.').catch(() => {}); }
  if (commandName === 'stickyremove') { if (!isManageMessages(message.member)) return message.reply('❌ Manage Messages is required.').catch(() => {}); const removed = await removeSticky(message.channel).catch(() => false); return message.reply(removed ? '✅ Sticky removed.' : 'ℹ️ No sticky is set here.').catch(() => {}); }
  if (commandName === 'automod') {
    if (!isManageMessages(message.member)) return message.reply('❌ Manage Messages is required.').catch(() => {});
    const sub = (args.shift() || 'status').toLowerCase(); const config = getConfig(message.guild.id);
    if (sub === 'status') return message.reply({ embeds: [automodStatus(message.guild.id)] }).catch(() => {});
    if (sub === 'on' || sub === 'off') { config.enabled = sub === 'on'; return message.reply(`✅ AutoMod is now **${config.enabled ? 'enabled' : 'disabled'}**.`).catch(() => {}); }
    if (sub === 'links' || sub === 'invites') { const value = (args.shift() || '').toLowerCase(); if (!['on', 'off'].includes(value)) return message.reply(`❌ Usage: ${PREFIX}automod ${sub} on|off`).catch(() => {}); config[sub] = value === 'on'; return message.reply(`✅ ${sub} are now **${config[sub] ? 'blocked' : 'allowed'}**.`).catch(() => {}); }
    if (sub === 'word') { const action = (args.shift() || '').toLowerCase(); const word = args.join(' ').trim().toLowerCase(); if (!['add', 'remove'].includes(action) || !word) return message.reply(`❌ Usage: ${PREFIX}automod word add|remove <word>`).catch(() => {}); if (action === 'add') config.words.add(word); else config.words.delete(word); return message.reply(`✅ Word ${action === 'add' ? 'added' : 'removed'}.`).catch(() => {}); }
    if (sub === 'gifonly') { const action = (args.shift() || '').toLowerCase(); const target = args.shift(); const id = parseTarget(target) || target; if (!['add', 'remove'].includes(action) || !id) return message.reply(`❌ Usage: ${PREFIX}automod gifonly add|remove @role|@user`).catch(() => {}); const bypass = getGifBypass(message.guild.id); const isRole = /^<@&\d+>$/.test(target) || Boolean(message.guild.roles.cache.get(id)); const set = isRole ? bypass.roles : bypass.users; if (action === 'add') set.add(id); else set.delete(id); return message.reply(`✅ GIF-only ${isRole ? 'role' : 'user'} ${action === 'add' ? 'added' : 'removed'}.`).catch(() => {}); }
    return message.reply(`❌ Unknown AutoMod option. Use ${PREFIX}automod status`).catch(() => {});
  }
}

client.on('messageCreate', async message => {
  if (message.author.bot || !message.guild) return;
  if (message.content.startsWith(PREFIX)) { await runPrefix(message); return; }
  await runAutoMod(message).catch(error => console.error('AutoMod failed:', error));
  if (message.author.bot) return;
  const sticky = stickies.get(message.channel.id);
  if (!sticky || stickyLocks.has(message.channel.id)) return;
  stickyLocks.add(message.channel.id);
  try {
    if (sticky.messageId === message.id) return;
    await message.channel.messages.delete(sticky.messageId).catch(() => {});
    const sent = await message.channel.send({ content: sticky.content, allowedMentions: { parse: [] } });
    stickies.set(message.channel.id, { ...sticky, messageId: sent.id });
  } catch (error) { console.error(`Sticky bump failed in ${message.channel.id}:`, error); }
  finally { stickyLocks.delete(message.channel.id); }
});

setInterval(() => {
  const now = Date.now();
  for (const [key, entries] of spamTracker) {
    const recent = entries.filter(entry => now - entry.time <= 10_000);
    if (recent.length) spamTracker.set(key, recent); else spamTracker.delete(key);
  }
}, 30_000).unref();

process.on('unhandledRejection', error => console.error('Unhandled rejection:', error));
process.on('uncaughtException', error => console.error('Uncaught exception:', error));
await client.login(TOKEN);
