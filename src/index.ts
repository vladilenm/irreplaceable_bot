import 'dotenv/config';
import type { Bot } from 'grammy';
import type { Pool } from 'pg';
import { createBot } from './bot.js';
import { config } from './config.js';
import { logger, bootId, errMsg } from './logger.js';
import { startScheduler, stopScheduler } from './scheduler.js';
import { initDb, closeDb, importLegacyState } from './database.js';
import { createRequestMatchingRuntime } from './request.runtime.js';
import {
  classifyStartupError,
  POLLING_CONFLICT_BACKOFF_MS,
  runPreflight,
} from './startup.js';
import { createPool, assertDatabaseReady } from './db/pool.js';
import { runMigrations } from './db/migrations.js';
import { createCorePersistence } from './persistence.js';

let mainStep = 0;
let runningBot: Bot | null = null;
let postgresPool: Pool | null = null;

async function main(): Promise<void> {
  mainStep += 1;
  logger.info(`Starting bot... bootId=${bootId} step=${mainStep}`);

  // Database readiness is a startup requirement; scheduled jobs and capture
  // handlers must never run against a partially migrated schema.
  const migrationPool = createPool(config.database, config.database.migrationUrl);
  try {
    await runMigrations(migrationPool);
  } finally {
    await migrationPool.end();
  }
  postgresPool = createPool(config.database);
  await assertDatabaseReady(postgresPool);
  const persistence = createCorePersistence(postgresPool);

  // Transitional until member matching is moved in the next migration slices.
  initDb();
  importLegacyState();

  const requestMatching = config.requestMatching
    ? createRequestMatchingRuntime(config.requestMatching)
    : undefined;
  const bot = createBot({ persistence, requestMatching });
  runningBot = bot;

  // Start long-polling — fire-and-forget with explicit .catch so startup
  // errors are logged and cause a clean exit rather than an unhandled rejection.
  // startScheduler() is called inside onStart so cron jobs only tick AFTER the
  // bot successfully establishes long-polling. This prevents a rolling-deploy
  // TOCTOU where the new container's cron fires while the old container is still
  // alive, causing both to pass the idempotency guard and double-publish.
  void bot.start({
    onStart: () => {
      logger.info('Bot is running (long-polling mode)');
      startScheduler(bot.api, persistence, requestMatching
        ? {
            memberSync: {
              cron: config.requestMatching?.memberSyncCron ?? '*/15 * * * *',
              run: () => requestMatching.syncService.sync(),
            },
          }
        : {});
      if (requestMatching) {
        void requestMatching.syncService.sync()
          .then((result) => {
            logger.info({
              generation: result.generation,
              active: result.active,
              embedded: result.embedded,
            }, 'Initial member directory sync complete');
          })
          .catch((error: unknown) => {
            logger.error({
              errorClass: error instanceof Error ? error.name : 'unknown',
            }, 'Initial member directory sync failed');
          });
      }
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
  await runningBot?.stop();
  // Stop Telegram first so no capture transaction starts during DB shutdown.
  closeDb();
  await postgresPool?.end();
  postgresPool = null;
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
