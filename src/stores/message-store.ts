import type { Statement } from 'better-sqlite3';
import { getDb } from '../services/db.service.js';
import type { CapturedMessage } from '../types/index.js';

// Module-level lazy prepared statements (STORE-04 — cached per store).
// Lazy because module load order MUST not depend on initDb() — getDb() throws if
// initDb() hasn't run, so we defer .prepare() until first call.

let _upsertStmt: Statement<[CapturedMessage]> | null = null;
let _selectWindowStmt: Statement<[number, string]> | null = null;
// Top-participants statement uses 5 positional placeholders:
// (thread_id, since, thread_id, since, limit). better-sqlite3's
// Statement<P> generic types `.all(...args: P)` against a tuple, so we
// declare the tuple explicitly to keep the call signature compiling.
type TopParticipantsArgs = [number, string, number, string, number];
let _selectTopParticipantsStmt: Statement<TopParticipantsArgs> | null = null;

interface CapturedMessageRow {
  chat_id: number;
  thread_id: number;
  tg_message_id: number;
  author_id: number | null;
  author_name: string;
  is_anonymous: 0 | 1;
  text: string;
  reply_to_message_id: number | null;
  created_at: string;
  edited_at: string | null;
}

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

function selectWindowStmt(): Statement<[number, string]> {
  _selectWindowStmt ??= getDb().prepare<[number, string]>(`
    SELECT chat_id, thread_id, tg_message_id, author_id, author_name,
           is_anonymous, text, reply_to_message_id, created_at, edited_at
    FROM messages
    WHERE thread_id = ? AND created_at >= ?
    ORDER BY created_at ASC
  `);
  return _selectWindowStmt;
}

/**
 * Lazy-cached correlated-subquery statement for top-N participants.
 * 5 placeholders total (thread_id, since, thread_id, since, limit) — the inner
 * subquery needs thread_id+since to scope the latest-author_name lookup, and
 * the outer query repeats them for the GROUP BY scope.
 *
 * Anon admins (author_id=NULL) get a synthetic group_key per tg_message_id:
 * `COALESCE(author_id, -1000000 - tg_message_id)`. Phase 6 D-14 — distinct
 * anon channels do not merge.
 *
 * Latest author_name per group via correlated subquery `ORDER BY m2.id DESC
 * LIMIT 1` — handles mid-window rename per Phase 6 D-13.
 */
function selectTopParticipantsStmt(): Statement<TopParticipantsArgs> {
  _selectTopParticipantsStmt ??= getDb().prepare<TopParticipantsArgs>(`
    SELECT
      COALESCE(author_id, -1000000 - tg_message_id) AS group_key,
      (SELECT m2.author_name FROM messages m2
       WHERE COALESCE(m2.author_id, -1000000 - m2.tg_message_id) =
             COALESCE(messages.author_id, -1000000 - messages.tg_message_id)
         AND m2.thread_id = ? AND m2.created_at >= ?
       ORDER BY m2.id DESC LIMIT 1) AS author_name,
      COUNT(*) AS msg_count
    FROM messages
    WHERE thread_id = ? AND created_at >= ?
    GROUP BY group_key
    ORDER BY msg_count DESC, group_key ASC
    LIMIT ?
  `);
  return _selectTopParticipantsStmt;
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
 * Phase 6 D-13: select all messages in [sinceIso, now) window for a thread,
 * ordered chronologically. Used by orchestrator to build LLM transcript.
 */
export function selectMessagesInWindow(
  threadId: number,
  sinceIso: string,
): CapturedMessage[] {
  const rows = selectWindowStmt().all(threadId, sinceIso) as CapturedMessageRow[];
  return rows.map((r) => ({
    chatId: r.chat_id,
    threadId: r.thread_id,
    tgMessageId: r.tg_message_id,
    authorId: r.author_id,
    authorName: r.author_name,
    isAnonymous: r.is_anonymous,
    text: r.text,
    replyToMessageId: r.reply_to_message_id,
    createdAt: r.created_at,
    editedAt: r.edited_at,
  }));
}

export interface ParticipantStat {
  authorName: string;
  messageCount: number;
}

/**
 * Phase 6 D-10 + D-13 + D-14: top-N participants by message count in window,
 * with the LATEST author_name per author (handles mid-window rename).
 * Anon admins grouped per (chat_id, tg_message_id) seed so distinct channels
 * are not merged.
 */
export function selectTopParticipants(
  threadId: number,
  sinceIso: string,
  limit = 3,
): ParticipantStat[] {
  const rows = selectTopParticipantsStmt().all(
    threadId,
    sinceIso,
    threadId,
    sinceIso,
    limit,
  ) as Array<{
    group_key: number;
    author_name: string;
    msg_count: number;
  }>;
  return rows.map((r) => ({
    authorName: r.author_name,
    messageCount: r.msg_count,
  }));
}

// Test-only: invalidate cached prepared statements so a subsequent
// initDb() (e.g. between vitest cases) re-prepares against the fresh
// connection. Production never calls this — _db is opened once per boot.
export function _resetMessageStoreForTests(): void {
  _upsertStmt = null;
  _selectWindowStmt = null;
  _selectTopParticipantsStmt = null;
}
