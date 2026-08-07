import { PermissionFlagsBits } from 'discord.js';

export const data = {
  name: 'stickyremove',
  description: 'Remove the sticky message from this channel.',
};

export async function execute(message) {
  if (!message.member?.permissions.has(PermissionFlagsBits.ManageMessages)) {
    return message.reply('❌ You need **Manage Messages** permission to use this command.');
  }

  const stickyStore = message.client.stickyMessages;
  if (!stickyStore) {
    return message.reply('❌ Sticky message system is not initialized.');
  }

  const existing = stickyStore.get(message.channel.id);
  if (!existing) {
    return message.reply('❌ There is no sticky message in this channel.');
  }

  if (existing.messageId) {
    try {
      const sticky = await message.channel.messages.fetch(existing.messageId);
      await sticky.delete();
    } catch {}
  }

  stickyStore.delete(message.channel.id);
  return message.reply('✅ Sticky message removed from this channel.');
}

export const prefix = true;
