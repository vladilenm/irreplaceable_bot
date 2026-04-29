import type { Statement } from 'better-sqlite3';
import { getDb } from '../services/db.service.js';
import type { TrackedThread } from '../types/index.js';

// Lazy-cached prepared statements (STORE-04). Phase 5 will add
// insertTrackedThread / deleteTrackedThread here; Phase 4 ships read-side only
// (D-01 contract: no refactor required when Phase 5 adds the writers).
// Phase 6 D-05/D-06: extends listTracked to return title; adds upsertThreadTitle
// (UPDATE-only — Phase 5 owns INSERT via /track command).

let _listStmt: Statement<[]> | null = null;
let _upsertTitleStmt: Statement<[string, number]> | null = null;

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

function upsertTitleStmt(): Statement<[string, number]> {
  // No INSERT path — Phase 6 D-07: orchestrator only updates titles for
  // already-tracked threads. Phase 5 owns INSERT via /track command.
  _upsertTitleStmt ??= getDb().prepare<[string, number]>(
    'UPDATE tracked_threads SET title = ? WHERE thread_id = ?',
  );
  return _upsertTitleStmt;
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

/**
 * Phase 6 D-06: orchestrator calls this once per day per thread to refresh
 * the cached forum-topic title from getForumTopic API. No-op for non-existent
 * thread_id (UPDATE matches 0 rows; safe).
 */
export function upsertThreadTitle(threadId: number, title: string): void {
  upsertTitleStmt().run(title, threadId);
}

// Test-only: invalidate cached prepared statements so a subsequent
// initDb() (e.g. between vitest cases) re-prepares against the fresh
// connection. Production never calls this — _db is opened once per boot.
export function _resetTrackedThreadsStoreForTests(): void {
  _listStmt = null;
  _upsertTitleStmt = null;
}
