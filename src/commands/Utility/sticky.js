import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { setSticky } from '../../services/stickyMessageService.js';

export default {
  data: new SlashCommandBuilder()
    .setName('sticky')
    .setDescription('Create or replace the sticky message in this channel.')
    .addStringOption(option =>
      option
        .setName('message')
        .setDescription('The message to keep at the bottom of the channel.')
        .setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  async prefixExecute(interaction) {
    if (!interaction.member?.permissions?.has(PermissionFlagsBits.ManageMessages)) {
      return interaction.reply('❌ You need **Manage Messages** permission to use this command.');
    }

    let content = interaction.options.getString('message') || '';
    content = content.replace(/^\s*,\s*/, '').trim();

    if (!content) {
      return interaction.reply('❌ Usage: `!sticky <message>`');
    }

    if (content.length > 2000) {
      return interaction.reply('❌ Sticky messages cannot be longer than 2000 characters.');
    }

    const existing = await import('../../services/stickyMessageService.js').then(({ getSticky }) =>
      getSticky(interaction.client, interaction.guild.id, interaction.channel.id)
    );

    if (existing?.messageId) {
      const oldMessage = await interaction.channel.messages.fetch(existing.messageId).catch(() => null);
      if (oldMessage) await oldMessage.delete().catch(() => {});
    }

    const stickyMessage = await interaction.channel.send({ content });
    await setSticky(
      interaction.client,
      interaction.guild.id,
      interaction.channel.id,
      content,
      stickyMessage.id,
    );

    await interaction.reply('✅ Sticky message set for this channel.');
  },

  async execute(interaction) {
    const content = interaction.options.getString('message')?.trim();
    if (!content || content.length > 2000) {
      return interaction.reply({ content: '❌ Please provide a message up to 2000 characters.', ephemeral: true });
    }

    const { getSticky } = await import('../../services/stickyMessageService.js');
    const existing = await getSticky(interaction.client, interaction.guild.id, interaction.channel.id);
    if (existing?.messageId) {
      const oldMessage = await interaction.channel.messages.fetch(existing.messageId).catch(() => null);
      if (oldMessage) await oldMessage.delete().catch(() => {});
    }

    const stickyMessage = await interaction.channel.send({ content });
    await setSticky(interaction.client, interaction.guild.id, interaction.channel.id, content, stickyMessage.id);
    await interaction.reply({ content: '✅ Sticky message set for this channel.', ephemeral: true });
  },
};
