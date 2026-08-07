import { PermissionFlagsBits } from 'discord.js';

export const data = {
  name: 'sticky',
  description: 'Create a sticky message in this channel.',
};

export async function execute(message, args) {
  if (!message.member?.permissions.has(PermissionFlagsBits.ManageMessages)) {
    return message.reply('❌ You need **Manage Messages** permission to use this command.');
  }

  const content = args.join(' ').trim();
  if (!content) {
    return message.reply('❌ Usage: `!sticky <message>`');
  }

  const stickyStore = message.client.stickyMessages;
  if (!stickyStore) {
    return message.reply('❌ Sticky message system is not initialized.');
  }

  const existing = stickyStore.get(message.channel.id);
  if (existing?.messageId) {
    try {
      const old = await message.channel.messages.fetch(existing.messageId);
      await old.delete();
    } catch {}
  }

  const sticky = await message.channel.send({ content });
  stickyStore.set(message.channel.id, {
    content,
    messageId: sticky.id,
  });

  return message.reply('✅ Sticky message set for this channel.');
}

export const prefix = true;
