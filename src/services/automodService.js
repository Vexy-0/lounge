import { PermissionFlagsBits } from 'discord.js';
import { getConfigValue, setConfigValue } from './config/guildConfig.js';
import { ModerationService } from './moderation/moderationService.js';
import { WarningService } from './moderation/warningService.js';
import { logModerationAction } from '../utils/moderation.js';
import { logger } from '../utils/logger.js';

const CACHE_KEY = 'automod';
const stateCache = new Map();
const activity = new Map();

const DEFAULT_AUTOMOD = {
  enabled: false,
  logChannelId: null,
  exemptUsers: [],
  exemptRoles: [],
  exemptChannels: [],
  allowedDomains: [],
  blockedWords: [],
  allowedWords: [],
  regexPatterns: [],
  gifOnlyUsers: [],
  gifOnlyRoles: [],
  gifAllowedDomains: ['giphy.com', 'gph.is', 'tenor.com', 'media.tenor.com', 'c.tenor.com', 'giphy.com', 'media.giphy.com'],
  rules: {
    words: { enabled: true, action: 'delete_warn' },
    regex: { enabled: true, action: 'delete_warn' },
    invites: { enabled: true, action: 'delete_warn' },
    links: { enabled: false, action: 'delete_warn' },
    externalLinks: { enabled: false, action: 'delete_warn' },
    linkSpam: { enabled: true, max: 3, action: 'delete_warn' },
    duplicate: { enabled: true, action: 'delete_warn' },
    fastMessages: { enabled: true, max: 5, windowMs: 5000, action: 'delete_warn' },
    caps: { enabled: true, threshold: 70, minLetters: 12, action: 'delete_warn' },
    mentionSpam: { enabled: true, limit: 5, action: 'delete_warn' },
    everyone: { enabled: true, action: 'delete_timeout' },
    emojiSpam: { enabled: true, max: 12, action: 'delete_warn' },
    zalgo: { enabled: true, action: 'delete_warn' },
    attachments: { enabled: false, max: 5, action: 'delete_warn' },
    stickers: { enabled: false, max: 5, action: 'delete_warn' },
    repeatedChars: { enabled: true, max: 14, action: 'delete_warn' },
  },
};

function cloneDefault() {
  return JSON.parse(JSON.stringify(DEFAULT_AUTOMOD));
}

function normalizeConfig(raw) {
  const base = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const defaults = cloneDefault();
  return {
    ...defaults,
    ...base,
    exemptUsers: Array.isArray(base.exemptUsers) ? base.exemptUsers.map(String) : defaults.exemptUsers,
    exemptRoles: Array.isArray(base.exemptRoles) ? base.exemptRoles.map(String) : defaults.exemptRoles,
    exemptChannels: Array.isArray(base.exemptChannels) ? base.exemptChannels.map(String) : defaults.exemptChannels,
    allowedDomains: Array.isArray(base.allowedDomains) ? base.allowedDomains.map(normalizeDomain).filter(Boolean) : [],
    blockedWords: Array.isArray(base.blockedWords) ? base.blockedWords.map(String).filter(Boolean).slice(0, 1000) : [],
    allowedWords: Array.isArray(base.allowedWords) ? base.allowedWords.map(String).filter(Boolean).slice(0, 1000) : [],
    regexPatterns: Array.isArray(base.regexPatterns) ? base.regexPatterns.map(String).filter(Boolean).slice(0, 50) : [],
    gifOnlyUsers: Array.isArray(base.gifOnlyUsers) ? base.gifOnlyUsers.map(String) : [],
    gifOnlyRoles: Array.isArray(base.gifOnlyRoles) ? base.gifOnlyRoles.map(String) : [],
    gifAllowedDomains: Array.isArray(base.gifAllowedDomains)
      ? base.gifAllowedDomains.map(normalizeDomain).filter(Boolean)
      : defaults.gifAllowedDomains,
    rules: {
      ...defaults.rules,
      ...(base.rules && typeof base.rules === 'object' ? base.rules : {}),
    },
  };
}

function normalizeDomain(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0];
}

export async function getAutomodConfig(client, guildId) {
  if (stateCache.has(guildId)) return stateCache.get(guildId);
  const stored = await getConfigValue(client, guildId, CACHE_KEY, null, { source: 'automodService', operation: 'get' });
  const config = normalizeConfig(stored);
  stateCache.set(guildId, config);
  return config;
}

export async function saveAutomodConfig(client, guildId, config) {
  const normalized = normalizeConfig(config);
  stateCache.set(guildId, normalized);
  await setConfigValue(client, guildId, CACHE_KEY, normalized, { source: 'automodService', operation: 'save' });
  return normalized;
}

export function getDefaultAutomodConfig() {
  return cloneDefault();
}

function memberExempt(message, config) {
  const member = message.member;
  if (!member) return true;
  if (member.permissions.has(PermissionFlagsBits.Administrator) || member.permissions.has(PermissionFlagsBits.ManageGuild)) return true;
  if (config.exemptUsers.includes(message.author.id)) return true;
  if (config.exemptChannels.includes(message.channel.id)) return true;
  if (member.roles.cache.some((role) => config.exemptRoles.includes(role.id))) return true;
  return false;
}

function extractUrls(content = '') {
  const matches = content.match(/https?:\/\/[^\s<>()]+|(?:www\.)[a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s<>()]*)?/gi) || [];
  return matches.map((raw) => raw.replace(/[),.!?]+$/g, '')).map((raw) => {
    try {
      return new URL(raw.startsWith('http') ? raw : `https://${raw}`);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function hostMatches(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

function isInviteUrl(url) {
  const host = url.hostname.toLowerCase();
  return hostMatches(host, 'discord.gg') || hostMatches(host, 'discord.com') && url.pathname.toLowerCase().startsWith('/invite');
}

function isGifUrl(url, config) {
  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();
  if (hostMatches(host, 'giphy.com') || hostMatches(host, 'gph.is') || hostMatches(host, 'tenor.com') || hostMatches(host, 'media.tenor.com') || hostMatches(host, 'c.tenor.com') || hostMatches(host, 'media.giphy.com')) return true;
  if (config.gifAllowedDomains.some((domain) => hostMatches(host, domain))) return path.endsWith('.gif') || /\/gif(?:s)?\//.test(path);
  if (hostMatches(host, 'cdn.discordapp.com') || hostMatches(host, 'media.discordapp.net')) return path.endsWith('.gif');
  return path.endsWith('.gif');
}

function isGifAttachment(attachment) {
  return attachment?.contentType === 'image/gif' || /\.gif(?:$|\?)/i.test(attachment?.name || '') || /\.gif(?:$|\?)/i.test(attachment?.url || '');
}

function isGifOnlyTarget(message, config) {
  if (config.gifOnlyUsers.includes(message.author.id)) return true;
  return message.member?.roles?.cache?.some((role) => config.gifOnlyRoles.includes(role.id)) || false;
}

function hasOnlyGifContent(message, config) {
  const urls = extractUrls(message.content);
  const attachments = [...(message.attachments?.values?.() || [])];
  const gifAttachments = attachments.filter(isGifAttachment);
  const allUrlsAreGifs = urls.length > 0 && urls.every((url) => isGifUrl(url, config));
  const hasGif = gifAttachments.length > 0 || allUrlsAreGifs;
  const stripped = message.content
    .replace(/https?:\/\/[^\s<>()]+/gi, '')
    .replace(/(?:www\.)[a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s<>()]*)?/gi, '')
    .trim();
  return hasGif && stripped.length === 0 && attachments.every(isGifAttachment) && urls.every((url) => isGifUrl(url, config));
}

function normalizedText(content) {
  return content.toLowerCase().replace(/\s+/g, ' ').trim();
}

function containsBlockedWord(content, config) {
  const normalized = normalizedText(content);
  if (!normalized) return false;
  const allowed = config.allowedWords.map(normalizedText);
  return config.blockedWords.some((word) => {
    const needle = normalizedText(word);
    if (!needle || allowed.includes(needle)) return false;
    const wildcardStart = needle.startsWith('*');
    const wildcardEnd = needle.endsWith('*');
    const core = needle.replace(/^\*|\*$/g, '');
    if (!core) return false;
    if (wildcardStart && wildcardEnd) return normalized.includes(core);
    if (wildcardStart) return new RegExp(`\\b\\w*${escapeRegExp(core)}\\b`, 'i').test(normalized);
    if (wildcardEnd) return new RegExp(`\\b${escapeRegExp(core)}\\w*`, 'i').test(normalized);
    return new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escapeRegExp(core)}(?:$|[^\\p{L}\\p{N}_])`, 'iu').test(normalized);
  });
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchesRegex(content, patterns) {
  for (const pattern of patterns) {
    try {
      if (pattern.length > 200) continue;
      const regex = new RegExp(pattern, 'iu');
      if (regex.test(content.slice(0, 4000))) return true;
    } catch {
      // Invalid patterns are ignored here and rejected when added by the command.
    }
  }
  return false;
}

function capsRatio(content) {
  const letters = [...content].filter((char) => /\p{L}/u.test(char));
  if (letters.length === 0) return 0;
  const upper = letters.filter((char) => char === char.toUpperCase() && char !== char.toLowerCase()).length;
  return (upper / letters.length) * 100;
}

function countEmojis(content) {
  const unicode = content.match(/[\p{Extended_Pictographic}\uFE0F]/gu) || [];
  const custom = content.match(/<a?:[^:>]+:\d+>/g) || [];
  return unicode.length + custom.length;
}

function countUniqueMentions(message) {
  const ids = new Set([
    ...message.mentions.users.keys(),
    ...message.mentions.roles.keys(),
  ]);
  return ids.size;
}

function hasZalgo(content) {
  const combining = (content.match(/[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f]/g) || []).length;
  return combining >= 8 || (content.length > 20 && combining / content.length > 0.18);
}

function hasRepeatedCharacters(content, max) {
  return new RegExp(`(.)\\1{${Math.max(2, max)} ,}`, 'u').test(content.replace(/\s/g, ''));
}

function getActivity(guildId, userId) {
  const key = `${guildId}:${userId}`;
  if (!activity.has(key)) activity.set(key, { messages: [], lastContent: null, lastAt: 0 });
  return activity.get(key);
}

function trimActivity(state, now, windowMs) {
  state.messages = state.messages.filter((timestamp) => now - timestamp <= windowMs);
}

function reasonLabel(reason) {
  return reason.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
}

async function logViolation(client, message, reason) {
  try {
    const config = await getAutomodConfig(client, message.guild.id);
    await logModerationAction({
      client,
      guild: message.guild,
      event: {
        action: 'AutoMod Violation',
        target: `${message.author.tag} (${message.author.id})`,
        executor: `${client.user?.tag || 'AutoMod'} (${client.user?.id || 'bot'})`,
        reason: reasonLabel(reason),
        metadata: {
          userId: message.author.id,
          moderatorId: client.user?.id,
          channelId: message.channel.id,
          automodRule: reason,
          messageId: message.id,
        },
      },
    });

    if (config.logChannelId) {
      const channel = await message.guild.channels.fetch(config.logChannelId).catch(() => null);
      if (channel?.isTextBased?.()) {
        await channel.send({
          content: `🛡️ AutoMod: **${reasonLabel(reason)}** detected for <@${message.author.id}> in <#${message.channel.id}>.`,
          allowedMentions: { users: [], roles: [] },
        }).catch(() => {});
      }
    }
  } catch (error) {
    logger.error('Failed to log AutoMod violation:', error);
  }
}

async function performAction(client, message, action, reason) {
  const botMember = message.guild.members.me;
  const moderator = botMember;
  let deleted = false;

  if (action === 'delete' || action === 'warn' || action === 'delete_warn' || action === 'timeout' || action === 'delete_timeout' || action === 'kick' || action === 'ban') {
    if (message.deletable) {
      deleted = await message.delete().then(() => true).catch(() => false);
    }
  }

  if (action === 'warn' || action === 'delete_warn') {
    const result = await WarningService.addWarning({
      guildId: message.guild.id,
      userId: message.author.id,
      moderatorId: client.user.id,
      reason: `AutoMod: ${reasonLabel(reason)}`,
      timestamp: Date.now(),
    }).catch(() => null);

    await message.channel.send({
      content: `⚠️ <@${message.author.id}>, your message was removed by AutoMod: **${reasonLabel(reason)}**.${result ? ` Warning #${result.totalCount}.` : ''}`,
      allowedMentions: { users: [message.author.id], roles: [] },
    }).then((warning) => setTimeout(() => warning.delete().catch(() => {}), 7000)).catch(() => {});
  }

  if (action === 'timeout' || action === 'delete_timeout') {
    if (moderator && message.member) {
      await ModerationService.timeoutUser({
        guild: message.guild,
        member: message.member,
        moderator,
        durationMs: 10 * 60 * 1000,
        reason: `AutoMod: ${reasonLabel(reason)}`,
      }).catch((error) => logger.warn(`AutoMod timeout failed: ${error.message}`));
    }
  }

  if (action === 'kick' && moderator && message.member) {
    await ModerationService.kickUser({
      guild: message.guild,
      member: message.member,
      moderator,
      reason: `AutoMod: ${reasonLabel(reason)}`,
    }).catch((error) => logger.warn(`AutoMod kick failed: ${error.message}`));
  }

  if (action === 'ban' && moderator) {
    await ModerationService.banUser({
      guild: message.guild,
      user: message.author,
      moderator,
      reason: `AutoMod: ${reasonLabel(reason)}`,
    }).catch((error) => logger.warn(`AutoMod ban failed: ${error.message}`));
  }

  await logViolation(client, message, reason);
  return deleted;
}

export async function checkAutomod(client, message, { isEdit = false } = {}) {
  if (!message?.guild || message.author?.bot || !message.member) return { blocked: false };
  const config = await getAutomodConfig(client, message.guild.id);
  if (!config.enabled || memberExempt(message, config)) return { blocked: false };

  const gifOnly = isGifOnlyTarget(message, config);
  if (gifOnly && !hasOnlyGifContent(message, config)) {
    const action = config.rules.links?.action || 'delete_warn';
    await performAction(client, message, action, 'gifOnly');
    return { blocked: true, reason: 'gifOnly' };
  }

  const content = message.content || '';
  const urls = extractUrls(content);
  const activityState = getActivity(message.guild.id, message.author.id);
  const now = Date.now();

  const violations = [];
  if (config.rules.words?.enabled && containsBlockedWord(content, config)) violations.push('blockedWords');
  if (config.rules.regex?.enabled && matchesRegex(content, config.regexPatterns)) violations.push('regex');
  if (config.rules.invites?.enabled && urls.some(isInviteUrl)) violations.push('invites');
  if (config.rules.links?.enabled && urls.some((url) => !config.allowedDomains.some((domain) => hostMatches(url.hostname.toLowerCase(), domain)))) violations.push('links');
  if (config.rules.externalLinks?.enabled && urls.some((url) => !config.allowedDomains.some((domain) => hostMatches(url.hostname.toLowerCase(), domain)))) violations.push('externalLinks');
  if (config.rules.linkSpam?.enabled && urls.length > Number(config.rules.linkSpam.max || 3)) violations.push('linkSpam');
  if (config.rules.mentionSpam?.enabled && countUniqueMentions(message) > Number(config.rules.mentionSpam.limit || 5)) violations.push('mentionSpam');
  if (config.rules.everyone?.enabled && (message.mentions.everyone || /@(everyone|here)\b/i.test(content))) violations.push('everyone');
  if (config.rules.emojiSpam?.enabled && countEmojis(content) > Number(config.rules.emojiSpam.max || 12)) violations.push('emojiSpam');
  if (config.rules.zalgo?.enabled && hasZalgo(content)) violations.push('zalgo');
  if (config.rules.caps?.enabled && content.length >= Number(config.rules.caps.minLetters || 12) && capsRatio(content) >= Number(config.rules.caps.threshold || 70)) violations.push('caps');
  if (config.rules.attachments?.enabled && message.attachments.size > Number(config.rules.attachments.max || 5)) violations.push('attachments');
  if (config.rules.stickers?.enabled && message.stickers.size > Number(config.rules.stickers.max || 5)) violations.push('stickers');
  if (config.rules.repeatedChars?.enabled && hasRepeatedCharacters(content, Number(config.rules.repeatedChars.max || 14))) violations.push('repeatedChars');

  if (!isEdit) {
    const fastRule = config.rules.fastMessages || {};
    const windowMs = Number(fastRule.windowMs || 5000);
    trimActivity(activityState, now, windowMs);
    activityState.messages.push(now);
    if (fastRule.enabled && activityState.messages.length > Number(fastRule.max || 5)) violations.push('fastMessages');

    if (config.rules.duplicate?.enabled && activityState.lastContent && normalizedText(activityState.lastContent) === normalizedText(content) && content.trim()) {
      violations.push('duplicate');
    }
    activityState.lastContent = content;
    activityState.lastAt = now;
  }

  if (violations.length === 0) return { blocked: false };

  const reason = violations[0];
  const rule = config.rules[reason] || { action: 'delete_warn' };
  await performAction(client, message, rule.action || 'delete_warn', reason);
  return { blocked: true, reason, violations };
}

export async function resetAutomodCache(guildId) {
  stateCache.delete(guildId);
  for (const key of activity.keys()) if (key.startsWith(`${guildId}:`)) activity.delete(key);
}

export { DEFAULT_AUTOMOD };
