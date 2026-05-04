import Database from 'better-sqlite3';
import { config } from '../config.js';
import { logger, errMsg } from '../utils/logger.js';

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
  // future versions append here
];

let _db: Database.Database | null = null;

/**
 * Open the SQLite database, apply pragmas in canonical order, run pending
 * migrations inside transactions, and seed tracked_threads from
 * INITIAL_TRACKED_THREAD_IDS on first boot only (D-02).
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

  // 5. ENV-seed tracked_threads if BOTH table empty AND ENV non-empty (D-02).
  const trackedCount = (
    _db.prepare('SELECT COUNT(*) AS c FROM tracked_threads').get() as { c: number }
  ).c;
  if (trackedCount === 0 && config.initialTrackedThreadIds.length > 0) {
    const insertStmt = _db.prepare(`
      INSERT INTO tracked_threads (thread_id, chat_id, added_by, added_at)
      VALUES (?, ?, NULL, ?)
    `);
    const seedTxn = _db.transaction((ids: number[]) => {
      const now = new Date().toISOString();
      const chatId = Number(config.targetChatId);
      for (const id of ids) insertStmt.run(id, chatId, now);
    });
    seedTxn(config.initialTrackedThreadIds);
    logger.info(
      { count: config.initialTrackedThreadIds.length, ids: config.initialTrackedThreadIds },
      'Bootstrapped tracked_threads from INITIAL_TRACKED_THREAD_IDS',
    );
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
}
