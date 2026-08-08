import 'dotenv/config';
import { ActivityType, ChannelType, Client, GatewayIntentBits, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import fs from 'node:fs/promises';
import path from 'node:path';

const TOKEN = process.env.DISCORD_TOKEN || process.env.TOKEN;
const PREFIX = (process.env.PREFIX || '!').trim() || '!';
if (!TOKEN) throw new Error('Missing DISCORD_TOKEN/TOKEN in Railway variables.');

// Keep the gateway intents minimal. MessageContent is required for !prefix commands.
// GuildMembers is intentionally NOT requested because it is a privileged intent and
// should not be able to take the whole bot offline if it is disabled in the Portal.
const client = new Client({ intents: [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.GuildVoiceStates,
  GatewayIntentBits.MessageContent,
] });

const DATA = path.join(process.cwd(), 'data');
const FILE = path.join(DATA, 'guild-settings.json');
const configs = new Map();
const stickies = new Map();
const spam = new Map();
let saveTimer;
const started = Date.now();

const commands = [
  new SlashCommandBuilder().setName('ping').setDescription('Check Lounge latency.'),
  new SlashCommandBuilder().setName('status').setDescription('Show Lounge status.'),
  new SlashCommandBuilder().setName('help').setDescription('Show Lounge commands.'),
  new SlashCommandBuilder().setName('sticky').setDescription('Create a sticky message.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages.toString())
    .addStringOption(o => o.setName('message').setDescription('Sticky message.').setRequired(true).setMaxLength(2000)),
  new SlashCommandBuilder().setName('stickyremove').setDescription('Remove the sticky message.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages.toString()),
  new SlashCommandBuilder().setName('automod').setDescription('Configure AutoMod.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild.toString())
    .addSubcommand(s => s.setName('status').setDescription('Show settings.'))
    .addSubcommand(s => s.setName('on').setDescription('Enable AutoMod.'))
    .addSubcommand(s => s.setName('off').setDescription('Disable AutoMod.'))
    .addSubcommand(s => s.setName('links').setDescription('Configure link blocking.').addBooleanOption(o => o.setName('enabled').setDescription('Block links.').setRequired(true)))
    .addSubcommand(s => s.setName('invites').setDescription('Configure invite blocking.').addBooleanOption(o => o.setName('enabled').setDescription('Block invites.').setRequired(true)))
    .addSubcommand(s => s.setName('caps').setDescription('Configure CAPS protection.').addBooleanOption(o => o.setName('enabled').setDescription('Enable CAPS protection.').setRequired(true)))
    .addSubcommand(s => s.setName('spam').setDescription('Configure spam protection.').addBooleanOption(o => o.setName('enabled').setDescription('Enable spam protection.').setRequired(true)))
    .addSubcommand(s => s.setName('words').setDescription('Manage blocked words.')
      .addStringOption(o => o.setName('action').setDescription('Add/remove.').setRequired(true).addChoices({ name: 'add', value: 'add' }, { name: 'remove', value: 'remove' }))
      .addStringOption(o => o.setName('word').setDescription('Word or phrase.').setRequired(true).setMaxLength(100)))
    .addSubcommand(s => s.setName('gifonly').setDescription('Allow a user/role to send GIFs only.')
      .addStringOption(o => o.setName('action').setDescription('Add/remove.').setRequired(true).addChoices({ name: 'add', value: 'add' }, { name: 'remove', value: 'remove' }))
      .addMentionableOption(o => o.setName('target').setDescription('User or role.').setRequired(true))),
  new SlashCommandBuilder().setName('logging').setDescription('Configure server logs.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild.toString())
    .addSubcommand(s => s.setName('setup').setDescription('Create all log channels.'))
    .addSubcommand(s => s.setName('status').setDescription('Show logging status.')),
].map(c => c.toJSON());

const defaults = () => ({
  automod: true, links: true, invites: true, caps: false, spam: true, duplicate: true, mentionSpam: true,
  badWords: [], gifOnlyRoles: [], gifOnlyUsers: [], exemptRoles: [], exemptChannels: [], logging: {},
});
function cfg(guildId) {
  if (!configs.has(guildId)) configs.set(guildId, defaults());
  const c = configs.get(guildId), d = defaults();
  for (const [k, v] of Object.entries(d)) if (c[k] === undefined) c[k] = Array.isArray(v) ? [...v] : v;
  for (const k of ['badWords','gifOnlyRoles','gifOnlyUsers','exemptRoles','exemptChannels']) if (!Array.isArray(c[k])) c[k] = [];
  if (!c.logging || typeof c.logging !== 'object' || Array.isArray(c.logging)) c.logging = {};
  return c;
}
async function load() {
  try { const data = JSON.parse(await fs.readFile(FILE, 'utf8')); for (const [id, c] of Object.entries(data || {})) configs.set(id, { ...defaults(), ...c }); }
  catch (e) { if (e.code !== 'ENOENT') console.error('[Lounge] Settings load:', e); }
}
function save() {
  clearTimeout(saveTimer); saveTimer = setTimeout(async () => { try { await fs.mkdir(DATA, { recursive: true }); const t = `${FILE}.tmp`; await fs.writeFile(t, JSON.stringify(Object.fromEntries(configs), null, 2)); await fs.rename(t, FILE); } catch (e) { console.error('[Lounge] Settings save:', e); } }, 100);
}
const urls = text => text.match(/https?:\/\/[^\s<>]+/gi) || [];
const invite = text => /(?:discord\.gg|discord(?:app)?\.com\/invite)\/[^\s<>]+/i.test(text);
function gifUrl(value) { try { const u = new URL(value), h = u.hostname.toLowerCase(); const hosts = ['giphy.com','media.giphy.com','tenor.com','media.tenor.com','klipy.com','klipy.co','redgifs.com','gfycat.com','imgur.com','i.imgur.com','cdn.discordapp.com','media.discordapp.net']; return hosts.some(x => h === x || h.endsWith(`.${x}`)) || /\.gif(?:$|[?#])/i.test(u.pathname + u.search); } catch { return false; } }
function gifOnly(message, c) { return c.gifOnlyUsers.includes(message.author.id) || Boolean(message.member?.roles.cache.some(r => c.gifOnlyRoles.includes(r.id))); }
function gifMessage(message) { const a = [...message.attachments.values()]; if (a.length && !a.every(x => (x.contentType || '').toLowerCase() === 'image/gif' || /\.gif(?:$|[?#])/i.test(x.name || '') || gifUrl(x.url))) return false; const u = urls(message.content); if (a.length) return !u.length || u.every(gifUrl); const embeds = [...message.embeds]; if (embeds.length) { const media = embeds.map(e => e.image?.url || e.thumbnail?.url).filter(Boolean); if (media.length && media.every(gifUrl)) return true; } return u.length > 0 && u.every(gifUrl); }
function exempt(message, c) { return message.member?.permissions.has(PermissionFlagsBits.Administrator) || c.exemptChannels.includes(message.channelId) || Boolean(message.member?.roles.cache.some(r => c.exemptRoles.includes(r.id))); }
async function log(guild, type, text) { const id = cfg(guild.id).logging[type], ch = id && guild.channels.cache.get(id); if (ch?.isTextBased()) await ch.send({ content: text, allowedMentions: { parse: [] } }).catch(() => {}); }
async function punish(message, reason) { await message.delete().catch(() => {}); await log(message.guild, 'moderation', `🚨 AutoMod: ${reason}\nUser: <@${message.author.id}>\nChannel: <#${message.channelId}>`); }
async function setupLogs(guild) {
  const c = cfg(guild.id); const cat = guild.channels.cache.find(x => x.type === ChannelType.GuildCategory && x.name.toLowerCase() === 'lounge logs') || await guild.channels.create({ name: 'Lounge Logs', type: ChannelType.GuildCategory, reason: 'Lounge logging setup' });
  const defs = { messages: '📝・message-logs', moderation: '🛡️・moderation-logs', members: '👤・member-logs', voice: '🔊・voice-logs', server: '⚙️・server-logs', roles: '🎭・role-logs' }, out = {};
  for (const [key, name] of Object.entries(defs)) { const ch = guild.channels.cache.find(x => x.parentId === cat.id && x.type === ChannelType.GuildText && x.name === name) || await guild.channels.create({ name, type: ChannelType.GuildText, parent: cat.id, reason: 'Lounge logging setup' }); out[key] = ch.id; }
  c.logging = out; save(); return out;
}
const status = () => `🟢 **Lounge Online**\n🏓 Ping: **${client.ws.ping}ms**\n⏱️ Uptime: **${Math.floor((Date.now()-started)/1000)}s**\n🏠 Servers: **${client.guilds.cache.size}**`;
async function register(guild) { try { await guild.commands.set(commands); console.log(`[Lounge] Registered ${commands.length} commands in ${guild.name} (${guild.id}).`); } catch (e) { console.error(`[Lounge] Command registration ${guild.id}:`, e); } }
async function clearGlobals() { try { const old = await client.application.commands.fetch(); await client.application.commands.set([]); console.log(`[Lounge] Cleared ${old.size} global commands.`); } catch (e) { console.error('[Lounge] Global command cleanup:', e); } }

async function slash(i) {
  if (i.commandName === 'ping') return i.editReply(`🏓 Pong! **${client.ws.ping}ms**`);
  if (i.commandName === 'status') return i.editReply(status());
  if (i.commandName === 'help') return i.editReply(`**Lounge Commands**\n/ping · /status · /help\n/sticky · /stickyremove\n/automod status|on|off|links|invites|caps|spam|words|gifonly\n/logging setup|status\nPrefix: \`${PREFIX}\``);
  if (i.commandName === 'sticky' || i.commandName === 'stickyremove') {
    if (!i.memberPermissions?.has(PermissionFlagsBits.ManageMessages)) return i.editReply('❌ You need **Manage Messages**.');
    const ch = i.channel; if (!ch?.isTextBased()) return i.editReply('❌ Use this in a text channel.');
    if (i.commandName === 'stickyremove') { const old = stickies.get(ch.id); if (!old) return i.editReply('ℹ️ No sticky here.'); await ch.messages.delete(old.id).catch(() => {}); stickies.delete(ch.id); return i.editReply('🗑️ Sticky removed.'); }
    const text = i.options.getString('message', true), old = stickies.get(ch.id); if (old) await ch.messages.delete(old.id).catch(() => {}); const m = await ch.send({ content: text, allowedMentions: { parse: [] } }); stickies.set(ch.id, { id: m.id, text }); return i.editReply('📌 Sticky set.');
  }
  if (i.commandName === 'automod') {
    const c = cfg(i.guildId), sub = i.options.getSubcommand();
    if (sub === 'status') return i.editReply(`🛡️ AutoMod **${c.automod?'ON':'OFF'}**\n🔗 Links **${c.links?'BLOCKED':'ALLOWED'}** · Invites **${c.invites?'BLOCKED':'ALLOWED'}**\n🔠 CAPS **${c.caps?'ON':'OFF'}** · Spam **${c.spam?'ON':'OFF'}**\n🎞️ GIF roles **${c.gifOnlyRoles.length}** · users **${c.gifOnlyUsers.length}**\n🚫 Words **${c.badWords.length}**`);
    if (sub === 'on' || sub === 'off') { c.automod = sub === 'on'; save(); return i.editReply(`🛡️ AutoMod **${c.automod?'ON':'OFF'}**.`); }
    if (['links','invites','caps','spam'].includes(sub)) { c[sub] = i.options.getBoolean('enabled', true); save(); return i.editReply(`✅ ${sub} **${c[sub]?'ON':'OFF'}**.`); }
    if (sub === 'words') { const a=i.options.getString('action',true), w=i.options.getString('word',true).trim().toLowerCase(); if(a==='add'&&!c.badWords.includes(w))c.badWords.push(w); if(a==='remove')c.badWords=c.badWords.filter(x=>x!==w); save(); return i.editReply(`✅ Word **${w}** updated.`); }
    if (sub === 'gifonly') { const t=i.options.getMentionable('target',true), a=i.options.getString('action',true), list=t.user?c.gifOnlyUsers:c.gifOnlyRoles; if(a==='add'&&!list.includes(t.id))list.push(t.id); if(a==='remove'){const n=list.indexOf(t.id);if(n>=0)list.splice(n,1);} save(); return i.editReply(`🎞️ GIF-only **${a}** for <@${t.id}>.`); }
  }
  if (i.commandName === 'logging') { if (i.options.getSubcommand() === 'status') return i.editReply(`📋 Logging **${Object.keys(cfg(i.guildId).logging).length?'SET UP':'NOT SET UP'}**.`); await setupLogs(i.guild); return i.editReply('✅ All Lounge log channels are ready.'); }
  return i.editReply('❌ Unknown command.');
}

async function prefix(message) {
  if (!message.content.startsWith(PREFIX)) return false;
  const parts=message.content.slice(PREFIX.length).trim().split(/\s+/), cmd=(parts.shift()||'').toLowerCase(); if(!cmd)return true;
  const c=cfg(message.guild.id);
  if(cmd==='ping'){await message.reply(`🏓 Pong! **${client.ws.ping}ms**`);return true;}
  if(cmd==='status'){await message.reply(status());return true;}
  if(cmd==='help'){await message.reply(`**Lounge:** ${PREFIX}ping ${PREFIX}status ${PREFIX}help ${PREFIX}sticky ${PREFIX}stickyremove ${PREFIX}automod ${PREFIX}logging`);return true;}
  if(cmd==='sticky'){if(!message.member.permissions.has(PermissionFlagsBits.ManageMessages)){await message.reply('❌ You need Manage Messages.');return true;}const text=parts.join(' ');if(!text){await message.reply(`Usage: ${PREFIX}sticky <message>`);return true;}const old=stickies.get(message.channelId);if(old)await message.channel.messages.delete(old.id).catch(()=>{});const m=await message.channel.send({content:text,allowedMentions:{parse:[]}});stickies.set(message.channelId,{id:m.id,text});await message.reply('📌 Sticky set.');return true;}
  if(cmd==='stickyremove'){if(!message.member.permissions.has(PermissionFlagsBits.ManageMessages)){await message.reply('❌ You need Manage Messages.');return true;}const old=stickies.get(message.channelId);if(!old){await message.reply('ℹ️ No sticky here.');return true;}await message.channel.messages.delete(old.id).catch(()=>{});stickies.delete(message.channelId);await message.reply('🗑️ Sticky removed.');return true;}
  if(cmd==='automod'){if(!message.member.permissions.has(PermissionFlagsBits.ManageGuild)){await message.reply('❌ You need Manage Server.');return true;}const a=(parts.shift()||'status').toLowerCase();if(a==='status'){await message.reply(`🛡️ AutoMod ${c.automod?'ON':'OFF'} · links ${c.links?'BLOCKED':'ALLOWED'} · invites ${c.invites?'BLOCKED':'ALLOWED'} · GIF roles ${c.gifOnlyRoles.length} · users ${c.gifOnlyUsers.length}`);return true;}if(a==='on'||a==='off'){c.automod=a==='on';save();await message.reply(`🛡️ AutoMod ${c.automod?'ON':'OFF'}.`);return true;}if(['links','invites','caps','spam'].includes(a)){const v=(parts.shift()||'').toLowerCase();if(!['on','off'].includes(v)){await message.reply(`Usage: ${PREFIX}automod ${a} on|off`);return true;}c[a]=v==='on';save();await message.reply(`✅ ${a} ${c[a]?'ON':'OFF'}.`);return true;}if(a==='words'){const op=(parts.shift()||'').toLowerCase(),w=parts.join(' ').trim().toLowerCase();if(!w||!['add','remove'].includes(op)){await message.reply(`Usage: ${PREFIX}automod words add|remove <word>`);return true;}if(op==='add'&&!c.badWords.includes(w))c.badWords.push(w);if(op==='remove')c.badWords=c.badWords.filter(x=>x!==w);save();await message.reply('✅ Word updated.');return true;}if(a==='gifonly'){const op=(parts.shift()||'').toLowerCase(),raw=parts[0]||'',id=raw.match(/<@!?([0-9]+)>/)?.[1]||raw.match(/<@&([0-9]+)>/)?.[1];if(!id||!['add','remove'].includes(op)){await message.reply(`Usage: ${PREFIX}automod gifonly add|remove @user/@role`);return true;}const list=message.guild.roles.cache.has(id)?c.gifOnlyRoles:c.gifOnlyUsers;if(op==='add'&&!list.includes(id))list.push(id);if(op==='remove'){const n=list.indexOf(id);if(n>=0)list.splice(n,1);}save();await message.reply(`🎞️ GIF-only ${op} for <@${id}>.`);return true;}await message.reply(`Use ${PREFIX}automod status|on|off|links|invites|caps|spam|words|gifonly`);return true;}
  if(cmd==='logging'){if(!message.member.permissions.has(PermissionFlagsBits.ManageGuild)){await message.reply('❌ You need Manage Server.');return true;}if((parts[0]||'status').toLowerCase()==='setup'){await setupLogs(message.guild);await message.reply('✅ All Lounge log channels are ready.');return true;}await message.reply(`📋 Logging ${Object.keys(c.logging).length?'SET UP':'NOT SET UP'}.`);return true;}
  return false;
}

client.once('ready', async () => { await load(); client.user.setPresence({status:'dnd',activities:[{name:'Lounge',type:ActivityType.Watching}]}); console.log(`[Lounge] Logged in as ${client.user.tag} (${client.user.id}).`); await clearGlobals(); for(const g of client.guilds.cache.values()){cfg(g.id);await register(g);} save(); console.log(`[Lounge] READY — ${client.guilds.cache.size} server(s).`); });
client.on('guildCreate', async g => { cfg(g.id); save(); console.log(`[Lounge] Joined ${g.name} (${g.id}).`); await register(g); });

client.on('interactionCreate', async i => { if(!i.isChatInputCommand())return; console.log(`[Lounge] Interaction /${i.commandName} in ${i.guildId||'DM'}.`); if(!i.inGuild())return i.reply({content:'❌ Use commands in a server.',ephemeral:true}).catch(()=>{}); try{await i.deferReply();await slash(i);}catch(e){console.error(`[Lounge] /${i.commandName}:`,e);const p={content:e?.code===50013?'❌ I need more permissions to do that.':'❌ Something went wrong while running that command.'};if(i.deferred||i.replied)await i.editReply(p).catch(()=>{});else await i.reply({...p,ephemeral:true}).catch(()=>{});} });

client.on('messageCreate', async message => {
  if(!message.guild||message.author.bot)return; const c=cfg(message.guild.id);
  try{if(await prefix(message))return;}catch(e){console.error('[Lounge] Prefix:',e);return;}
  if(!c.automod||exempt(message,c))return;
  if(gifOnly(message,c)){if(!gifMessage(message))await punish(message,'GIF-only user/role sent non-GIF content.');return;}
  const text=message.content||'', links=urls(text);
  if(c.invites&&invite(text)){await punish(message,'Discord invite blocked.');return;}
  if(c.links&&links.length){await punish(message,'Link blocked.');return;}
  const lower=text.toLowerCase(); if(c.badWords.some(w=>w&&lower.includes(w))){await punish(message,'Blocked word detected.');return;}
  if(c.caps){const letters=text.match(/[A-Za-z]/g)||[],upper=text.match(/[A-Z]/g)||[];if(letters.length>=10&&upper.length/letters.length>=.75){await punish(message,'Excessive CAPS detected.');return;}}
  if(c.mentionSpam&&message.mentions.users.size+message.mentions.roles.size>6){await punish(message,'Mention spam detected.');return;}
  const now=Date.now(), s=spam.get(message.author.id)||{times:[],last:'',lastAt:0};s.times=s.times.filter(t=>now-t<6000);s.times.push(now);if(c.spam&&s.times.length>6){spam.set(message.author.id,s);await punish(message,'Message spam detected.');return;}if(c.duplicate&&text&&text===s.last&&now-s.lastAt<10000){await punish(message,'Duplicate message detected.');return;}s.last=text;s.lastAt=now;spam.set(message.author.id,s);
  const sticky=stickies.get(message.channelId); if(sticky&&message.channel?.isTextBased()){await message.channel.messages.delete(sticky.id).catch(()=>{});const m=await message.channel.send({content:sticky.text,allowedMentions:{parse:[]}}).catch(()=>null);if(m)stickies.set(message.channelId,{...sticky,id:m.id});}
});

client.on('messageDelete',m=>{if(m.guild&&!m.author?.bot)log(m.guild,'messages',`🗑️ Message deleted in <#${m.channelId}>.`).catch(()=>{});});
client.on('messageUpdate',(a,b)=>{if(b.guild&&!b.author?.bot&&a.content!==b.content)log(b.guild,'messages',`✏️ Message edited in <#${b.channelId}> by <@${b.author.id}>.`).catch(()=>{});});
client.on('guildMemberAdd',m=>log(m.guild,'members',`📥 <@${m.id}> joined.`).catch(()=>{}));
client.on('guildMemberRemove',m=>log(m.guild,'members',`📤 <@${m.id}> left.`).catch(()=>{}));
client.on('voiceStateUpdate',(a,b)=>{if(a.channelId!==b.channelId)log(b.guild,'voice',`🔊 <@${b.id}> ${b.channelId?(a.channelId?'moved':'joined'):'left'} voice.`).catch(()=>{});});
client.on('channelCreate',c=>{if(c.guild)log(c.guild,'server',`📁 Channel created: ${c.name}`).catch(()=>{});});
client.on('channelDelete',c=>{if(c.guild)log(c.guild,'server',`🗑️ Channel deleted: ${c.name}`).catch(()=>{});});
client.on('roleCreate',r=>log(r.guild,'roles',`🎭 Role created: ${r.name}`).catch(()=>{}));
client.on('roleDelete',r=>log(r.guild,'roles',`🗑️ Role deleted: ${r.name}`).catch(()=>{}));
client.on('error',e=>console.error('[Lounge] Client error:',e));
client.on('shardError',e=>console.error('[Lounge] Gateway error:',e));
process.on('unhandledRejection',e=>console.error('[Lounge] Unhandled rejection:',e));
process.on('uncaughtException',e=>console.error('[Lounge] Uncaught exception:',e));

console.log('[Lounge] Starting...');
client.login(TOKEN).catch(e=>{console.error('[Lounge] Login failed:',e);process.exitCode=1;});
