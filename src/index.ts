import 'dotenv/config';
import { bot } from './bot.js';
import { logger } from './utils/logger.js';
import { startScheduler, stopScheduler } from './scheduler/cron.js';
import { initDb, closeDb } from './services/db.service.js';
import { loadTrackingWhitelist } from './services/tracking.service.js';
import { runPreflight } from './utils/preflight.js';

async function main(): Promise<void> {
  logger.info('Starting bot...');

  // v2.0 Phase 4: synchronous DB init BEFORE scheduler/polling.
  // Throws on WAL pragma failure (DB-01) — exit-fast preferred over silent
  // degraded mode. Better-sqlite3 is sync by design.
  initDb();

  // v2.0 Phase 4 (TRK-05): rebuild in-memory whitelist Set from DB BEFORE
  // bot.start(). If polling started first, capture handler would race against
  // an empty Set on the first ms of messages.
  loadTrackingWhitelist();

  startScheduler();

  // Start long-polling — fire-and-forget with explicit .catch so startup
  // errors are logged and cause a clean exit rather than an unhandled rejection.
  void bot.start({
    onStart: () => {
      logger.info('Bot is running (long-polling mode)');
      // v2.0 Phase 4 (MSG-08, OPS-03): non-blocking preflight self-check.
      // Logs WARN if privacy mode ON or bot is not admin in target chat.
      void runPreflight(bot);
    },
  }).catch((err: unknown) => {
    logger.fatal({ err }, 'bot.start() failed');
    process.exit(1);
  });
}

// Graceful shutdown (REL-01)
async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Shutdown signal received, stopping gracefully...');
  stopScheduler();
  await bot.stop();
  // v2.0 Phase 4: closeDb AFTER bot.stop() so in-flight capture transactions
  // complete cleanly. closeDb checkpoints WAL before close (REL-05 prep).
  closeDb();
  logger.info('Bot stopped. Goodbye.');
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

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
