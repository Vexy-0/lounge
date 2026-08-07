import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { successEmbed } from '../../utils/embeds.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { getAutomodConfig, saveAutomodConfig } from '../../services/automodEngine.js';

const RULES = ['linkSpam','fastMessages','caps','mentionSpam','emojiSpam','attachments','stickers','repeatedChars','messageLength'];

export default {
  data: new SlashCommandBuilder()
    .setName('automodthreshold')
    .setDescription('Tune AutoMod thresholds and limits.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(o=>o.setName('rule').setDescription('Rule to tune').setRequired(true).addChoices(...RULES.map(r=>({name:r,value:r}))))
    .addIntegerOption(o=>o.setName('value').setDescription('New limit/threshold').setRequired(true).setMinValue(1).setMaxValue(10000))
    .addIntegerOption(o=>o.setName('window').setDescription('Fast-message window in milliseconds').setRequired(false).setMinValue(1000).setMaxValue(60000)),
  category:'moderation',
  async execute(interaction,config,client){
    const rule=interaction.options.getString('rule');const value=interaction.options.getInteger('value');const window=interaction.options.getInteger('window');const c=await getAutomodConfig(client,interaction.guildId);
    c.rules[rule]={...(c.rules[rule]||{})};
    if(rule==='fastMessages'){c.rules[rule].max=value;if(window)c.rules[rule].windowMs=window;}
    else if(rule==='caps')c.rules[rule].threshold=Math.min(100,value);
    else c.rules[rule].max=value;
    await saveAutomodConfig(client,interaction.guildId,c);
    return InteractionHelper.universalReply(interaction,{embeds:[successEmbed(`AutoMod **${rule}** threshold updated to **${rule==='caps'?c.rules[rule].threshold:value}**${rule==='fastMessages'&&window?` with a ${window}ms window`:''}.`)]});
  },
};
