import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Database, { type Statement } from 'better-sqlite3';
import { config } from './config.js';
import { logger, errMsg } from './logger.js';
import type { CapturedMessage, PipelineState } from './types.js';

interface Migration {
  version: number;
  description: string;
  sql: string;
}

// Migrations are forward-only. Never edit a shipped version; append a new one.
const MIGRATIONS: ReadonlyArray<Migration> = [
  {
    version: 1,
    description: 'Create message capture tables and indexes',
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
    description: 'Add forum-topic title cache',
    sql: `
      ALTER TABLE tracked_threads ADD COLUMN title TEXT;
    `,
  },
  {
    version: 3,
    description: 'Remove unused forgotten-users table',
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
];

let _db: Database.Database | null = null;

/** Open SQLite, configure it, and apply pending migrations. */
export function initDb(): void {
  if (_db) return;

  _db = new Database(config.dbPath);

  // WAL must be enabled before opening a transaction. In-memory test databases
  // use SQLite's memory journal instead.
  const isMemoryDb = config.dbPath === ':memory:';
  if (!isMemoryDb) {
    _db.pragma('journal_mode = WAL');
  }

  // SQLite may silently fall back when the data directory is not writable.
  const mode = _db.pragma('journal_mode', { simple: true });
  if (!isMemoryDb && mode !== 'wal') {
    throw new Error(
      `WAL mode not active — got '${String(mode)}'. ` +
        `Check directory permissions on ${config.dbPath} parent ` +
        `(needs RWX for uid 1001 in Docker).`,
    );
  }

  _db.pragma('foreign_keys = ON');
  _db.pragma('synchronous = NORMAL');
  _db.pragma('busy_timeout = 5000');

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

  // A failed migration rolls back without affecting earlier versions.
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

/** Checkpoint WAL and close the database. */
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

// Reset module-level handles between in-memory test databases.
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

interface JobStateRow {
  job_name: 'digest' | 'thread-summary';
  last_completed_at: string | null;
  last_outcome: 'success' | 'skipped';
  item_count: number;
}

export function readState(): PipelineState {
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

function writeFullState(state: PipelineState): void {
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

export function recordDigestCompletion(
  completedAt: Date,
  skipped: boolean,
  itemCount: number,
): void {
  getDb().prepare(`
    INSERT INTO job_state (job_name, last_completed_at, last_outcome, item_count)
    VALUES ('digest', ?, ?, ?)
    ON CONFLICT(job_name) DO UPDATE SET
      last_completed_at = excluded.last_completed_at,
      last_outcome = excluded.last_outcome,
      item_count = excluded.item_count
  `).run(completedAt.toISOString(), skipped ? 'skipped' : 'success', itemCount);
}

export function recordThreadSummaryCompletion(completedAt: Date): void {
  getDb().prepare(`
    INSERT INTO job_state (job_name, last_completed_at, last_outcome, item_count)
    VALUES ('thread-summary', ?, 'success', 0)
    ON CONFLICT(job_name) DO UPDATE SET
      last_completed_at = excluded.last_completed_at,
      last_outcome = 'success',
      item_count = 0
  `).run(completedAt.toISOString());
}

function parseLegacyState(raw: string): PipelineState {
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
    writeFullState(parseLegacyState(readFileSync(path, 'utf8')));
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
  return isDigestPublishedTodayWithState(readState());
}

export function isDigestPublishedTodayWithState(state: PipelineState): boolean {
  return Boolean(
    state.lastDigestDate && !state.lastSkipped && sameMskDay(state.lastDigestDate),
  );
}

export function isThreadSummaryPublishedTodayWithState(state: PipelineState): boolean {
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
