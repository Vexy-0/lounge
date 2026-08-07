import { Events } from 'discord.js';
import { checkAutomod } from '../services/automodEngine.js';

export default {
  name: Events.MessageUpdate,
  once: false,
  async execute(oldMessage, newMessage, client) {
    if (!newMessage.guild || newMessage.author?.bot) return;
    if (oldMessage.content === newMessage.content && oldMessage.attachments?.size === newMessage.attachments?.size) return;
    await checkAutomod(client, newMessage, { isEdit: true });
  },
};
