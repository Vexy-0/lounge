import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { getSticky, removeSticky } from '../../services/stickyMessageService.js';

export default {
  data: new SlashCommandBuilder()
    .setName('stickyremove')
    .setDescription('Remove the sticky message from this channel.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  async prefixExecute(interaction) {
    if (!interaction.member?.permissions?.has(PermissionFlagsBits.ManageMessages)) {
      return interaction.reply('❌ You need **Manage Messages** permission to use this command.');
    }

    const existing = await getSticky(interaction.client, interaction.guild.id, interaction.channel.id);
    if (!existing) {
      return interaction.reply('ℹ️ There is no sticky message in this channel.');
    }

    if (existing.messageId) {
      const stickyMessage = await interaction.channel.messages.fetch(existing.messageId).catch(() => null);
      if (stickyMessage) await stickyMessage.delete().catch(() => {});
    }

    await removeSticky(interaction.client, interaction.guild.id, interaction.channel.id);
    await interaction.reply('✅ Sticky message removed from this channel.');
  },

  async execute(interaction) {
    const existing = await getSticky(interaction.client, interaction.guild.id, interaction.channel.id);
    if (!existing) {
      return interaction.reply({ content: 'ℹ️ There is no sticky message in this channel.', ephemeral: true });
    }

    if (existing.messageId) {
      const stickyMessage = await interaction.channel.messages.fetch(existing.messageId).catch(() => null);
      if (stickyMessage) await stickyMessage.delete().catch(() => {});
    }

    await removeSticky(interaction.client, interaction.guild.id, interaction.channel.id);
    await interaction.reply({ content: '✅ Sticky message removed from this channel.', ephemeral: true });
  },
};
