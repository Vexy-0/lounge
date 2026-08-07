import { readdir } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { logger } from '../../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const LEGACY_EVENTS = new Set([
  'messageCreate.js',
  'ready.js',
]);

export default async function loadEvents(client) {
  const eventsPath = join(__dirname, '../../events');
  const eventFiles = await readdir(eventsPath).then(files => files
    .filter(file => file.endsWith('.js'))
    .filter(file => !LEGACY_EVENTS.has(file))
    .sort((a, b) => {
      if (a === '00_interactionAck.js') return -1;
      if (b === '00_interactionAck.js') return 1;
      return a.localeCompare(b);
    }));

  logger.info(`Found ${eventFiles.length} active event files to load`);

  for (const file of eventFiles) {
    const filePath = join(eventsPath, file);
    try {
      const { default: event } = await import(`file://${filePath}`);
      if (!event?.name || typeof event.execute !== 'function') {
        logger.warn(`Event ${file} is missing required "name" or "execute" properties.`);
        continue;
      }

      const safeExecute = async (...args) => {
        try {
          await event.execute(...args, client);
        } catch (error) {
          logger.error(`Error executing event ${event.name}:`, error);
        }
      };

      if (event.once) {
        client.once(event.name, safeExecute);
        logger.info(`✅ Registered once event: ${event.name} (${file})`);
      } else {
        client.on(event.name, safeExecute);
        logger.info(`✅ Registered event: ${event.name} (${file})`);
      }
    } catch (error) {
      logger.error(`Error loading event ${file}:`, error);
    }
  }
}
