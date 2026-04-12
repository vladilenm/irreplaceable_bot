import { bot } from './bot.js';
import { logger } from './utils/logger.js';
import { startScheduler, stopScheduler } from './scheduler/cron.js';

async function main(): Promise<void> {
  logger.info('Starting bot...');

  startScheduler();

  // Start long-polling
  bot.start({
    onStart: () => {
      logger.info('Bot is running (long-polling mode)');
    },
  });
}

// Graceful shutdown (REL-01)
function shutdown(signal: string): void {
  logger.info({ signal }, 'Shutdown signal received, stopping gracefully...');
  stopScheduler();
  bot.stop();
  logger.info('Bot stopped. Goodbye.');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Uncaught error handlers (REL-02) -- log but exit cleanly
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.fatal({ reason }, 'Unhandled rejection');
  process.exit(1);
});

main().catch((err: unknown) => {
  logger.fatal({ err }, 'Failed to start bot');
  process.exit(1);
});
