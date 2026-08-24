import 'dotenv/config';
import type { Bot } from 'grammy';
import {
  startApplication,
  type PollingHandle,
  type RunningApplication,
} from './application.js';
import { createBot } from './bot.js';
import { config } from './config.js';
import { runMigrations } from './db/migrations.js';
import { assertDatabaseReady, createPool } from './db/pool.js';
import { logger, bootId, errMsg } from './logger.js';
import { createPersistence } from './persistence.js';
import { createRequestMatchingRuntime } from './request.runtime.js';
import { createPublicationDispatcher } from './publication-dispatcher.js';
import { startTelegramTransport } from './telegram-transport.js';
import { startScheduler, stopScheduler } from './scheduler.js';
import {
  classifyStartupError,
  POLLING_CONFLICT_BACKOFF_MS,
  runPreflight,
} from './startup.js';

let mainStep = 0;
let runningApplication: RunningApplication | null = null;

function startPolling(bot: Bot): PollingHandle {
  let started = false;
  let resolveStarted: (() => void) | undefined;
  let rejectStarted: ((error: unknown) => void) | undefined;
  const startedPromise = new Promise<void>((resolve, reject) => {
    resolveStarted = resolve;
    rejectStarted = reject;
  });
  const completed = bot.start({
    onStart: () => {
      started = true;
      logger.info('Bot is running (long-polling mode)');
      resolveStarted?.();
    },
  }).catch((error: unknown) => {
    if (!started) rejectStarted?.(error);
    throw error;
  });
  // startApplication awaits `started`; this observer prevents an unhandled
  // rejection in the narrow startup-failure window before it can return.
  void completed.catch(() => undefined);
  return { started: startedPromise, completed };
}

async function handleRuntimeFailure(error: unknown): Promise<void> {
  await runningApplication?.stop();
  runningApplication = null;
  const kind = classifyStartupError(error);
  if (kind === 'polling-conflict-409') {
    logger.fatal(
      { error, backoffMs: POLLING_CONFLICT_BACKOFF_MS },
      `bot.start() failed: 409 Conflict — another instance is already polling. Sleeping ${String(POLLING_CONFLICT_BACKOFF_MS)}ms before exit. err=${errMsg(error)}`,
    );
    setTimeout(() => process.exit(1), POLLING_CONFLICT_BACKOFF_MS);
    return;
  }
  logger.fatal(
    { errorClass: error instanceof Error ? error.name : 'unknown' },
    'Telegram runtime failed',
  );
  process.exit(1);
}

async function main(): Promise<void> {
  mainStep += 1;
  logger.info(`Starting bot... bootId=${bootId} step=${String(mainStep)}`);
  const application = await startApplication({
    database: config.database,
    requestMatching: config.requestMatching,
    telegramProxy: config.telegramProxy,
    createPool,
    migrate: runMigrations,
    assertReady: assertDatabaseReady,
    createPersistence,
    createRequestMatching: createRequestMatchingRuntime,
    createPublicationDispatcher,
    startTelegramTransport,
    createBot,
    startPolling,
    startScheduler,
    stopScheduler,
    runPreflight,
  });
  runningApplication = application;
  void application.pollingCompleted.catch((error: unknown) =>
    handleRuntimeFailure(error));
}

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Shutdown signal received, stopping gracefully...');
  await runningApplication?.stop();
  runningApplication = null;
  logger.info('Bot stopped. Goodbye.');
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

process.on('uncaughtException', (error) => {
  logger.fatal({ error }, `Uncaught exception: ${errMsg(error)}`);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.fatal({ reason }, `Unhandled rejection: ${errMsg(reason)}`);
  process.exit(1);
});

main().catch((error: unknown) => {
  logger.fatal({ error }, `Failed to start bot: ${errMsg(error)}`);
  process.exit(1);
});
