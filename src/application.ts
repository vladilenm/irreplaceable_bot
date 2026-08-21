import type { Api, Bot } from 'grammy';
import type { Pool } from 'pg';
import type { CreateBotOptions } from './bot.js';
import { logger } from './logger.js';
import type { Persistence } from './persistence.js';
import type { RequestMatchingRuntime } from './request.runtime.js';
import type { SchedulerOptions } from './scheduler.js';
import type { DatabaseConfig, RequestMatchingConfig } from './types.js';

export interface PollingHandle {
  started: Promise<void>;
  completed: Promise<void>;
}

export interface ApplicationDependencies {
  database: DatabaseConfig;
  requestMatching: RequestMatchingConfig;
  createPool(config: DatabaseConfig): Pool;
  migrate(pool: Pool): Promise<number | void>;
  assertReady(pool: Pool): Promise<void>;
  createPersistence(pool: Pool): Persistence;
  createRequestMatching(
    feature: RequestMatchingConfig,
    persistence: Persistence,
  ): Promise<RequestMatchingRuntime>;
  createBot(options: CreateBotOptions): Bot;
  startPolling(bot: Bot): PollingHandle;
  startScheduler(api: Api, persistence: Persistence, options?: SchedulerOptions): void;
  stopScheduler(): void;
  runPreflight(bot: Bot): Promise<unknown>;
}

export interface RunningApplication {
  bot: Bot;
  pool: Pool;
  persistence: Persistence;
  requestMatching?: RequestMatchingRuntime;
  pollingCompleted: Promise<void>;
  stop(): Promise<void>;
}

export async function startApplication(
  deps: ApplicationDependencies,
): Promise<RunningApplication> {
  const migrationPool = deps.createPool(deps.database);
  try {
    await deps.migrate(migrationPool);
  } finally {
    await migrationPool.end();
  }

  const pool = deps.createPool(deps.database);
  let bot: Bot | null = null;
  let schedulerStarted = false;
  try {
    await deps.assertReady(pool);
    const persistence = deps.createPersistence(pool);
    const requestMatching = await deps.createRequestMatching(deps.requestMatching, persistence);
    bot = deps.createBot({ persistence, requestMatching });
    const polling = deps.startPolling(bot);
    await polling.started;

    deps.startScheduler(
      bot.api,
      persistence,
      {
        memberIndex: {
          cron: deps.requestMatching.memberIndexCron,
          run: () => requestMatching.memberDirectory.indexPending(),
        },
      },
    );
    schedulerStarted = true;

    void requestMatching.memberDirectory.indexPending()
      .then((result) => {
        logger.info(
          { indexed: result.indexed, failed: result.failed },
          'Initial member directory indexing complete',
        );
      })
      .catch((error: unknown) => {
        logger.error(
          { errorClass: error instanceof Error ? error.name : 'unknown' },
          'Initial member directory indexing failed',
        );
      });
    void deps.runPreflight(bot).catch((error: unknown) => {
      logger.error(
        { errorClass: error instanceof Error ? error.name : 'unknown' },
        'Telegram preflight failed',
      );
    });

    let stopped = false;
    return {
      bot,
      pool,
      persistence,
      requestMatching,
      pollingCompleted: polling.completed,
      async stop(): Promise<void> {
        if (stopped) return;
        stopped = true;
        deps.stopScheduler();
        await bot?.stop();
        await pool.end();
      },
    };
  } catch (error: unknown) {
    if (schedulerStarted) deps.stopScheduler();
    if (bot) {
      try {
        await bot.stop();
      } catch {
        // Startup error is more actionable than a secondary stop error.
      }
    }
    await pool.end();
    throw error;
  }
}
