import type { Api, Bot } from 'grammy';
import type { Pool } from 'pg';
import type { CreateBotOptions } from './bot.js';
import { logger } from './logger.js';
import type { Persistence } from './persistence.js';
import type { RequestMatchingRuntime } from './request.runtime.js';
import type { SchedulerOptions } from './scheduler.js';
import type {
  DatabaseConfig,
  RequestMatchingConfig,
  TelegramProxyConfig,
} from './types.js';
import type { TelegramTransportRuntime } from './telegram-transport.js';
import type {
  PublicationDispatcher,
  PublicationDispatcherOptions,
} from './publication-dispatcher.js';
import type { DigestImporter, DigestImporterOptions } from './digest-importer.js';

export interface PollingHandle {
  started: Promise<void>;
  completed: Promise<void>;
}

export interface ApplicationDependencies {
  database: DatabaseConfig;
  requestMatching: RequestMatchingConfig;
  telegramProxy: TelegramProxyConfig | null;
  digestImport: {
    enabled: boolean;
    targetChatId: number;
    threadId: number;
    intervalMs: number;
  };
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
  createPublicationDispatcher(options: PublicationDispatcherOptions): PublicationDispatcher;
  createDigestImporter(options: DigestImporterOptions): DigestImporter;
  startTelegramTransport(
    proxy: TelegramProxyConfig | null,
  ): Promise<TelegramTransportRuntime>;
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
  let dispatcher: PublicationDispatcher | null = null;
  let importer: DigestImporter | null = null;
  let telegramTransport: TelegramTransportRuntime | null = null;
  let schedulerStarted = false;
  try {
    await deps.assertReady(pool);
    const persistence = deps.createPersistence(pool);
    const requestMatching = await deps.createRequestMatching(deps.requestMatching, persistence);
    const startupSync = await requestMatching.memberSync.startupAttempt(
      deps.requestMatching.memberSyncStartupTimeoutMs,
    );
    if (startupSync === 'completed') {
      logger.info(
        { event: 'member-sync-startup', outcome: startupSync },
        'Initial member source sync attempt finished',
      );
    } else {
      logger.warn(
        { event: 'member-sync-startup', outcome: startupSync },
        'Initial member source sync attempt finished',
      );
    }
    telegramTransport = await deps.startTelegramTransport(deps.telegramProxy);
    dispatcher = deps.createPublicationDispatcher({
      publications: persistence.publications,
      jobs: persistence.jobs,
      sendMessageOnce: async (params) => {
        if (!bot) throw new Error('Telegram bot is not ready');
        const { sendMessageOnce } = await import('./telegram.js');
        return sendMessageOnce(bot.api, params);
      },
      sendRichMessageOnce: async (params) => {
        if (!bot) throw new Error('Telegram bot is not ready');
        const { sendRichMessageOnce } = await import('./telegram.js');
        return sendRichMessageOnce(bot.api, params);
      },
    });
    bot = deps.createBot({
      persistence,
      requestMatching,
      dispatcher,
      telegramClientOptions: telegramTransport.clientOptions,
    });
    const polling = deps.startPolling(bot);
    await polling.started;
    dispatcher.start();
    if (deps.digestImport.enabled) {
      importer = deps.createDigestImporter({
        source: persistence.digestSource,
        publications: persistence.publications,
        dispatcher,
        targetChatId: deps.digestImport.targetChatId,
        threadId: deps.digestImport.threadId,
        intervalMs: deps.digestImport.intervalMs,
        onError: (error: unknown) => {
          logger.error(
            {
              event: 'digest-import-failed',
              errorClass: error instanceof Error ? error.name : 'unknown',
            },
            'Digest importer cycle failed',
          );
        },
        logInvalid: (digestId, reason) => {
          logger.error(
            { event: 'digest-contract-rejected', digestId, reason },
            'Digest issue rejected at consumer boundary',
          );
        },
      });
      importer.start();
    }

    deps.startScheduler(
      bot.api,
      persistence,
      {
        dispatcher,
        memberSync: {
          cron: deps.requestMatching.memberSyncCron,
          run: () => requestMatching.memberSync.sync(),
        },
      },
    );
    schedulerStarted = true;

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
      pollingCompleted: Promise.race([
        polling.completed,
        telegramTransport.completed,
      ]),
      async stop(): Promise<void> {
        if (stopped) return;
        stopped = true;
        importer?.stop();
        dispatcher?.stop();
        deps.stopScheduler();
        await bot?.stop();
        await telegramTransport?.stop();
        await pool.end();
      },
    };
  } catch (error: unknown) {
    importer?.stop();
    dispatcher?.stop();
    if (schedulerStarted) deps.stopScheduler();
    if (bot) {
      try {
        await bot.stop();
      } catch {
        // Startup error is more actionable than a secondary stop error.
      }
    }
    if (telegramTransport) {
      try {
        await telegramTransport.stop();
      } catch {
        // Startup error is more actionable than a secondary stop error.
      }
    }
    await pool.end();
    throw error;
  }
}
