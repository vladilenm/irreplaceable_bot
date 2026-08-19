import cron from 'node-cron';
import type { ScheduledTask } from 'node-cron';
import type { Api } from 'grammy';
import { config } from './config.js';
import { logger, errMsg } from './logger.js';
import { runDigestPipeline, sendDigest } from './radar.js';
import {
  runThreadSummaryPipeline,
  sendThreadSummary,
} from './summary.js';
import { recordThreadSummaryCompletion, runRetentionSweep } from './database.js';

const tasks = new Map<string, ScheduledTask>();

type CronHandler = () => Promise<void>;

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

async function digestHandler(api: Api): Promise<void> {
  const result = await runDigestPipeline();
  if (result.alreadyPublished) {
    logger.warn('Cron: digest already published today, skipping send');
    return;
  }
  await sendDigest(api, result);
  logger.info(
    { itemCount: result.itemCount, skipped: result.skipped },
    'Cron: digest cycle complete',
  );
}

async function threadSummaryHandler(api: Api): Promise<void> {
  const result = await runThreadSummaryPipeline();
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
  await sendThreadSummary(api, result.chunks);
  // Delivery state advances only after every Telegram chunk succeeds.
  if (result.persistState) {
    recordThreadSummaryCompletion(result.date);
  }
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

async function retentionSweepHandler(): Promise<void> {
  await runRetentionSweep();
}

export function startScheduler(api: Api): void {
  registerJob('digest', config.digestCron, () => digestHandler(api));
  registerJob('thread-summary', config.threadSummaryCron, () => threadSummaryHandler(api));
  registerJob('retention-sweep', config.retentionSweepCron, retentionSweepHandler);
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
