import cron from 'node-cron';
import type { ScheduledTask } from 'node-cron';
import type { Api } from 'grammy';
import { config } from './config.js';
import { logger, errMsg } from './logger.js';
import { runThreadSummaryPipeline } from './summary.js';
import type { CorePersistence } from './persistence.js';
import type { PublicationDispatcher } from './publication-dispatcher.js';
import {
  enqueueThreadSummaryPublication,
} from './scheduled-publication.service.js';

const tasks = new Map<string, ScheduledTask>();

type CronHandler = () => Promise<void>;

export interface SchedulerOptions {
  dispatcher: PublicationDispatcher;
  memberSync?: {
    cron: string;
    run: () => Promise<unknown>;
  };
}

/**
 * Register a single named cron job. Validates the expression, wraps the handler
 * in per-job try/catch, and stores the task for graceful shutdown.
 * Invalid expression logs ERROR and returns false; sibling jobs still register.
 */
function registerJob(name: string, cronExpr: string, handler: CronHandler): boolean {
  if (!cron.validate(cronExpr)) {
    logger.error({ name, cronExpr }, 'Invalid cron expression, job not registered');
    return false;
  }
  if (tasks.has(name)) {
    logger.warn({ name }, 'Cron job already registered, skipping duplicate');
    return false;
  }
  const task = cron.schedule(cronExpr, async () => {
    logger.info({ name }, 'Cron triggered');
    try {
      await handler();
    } catch (err: unknown) {
      logger.error({ err, name }, `Cron job handler failed: name=${name} err=${errMsg(err)}`);
    }
  });
  tasks.set(name, task);
  logger.info({ name, cronExpr }, 'Cron job registered');
  return true;
}

async function threadSummaryHandler(
  persistence: CorePersistence,
  dispatcher: PublicationDispatcher,
): Promise<void> {
  const result = await runThreadSummaryPipeline(
    persistence.messages,
    persistence.jobs,
    { persistState: false },
  );
  if (result.alreadyPublished) {
    logger.warn(
      { date: result.date.toISOString() },
      'Cron: thread-summary already published today, skipping send',
    );
    return;
  }
  if (result.llmOutage) {
    logger.error(
      {
        event: 'thread-summary-llm-outage-skip',
        threadsSkippedError: result.threadsSkippedError,
      },
      'Cron: thread-summary skipped due to full LLM outage; job state unchanged',
    );
    return;
  }
  if (result.chunks.length === 0) {
    logger.warn('Cron: thread-summary returned 0 chunks, nothing to send');
    return;
  }
  await enqueueThreadSummaryPublication(result, persistence, dispatcher, {
    targetChatId: config.targetChatId,
    threadId: config.threadSummaryThreadId,
  });
  logger.info(
    {
      event: 'thread-summary-published',
      threadsSummarised: result.threadsSummarised,
      threadsSkippedLowVolume: result.threadsSkippedLowVolume,
      threadsSkippedError: result.threadsSkippedError,
      totalMessageCount: result.totalMessageCount,
      chunkCount: result.chunks.length,
    },
    'Cron: thread-summary cycle complete',
  );
}

async function retentionSweepHandler(persistence: CorePersistence): Promise<void> {
  await persistence.messages.runRetention(config.messageRetentionDays);
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  await persistence.publications.deleteExpiredPublications(cutoff);
}

export function startScheduler(
  api: Api,
  persistence: CorePersistence,
  options: SchedulerOptions,
): void {
  registerJob('thread-summary', config.threadSummaryCron, () =>
    threadSummaryHandler(persistence, options.dispatcher));
  registerJob('retention-sweep', config.retentionSweepCron, () =>
    retentionSweepHandler(persistence));
  if (options.memberSync) {
    registerJob('member-sync', options.memberSync.cron, async () => {
      await options.memberSync?.run();
    });
  }
  logger.info({ jobCount: tasks.size, jobs: [...tasks.keys()] }, 'Scheduler started');
}

export function stopScheduler(): void {
  if (tasks.size === 0) {
    logger.debug('Scheduler: no active tasks to stop');
    return;
  }
  for (const [name, task] of tasks) {
    try {
      task.stop();
      logger.info({ name }, 'Cron job stopped');
    } catch (err: unknown) {
      logger.error({ err, name }, `Cron job stop failed: name=${name} err=${errMsg(err)}`);
    }
  }
  tasks.clear();
  logger.info('Scheduler stopped');
}

export function _getRegisteredJobNames(): string[] {
  return [...tasks.keys()];
}

// Test-only: clear the registry between unit tests so each test starts fresh.
export function _resetSchedulerForTests(): void {
  for (const task of tasks.values()) {
    try {
      task.stop();
    } catch {
      /* ignore */
    }
  }
  tasks.clear();
}
