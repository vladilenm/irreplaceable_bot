import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Database, { type Statement } from 'better-sqlite3';
import { config } from './config.js';
import { logger, errMsg } from './logger.js';
import type { CapturedMessage, PipelineStateV2 } from './types.js';

interface Migration {
  version: number;
  description: string;
  sql: string;
}

// In-code MIGRATIONS array (D-07). Forward-only. NEVER edit a shipped version;
// add a new one. Each migration runs in its own db.transaction() — partial
// failure is isolated to a single version (PITFALLS DB-04).
const MIGRATIONS: ReadonlyArray<Migration> = [
  {
    version: 1,
    description: 'Phase 4: messages capture infrastructure (4 tables + indexes)',
    sql: `
      CREATE TABLE IF NOT EXISTS messages (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id             INTEGER NOT NULL,
        thread_id           INTEGER NOT NULL,
        tg_message_id       INTEGER NOT NULL,
        author_id           INTEGER,
        author_name         TEXT    NOT NULL,
        is_anonymous        INTEGER NOT NULL DEFAULT 0,
        text                TEXT    NOT NULL,
        reply_to_message_id INTEGER,
        created_at          TEXT    NOT NULL,
        edited_at           TEXT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_chat_tg
        ON messages (chat_id, tg_message_id);

      CREATE INDEX IF NOT EXISTS idx_messages_thread_created
        ON messages (thread_id, created_at);

      CREATE INDEX IF NOT EXISTS idx_messages_author
        ON messages (author_id) WHERE author_id IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_messages_created
        ON messages (created_at);

      CREATE TABLE IF NOT EXISTS users (
        author_id     INTEGER PRIMARY KEY,
        display_name  TEXT    NOT NULL,
        first_seen_at TEXT    NOT NULL,
        last_seen_at  TEXT    NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tracked_threads (
        thread_id   INTEGER PRIMARY KEY,
        chat_id     INTEGER NOT NULL,
        added_by    INTEGER,
        added_at    TEXT    NOT NULL
      );

      CREATE TABLE IF NOT EXISTS forgotten_users (
        author_id      INTEGER PRIMARY KEY,
        forgotten_at   TEXT    NOT NULL,
        deleted_count  INTEGER NOT NULL DEFAULT 0,
        requested_via  TEXT    NOT NULL
      );
    `,
  },
  {
    version: 2,
    description: 'Phase 6 D-05: tracked_threads.title (forum-topic display name cache)',
    sql: `
      ALTER TABLE tracked_threads ADD COLUMN title TEXT;
    `,
  },
  {
    version: 3,
    description: 'Phase 7: drop forgotten_users (CMD-07 de-scoped 2026-04-29)',
    sql: `
      DROP TABLE IF EXISTS forgotten_users;
    `,
  },
  {
    version: 4,
    description: 'Store scheduled-job state in SQLite',
    sql: `
      CREATE TABLE job_state (
        job_name          TEXT PRIMARY KEY,
        last_completed_at TEXT,
        last_outcome      TEXT NOT NULL CHECK (last_outcome IN ('success', 'skipped')),
        item_count        INTEGER NOT NULL DEFAULT 0
      );
    `,
  },
  {
    version: 5,
    description: 'Remove unused user and tracked-thread tables',
    sql: `
      DROP TABLE IF EXISTS users;
      DROP TABLE IF EXISTS tracked_threads;
    `,
  },
  // Future versions append here. Shipped migrations are immutable.
];

let _db: Database.Database | null = null;

/**
 * Open the SQLite database, apply pragmas in canonical order, run pending
 * migrations inside transactions.
 *
 * SYNCHRONOUS — better-sqlite3 design choice. Throws on WAL pragma failure
 * (DB-01 silent-fallback defence). Idempotent: subsequent calls are no-ops.
 */
export function initDb(): void {
  if (_db) return;

  _db = new Database(config.dbPath);

  // ─── Pragma application order (RESEARCH §1.5, sqlite.org) ───
  // 1. journal_mode = WAL — FIRST, OUTSIDE any transaction.
  //    sqlite.org: "journal_mode cannot be changed while a transaction is active".
  //    sqlite.org also: `:memory:` databases cannot use WAL — silently fall
  //    back to 'memory' journal mode. Skip the WAL pragma + check for
  //    in-memory DBs (test env). Production DB_PATH is always file-backed.
  const isMemoryDb = config.dbPath === ':memory:';
  if (!isMemoryDb) {
    _db.pragma('journal_mode = WAL');
  }

  // 2. Verify WAL active for file-backed DBs (PITFALLS DB-01: silent fallback
  //    to 'delete' if dir perms denied). For :memory: we just record the mode.
  const mode = _db.pragma('journal_mode', { simple: true });
  if (!isMemoryDb && mode !== 'wal') {
    throw new Error(
      `WAL mode not active — got '${String(mode)}'. ` +
        `Check directory permissions on ${config.dbPath} parent ` +
        `(needs RWX for uid 1001 in Docker).`,
    );
  }

  // 3. Other pragmas — no ordering constraint between them.
  _db.pragma('foreign_keys = ON');
  _db.pragma('synchronous = NORMAL');
  _db.pragma('busy_timeout = 5000');

  // 4. Bootstrap schema_migrations meta-table (idempotent CREATE IF NOT EXISTS).
  _db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      applied_at TEXT    NOT NULL
    );
  `);

  const appliedRows = _db
    .prepare('SELECT version FROM schema_migrations ORDER BY version')
    .all() as Array<{ version: number }>;
  const applied = new Set(appliedRows.map((r) => r.version));

  // Each migration runs in its own transaction (D-07, PITFALLS DB-04).
  const dbRef = _db;
  const applyMigration = dbRef.transaction((m: Migration) => {
    dbRef.exec(m.sql);
    dbRef
      .prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
      .run(m.version, new Date().toISOString());
  });

  let appliedCount = 0;
  for (const m of MIGRATIONS) {
    if (!applied.has(m.version)) {
      logger.info({ version: m.version, description: m.description }, 'Applying migration');
      applyMigration(m);
      appliedCount++;
    }
  }

  logger.info(
    { dbPath: config.dbPath, journalMode: mode, appliedMigrations: appliedCount },
    'Database initialised',
  );
}

export function getDb(): Database.Database {
  if (!_db) throw new Error('initDb() must be called before getDb()');
  return _db;
}

/**
 * Checkpoint WAL and close the database. Called from the SIGTERM/SIGINT handler
 * AFTER bot.stop() so in-flight capture transactions can finish (REL-05 gates
 * Phase 8; this plan ships the function — Phase 4 wiring in 04-03 calls it).
 */
export function closeDb(): void {
  if (_db) {
    try {
      _db.pragma('wal_checkpoint(TRUNCATE)');
    } catch (err: unknown) {
      logger.warn({ err }, `WAL checkpoint failed on close (non-fatal): ${errMsg(err)}`);
    }
    _db.close();
    _db = null;
    logger.info('Database closed');
  }
}

// Test-only: reset the cached connection so a fresh initDb() reopens :memory:.
// The `_` prefix signals private; not called by any production code path.
// Required because better-sqlite3 with `:memory:` creates a fresh DB on every
// `Database(':memory:')` call, but `_db` is module-level cached.
export function _resetForTests(): void {
  if (_db) {
    try {
      _db.close();
    } catch {
      /* ignore */
    }
    _db = null;
  }
  _upsertMessageStmt = null;
  _selectMessagesStmt = null;
  _deleteBatchStmt = null;
}

const LEGACY_STATE_PATH = fileURLToPath(new URL('../data/state.json', import.meta.url));
const DEFAULT_STATE: PipelineStateV2 = {
  lastDigestDate: null,
  lastSkipped: false,
  lastItemCount: 0,
  lastThreadSummaryDate: null,
};

interface JobStateRow {
  job_name: 'digest' | 'thread-summary';
  last_completed_at: string | null;
  last_outcome: 'success' | 'skipped';
  item_count: number;
}

export function readState(): PipelineStateV2 {
  const rows = getDb()
    .prepare('SELECT job_name, last_completed_at, last_outcome, item_count FROM job_state')
    .all() as JobStateRow[];
  const digest = rows.find((row) => row.job_name === 'digest');
  const summary = rows.find((row) => row.job_name === 'thread-summary');
  return {
    lastDigestDate: digest?.last_completed_at ?? null,
    lastSkipped: digest?.last_outcome === 'skipped',
    lastItemCount: digest?.item_count ?? 0,
    lastThreadSummaryDate: summary?.last_completed_at ?? null,
  };
}

export function writeState(state: PipelineStateV2): void {
  const db = getDb();
  const upsert = db.prepare(`
    INSERT INTO job_state (job_name, last_completed_at, last_outcome, item_count)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(job_name) DO UPDATE SET
      last_completed_at = excluded.last_completed_at,
      last_outcome = excluded.last_outcome,
      item_count = excluded.item_count
  `);
  db.transaction(() => {
    upsert.run(
      'digest',
      state.lastDigestDate,
      state.lastSkipped ? 'skipped' : 'success',
      state.lastItemCount,
    );
    upsert.run('thread-summary', state.lastThreadSummaryDate, 'success', 0);
  })();
}

function parseLegacyState(raw: string): PipelineStateV2 {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) throw new Error('not a JSON object');
  const state = parsed as Record<string, unknown>;
  return {
    lastDigestDate:
      typeof state['lastDigestDate'] === 'string' ? state['lastDigestDate'] : null,
    lastSkipped: typeof state['lastSkipped'] === 'boolean' && state['lastSkipped'],
    lastItemCount:
      typeof state['lastItemCount'] === 'number' ? state['lastItemCount'] : 0,
    lastThreadSummaryDate:
      typeof state['lastThreadSummaryDate'] === 'string'
        ? state['lastThreadSummaryDate']
        : null,
  };
}

export function importLegacyState(path = LEGACY_STATE_PATH): boolean {
  const count = (
    getDb().prepare('SELECT COUNT(*) AS count FROM job_state').get() as { count: number }
  ).count;
  if (count > 0 || !existsSync(path)) return false;
  try {
    writeState(parseLegacyState(readFileSync(path, 'utf8')));
    logger.info({ path }, 'Imported legacy job state into SQLite');
    return true;
  } catch (err: unknown) {
    logger.warn({ err, path }, 'Legacy state.json could not be imported');
    return false;
  }
}

function sameMskDay(iso: string): boolean {
  const options = { timeZone: 'Europe/Moscow' } as const;
  return (
    new Date().toLocaleDateString('en-CA', options) ===
    new Date(iso).toLocaleDateString('en-CA', options)
  );
}

export function isDigestPublishedToday(): boolean {
  const state = readState();
  return Boolean(
    state.lastDigestDate && !state.lastSkipped && sameMskDay(state.lastDigestDate),
  );
}

export function isThreadSummaryPublishedTodayWithState(state: PipelineStateV2): boolean {
  return Boolean(
    state.lastThreadSummaryDate && sameMskDay(state.lastThreadSummaryDate),
  );
}

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

let _upsertMessageStmt: Statement<[CapturedMessage]> | null = null;
let _selectMessagesStmt: Statement<[number, number, string]> | null = null;

export function upsertMessage(message: CapturedMessage): void {
  _upsertMessageStmt ??= getDb().prepare<[CapturedMessage]>(`
    INSERT INTO messages (
      chat_id, thread_id, tg_message_id, author_id, author_name,
      is_anonymous, text, reply_to_message_id, created_at, edited_at
    ) VALUES (
      @chatId, @threadId, @tgMessageId, @authorId, @authorName,
      @isAnonymous, @text, @replyToMessageId, @createdAt, @editedAt
    )
    ON CONFLICT(chat_id, tg_message_id) DO UPDATE SET
      text = excluded.text,
      author_name = excluded.author_name,
      edited_at = excluded.edited_at
  `);
  _upsertMessageStmt.run(message);
}

export function selectMessagesInWindow(
  chatId: number,
  threadId: number,
  sinceIso: string,
): CapturedMessage[] {
  _selectMessagesStmt ??= getDb().prepare<[number, number, string]>(`
    SELECT chat_id, thread_id, tg_message_id, author_id, author_name,
           is_anonymous, text, reply_to_message_id, created_at, edited_at
    FROM messages
    WHERE chat_id = ? AND thread_id = ? AND created_at >= ?
    ORDER BY created_at ASC
  `);
  const rows = _selectMessagesStmt.all(chatId, threadId, sinceIso) as CapturedMessageRow[];
  return rows.map((row) => ({
    chatId: row.chat_id,
    threadId: row.thread_id,
    tgMessageId: row.tg_message_id,
    authorId: row.author_id,
    authorName: row.author_name,
    isAnonymous: row.is_anonymous,
    text: row.text,
    replyToMessageId: row.reply_to_message_id,
    createdAt: row.created_at,
    editedAt: row.edited_at,
  }));
}

export function _resetMessageStoreForTests(): void {
  _upsertMessageStmt = null;
  _selectMessagesStmt = null;
}

export interface RetentionSweepResult {
  rowsDeleted: number;
  durationMs: number;
}

const RETENTION_BATCH_SIZE = 1000;
let _deleteBatchStmt: Statement<[string, string]> | null = null;

export async function runRetentionSweep(): Promise<RetentionSweepResult> {
  const startedAt = Date.now();
  const cutoff = new Date(
    startedAt - config.messageRetentionDays * 86400 * 1000,
  ).toISOString();
  _deleteBatchStmt ??= getDb().prepare<[string, string]>(`
    DELETE FROM messages
    WHERE created_at < ?
      AND id IN (
        SELECT id FROM messages
        WHERE created_at < ?
        ORDER BY created_at ASC
        LIMIT ${RETENTION_BATCH_SIZE}
      )
  `);

  let rowsDeleted = 0;
  for (let iteration = 0; iteration < 10_000; iteration++) {
    const info = _deleteBatchStmt.run(cutoff, cutoff);
    if (info.changes === 0) {
      const durationMs = Date.now() - startedAt;
      logger.info(
        { event: 'retention-sweep', rows_deleted: rowsDeleted, duration_ms: durationMs },
        'Retention sweep complete',
      );
      return { rowsDeleted, durationMs };
    }
    rowsDeleted += info.changes;
  }
  throw new Error('Retention sweep exceeded 10000 batches');
}

export function _resetRetentionServiceForTests(): void {
  _deleteBatchStmt = null;
}
