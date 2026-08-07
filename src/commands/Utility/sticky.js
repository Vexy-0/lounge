import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { successEmbed } from '../../utils/embeds.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { getSticky, setSticky, removeSticky } from '../../services/stickyMessageService.js';

export default {
  data: new SlashCommandBuilder()
    .setName('sticky')
    .setDescription('Create or manage the sticky message in this channel.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addSubcommand((s) => s.setName('set').setDescription('Set the sticky message.').addStringOption((o) => o.setName('message').setDescription('Sticky message content').setRequired(true)))
    .addSubcommand((s) => s.setName('remove').setDescription('Remove the sticky message.'))
    .addSubcommand((s) => s.setName('view').setDescription('View the current sticky message.')),
  category: 'utility',
  async prefixExecute(interaction) {
    const content = (interaction.options.getString('message') || '').replace(/^\s*,\s*/, '').trim();
    if (!interaction.member?.permissions?.has(PermissionFlagsBits.ManageMessages)) return interaction.reply('❌ You need **Manage Messages** permission.');
    if (!content || content.length > 2000) return interaction.reply('❌ Usage: `!sticky <message>` (max 2000 characters).');
    const existing = await getSticky(interaction.client, interaction.guild.id, interaction.channel.id);
    if (existing?.messageId) (await interaction.channel.messages.fetch(existing.messageId).catch(() => null))?.delete().catch(() => {});
    const sticky = await interaction.channel.send({ content });
    await setSticky(interaction.client, interaction.guild.id, interaction.channel.id, content, sticky.id);
    return interaction.reply('✅ Sticky message set for this channel.');
  },
  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guildId;
    const channelId = interaction.channelId;
    if (sub === 'set') {
      const content = interaction.options.getString('message').trim();
      if (content.length > 2000) return InteractionHelper.universalReply(interaction, { content: '❌ Sticky messages cannot exceed 2000 characters.', ephemeral: true });
      const existing = await getSticky(interaction.client, guildId, channelId);
      if (existing?.messageId) (await interaction.channel.messages.fetch(existing.messageId).catch(() => null))?.delete().catch(() => {});
      const sticky = await interaction.channel.send({ content });
      await setSticky(interaction.client, guildId, channelId, content, sticky.id);
      return InteractionHelper.universalReply(interaction, { embeds: [successEmbed('Sticky message set for this channel.')] });
    }
    if (sub === 'remove') {
      const existing = await removeSticky(interaction.client, guildId, channelId);
      if (existing?.messageId) (await interaction.channel.messages.fetch(existing.messageId).catch(() => null))?.delete().catch(() => {});
      return InteractionHelper.universalReply(interaction, { embeds: [successEmbed(existing ? 'Sticky message removed.' : 'No sticky message is configured here.')] });
    }
    const sticky = await getSticky(interaction.client, guildId, channelId);
    return InteractionHelper.universalReply(interaction, { content: sticky ? `Current sticky:\n${sticky.content}` : 'No sticky message is configured here.', ephemeral: true });
  },
};
