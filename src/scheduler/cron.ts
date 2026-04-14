// Cron scheduler: triggers the digest pipeline at the configured time (default
// 06:00 UTC = 09:00 MSK), then publishes via the sender. Per plan 03-01
// (D-03, D-04, D-05, REL-01, REL-02, T-03-03).
import cron from 'node-cron';
import type { ScheduledTask } from 'node-cron';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { runDigestPipeline } from '../modules/digest/digest.service.js';
import { sendDigest } from '../modules/digest/digest.sender.js';

let task: ScheduledTask | null = null;

export function startScheduler(): void {
  const cronExpression = config.digestCron;

  if (!cron.validate(cronExpression)) {
    logger.error({ cronExpression }, 'Invalid cron expression, scheduler not started');
    return;
  }

  task = cron.schedule(cronExpression, async () => {
    logger.info('Cron triggered: starting digest pipeline');
    try {
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
    } catch (err: unknown) {
      logger.error({ err }, 'Cron: digest cycle failed');
    }
  });

  logger.info({ cronExpression }, 'Scheduler started');
}

export function stopScheduler(): void {
  if (task) {
    task.stop();
    task = null;
    logger.info('Scheduler stopped');
  } else {
    logger.debug('Scheduler: no active task to stop');
  }
}
