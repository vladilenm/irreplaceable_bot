import type { Statement } from 'better-sqlite3';
import { getDb } from '../services/db.service.js';
import type { TrackedThread } from '../types/index.js';

// Lazy-cached prepared statements (STORE-04). Phase 4 ships read-side only;
// Phase 5 (track/untrack in-chat commands) was cancelled 2026-04-29, so the writer
// path stays out of v2.0. tracked_threads.title remains nullable; thread-summary
// orchestrator falls back to `Тред #N` when title is NULL (see refreshThreadTitle).

let _listStmt: Statement<[]> | null = null;

interface TrackedThreadRow {
  thread_id: number;
  chat_id: number;
  added_by: number | null;
  added_at: string;
  title: string | null;
}

function listStmt(): Statement<[]> {
  _listStmt ??= getDb().prepare<[]>(
    'SELECT thread_id, chat_id, added_by, added_at, title FROM tracked_threads ORDER BY thread_id',
  );
  return _listStmt;
}


/**
 * Read all currently-tracked threads from DB (TRK-05 restart resilience).
 * Called from tracking.service.loadTrackingWhitelist() on boot.
 *
 * Phase 6 D-05: returns title column (null for threads never refreshed).
 */
export function listTracked(): TrackedThread[] {
  const rows = listStmt().all() as TrackedThreadRow[];
  return rows.map((r) => ({
    threadId: r.thread_id,
    chatId: r.chat_id,
    addedBy: r.added_by,
    addedAt: r.added_at,
    title: r.title,
  }));
}


// Test-only: invalidate cached prepared statements so a subsequent
// initDb() (e.g. between vitest cases) re-prepares against the fresh
// connection. Production never calls this — _db is opened once per boot.
export function _resetTrackedThreadsStoreForTests(): void {
  _listStmt = null;
}
