import { logger } from '../utils/logger.js';
import { listTracked } from '../stores/tracked-threads-store.js';

// Private module-singleton Set — source of truth for the capture hot path.
// O(1) lookup vs ~0.1ms SELECT per message (RESEARCH §"Don't Hand-Roll" table).
// Phase 5 (track/untrack in-chat commands) was cancelled 2026-04-29 — whitelist
// is managed via env-seed (INITIAL_TRACKED_THREAD_IDS) and direct DB writes only.
const trackedSet = new Set<number>();

/**
 * Rebuild the in-memory whitelist from DB (TRK-05). Called once at startup
 * BEFORE bot.start() — Plan 04-03 wires this into src/index.ts main().
 *
 * Idempotent: safe to call again on demand. Subsequent invocations clear and
 * reload — guarantees Set matches DB state at the moment of call.
 */
export function loadTrackingWhitelist(): void {
  trackedSet.clear();
  for (const t of listTracked()) {
    trackedSet.add(t.threadId);
  }
  logger.info(
    { count: trackedSet.size, threadIds: [...trackedSet] },
    'Tracking whitelist loaded',
  );
}

/**
 * O(1) hot-path check — called by capture handler on every message
 * (Plan 04-03 captureHandler).
 */
export function isThreadTracked(threadId: number): boolean {
  return trackedSet.has(threadId);
}

/**
 * Snapshot of currently-tracked thread IDs. Consumed by the thread-summary
 * orchestrator (src/modules/thread-summary/thread-summary.service.ts) on every
 * 06:30 MSK cron tick.
 */
export function listTrackedThreadIds(): number[] {
  return [...trackedSet];
}

