import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeEach, expect, it } from 'vitest';
import { runMigrations } from './db/migrations.js';
import { importSqlite } from './migrate-sqlite.js';
import { createTestPool, resetPostgres } from './test/postgres.js';

const pool = createTestPool();

beforeEach(async () => {
  await resetPostgres(pool);
  await runMigrations(pool);
});

afterAll(async () => {
  await pool.end();
});

function vectorBlob(dimensions = 1536): Buffer {
  const values = new Float32Array(dimensions);
  values[0] = 1;
  return Buffer.from(values.buffer);
}

function createLegacySqlite(options: { invalidEmbedding?: boolean } = {}): string {
  const path = join(mkdtempSync(join(tmpdir(), 'club-bot-import-')), 'messages.db');
  const sqlite = new Database(path);
  sqlite.exec(`
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL,
      thread_id INTEGER NOT NULL, tg_message_id INTEGER NOT NULL,
      author_id INTEGER, author_name TEXT NOT NULL, is_anonymous INTEGER NOT NULL,
      text TEXT NOT NULL, reply_to_message_id INTEGER, created_at TEXT NOT NULL,
      edited_at TEXT
    );
    CREATE TABLE job_state (
      job_name TEXT PRIMARY KEY, last_completed_at TEXT,
      last_outcome TEXT NOT NULL, item_count INTEGER NOT NULL
    );
    CREATE TABLE members (
      member_id TEXT PRIMARY KEY, source TEXT NOT NULL, external_id TEXT NOT NULL,
      display_name TEXT NOT NULL, telegram_username TEXT NOT NULL,
      profile_text TEXT NOT NULL, content_hash TEXT NOT NULL,
      source_updated_at TEXT NOT NULL, active INTEGER NOT NULL,
      sync_generation INTEGER NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE member_embeddings (
      member_id TEXT PRIMARY KEY, model TEXT NOT NULL, dimensions INTEGER NOT NULL,
      content_hash TEXT NOT NULL, vector BLOB NOT NULL
    );
    CREATE TABLE member_sync_state (
      provider TEXT PRIMARY KEY, generation INTEGER NOT NULL,
      last_success_at TEXT NOT NULL, embedding_model TEXT NOT NULL,
      dimensions INTEGER NOT NULL, active_count INTEGER NOT NULL
    );
    CREATE TABLE member_requests (
      chat_id INTEGER NOT NULL, tg_message_id INTEGER NOT NULL,
      thread_id INTEGER NOT NULL, author_id INTEGER, author_username TEXT,
      query_hash TEXT NOT NULL, status TEXT NOT NULL, match_count INTEGER NOT NULL,
      response_message_id INTEGER, error_code TEXT, started_at TEXT NOT NULL,
      completed_at TEXT, PRIMARY KEY(chat_id, tg_message_id)
    );
  `);
  const insertMigration = sqlite.prepare(
    'INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)',
  );
  for (let version = 1; version <= 6; version++) {
    insertMigration.run(version, '2026-08-21T00:00:00.000Z');
  }
  const insertMessage = sqlite.prepare(`
    INSERT INTO messages (
      chat_id, thread_id, tg_message_id, author_id, author_name,
      is_anonymous, text, reply_to_message_id, created_at, edited_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertMessage.run(-1001, 10, 1, 5, 'Анна', 0, 'Первое', null, '2026-08-21T09:00:00Z', null);
  insertMessage.run(-1001, 10, 2, null, 'Аноним', 1, 'Второе', 1, '2026-08-21T09:01:00Z', null);
  sqlite.prepare('INSERT INTO job_state VALUES (?, ?, ?, ?)')
    .run('digest', '2026-08-21T06:00:00Z', 'success', 4);
  sqlite.prepare('INSERT INTO job_state VALUES (?, ?, ?, ?)')
    .run('thread-summary', '2026-08-21T03:30:00Z', 'success', 0);

  const insertMember = sqlite.prepare(`
    INSERT INTO members VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertEmbedding = sqlite.prepare(`
    INSERT INTO member_embeddings VALUES (?, ?, ?, ?, ?)
  `);
  for (let index = 1; index <= 3; index++) {
    const id = `notion:page-${String(index)}`;
    insertMember.run(
      id,
      'notion',
      `page-${String(index)}`,
      `Участник ${String(index)}`,
      `member_${String(index).padStart(2, '0')}`,
      `Профиль ${String(index)}`,
      `hash-${String(index)}`,
      '2026-08-21T09:00:00Z',
      1,
      2,
      '2026-08-21T10:00:00Z',
    );
    insertEmbedding.run(
      id,
      'text-embedding-3-small',
      1536,
      `hash-${String(index)}`,
      options.invalidEmbedding && index === 2 ? vectorBlob(2) : vectorBlob(),
    );
  }
  sqlite.prepare('INSERT INTO member_sync_state VALUES (?, ?, ?, ?, ?, ?)').run(
    'notion',
    2,
    '2026-08-21T10:00:00Z',
    'text-embedding-3-small',
    1536,
    3,
  );
  sqlite.prepare(`
    INSERT INTO member_requests VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    -1001,
    77,
    10,
    5,
    'author',
    'query-hash',
    'completed',
    3,
    88,
    null,
    '2026-08-21T10:00:00Z',
    '2026-08-21T10:00:02Z',
  );
  sqlite.close();
  return path;
}

it('imports every durable table and preserves the source SQLite file', async () => {
  const path = createLegacySqlite();
  const before = readFileSync(path);

  await expect(importSqlite(path, pool)).resolves.toEqual({
    messages: 2,
    jobState: 2,
    members: 3,
    embeddings: 3,
    indexState: 1,
    requests: 1,
  });
  expect(readFileSync(path)).toEqual(before);

  const counts = await pool.query<{
    messages: number;
    job_state: number;
    members: number;
    embeddings: number;
    index_state: number;
    requests: number;
  }>(`
    SELECT
      (SELECT COUNT(*)::integer FROM messages) AS messages,
      (SELECT COUNT(*)::integer FROM job_state) AS job_state,
      (SELECT COUNT(*)::integer FROM members) AS members,
      (SELECT COUNT(*)::integer FROM member_embeddings) AS embeddings,
      (SELECT COUNT(*)::integer FROM member_index_state) AS index_state,
      (SELECT COUNT(*)::integer FROM member_requests) AS requests
  `);
  expect(counts.rows[0]).toEqual({
    messages: 2,
    job_state: 2,
    members: 3,
    embeddings: 3,
    index_state: 1,
    requests: 1,
  });
  const state = await pool.query<{ provider: string; pending_count: number }>(
    'SELECT provider, pending_count FROM member_index_state',
  );
  expect(state.rows[0]).toEqual({ provider: 'postgres', pending_count: 0 });
});

it('rolls back PostgreSQL on an invalid embedding blob', async () => {
  const path = createLegacySqlite({ invalidEmbedding: true });

  await expect(importSqlite(path, pool)).rejects.toThrow('embedding');
  const count = await pool.query<{ count: string }>(`
    SELECT (
      (SELECT COUNT(*) FROM messages) +
      (SELECT COUNT(*) FROM members) +
      (SELECT COUNT(*) FROM member_requests)
    )::text AS count
  `);
  expect(count.rows[0]?.count).toBe('0');
});

it('refuses to merge into a non-empty PostgreSQL application schema', async () => {
  const path = createLegacySqlite();
  await pool.query(`
    INSERT INTO job_state(job_name, last_outcome, item_count)
    VALUES ('digest', 'success', 0)
  `);

  await expect(importSqlite(path, pool)).rejects.toThrow('must be empty');
});
