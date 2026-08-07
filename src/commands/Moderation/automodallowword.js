import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { successEmbed } from '../../utils/embeds.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { getAutomodConfig, saveAutomodConfig } from '../../services/automodEngine.js';

export default {
  data:new SlashCommandBuilder().setName('automodallowword').setDescription('Allow a word/phrase to bypass the blocked-word rule.').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(o=>o.setName('action').setDescription('Operation').setRequired(true).addChoices({name:'add',value:'add'},{name:'remove',value:'remove'}))
    .addStringOption(o=>o.setName('word').setDescription('Word or phrase').setRequired(true)),
  category:'moderation',
  async execute(interaction,config,client){const c=await getAutomodConfig(client,interaction.guildId);const a=interaction.options.getString('action');const w=interaction.options.getString('word').trim();if(a==='add'&&!c.allowedWords.some(x=>x.toLowerCase()===w.toLowerCase()))c.allowedWords.push(w);if(a==='remove')c.allowedWords=c.allowedWords.filter(x=>x.toLowerCase()!==w.toLowerCase());await saveAutomodConfig(client,interaction.guildId,c);return InteractionHelper.universalReply(interaction,{embeds:[successEmbed(`Allowed word **${w}** ${a==='add'?'added':'removed'}.`)]});},
};
