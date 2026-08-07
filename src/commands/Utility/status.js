import { SlashCommandBuilder } from 'discord.js';

function formatUptime(seconds) {
  const s = Math.floor(seconds);
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  return `${days}d ${hours}h ${minutes}m ${secs}s`;
}

function buildStatus(client) {
  const ping = Math.max(0, Math.round(client.ws.ping || 0));
  const guilds = client.guilds.cache.size;
  const users = client.guilds.cache.reduce((total, guild) => total + (guild.memberCount || 0), 0);
  const memory = process.memoryUsage();
  return `**Lounge Status**\n> 🟢 Online\n> 🏓 WebSocket: **${ping}ms**\n> ⏱️ Uptime: **${formatUptime(process.uptime())}**\n> 🏠 Servers: **${guilds}**\n> 👥 Members: **${users}**\n> 🧠 Memory: **${Math.round(memory.rss / 1024 / 1024)}MB**`;
}

export default {
  data: new SlashCommandBuilder().setName('status').setDescription('Show the bot health and performance status.'),
  category: 'utility',
  async execute(interaction) {
    const content = buildStatus(interaction.client);
    if (interaction.deferred || interaction.replied) return interaction.editReply({ content });
    return interaction.reply({ content });
  },
  async prefixExecute(message, args, client) {
    return message.channel.send({ content: buildStatus(client) });
  },
};
