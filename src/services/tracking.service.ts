import { logger } from '../utils/logger.js';
import { listTracked } from '../stores/tracked-threads-store.js';

// Private module-singleton Set — source of truth for the capture hot path.
// O(1) lookup vs ~0.1ms SELECT per message (RESEARCH §"Don't Hand-Roll" table).
// Phase 5 will add track()/untrack() that mutate this Set + write to DB
// (D-01 contract: Phase 4 ships read-side only).
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
 * Snapshot of currently-tracked thread IDs. Used by future Phase 5 /tracked
 * command and Phase 7 thread-summary orchestrator.
 */
export function listTrackedThreadIds(): number[] {
  return [...trackedSet];
}

// Phase 5 will add track(threadId, addedBy: number) and untrack(threadId)
// functions here that mutate trackedSet AND write through to the store.
// Phase 4 ships read-side only — no placeholders, no throwing stubs (D-01).
