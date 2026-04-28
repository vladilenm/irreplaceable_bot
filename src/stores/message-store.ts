import type { Statement } from 'better-sqlite3';
import { getDb } from '../services/db.service.js';
import type { CapturedMessage } from '../types/index.js';

// Module-level lazy prepared statements (STORE-04 — cached per store).
// Lazy because module load order MUST not depend on initDb() — getDb() throws if
// initDb() hasn't run, so we defer .prepare() until first call.

let _upsertStmt: Statement<[CapturedMessage]> | null = null;
let _forgottenStmt: Statement<[number]> | null = null;

function upsertStmt(): Statement<[CapturedMessage]> {
  _upsertStmt ??= getDb().prepare<[CapturedMessage]>(`
    INSERT INTO messages (
      chat_id, thread_id, tg_message_id,
      author_id, author_name, is_anonymous,
      text, reply_to_message_id, created_at, edited_at
    ) VALUES (
      @chatId, @threadId, @tgMessageId,
      @authorId, @authorName, @isAnonymous,
      @text, @replyToMessageId, @createdAt, @editedAt
    )
    ON CONFLICT(chat_id, tg_message_id) DO UPDATE SET
      text        = excluded.text,
      author_name = excluded.author_name,
      edited_at   = excluded.edited_at
  `);
  return _upsertStmt;
}

function forgottenStmt(): Statement<[number]> {
  _forgottenStmt ??= getDb().prepare<[number]>(
    'SELECT 1 FROM forgotten_users WHERE author_id = ?',
  );
  return _forgottenStmt;
}

/**
 * Insert a captured message, OR update text + author_name + edited_at if a row
 * with the same (chat_id, tg_message_id) already exists.
 *
 * Idempotent for redelivery (long-polling restart, Telegram retry — OPS-05).
 * Edit-aware: re-delivered original from edit-after-original sequence preserves
 * created_at; edit always sets edited_at (RESEARCH §1.7 out-of-order handling).
 *
 * Hot path — synchronous better-sqlite3 INSERT in WAL mode is ~0.1-1ms;
 * STORE-04 p95 < 50ms requirement satisfied trivially.
 */
export function upsertMessage(m: CapturedMessage): void {
  upsertStmt().run(m);
}

/**
 * Pre-INSERT forgotten-user guard (D-12, closes PRIV-02 in Phase 4 ahead of
 * Phase 8 /forget-me). Returns true if author_id has a row in forgotten_users.
 *
 * Caller (capture handler) MUST short-circuit when this returns true — never
 * write a captured row for a forgotten user. Anon admins (author_id === null)
 * never call this function (NULL never matches anything).
 */
export function isAuthorForgotten(authorId: number): boolean {
  return forgottenStmt().get(authorId) !== undefined;
}
