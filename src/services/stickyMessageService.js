import { getConfigValue, setConfigValue } from './config/guildConfig.js';
import { logger } from '../utils/logger.js';

const CACHE_KEY = 'stickyMessages';
const cache = new Map();

function getGuildCache(guildId) {
  if (!cache.has(guildId)) cache.set(guildId, new Map());
  return cache.get(guildId);
}

async function loadGuildStickies(client, guildId) {
  const guildCache = getGuildCache(guildId);
  if (guildCache.size > 0 || guildCache._loaded) return guildCache;

  const stored = await getConfigValue(client, guildId, CACHE_KEY, {});
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
    for (const [channelId, value] of Object.entries(stored)) {
      if (value?.content) guildCache.set(channelId, value);
    }
  }
  guildCache._loaded = true;
  return guildCache;
}

function serialize(guildCache) {
  const result = {};
  for (const [channelId, value] of guildCache.entries()) {
    if (channelId !== '_loaded' && value?.content) result[channelId] = value;
  }
  return result;
}

export async function getSticky(client, guildId, channelId) {
  const guildCache = await loadGuildStickies(client, guildId);
  return guildCache.get(channelId) || null;
}

export async function setSticky(client, guildId, channelId, content, messageId) {
  const guildCache = await loadGuildStickies(client, guildId);
  const value = { content, messageId };
  guildCache.set(channelId, value);
  await setConfigValue(client, guildId, CACHE_KEY, serialize(guildCache), {
    source: 'stickyMessageService',
    operation: 'setSticky',
  });
  return value;
}

export async function removeSticky(client, guildId, channelId) {
  const guildCache = await loadGuildStickies(client, guildId);
  const existing = guildCache.get(channelId) || null;
  guildCache.delete(channelId);
  await setConfigValue(client, guildId, CACHE_KEY, serialize(guildCache), {
    source: 'stickyMessageService',
    operation: 'removeSticky',
  });
  return existing;
}

export async function refreshSticky(client, message) {
  if (!message.guild || !message.channel?.isTextBased?.()) return;

  const sticky = await getSticky(client, message.guild.id, message.channel.id);
  if (!sticky) return;

  if (sticky.messageId === message.id) return;

  try {
    if (sticky.messageId) {
      const oldMessage = await message.channel.messages.fetch(sticky.messageId).catch(() => null);
      if (oldMessage) await oldMessage.delete().catch(() => {});
    }

    const newMessage = await message.channel.send({ content: sticky.content });
    await setSticky(client, message.guild.id, message.channel.id, sticky.content, newMessage.id);
  } catch (error) {
    logger.error('Failed to refresh sticky message:', error);
  }
}
