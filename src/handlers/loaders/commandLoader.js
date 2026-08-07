import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { Collection } from 'discord.js';
import { logger } from '../../utils/logger.js';
import botConfig from '../../config/bot.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MAX_COMMANDS = 100;
const COMMAND_COUNT_WARN_THRESHOLD = 90;

function getSubcommandInfo(commandData) {
    const subcommands = [];
    if (commandData.options) {
        for (const option of commandData.options) {
            if (option.type === 1) subcommands.push(option.name);
            else if (option.type === 2 && option.options) {
                for (const subOption of option.options) {
                    if (subOption.type === 1) subcommands.push(`${option.name}/${subOption.name}`);
                }
            }
        }
    }
    return subcommands;
}

async function getAllFiles(directory, fileList = []) {
    const files = await fs.readdir(directory, { withFileTypes: true });
    for (const file of files) {
        const filePath = path.join(directory, file.name);
        if (file.isDirectory()) {
            if (file.name === 'modules') continue;
            await getAllFiles(filePath, fileList);
        } else if (file.name.endsWith('.js')) {
            fileList.push(filePath);
        }
    }
    return fileList;
}

export async function loadCommands(client) {
    client.commands = new Collection();
    const commandsPath = path.join(__dirname, '../../commands');
    const commandFiles = await getAllFiles(commandsPath);
    logger.info(`Found ${commandFiles.length} command files to load`);

    const uniqueCommandNames = new Set();
    for (const filePath of commandFiles) {
        try {
            const normalizedPath = filePath.replace(/\\/g, '/');
            const commandDir = path.dirname(filePath);
            const category = path.basename(commandDir);
            const commandModule = await import(`file://${filePath}`);
            const command = commandModule.default || commandModule;

            if (!command.data || !command.execute) {
                logger.warn(`Command at ${filePath} is missing required "data" or "execute" property.`);
                continue;
            }

            command.category = command.category || category;
            command.filePath = normalizedPath;
            const primaryCommandName = command.data.name;

            if (!uniqueCommandNames.has(primaryCommandName)) {
                uniqueCommandNames.add(primaryCommandName);
                client.commands.set(primaryCommandName, command);
            }

            const subcommands = getSubcommandInfo(command.data.toJSON());
            logger.info(`Loaded command: ${primaryCommandName} from ${normalizedPath} (category: ${command.category})`);
            if (subcommands.length > 0) logger.info(`  - Subcommands: ${subcommands.join(', ')}`);
        } catch (error) {
            logger.error(`Error loading command from ${filePath}:`, error);
        }
    }

    logger.info(`Loaded ${client.commands.size} unique slash commands`);
    return client.commands;
}

function collectCommandPayloads(client) {
    const commands = [];
    let totalSubcommands = 0;
    const registeredNames = new Set();

    for (const command of client.commands.values()) {
        if (!command.data || typeof command.data.toJSON !== 'function') {
            logger.warn('Command missing data or toJSON method; skipping registration.');
            continue;
        }
        const commandName = command.data.name;
        if (registeredNames.has(commandName)) continue;
        registeredNames.add(commandName);
        const commandJson = command.data.toJSON();
        commands.push(commandJson);
        totalSubcommands += getSubcommandInfo(commandJson).length;
    }

    return { commands, totalSubcommands };
}

function validateCommands(commands) {
    const validationErrors = [];
    for (const cmd of commands) {
        if (!cmd.name || !/^[a-z0-9_-]{1,32}$/.test(cmd.name)) {
            validationErrors.push(`Invalid command name: ${cmd.name}`);
        }
        if (cmd.description && cmd.description.length > 100) {
            validationErrors.push(`Command ${cmd.name} has a description longer than Discord's 100-character limit.`);
        }
        for (const option of cmd.options || []) {
            if (option.name && option.name.length > 32) validationErrors.push(`Command ${cmd.name} option ${option.name} has a name longer than 32 characters.`);
            if (option.description && option.description.length > 100) validationErrors.push(`Command ${cmd.name} option ${option.name} has a description longer than 100 characters.`);
        }
    }
    if (validationErrors.length) {
        validationErrors.forEach((error) => logger.error(`  - ${error}`));
        throw new Error(`Command validation failed with ${validationErrors.length} errors`);
    }
}

function prepareCommandsForRegistration(commands) {
    if (commands.length >= COMMAND_COUNT_WARN_THRESHOLD) {
        logger.warn(`Command count (${commands.length}) is near Discord's ${MAX_COMMANDS} command limit.`);
    }
    if (commands.length > MAX_COMMANDS) {
        throw new Error(`Loaded ${commands.length} top-level commands, exceeding Discord's ${MAX_COMMANDS} command limit. Reduce the command count instead of silently dropping commands.`);
    }
    return commands;
}

async function putCommands(client, route, commands, scopeLabel) {
    logger.info(`Registering ${commands.length} ${scopeLabel} slash commands...`);
    const registered = await client.rest.put(route, { body: commands });
    logger.info(`Successfully registered ${Array.isArray(registered) ? registered.length : commands.length} ${scopeLabel} slash commands.`);
    return registered;
}

async function registerCommandsInternal(client, clientId, guildId, commands, totalSubcommands) {
    if (!clientId) throw new Error('CLIENT_ID is required for slash command registration');
    if (!client.rest) throw new Error('Discord REST client is not available for slash command registration');

    validateCommands(commands);
    const commandsToRegister = prepareCommandsForRegistration(commands);
    logger.info(`Preparing ${commandsToRegister.length} top-level commands (${totalSubcommands} subcommands) for registration.`);

    if (guildId) {
        await putCommands(client, `/applications/${clientId}/guilds/${guildId}/commands`, commandsToRegister, `guild (${guildId})`);
        logger.info('Guild slash commands are available immediately after Discord accepts the registration.');

        if (process.env.REGISTER_GLOBAL_COMMANDS === 'true') {
            await putCommands(client, `/applications/${clientId}/commands`, commandsToRegister, 'global');
        }
        return;
    }

    logger.warn('GUILD_ID is not configured; falling back to global slash-command registration.');
    await putCommands(client, `/applications/${clientId}/commands`, commandsToRegister, 'global');
    logger.info('Global slash commands can take time to propagate. Set GUILD_ID in Railway for immediate server commands.');
}

export async function registerCommands(client, options = {}) {
    const { clientId = null, guildId = null } = options;
    try {
        const { commands, totalSubcommands } = collectCommandPayloads(client);
        await registerCommandsInternal(client, clientId, guildId, commands, totalSubcommands);
    } catch (error) {
        logger.error('Error registering commands:', error);
        throw error;
    }
}

export async function reloadCommand(client, commandName) {
    const command = client.commands.get(commandName);
    if (!command) return { success: false, message: `Command "${commandName}" not found` };

    try {
        const commandPath = path.resolve(command.filePath);
        const moduleUrl = pathToFileURL(commandPath);
        moduleUrl.searchParams.set('t', Date.now().toString());
        const module = await import(moduleUrl.href);
        const newCommand = module.default || module;
        newCommand.category = newCommand.category || command.category;
        newCommand.filePath = command.filePath;
        client.commands.set(commandName, newCommand);
        logger.info(`Reloaded command: ${commandName}`);
        return { success: true, message: `Successfully reloaded command "${commandName}"` };
    } catch (error) {
        logger.error(`Error reloading command "${commandName}":`, error);
        return { success: false, message: `Error reloading command: ${error.message}` };
    }
}