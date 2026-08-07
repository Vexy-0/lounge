import { PermissionFlagsBits } from 'discord.js';
import { getConfigValue, setConfigValue } from './config/guildConfig.js';
import { ModerationService } from './moderation/moderationService.js';
import { WarningService } from './moderation/warningService.js';
import { logModerationAction } from '../utils/moderation.js';
import { logger } from '../utils/logger.js';

const KEY = 'automod';
const cache = new Map();
const activity = new Map();

export const DEFAULT_AUTOMOD = {
  enabled: false, logChannelId: null,
  exemptUsers: [], exemptRoles: [], exemptChannels: [],
  allowedDomains: [], blockedWords: [], allowedWords: [], regexPatterns: [],
  gifOnlyUsers: [], gifOnlyRoles: [],
  gifAllowedDomains: ['giphy.com','gph.is','tenor.com','media.tenor.com','c.tenor.com','media.giphy.com'],
  rules: {
    words:{enabled:true,action:'delete_warn'}, regex:{enabled:true,action:'delete_warn'}, invites:{enabled:true,action:'delete_warn'},
    links:{enabled:false,action:'delete_warn'}, externalLinks:{enabled:false,action:'delete_warn'}, suspiciousLinks:{enabled:true,action:'delete_warn'},
    linkSpam:{enabled:true,max:3,action:'delete_warn'}, duplicate:{enabled:true,action:'delete_warn'}, fastMessages:{enabled:true,max:5,windowMs:5000,action:'delete_warn'},
    caps:{enabled:true,threshold:70,minLetters:12,action:'delete_warn'}, mentionSpam:{enabled:true,limit:5,action:'delete_warn'}, everyone:{enabled:true,action:'delete_timeout'},
    emojiSpam:{enabled:true,max:12,action:'delete_warn'}, zalgo:{enabled:true,action:'delete_warn'}, attachments:{enabled:false,max:5,action:'delete_warn'},
    stickers:{enabled:false,max:5,action:'delete_warn'}, repeatedChars:{enabled:true,max:14,action:'delete_warn'}, messageLength:{enabled:false,max:1900,action:'delete_warn'},
  },
};

const clone = (v) => JSON.parse(JSON.stringify(v));
const domain = (v) => String(v||'').trim().toLowerCase().replace(/^https?:\/\//,'').replace(/^www\./,'').split('/')[0];
const normalize = (raw) => {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const d = clone(DEFAULT_AUTOMOD);
  return {...d,...r,exemptUsers:(r.exemptUsers||[]).map(String),exemptRoles:(r.exemptRoles||[]).map(String),exemptChannels:(r.exemptChannels||[]).map(String),
    allowedDomains:(r.allowedDomains||[]).map(domain).filter(Boolean),blockedWords:(r.blockedWords||[]).map(String).filter(Boolean).slice(0,1000),allowedWords:(r.allowedWords||[]).map(String).filter(Boolean).slice(0,1000),
    regexPatterns:(r.regexPatterns||[]).map(String).filter(Boolean).slice(0,50),gifOnlyUsers:(r.gifOnlyUsers||[]).map(String),gifOnlyRoles:(r.gifOnlyRoles||[]).map(String),
    gifAllowedDomains:(r.gifAllowedDomains||d.gifAllowedDomains).map(domain).filter(Boolean),rules:{...d.rules,...(r.rules||{})}};
};

export async function getAutomodConfig(client,guildId){if(cache.has(guildId))return cache.get(guildId);const c=normalize(await getConfigValue(client,guildId,KEY,null,{source:'automodEngine'}));cache.set(guildId,c);return c;}
export async function saveAutomodConfig(client,guildId,c){const n=normalize(c);cache.set(guildId,n);await setConfigValue(client,guildId,KEY,n,{source:'automodEngine'});return n;}
export function getDefaultAutomodConfig(){return clone(DEFAULT_AUTOMOD);}

const urls=(text='')=>(text.match(/https?:\/\/[^\s<>()]+|(?:www\.)[a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s<>()]*)?/gi)||[]).map(x=>x.replace(/[),.!?]+$/g,'')).map(x=>{try{return new URL(x.startsWith('http')?x:`https://${x}`);}catch{return null;}}).filter(Boolean);
const host=(h,d)=>h===d||h.endsWith(`.${d}`);
const invite=(u)=>host(u.hostname.toLowerCase(),'discord.gg')||(host(u.hostname.toLowerCase(),'discord.com')&&u.pathname.toLowerCase().startsWith('/invite'));
const gif=(u,c)=>{const h=u.hostname.toLowerCase(),p=u.pathname.toLowerCase();return host(h,'giphy.com')||host(h,'gph.is')||host(h,'tenor.com')||host(h,'media.tenor.com')||host(h,'c.tenor.com')||host(h,'media.giphy.com')||c.gifAllowedDomains.some(d=>host(h,d))&&(/\.gif$/i.test(p)||/\/gif(?:s)?\//.test(p))||((host(h,'cdn.discordapp.com')||host(h,'media.discordapp.net'))&&/\.gif$/i.test(p))||/\.gif$/i.test(p);};
const gifAttachment=(a)=>a?.contentType==='image/gif'||/\.gif(?:$|\?)/i.test(a?.name||'')||/\.gif(?:$|\?)/i.test(a?.url||'');
const onlyGif=(m,c)=>{const us=urls(m.content),as=[...(m.attachments?.values?.()||[])];const has=as.some(gifAttachment)||(us.length>0&&us.every(u=>gif(u,c)));const text=m.content.replace(/https?:\/\/[^\s<>()]+/gi,'').replace(/(?:www\.)[a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s<>()]*)?/gi,'').trim();return has&&!text&&as.every(gifAttachment)&&us.every(u=>gif(u,c));};
const esc=(s)=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const blockedWord=(text,c)=>{const n=text.toLowerCase();return c.blockedWords.some(w=>{const x=String(w).toLowerCase().trim();if(!x||c.allowedWords.some(a=>a.toLowerCase().trim()===x))return false;const core=x.replace(/^\*|\*$/g,'');if(x.startsWith('*')&&x.endsWith('*'))return n.includes(core);if(x.startsWith('*'))return new RegExp(`\\w*${esc(core)}\\b`,'iu').test(n);if(x.endsWith('*'))return new RegExp(`\\b${esc(core)}\\w*`,'iu').test(n);return new RegExp(`(?:^|[^\\p{L}\\p{N}_])${esc(core)}(?:$|[^\\p{L}\\p{N}_])`,'iu').test(n);});};
const regexHit=(text,patterns)=>patterns.some(p=>{try{return p.length<=200&&new RegExp(p,'iu').test(text.slice(0,4000));}catch{return false;}});
const caps=(text)=>{const l=[...text].filter(x=>/\p{L}/u.test(x));if(!l.length)return 0;return l.filter(x=>x===x.toUpperCase()&&x!==x.toLowerCase()).length/l.length*100;};
const emojis=(text)=>(text.match(/[\p{Extended_Pictographic}\uFE0F]/gu)||[]).length+(text.match(/<a?:[^:>]+:\d+>/g)||[]).length;
const mentions=(m)=>new Set([...m.mentions.users.keys(),...m.mentions.roles.keys()]).size;
const zalgo=(text)=>{const n=(text.match(/[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f]/g)||[]).length;return n>=8||(text.length>20&&n/text.length>.18);};
const repeated=(text,max)=>new RegExp(`(.)\\1{${Math.max(2,max)-1},}`,'u').test(text.replace(/\s/g,''));
const suspicious=(u)=>u.hostname.includes('xn--')||/^\d{1,3}(?:\.\d{1,3}){3}$/.test(u.hostname)||['bit.ly','tinyurl.com','t.co','is.gd','cutt.ly','shorturl.at'].some(d=>host(u.hostname.toLowerCase(),d));
const exempt=(m,c)=>m.member?.permissions.has(PermissionFlagsBits.Administrator)||m.member?.permissions.has(PermissionFlagsBits.ManageGuild)||c.exemptUsers.includes(m.author.id)||c.exemptChannels.includes(m.channel.id)||m.member?.roles.cache.some(r=>c.exemptRoles.includes(r.id));
const label=(x)=>x.replace(/([A-Z])/g,' $1').replace(/^./,x=>x.toUpperCase());

async function violationLog(client,m,reason){try{const c=await getAutomodConfig(client,m.guild.id);await logModerationAction({client,guild:m.guild,event:{action:'AutoMod Violation',target:`${m.author.tag} (${m.author.id})`,executor:`${client.user.tag} (${client.user.id})`,reason:`AutoMod: ${label(reason)}`,metadata:{userId:m.author.id,moderatorId:client.user.id,channelId:m.channel.id,messageId:m.id,automodRule:reason}}});if(c.logChannelId){const ch=await m.guild.channels.fetch(c.logChannelId).catch(()=>null);if(ch?.isTextBased?.())await ch.send({content:`AutoMod: **${label(reason)}** detected for <@${m.author.id}> in <#${m.channel.id}>.`,allowedMentions:{users:[],roles:[]}}).catch(()=>{});}}catch(e){logger.error('AutoMod log failed',e);}}

async function act(client,m,action,reason){if(['delete','warn','delete_warn','timeout','delete_timeout','kick','ban'].includes(action)&&m.deletable)await m.delete().catch(()=>{});const bot=m.guild.members.me;if(action==='warn'||action==='delete_warn'){const w=await WarningService.addWarning({guildId:m.guild.id,userId:m.author.id,moderatorId:client.user.id,reason:`AutoMod: ${label(reason)}`}).catch(()=>null);const msg=await m.channel.send({content:`⚠️ <@${m.author.id}>, your message was removed by AutoMod: **${label(reason)}**.${w?` Warning #${w.totalCount}.`:''}`,allowedMentions:{users:[m.author.id],roles:[]}}).catch(()=>null);if(msg)setTimeout(()=>msg.delete().catch(()=>{}),7000);}if((action==='timeout'||action==='delete_timeout')&&bot)await ModerationService.timeoutUser({guild:m.guild,member:m,moderator:bot,durationMs:600000,reason:`AutoMod: ${label(reason)}`}).catch(()=>{});if(action==='kick'&&bot)await ModerationService.kickUser({guild:m.guild,member:m,moderator:bot,reason:`AutoMod: ${label(reason)}`}).catch(()=>{});if(action==='ban'&&bot)await ModerationService.banUser({guild:m.guild,user:m.author,moderator:bot,reason:`AutoMod: ${label(reason)}`}).catch(()=>{});await violationLog(client,m,reason);}

export async function checkAutomod(client,m,{isEdit=false}={}){try{if(!m?.guild||m.author?.bot||!m.member)return{blocked:false};const c=await getAutomodConfig(client,m.guild.id);if(!c.enabled||exempt(m,c))return{blocked:false};const gifUser=c.gifOnlyUsers.includes(m.author.id)||m.member.roles.cache.some(r=>c.gifOnlyRoles.includes(r.id));if(gifUser&&!onlyGif(m,c)){await act(client,m,c.rules.links?.action||'delete_warn','gifOnly');return{blocked:true,reason:'gifOnly'};}const u=urls(m.content),v=[];if(c.rules.words?.enabled&&blockedWord(m.content,c))v.push('words');if(c.rules.regex?.enabled&&regexHit(m.content,c.regexPatterns))v.push('regex');if(c.rules.invites?.enabled&&u.some(invite))v.push('invites');if(c.rules.links?.enabled&&u.some(x=>!c.allowedDomains.some(d=>host(x.hostname.toLowerCase(),d))))v.push('links');if(c.rules.externalLinks?.enabled&&u.some(x=>!c.allowedDomains.some(d=>host(x.hostname.toLowerCase(),d))))v.push('externalLinks');if(c.rules.suspiciousLinks?.enabled&&u.some(suspicious))v.push('suspiciousLinks');if(c.rules.linkSpam?.enabled&&u.length>Number(c.rules.linkSpam.max||3))v.push('linkSpam');if(c.rules.mentionSpam?.enabled&&mentions(m)>Number(c.rules.mentionSpam.limit||5))v.push('mentionSpam');if(c.rules.everyone?.enabled&&(m.mentions.everyone||/@(?:everyone|here)\b/i.test(m.content)))v.push('everyone');if(c.rules.emojiSpam?.enabled&&emojis(m.content)>Number(c.rules.emojiSpam.max||12))v.push('emojiSpam');if(c.rules.zalgo?.enabled&&zalgo(m.content))v.push('zalgo');if(c.rules.caps?.enabled&&m.content.length>=Number(c.rules.caps.minLetters||12)&&caps(m.content)>=Number(c.rules.caps.threshold||70))v.push('caps');if(c.rules.attachments?.enabled&&m.attachments.size>Number(c.rules.attachments.max||5))v.push('attachments');if(c.rules.stickers?.enabled&&m.stickers.size>Number(c.rules.stickers.max||5))v.push('stickers');if(c.rules.repeatedChars?.enabled&&repeated(m.content,Number(c.rules.repeatedChars.max||14)))v.push('repeatedChars');if(c.rules.messageLength?.enabled&&m.content.length>Number(c.rules.messageLength.max||1900))v.push('messageLength');if(!isEdit){const s=activity.get(`${m.guild.id}:${m.author.id}`)||{times:[],last:''};const now=Date.now();const win=Number(c.rules.fastMessages?.windowMs||5000);s.times=s.times.filter(t=>now-t<=win);s.times.push(now);if(c.rules.fastMessages?.enabled&&s.times.length>Number(c.rules.fastMessages.max||5))v.push('fastMessages');if(c.rules.duplicate?.enabled&&s.last&&s.last.toLowerCase().trim()===m.content.toLowerCase().trim()&&m.content.trim())v.push('duplicate');s.last=m.content;activity.set(`${m.guild.id}:${m.author.id}`,s);}if(!v.length)return{blocked:false};const reason=v[0];await act(client,m,c.rules[reason]?.action||'delete_warn',reason);return{blocked:true,reason,violations:v};}catch(e){logger.error('AutoMod check failed',e);return{blocked:false,error:true};}}

export async function resetAutomodCache(guildId){cache.delete(guildId);for(const k of activity.keys())if(k.startsWith(`${guildId}:`))activity.delete(k);}
