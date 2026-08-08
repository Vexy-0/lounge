import { SlashCommandBuilder } from 'discord.js';
import { EmbedBuilder } from 'discord.js';

function buildStatus(client) {
  const ws = client.ws?.ping ?? -1;
  const memory = process.memoryUsage();
  return new EmbedBuilder()
    .setTitle('Lounge Status')
    .setDescription('🟢 **Online and operational**')
    .addFields(
      { name: 'Latency', value: `\`${ws >= 0 ? `${ws}ms` : 'N/A'}\``, inline: true },
      { name: 'Uptime', value: `\`${formatUptime(process.uptime())}\``, inline: true },
      { name: 'Servers', value: `\`${client.guilds.cache.size}\``, inline: true },
      { name: 'Users', value: `\`${client.guilds.cache.reduce((total, guild) => total + (guild.memberCount || 0), 0)}\``, inline: true },
      { name: 'Memory', value: `\`${Math.round(memory.rss / 1024 / 1024)} MB RSS\``, inline: true },
      { name: 'Commands', value: `\`${client.commands.size}\``, inline: true },
    )
    .setTimestamp();
}

function formatUptime(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return [days ? `${days}d` : '', hours ? `${hours}h` : '', minutes ? `${minutes}m` : '', `${secs}s`].filter(Boolean).join(' ');
}

export default {
  data: new SlashCommandBuilder().setName('status').setDescription('Check Lounge bot status and performance.'),
  category: 'core',
  async execute(interaction) {
    return interaction.reply({ embeds: [buildStatus(interaction.client)], ephemeral: true });
  },
  async prefixExecute(interaction) {
    return interaction.reply({ embeds: [buildStatus(interaction.client)] });
  },
};
