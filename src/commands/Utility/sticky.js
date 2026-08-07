import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { successEmbed } from '../../utils/embeds.js';
import { getSticky, setSticky } from '../../services/stickyMessageService.js';

export default {
  data: new SlashCommandBuilder()
    .setName('sticky')
    .setDescription('Create or replace the sticky message in this channel.')
    .addStringOption(o=>o.setName('message').setDescription('The message to keep at the bottom.').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
  category:'utility',
  async prefixExecute(interaction){
    if(!interaction.member?.permissions?.has(PermissionFlagsBits.ManageMessages))return interaction.reply('❌ You need **Manage Messages** permission.');
    const content=(interaction.options.getString('message')||'').replace(/^\s*,\s*/,'').trim();
    if(!content||content.length>2000)return interaction.reply('❌ Usage: `!sticky <message>` (max 2000 characters).');
    const existing=await getSticky(interaction.client,interaction.guild.id,interaction.channel.id);
    if(existing?.messageId)(await interaction.channel.messages.fetch(existing.messageId).catch(()=>null))?.delete().catch(()=>{});
    const sticky=await interaction.channel.send({content});
    await setSticky(interaction.client,interaction.guild.id,interaction.channel.id,content,sticky.id);
    return interaction.reply('✅ Sticky message set for this channel.');
  },
  async execute(interaction){
    const content=interaction.options.getString('message')?.trim();
    if(!content||content.length>2000)return interaction.reply({content:'❌ Please provide a message up to 2000 characters.',ephemeral:true});
    const existing=await getSticky(interaction.client,interaction.guild.id,interaction.channel.id);
    if(existing?.messageId)(await interaction.channel.messages.fetch(existing.messageId).catch(()=>null))?.delete().catch(()=>{});
    const sticky=await interaction.channel.send({content});
    await setSticky(interaction.client,interaction.guild.id,interaction.channel.id,content,sticky.id);
    return interaction.reply({embeds:[successEmbed('Sticky message set for this channel.')],ephemeral:true});
  },
};
