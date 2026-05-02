import 'dotenv/config';
import { bot } from './bot.js';
import { logger, bootId } from './utils/logger.js';
import { startScheduler, stopScheduler } from './scheduler/cron.js';
import { initDb, closeDb } from './services/db.service.js';
import { loadTrackingWhitelist } from './services/tracking.service.js';
import { runPreflight } from './utils/preflight.js';
import {
  classifyStartupError,
  POLLING_CONFLICT_BACKOFF_MS,
} from './utils/startup-error.js';

// step counter on main() entry — if main() runs twice in one process, we see
// step=1 then step=2; if the dashboard merely double-renders one emit, both
// shown lines carry the same step. Diagnostic for prod-digest-delivery-conflict.
let mainStep = 0;

async function main(): Promise<void> {
  mainStep += 1;
  // bootId+step in msg so dashboards that surface only `msg` still show them.
  logger.info(`Starting bot... bootId=${bootId} step=${mainStep}`);

  // v2.0 Phase 4: synchronous DB init BEFORE scheduler/polling.
  // Throws on WAL pragma failure (DB-01) — exit-fast preferred over silent
  // degraded mode. Better-sqlite3 is sync by design.
  initDb();

  // v2.0 Phase 4 (TRK-05): rebuild in-memory whitelist Set from DB BEFORE
  // bot.start(). If polling started first, capture handler would race against
  // an empty Set on the first ms of messages.
  loadTrackingWhitelist();

  startScheduler();

  // Start long-polling — fire-and-forget with explicit .catch so startup
  // errors are logged and cause a clean exit rather than an unhandled rejection.
  void bot.start({
    onStart: () => {
      logger.info('Bot is running (long-polling mode)');
      // v2.0 Phase 4 (MSG-08, OPS-03): non-blocking preflight self-check.
      // Logs WARN if privacy mode ON or bot is not admin in target chat.
      void runPreflight(bot);
    },
  }).catch((err: unknown) => {
    // Phase 8 fix D — soften the 409 Conflict path. grammy rethrows 409 out of
    // bot.start() when another long-polling client (rolling-deploy lingering
    // pod, parallel local dev process, replicas>1) is talking to the same
    // BOT_TOKEN. Immediate process.exit(1) under `restart: unless-stopped`
    // produces a busy-loop that floods logs without resolving anything; sleep
    // 60s before exiting so:
    //   • a transient parallel process (rolling-deploy old pod) usually
    //     finishes shutting down within the wait → next restart succeeds,
    //   • a permanent parallel process still surfaces as repeated FATALs but
    //     at one entry/minute instead of dozens/second.
    // The retry strategy is documented in src/utils/startup-error.ts so the
    // operator can see the design decision next to the constant.
    const kind = classifyStartupError(err);
    if (kind === 'polling-conflict-409') {
      logger.fatal(
        { err, backoffMs: POLLING_CONFLICT_BACKOFF_MS },
        'bot.start() failed: another bot instance is already polling Telegram (409 Conflict). Sleeping before exit so docker-compose `restart: unless-stopped` does not busy-loop.',
      );
      setTimeout(() => process.exit(1), POLLING_CONFLICT_BACKOFF_MS);
      // Note: we deliberately do NOT call process.exit(1) here. The setTimeout
      // keeps the event loop alive long enough that pino has time to flush the
      // FATAL line, and the host process supervisor (docker-compose,
      // Timeweb App Platform) sees a slow-loop instead of a tight one.
      return;
    }
    logger.fatal({ err }, 'bot.start() failed');
    process.exit(1);
  });
}

// Graceful shutdown (REL-01)
async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Shutdown signal received, stopping gracefully...');
  stopScheduler();
  await bot.stop();
  // v2.0 Phase 4: closeDb AFTER bot.stop() so in-flight capture transactions
  // complete cleanly. closeDb checkpoints WAL before close (REL-05 prep).
  closeDb();
  logger.info('Bot stopped. Goodbye.');
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

// Uncaught error handlers (REL-02) -- log but exit cleanly
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.fatal({ reason }, 'Unhandled rejection');
  process.exit(1);
});

main().catch((err: unknown) => {
  logger.fatal({ err }, 'Failed to start bot');
  process.exit(1);
});
