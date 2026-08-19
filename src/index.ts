import 'dotenv/config';
import { bot } from './bot.js';
import { logger, bootId, errMsg } from './logger.js';
import { startScheduler, stopScheduler } from './scheduler.js';
import { initDb, closeDb, importLegacyState } from './database.js';
import {
  classifyStartupError,
  POLLING_CONFLICT_BACKOFF_MS,
  runPreflight,
} from './startup.js';

let mainStep = 0;

async function main(): Promise<void> {
  mainStep += 1;
  logger.info(`Starting bot... bootId=${bootId} step=${mainStep}`);

  // Database readiness is a startup requirement; scheduled jobs and capture
  // handlers must never run against a partially migrated schema.
  initDb();
  importLegacyState();

  // Start long-polling — fire-and-forget with explicit .catch so startup
  // errors are logged and cause a clean exit rather than an unhandled rejection.
  // startScheduler() is called inside onStart so cron jobs only tick AFTER the
  // bot successfully establishes long-polling. This prevents a rolling-deploy
  // TOCTOU where the new container's cron fires while the old container is still
  // alive, causing both to pass the idempotency guard and double-publish.
  void bot.start({
    onStart: () => {
      logger.info('Bot is running (long-polling mode)');
      startScheduler(bot.api);
      void runPreflight(bot);
    },
  }).catch((err: unknown) => {
    // A competing long-polling client produces Telegram 409. Back off before
    // exit so the process supervisor does not create a tight restart loop.
    const kind = classifyStartupError(err);
    if (kind === 'polling-conflict-409') {
      logger.fatal(
        { err, backoffMs: POLLING_CONFLICT_BACKOFF_MS },
        `bot.start() failed: 409 Conflict — another instance is already polling. Sleeping ${String(POLLING_CONFLICT_BACKOFF_MS)}ms before exit. err=${errMsg(err)}`,
      );
      setTimeout(() => process.exit(1), POLLING_CONFLICT_BACKOFF_MS);
      return;
    }
    logger.fatal({ err }, `bot.start() failed: ${errMsg(err)}`);
    process.exit(1);
  });
}

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Shutdown signal received, stopping gracefully...');
  stopScheduler();
  await bot.stop();
  // Stop Telegram first so no capture transaction starts during DB shutdown.
  closeDb();
  logger.info('Bot stopped. Goodbye.');
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, `Uncaught exception: ${errMsg(err)}`);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.fatal({ reason }, `Unhandled rejection: ${errMsg(reason)}`);
  process.exit(1);
});

main().catch((err: unknown) => {
  logger.fatal({ err }, `Failed to start bot: ${errMsg(err)}`);
  process.exit(1);
});
