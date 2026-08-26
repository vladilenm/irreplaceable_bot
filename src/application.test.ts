import { expect, it, vi } from 'vitest';
import type { Bot } from 'grammy';
import type { Pool } from 'pg';
import {
  startApplication,
  type ApplicationDependencies,
} from './application.js';
import { logger } from './logger.js';
import type { Persistence } from './persistence.js';
import type { RequestMatchingRuntime } from './request.runtime.js';
import type { PublicationDispatcher } from './publication-dispatcher.js';
import type { TelegramTransportRuntime } from './telegram-transport.js';

function dependencies(
  events: string[],
  options: { migrationFailure?: boolean; startupSyncResult?: 'completed' | 'failed' | 'timed-out' } = {},
) {
  const migrationPool = {
    end: vi.fn(async () => {
      events.push('close-migration-pool');
    }),
  } as unknown as Pool;
  const runtimePool = {
    end: vi.fn(async () => {
      events.push('close-runtime-pool');
    }),
  } as unknown as Pool;
  const persistence = {} as Persistence;
  const requestMatching = {
    memberSync: {
      startupAttempt: vi.fn(async () => {
        events.push('sync-members');
        return options.startupSyncResult ?? 'completed';
      }),
      sync: vi.fn(async () => ({
        fetched: 0,
        accepted: 0,
        rejected: 0,
        deactivated: 0,
        indexed: 0,
        failed: 0,
      })),
    },
  } as unknown as RequestMatchingRuntime;
  const dispatcher: PublicationDispatcher = {
    dispatchDue: vi.fn(),
    start: vi.fn(() => {
      events.push('start-dispatcher');
    }),
    stop: vi.fn(() => {
      events.push('stop-dispatcher');
    }),
  };
  const bot = {
    api: {},
    stop: vi.fn(async () => {
      events.push('stop-bot');
    }),
  } as unknown as Bot;
  const telegramTransport: TelegramTransportRuntime = {
    clientOptions: { timeoutSeconds: 60 },
    completed: new Promise<void>(() => undefined),
    stop: vi.fn(async () => {
      events.push('stop-telegram-transport');
    }),
  };
  let poolCall = 0;
  const deps = {
    database: {
      url: 'postgresql://runtime',
      ssl: false,
      poolMax: 5,
      statementTimeoutMs: 10_000,
    },
    requestMatching: {
      embeddingApiKey: 'gateway-token',
      embeddingBaseUrl: 'https://api.timeweb.ai/v1',
      embeddingModel: 'openai/text-embedding-3-large',
      embeddingDimensions: 1536,
      memberSyncCron: '*/5 * * * *',
      memberSyncStartupTimeoutMs: 60_000,
      supportedConsentPolicyVersions: ['member-matching-v1'],
      concurrency: 2,
      queueLimit: 50,
      processingTimeoutMinutes: 10,
    },
    telegramProxy: null,
    createPool: vi.fn(() => poolCall++ === 0 ? migrationPool : runtimePool),
    migrate: vi.fn(async () => {
      events.push('migrate');
      if (options.migrationFailure) throw new Error('migration failed');
    }),
    assertReady: vi.fn(async () => {
      events.push('connect');
    }),
    createPersistence: vi.fn(() => {
      events.push('create-persistence');
      return persistence;
    }),
    createRequestMatching: vi.fn(async () => requestMatching),
    createPublicationDispatcher: vi.fn(() => dispatcher),
    startTelegramTransport: vi.fn(async () => {
      events.push('start-telegram-transport');
      return telegramTransport;
    }),
    createBot: vi.fn(() => {
      events.push('create-bot');
      return bot;
    }),
    startPolling: vi.fn(() => {
      events.push('start-bot');
      return {
        started: Promise.resolve(),
        completed: new Promise<void>(() => undefined),
      };
    }),
    startScheduler: vi.fn(() => {
      events.push('start-scheduler');
    }),
    stopScheduler: vi.fn(() => {
      events.push('stop-scheduler');
    }),
    runPreflight: vi.fn(async () => undefined),
  } satisfies ApplicationDependencies;
  return { deps, migrationPool, runtimePool, bot, telegramTransport };
}

it('does not construct or start the bot before migrations and PostgreSQL readiness', async () => {
  const events: string[] = [];
  const { deps } = dependencies(events);

  const running = await startApplication(deps);

  expect(deps.createPool).toHaveBeenNthCalledWith(1, deps.database);
  expect(deps.createPool).toHaveBeenNthCalledWith(2, deps.database);

  expect(events).toEqual([
    'migrate',
    'close-migration-pool',
    'connect',
    'create-persistence',
    'sync-members',
    'start-telegram-transport',
    'create-bot',
    'start-bot',
    'start-dispatcher',
    'start-scheduler',
  ]);
  await running.stop();
});

it('continues to polling and logs only a safe outcome when startup sync fails', async () => {
  const events: string[] = [];
  const { deps } = dependencies(events, { startupSyncResult: 'failed' });
  const warnSpy = vi.spyOn(logger, 'warn');

  const running = await startApplication(deps);

  expect(events).toContain('start-bot');
  expect(warnSpy).toHaveBeenCalledWith(
    { event: 'member-sync-startup', outcome: 'failed' },
    'Initial member source sync attempt finished',
  );
  expect(JSON.stringify(warnSpy.mock.calls)).not.toContain('profile');
  warnSpy.mockRestore();
  await running.stop();
});

it('closes migration resources and never constructs the bot when migration fails', async () => {
  const events: string[] = [];
  const { deps } = dependencies(events, { migrationFailure: true });

  await expect(startApplication(deps)).rejects.toThrow('migration failed');
  expect(events).toEqual(['migrate', 'close-migration-pool']);
  expect(deps.createBot).not.toHaveBeenCalled();
});

it('shuts down scheduler, Telegram, then the runtime pool exactly once', async () => {
  const events: string[] = [];
  const { deps } = dependencies(events);
  const running = await startApplication(deps);
  events.length = 0;

  await running.stop();
  await running.stop();

  expect(events).toEqual([
    'stop-dispatcher',
    'stop-scheduler',
    'stop-bot',
    'stop-telegram-transport',
    'close-runtime-pool',
  ]);
});

it('propagates a safe Telegram transport runtime failure', async () => {
  const events: string[] = [];
  const { deps, telegramTransport } = dependencies(events);
  const safeFailure = new Error('Telegram proxy exited: code=23');
  telegramTransport.completed = Promise.reject(safeFailure);

  const running = await startApplication(deps);
  await expect(running.pollingCompleted).rejects.toBe(safeFailure);
  await running.stop();
});
