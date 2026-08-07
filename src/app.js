import 'dotenv/config';
import { Client, Collection, GatewayIntentBits } from 'discord.js';
import { REST } from '@discordjs/rest';
import express from 'express';
import cron from 'node-cron';

import config from './config/application.js';
import { initializeDatabase } from './utils/database.js';
import { getGuildConfig } from './services/config/guildConfig.js';
import { getServerCounters, saveServerCounters, updateCounter } from './services/serverstatsService.js';
import { logger, startupLog, shutdownLog } from './utils/logger.js';
import { checkBirthdays } from './services/birthdayService.js';
import { checkGiveaways } from './services/giveawayService.js';
import { loadCommands, registerCommands as registerSlashCommands } from './handlers/loaders/commandLoader.js';
import { runSafeTask, handleTaskError, ErrorCodes } from './utils/errorHandler.js';
import { initializeMusic } from './services/music/riffySetup.js';
import { shutdownMusic } from './services/music/playerHandler.js';
import pkg from '../package.json' with { type: 'json' };
import { EXPECTED_SCHEMA_VERSION, EXPECTED_SCHEMA_LABEL } from './config/database/schemaVersion.js';

class TitanBot extends Client {
  constructor() {
    super({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildBans,
      ],
    });

    this.config = config;
    this.commands = new Collection();
    this.events = new Collection();
    this.buttons = new Collection();
    this.selectMenus = new Collection();
    this.modals = new Collection();
    this.cooldowns = new Collection();
    this.db = null;
    this.rest = new REST({ version: '10' }).setToken(config.bot.token);
  }

  async start() {
    try {
      startupLog('Starting TitanBot...');
      await new Promise(resolve => setTimeout(resolve, 1000));

      startupLog('Initializing database...');
      const dbInstance = await initializeDatabase();
      this.db = dbInstance.db;
      const dbStatus = this.db.getStatus();
      if (dbStatus.isDegraded) {
        logger.warn('Database is running in degraded/in-memory mode; data will reset on restart.');
      } else {
        startupLog(`✅ Database Status: ${dbStatus.connectionType} (fully operational)`);
      }

      startupLog('Starting web server...');
      this.startWebServer();

      startupLog('Loading commands...');
      await loadCommands(this);
      startupLog(`Commands loaded: ${this.commands.size}`);

      startupLog('Loading handlers...');
      await this.loadHandlers();
      startupLog('Handlers loaded');

      initializeMusic(this);

      startupLog('Logging into Discord...');
      await this.login(this.config.bot.token);
      startupLog('Discord login successful');

      startupLog(`Registering slash commands ${this.config.bot.guildId ? `to guild ${this.config.bot.guildId}` : 'globally'}...`);
      await this.registerCommands();
      startupLog('Slash commands registration complete');

      const databaseMode = dbStatus.isDegraded
        ? 'Optional in-memory mode (data resets after restart)'
        : 'Connected (persistent data enabled)';
      const handlerSummary = `${this.buttons.size} buttons, ${this.selectMenus.size} menus, ${this.modals.size} modals`;
      startupLog(`ONLINE ✅ | ${this.commands.size} commands loaded | ${handlerSummary} | Database: ${databaseMode}`);
      this.setupCronJobs();
    } catch (error) {
      logger.error('Failed to start bot:', error);
      process.exit(1);
    }
  }

  startWebServer() {
    const app = express();
    const configuredPort = Number(this.config.api?.port || process.env.PORT || 3000);
    const maxPortRetryAttempts = Number(process.env.PORT_RETRY_ATTEMPTS || 5);
    const host = process.env.WEB_HOST || '0.0.0.0';
    const corsOrigin = this.config.api?.cors?.origin || '*';

    app.use((req, res, next) => {
      const allowedOrigins = Array.isArray(corsOrigin) ? corsOrigin : [corsOrigin];
      const origin = req.headers.origin;
      if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) res.header('Access-Control-Allow-Origin', origin || '*');
      res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      if (req.method === 'OPTIONS') return res.sendStatus(200);
      next();
    });

    const requestCounts = new Map();
    const windowMs = this.config.api?.rateLimit?.windowMs || 60000;
    const maxRequests = this.config.api?.rateLimit?.max || 100;
    app.use((req, res, next) => {
      const ip = req.ip;
      const now = Date.now();
      const times = (requestCounts.get(ip) || []).filter(t => t > now - windowMs);
      if (times.length >= maxRequests) return res.status(429).json({ error: 'Too many requests' });
      times.push(now);
      requestCounts.set(ip, times);
      next();
    });

    app.get('/health', (req, res) => {
      const dbStatus = this.db?.getStatus?.() || { isDegraded: 'unknown' };
      res.status(200).json({ status: 'healthy', timestamp: new Date().toISOString(), uptime: process.uptime(), database: { connected: dbStatus.connectionType !== 'none', degraded: dbStatus.isDegraded, type: dbStatus.connectionType } });
    });

    app.get('/ready', (req, res) => {
      const dbStatus = this.db?.getStatus?.() || { isDegraded: true, connectionType: 'none' };
      const isReady = this.isReady() && !dbStatus.isDegraded;
      const metrics = { guildCount: this.guilds?.cache?.size ?? 0, commandCount: this.commands?.size ?? 0, database: { mode: dbStatus.connectionType, degraded: dbStatus.isDegraded, degradedReason: dbStatus.degradedReason ?? null }, schemaVersion: EXPECTED_SCHEMA_VERSION, schemaLabel: EXPECTED_SCHEMA_LABEL };
      if (isReady) return res.status(200).json({ ready: true, message: 'Bot is ready', metrics });
      return res.status(503).json({ ready: false, reason: !this.isReady() ? 'Bot not Ready' : 'Database degraded', metrics });
    });

    app.get('/', (req, res) => res.status(200).json({ message: 'TitanBot System Online', version: pkg.version, timestamp: new Date().toISOString() }));

    const startServer = (port, attempt = 0) => {
      let hasStartedListening = false;
      const server = app.listen(port, host, () => {
        hasStartedListening = true;
        this.webServer = server;
        startupLog(`✅ Web Server running on ${host}:${port}`);
      });
      server.on('error', (error) => {
        if (!hasStartedListening && error?.code === 'EADDRINUSE' && attempt < maxPortRetryAttempts) {
          const nextPort = port + 1;
          startupLog(`Port ${port} is already in use. Trying port ${nextPort}...`);
          setTimeout(() => startServer(nextPort, attempt + 1), 250);
          return;
        }
        logger.error(`❌ Web server error on port ${port}: ${error?.message || error}`);
        if (!hasStartedListening) process.exit(1);
      });
    };
    startServer(configuredPort, 0);
  }

  setupCronJobs() {
    cron.schedule('0 6 * * *', runSafeTask('birthday_check', () => checkBirthdays(this)));
    cron.schedule('* * * * *', runSafeTask('giveaway_check', () => checkGiveaways(this)));
    cron.schedule('*/15 * * * *', runSafeTask('counter_update', () => this.updateAllCounters()));
  }

  async updateAllCounters() {
    if (!this.db) return;
    for (const [guildId, guild] of this.guilds.cache) {
      try {
        const counters = await getServerCounters(this, guildId);
        const validCounters = [];
        const orphanedCounters = [];
        for (const counter of counters) {
          if (counter && counter.type && counter.channelId && counter.enabled !== false) {
            const channel = guild.channels.cache.get(counter.channelId);
            if (channel) {
              validCounters.push(counter);
              await updateCounter(this, guild, counter);
            } else orphanedCounters.push(counter);
          }
        }
        if (orphanedCounters.length > 0) await saveServerCounters(this, guildId, validCounters);
      } catch (error) {
        logger.error(`Error updating counters for guild ${guildId}:`, error);
      }
    }
  }

  async loadHandlers() {
    startupLog('Loading handlers...');
    const handlers = [
      { path: 'events', type: 'default', required: true },
      { path: 'interactions', type: 'default', required: true },
    ];
    for (const handler of handlers) {
      try {
        startupLog(`Loading handler: ${handler.path}`);
        const module = await import(`./handlers/loaders/${handler.path}.js`);
        const loaderFn = handler.type.startsWith('named:') ? module[handler.type.split(':')[1]] : module.default;
        if (typeof loaderFn !== 'function') throw new Error(`Invalid loader export from ${handler.path}`);
        await loaderFn(this);
        startupLog(`✅ Loaded ${handler.path}`);
      } catch (error) {
        if (handler.required) {
          logger.error(`❌ Failed to load required handler ${handler.path}:`, error.message);
          throw error;
        }
        if (error.code !== 'MODULE_NOT_FOUND') logger.warn(`⚠️ Failed to load optional handler ${handler.path}:`, error.message);
      }
    }
  }

  async registerCommands() {
    try {
      await registerSlashCommands(this, { clientId: this.config.bot.clientId, guildId: this.config.bot.guildId });
    } catch (error) {
      logger.error('Error registering commands:', error);
    }
  }

  async shutdown(reason = 'UNKNOWN') {
    shutdownLog(`Bot is shutting down (${reason})...`);
    try {
      cron.getTasks().forEach(task => task.stop());
      await shutdownMusic(this);
      if (this.webServer) await new Promise(resolve => this.webServer.close(resolve));
      if (this.db && this.db.db) {
        try {
          if (this.db.db.pool) await this.db.db.pool.end();
          else if (typeof this.db.db.close === 'function') await this.db.db.close();
        } catch (error) {
          logger.warn(`Database close warning: ${error.message}`);
        }
      }
      this.destroy();
      shutdownLog('Bot shutdown complete.');
    } catch (error) {
      logger.error('Error during shutdown:', error);
    }
  }
}

const bot = new TitanBot();

process.on('SIGINT', () => bot.shutdown('SIGINT'));
process.on('SIGTERM', () => bot.shutdown('SIGTERM'));
process.on('unhandledRejection', (error) => logger.error('Unhandled promise rejection:', error));
process.on('uncaughtException', (error) => logger.error('Uncaught exception:', error));

bot.start();
export default bot;