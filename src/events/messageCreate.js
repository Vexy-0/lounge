import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';
import '../services/automodRuntime.js';
import { getLevelingConfig, getUserLevelData } from '../services/leveling/leveling.js';
import { addXp } from '../services/leveling/xpSystem.js';
import { checkRateLimit } from '../utils/rateLimiter.js';
import { parsePrefixCommand } from '../utils/prefixParser.js';
import { supportsPrefixExecution, executePrefixCommand, resolvePrefixAccessKey } from '../utils/messageAdapter.js';
import { resolveCommandAlias, resolveSubcommandAlias } from '../config/commands/commandAliases.js';
import { getPrefixRestriction } from '../config/commands/prefixRestrictions.js';
import { getGuildConfig } from '../services/config/guildConfig.js';
import { getCommandPrefix, getBotMessage, isBotOwner, isCommandCategoryEnabled, isMaintenanceMode } from '../config/bot.js';
import { enforceAbuseProtection, formatCooldownDuration } from '../utils/abuseProtection.js';
import { createEmbed } from '../utils/embeds.js';
import { isCommandEnabled } from '../services/commandAccessService.js';
import { refreshSticky } from '../services/stickyMessageService.js';
import { checkAutomod } from '../services/automodEngine.js';
import { getCountingGameConfig, saveCountingGameConfig, isValidCountingMessage, recordCorrectCount } from '../services/countingGameService.js';

const MESSAGE_XP_RATE_LIMIT_ATTEMPTS = 12;
const MESSAGE_XP_RATE_LIMIT_WINDOW_MS = 10000;

export default { name: Events.MessageCreate, async execute(message, client) {
  try {
    if (message.author.bot || !message.guild) return;
    const automodResult = await checkAutomod(client, message);
    if (automodResult.blocked) return;
    const countingProcessed = await handleCountingGame(message, client);
    if (countingProcessed) return;
    await handlePrefixCommand(message, client);
    await handleSticky(message, client);
    await handleLeveling(message, client);
  } catch (error) { logger.error('Error in messageCreate event:', error); }
}};

async function handleSticky(message, client) {
  try { const guildConfig=await getGuildConfig(client,message.guild.id);const prefix=guildConfig?.prefix||getCommandPrefix();const parsed=parsePrefixCommand(message.content,prefix);if(parsed){const commandName=resolveCommandAlias(parsed.commandName).toLowerCase();if(commandName==='sticky'||commandName==='stickyremove')return;}await refreshSticky(client,message); }
  catch(error){logger.error('Error handling sticky message:',error);}
}

async function handlePrefixCommand(message,client){
  try{
    const guildConfig=await getGuildConfig(client,message.guild.id);const prefix=guildConfig?.prefix||getCommandPrefix();const parsed=parsePrefixCommand(message.content,prefix);if(!parsed)return;let{commandName,args}=parsed;const shortcut=commandName.toLowerCase();const shortcuts=new Set(['leave','pause','resume','skip','stop','volume']);if(shortcuts.has(shortcut)){commandName='music';args=[shortcut,...args];}const resolvedCommandName=resolveCommandAlias(commandName);const command=client.commands.get(resolvedCommandName);if(!command)return;
    if(isMaintenanceMode()&&!isBotOwner(message.author.id)){await message.channel.send({embeds:[createEmbed({title:'Maintenance Mode',description:getBotMessage('maintenanceMode'),color:'warning'})]}).catch(()=>{});return;}
    if(!isCommandCategoryEnabled(command.category)){await message.channel.send({embeds:[createEmbed({title:'Feature Disabled',description:getBotMessage('commandDisabled'),color:'error'})]}).catch(()=>{});return;}
    const restriction=getPrefixRestriction(command,args,resolveSubcommandAlias);if(!supportsPrefixExecution(command)||restriction.blocked){if(restriction.blocked&&restriction.reason)await message.channel.send({embeds:[createEmbed({title:'Slash Command Only',description:`${restriction.reason}\nUse \`/${resolvedCommandName}\` instead.`,color:'info'})]}).catch(()=>{});return;}
    if(!(await isCommandEnabled(client,message.guild.id,resolvePrefixAccessKey(command.data,args),command.category))){await message.channel.send({embeds:[createEmbed({title:'Command Disabled',description:'This command has been disabled for this server.',color:'error'})]}).catch(()=>{});return;}
    const protection=await enforceAbuseProtection({guildId:message.guild.id,user:message.author},command,resolvedCommandName);if(!protection.allowed){await message.channel.send({embeds:[createEmbed({title:'Command Cooldown',description:`This command is on cooldown. Please wait ${formatCooldownDuration(protection.remainingMs)} before trying again.`,color:'error'})]}).catch(()=>{});return;}
    await executePrefixCommand(command,message,args,client,prefix,guildConfig);
  }catch(error){logger.error('Error handling prefix command:',error);}
}

async function handleCountingGame(message,client){try{const config=await getCountingGameConfig(client,message.guild.id);if(!config.enabled||!config.channelId||message.channel.id!==config.channelId)return false;const valid=isValidCountingMessage(message.content.trim(),config);if(!valid||message.author.id===config.lastUserId){await message.delete().catch(()=>{});await saveCountingGameConfig(client,message.guild.id,{...config,nextNumber:1,lastUserId:null,currentStreak:0});const m=await message.channel.send(`❌ Count broken by <@${message.author.id}>. The sequence has been reset to **1**.`);setTimeout(()=>m.delete().catch(()=>{}),10000);return true;}await recordCorrectCount(client,message.guild.id,message.author.id);return true;}catch(error){logger.error('Error handling counting game:',error);return false;}}

async function handleLeveling(message,client){try{const key=`xp-event:${message.guild.id}:${message.author.id}`;if(!(await checkRateLimit(key,MESSAGE_XP_RATE_LIMIT_ATTEMPTS,MESSAGE_XP_RATE_LIMIT_WINDOW_MS)) )return;const c=await getLevelingConfig(client,message.guild.id);if(!c?.enabled||c.ignoredChannels?.includes(message.channel.id)||c.blacklistedUsers?.includes(message.author.id))return;if(c.ignoredRoles?.length){const member=await message.guild.members.fetch(message.author.id).catch(()=>null);if(member&&member.roles.cache.some(r=>c.ignoredRoles.includes(r.id)))return;}if(!message.content?.trim())return;const data=await getUserLevelData(client,message.guild.id,message.author.id);const cooldown=c.xpCooldown||60;if(Date.now()-(data.lastMessage||0)<cooldown*1000)return;const min=Math.max(1,c.xpRange?.min||c.xpPerMessage?.min||15);const max=Math.max(min,c.xpRange?.max||c.xpPerMessage?.max||25);let xp=Math.floor(Math.random()*(max-min+1))+min;if(c.xpMultiplier>1)xp=Math.floor(xp*c.xpMultiplier);const result=await addXp(client,message.guild,message.member,xp);if(result?.leveledUp)logger.info(`${message.author.tag} leveled up to level ${result.level} in ${message.guild.name}`);}catch(error){logger.error('Error handling leveling for message:',error);}}
