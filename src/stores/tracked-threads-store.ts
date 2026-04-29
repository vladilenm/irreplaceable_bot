import type { Statement } from 'better-sqlite3';
import { getDb } from '../services/db.service.js';
import type { TrackedThread } from '../types/index.js';

// Lazy-cached prepared statement (STORE-04). Phase 5 will add
// insertTrackedThread / deleteTrackedThread here; Phase 4 ships read-side only
// (D-01 contract: no refactor required when Phase 5 adds the writers).

let _listStmt: Statement<[]> | null = null;

interface TrackedThreadRow {
  thread_id: number;
  chat_id: number;
  added_by: number | null;
  added_at: string;
}

function listStmt(): Statement<[]> {
  _listStmt ??= getDb().prepare<[]>(
    'SELECT thread_id, chat_id, added_by, added_at FROM tracked_threads ORDER BY thread_id',
  );
  return _listStmt;
}

/**
 * Read all currently-tracked threads from DB (TRK-05 restart resilience).
 * Called from tracking.service.loadTrackingWhitelist() on boot.
 */
export function listTracked(): TrackedThread[] {
  const rows = listStmt().all() as TrackedThreadRow[];
  return rows.map((r) => ({
    threadId: r.thread_id,
    chatId: r.chat_id,
    addedBy: r.added_by,
    addedAt: r.added_at,
    title: null,  // Phase 6 D-05: Plan 02 owns migration v2 + SELECT title; Plan 01 owns type-side. Default null until Plan 02 lands.
  }));
}
