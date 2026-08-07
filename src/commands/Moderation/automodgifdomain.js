import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { successEmbed } from '../../utils/embeds.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { getAutomodConfig, saveAutomodConfig } from '../../services/automodEngine.js';

export default {
  data:new SlashCommandBuilder().setName('automodgifdomain').setDescription('Manage domains allowed for GIF-only users/roles.').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(o=>o.setName('action').setDescription('Operation').setRequired(true).addChoices({name:'add',value:'add'},{name:'remove',value:'remove'}))
    .addStringOption(o=>o.setName('domain').setDescription('Domain such as giphy.com').setRequired(true)),
  category:'moderation',
  async execute(interaction,config,client){const c=await getAutomodConfig(client,interaction.guildId);const a=interaction.options.getString('action');const d=interaction.options.getString('domain').toLowerCase().replace(/^https?:\/\//,'').replace(/^www\./,'').split('/')[0];if(a==='add'&&!c.gifAllowedDomains.includes(d))c.gifAllowedDomains.push(d);if(a==='remove')c.gifAllowedDomains=c.gifAllowedDomains.filter(x=>x!==d);await saveAutomodConfig(client,interaction.guildId,c);return InteractionHelper.universalReply(interaction,{embeds:[successEmbed(`GIF domain **${d}** ${a==='add'?'allowed':'removed'}.`)]});},
};
