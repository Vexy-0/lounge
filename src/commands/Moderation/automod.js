import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { createEmbed, successEmbed, errorEmbed } from '../../utils/embeds.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { getAutomodConfig, saveAutomodConfig, getDefaultAutomodConfig } from '../../services/automodService.js';

const RULES = ['words','regex','invites','links','externalLinks','linkSpam','duplicate','fastMessages','caps','mentionSpam','everyone','emojiSpam','zalgo','attachments','stickers','repeatedChars'];
const ACTIONS = [
  { name: 'delete', value: 'delete' },
  { name: 'warn + delete', value: 'delete_warn' },
  { name: 'timeout + delete', value: 'delete_timeout' },
  { name: 'timeout only', value: 'timeout' },
  { name: 'kick', value: 'kick' },
  { name: 'ban', value: 'ban' },
];

function withBase(builder) {
  return builder.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);
}

const data = withBase(new SlashCommandBuilder()
  .setName('automod')
  .setDescription('Configure the advanced AutoMod system.')
  .addSubcommand((s) => s.setName('enable').setDescription('Enable AutoMod.'))
  .addSubcommand((s) => s.setName('disable').setDescription('Disable AutoMod.'))
  .addSubcommand((s) => s.setName('status').setDescription('Show the current AutoMod configuration.'))
  .addSubcommand((s) => s.setName('rule').setDescription('Enable/disable a rule and choose its action.')
    .addStringOption((o) => o.setName('name').setDescription('Rule name').setRequired(true).addChoices(...RULES.map((r) => ({ name: r, value: r }))))
    .addBooleanOption((o) => o.setName('enabled').setDescription('Whether the rule is enabled').setRequired(true))
    .addStringOption((o) => o.setName('action').setDescription('Action to take').setRequired(true).addChoices(...ACTIONS)))
  .addSubcommand((s) => s.setName('word').setDescription('Add or remove a blocked word.')
    .addStringOption((o) => o.setName('action').setDescription('Operation').setRequired(true).addChoices({ name: 'add', value: 'add' }, { name: 'remove', value: 'remove' }))
    .addStringOption((o) => o.setName('word').setDescription('Word or phrase').setRequired(true)))
  .addSubcommand((s) => s.setName('regex').setDescription('Add or remove a regular-expression filter.')
    .addStringOption((o) => o.setName('action').setDescription('Operation').setRequired(true).addChoices({ name: 'add', value: 'add' }, { name: 'remove', value: 'remove' }))
    .addStringOption((o) => o.setName('pattern').setDescription('Regex pattern').setRequired(true)))
  .addSubcommand((s) => s.setName('domain').setDescription('Allow or remove a link domain.')
    .addStringOption((o) => o.setName('action').setDescription('Operation').setRequired(true).addChoices({ name: 'allow', value: 'allow' }, { name: 'remove', value: 'remove' }))
    .addStringOption((o) => o.setName('domain').setDescription('Domain such as example.com').setRequired(true)))
  .addSubcommand((s) => s.setName('exempt').setDescription('Exempt a user, role, or channel from AutoMod.')
    .addStringOption((o) => o.setName('action').setDescription('Operation').setRequired(true).addChoices({ name: 'add', value: 'add' }, { name: 'remove', value: 'remove' }))
    .addStringOption((o) => o.setName('type').setDescription('Exemption type').setRequired(true).addChoices({ name: 'user', value: 'user' }, { name: 'role', value: 'role' }, { name: 'channel', value: 'channel' }))
    .addStringOption((o) => o.setName('id').setDescription('User, role, or channel ID').setRequired(true)))
  .addSubcommand((s) => s.setName('gifonly').setDescription('Allow a user or role to send GIFs only.')
    .addStringOption((o) => o.setName('action').setDescription('Operation').setRequired(true).addChoices({ name: 'add', value: 'add' }, { name: 'remove', value: 'remove' }))
    .addStringOption((o) => o.setName('type').setDescription('Target type').setRequired(true).addChoices({ name: 'user', value: 'user' }, { name: 'role', value: 'role' }))
    .addStringOption((o) => o.setName('id').setDescription('User or role ID').setRequired(true)))
  .addSubcommand((s) => s.setName('logchannel').setDescription('Set or clear the AutoMod log channel.')
    .addStringOption((o) => o.setName('channel').setDescription('Channel ID, or leave empty to clear').setRequired(false)))
  .addSubcommand((s) => s.setName('reset').setDescription('Reset AutoMod to safe defaults.')));

function listLabel(items) {
  return items.length ? items.map((x) => `\`${x}\``).join(', ') : 'None';
}

export default {
  data,
  category: 'moderation',
  async execute(interaction, config, client) {
    const sub = interaction.options.getSubcommand();
    const current = await getAutomodConfig(client, interaction.guildId);

    if (sub === 'status') {
      const enabledRules = RULES.filter((r) => current.rules[r]?.enabled);
      const gifUsers = current.gifOnlyUsers.length;
      const gifRoles = current.gifOnlyRoles.length;
      return InteractionHelper.universalReply(interaction, { embeds: [createEmbed({
        title: `AutoMod ${current.enabled ? 'Enabled' : 'Disabled'}`,
        description: `**Rules:** ${enabledRules.length}/${RULES.length} enabled\n**GIF-only users:** ${gifUsers}\n**GIF-only roles:** ${gifRoles}\n**Blocked words:** ${current.blockedWords.length}\n**Regex filters:** ${current.regexPatterns.length}\n**Allowed domains:** ${current.allowedDomains.length}\n**Log channel:** ${current.logChannelId ? `<#${current.logChannelId}>` : 'Not configured'}`,
        color: current.enabled ? 'success' : 'warning',
      })] });
    }

    if (sub === 'enable' || sub === 'disable') {
      current.enabled = sub === 'enable';
      await saveAutomodConfig(client, interaction.guildId, current);
      return InteractionHelper.universalReply(interaction, { embeds: [successEmbed(`AutoMod ${current.enabled ? 'enabled' : 'disabled'}.`)] });
    }

    if (sub === 'reset') {
      await saveAutomodConfig(client, interaction.guildId, getDefaultAutomodConfig());
      return InteractionHelper.universalReply(interaction, { embeds: [successEmbed('AutoMod has been reset to safe defaults and disabled.')] });
    }

    if (sub === 'rule') {
      const name = interaction.options.getString('name');
      current.rules[name] = { ...(current.rules[name] || {}), enabled: interaction.options.getBoolean('enabled'), action: interaction.options.getString('action') };
      await saveAutomodConfig(client, interaction.guildId, current);
      return InteractionHelper.universalReply(interaction, { embeds: [successEmbed(`Rule **${name}** is now ${current.rules[name].enabled ? 'enabled' : 'disabled'} with action **${current.rules[name].action}**.`)] });
    }

    if (sub === 'word') {
      const action = interaction.options.getString('action');
      const word = interaction.options.getString('word').trim();
      const has = current.blockedWords.some((x) => x.toLowerCase() === word.toLowerCase());
      if (action === 'add' && !has) current.blockedWords.push(word);
      if (action === 'remove') current.blockedWords = current.blockedWords.filter((x) => x.toLowerCase() !== word.toLowerCase());
      await saveAutomodConfig(client, interaction.guildId, current);
      return InteractionHelper.universalReply(interaction, { embeds: [successEmbed(`Blocked word list updated. **${word}** ${action === 'add' ? 'added' : 'removed'}.`)] });
    }

    if (sub === 'regex') {
      const action = interaction.options.getString('action');
      const pattern = interaction.options.getString('pattern');
      try { new RegExp(pattern, 'iu'); } catch { return InteractionHelper.universalReply(interaction, { embeds: [errorEmbed('Invalid regex pattern.')] }); }
      if (pattern.length > 200) return InteractionHelper.universalReply(interaction, { embeds: [errorEmbed('Regex patterns are limited to 200 characters.')] });
      if (action === 'add' && !current.regexPatterns.includes(pattern)) current.regexPatterns.push(pattern);
      if (action === 'remove') current.regexPatterns = current.regexPatterns.filter((x) => x !== pattern);
      await saveAutomodConfig(client, interaction.guildId, current);
      return InteractionHelper.universalReply(interaction, { embeds: [successEmbed(`Regex filter ${action === 'add' ? 'added' : 'removed'}.`)] });
    }

    if (sub === 'domain') {
      const action = interaction.options.getString('action');
      const domain = interaction.options.getString('domain').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
      if (action === 'allow' && !current.allowedDomains.includes(domain)) current.allowedDomains.push(domain);
      if (action === 'remove') current.allowedDomains = current.allowedDomains.filter((x) => x !== domain);
      await saveAutomodConfig(client, interaction.guildId, current);
      return InteractionHelper.universalReply(interaction, { embeds: [successEmbed(`Allowed-domain list updated for **${domain}**.`)] });
    }

    if (sub === 'exempt') {
      const action = interaction.options.getString('action');
      const type = interaction.options.getString('type');
      const id = interaction.options.getString('id').replace(/[<@&#>]/g, '');
      const key = type === 'user' ? 'exemptUsers' : type === 'role' ? 'exemptRoles' : 'exemptChannels';
      current[key] = current[key] || [];
      if (action === 'add' && !current[key].includes(id)) current[key].push(id);
      if (action === 'remove') current[key] = current[key].filter((x) => x !== id);
      await saveAutomodConfig(client, interaction.guildId, current);
      return InteractionHelper.universalReply(interaction, { embeds: [successEmbed(`AutoMod exemption updated for **${type}** \`${id}\`.`)] });
    }

    if (sub === 'gifonly') {
      const action = interaction.options.getString('action');
      const type = interaction.options.getString('type');
      const id = interaction.options.getString('id').replace(/[<@&#>]/g, '');
      const key = type === 'user' ? 'gifOnlyUsers' : 'gifOnlyRoles';
      if (action === 'add' && !current[key].includes(id)) current[key].push(id);
      if (action === 'remove') current[key] = current[key].filter((x) => x !== id);
      await saveAutomodConfig(client, interaction.guildId, current);
      return InteractionHelper.universalReply(interaction, { embeds: [successEmbed(`GIF-only ${type} restriction ${action === 'add' ? 'enabled' : 'removed'} for \`${id}\`.`)] });
    }

    if (sub === 'logchannel') {
      current.logChannelId = interaction.options.getString('channel')?.replace(/[<#>]/g, '') || null;
      await saveAutomodConfig(client, interaction.guildId, current);
      return InteractionHelper.universalReply(interaction, { embeds: [successEmbed(current.logChannelId ? `AutoMod logs will be sent to <#${current.logChannelId}>.` : 'AutoMod logging channel cleared.')] });
    }
  },
};
