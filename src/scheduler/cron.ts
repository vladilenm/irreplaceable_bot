// Cron scheduler registry: Phase 6 D-25..D-27 refactor from a single
// task slot to a Map<string, ScheduledTask>. Public API
// (startScheduler/stopScheduler) unchanged.
// Three jobs registered:
//   - digest         (06:00 MSK / config.digestCron)         — existing v1.0 handler, unchanged
//   - thread-summary (06:30 MSK / config.threadSummaryCron)  — STUB (Plan 06-03 wires real handler)
//   - retention-sweep (04:00 MSK / config.retentionSweepCron) — STUB (Phase 7 implements)
//
// Each registerJob wraps the handler in per-job try/catch (SCHED-04) so a failing
// job does not affect siblings. cron.validate() called per registration; invalid
// expression logs ERROR and skips (does not throw, other jobs still register).
import cron from 'node-cron';
import type { ScheduledTask } from 'node-cron';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { runDigestPipeline } from '../modules/digest/digest.service.js';
import { sendDigest } from '../modules/digest/digest.sender.js';

// Module-level registry. Singleton-by-import (mirrors tracking.service trackedSet pattern).
const tasks = new Map<string, ScheduledTask>();

type CronHandler = () => Promise<void>;

/**
 * Register a single named cron job. Validates the expression, wraps the handler
 * in per-job try/catch (SCHED-04), and stores the ScheduledTask in the registry.
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
      // SCHED-04: per-job isolation — log + swallow so other jobs continue ticking.
      logger.error({ err, name }, 'Cron job handler failed');
    }
  });
  tasks.set(name, task);
  logger.info({ name, cronExpr }, 'Cron job registered');
  return true;
}

// ─── Job handlers ───

async function digestHandler(): Promise<void> {
  // Existing v1.0 handler body — moved verbatim from previous src/scheduler/cron.ts.
  const result = await runDigestPipeline();
  if (result.alreadyPublished) {
    logger.warn('Cron: digest already published today, skipping send');
    return;
  }
  await sendDigest(result);
  logger.info(
    { itemCount: result.itemCount, skipped: result.skipped },
    'Cron: digest cycle complete',
  );
}

/**
 * Phase 6 D-26 stub. Plan 06-03 replaces this body with the real
 * runThreadSummaryPipeline + sendThreadSummary call.
 *
 * The stub itself MUST exist — otherwise registerJob has no callable to wire,
 * and Phase 7 would have to refactor the registry. With this stub, Plan 06-03
 * is a body-replace not a structural change.
 */
async function threadSummaryHandler(): Promise<void> {
  logger.warn('thread-summary stub — Plan 06-03 wires real handler');
}

/**
 * Phase 6 D-26 stub. Phase 7 replaces this body with the retention-sweep batch
 * delete (90-day cutoff, ≤1000 rows per iteration).
 */
async function retentionSweepHandler(): Promise<void> {
  logger.info('retention sweep stub — Phase 7 implements');
}

// ─── Public API (unchanged signature — SCHED-01) ───

export function startScheduler(): void {
  registerJob('digest', config.digestCron, digestHandler);
  registerJob('thread-summary', config.threadSummaryCron, threadSummaryHandler);
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
      logger.error({ err, name }, 'Cron job stop failed');
    }
  }
  tasks.clear();
  logger.info('Scheduler stopped');
}

// Test-only export for Plan 06-03 to swap in real thread-summary handler
// without re-instantiating the registry. Plan 06-03 WILL replace this function
// when it lands; for now Plan 06-02 ships only the stub.
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
