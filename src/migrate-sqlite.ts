import 'dotenv/config';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import type { Pool, PoolClient } from 'pg';
import { toSql } from 'pgvector/pg';
import { readDatabaseConfig } from './config.js';
import { runMigrations } from './db/migrations.js';
import { createPool } from './db/pool.js';
import { logger } from './logger.js';

const SQLITE_SCHEMA_VERSION = 6;
const VECTOR_DIMENSIONS = 1536;
const IMPORT_LOCK_ID = 620260823;

export interface ImportReport {
  messages: number;
  jobState: number;
  members: number;
  embeddings: number;
  indexState: number;
  requests: number;
}

interface LegacyMessageRow {
  chat_id: number;
  thread_id: number;
  tg_message_id: number;
  author_id: number | null;
  author_name: string;
  is_anonymous: number;
  text: string;
  reply_to_message_id: number | null;
  created_at: string;
  edited_at: string | null;
}

interface LegacyJobStateRow {
  job_name: string;
  last_completed_at: string | null;
  last_outcome: string;
  item_count: number;
}

interface LegacyMemberRow {
  member_id: string;
  source: string;
  external_id: string;
  display_name: string;
  telegram_username: string;
  profile_text: string;
  content_hash: string;
  source_updated_at: string;
  active: number;
  updated_at: string;
}

interface LegacyEmbeddingRow {
  member_id: string;
  model: string;
  dimensions: number;
  content_hash: string;
  vector: Buffer;
}

interface LegacyIndexStateRow {
  generation: number;
  last_success_at: string;
  embedding_model: string;
  dimensions: number;
}

interface LegacyRequestRow {
  chat_id: number;
  tg_message_id: number;
  thread_id: number;
  author_id: number | null;
  author_username: string | null;
  query_hash: string;
  status: string;
  match_count: number;
  response_message_id: number | null;
  error_code: string | null;
  started_at: string;
  completed_at: string | null;
}

interface LegacySnapshot {
  messages: LegacyMessageRow[];
  jobState: LegacyJobStateRow[];
  members: LegacyMemberRow[];
  embeddings: LegacyEmbeddingRow[];
  indexState: LegacyIndexStateRow[];
  requests: LegacyRequestRow[];
}

function readLegacySnapshot(path: string): LegacySnapshot {
  const sqlite = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const versions = sqlite.prepare(
      'SELECT version FROM schema_migrations ORDER BY version',
    ).all() as Array<{ version: number }>;
    const maxVersion = versions.at(-1)?.version ?? 0;
    if (
      maxVersion !== SQLITE_SCHEMA_VERSION ||
      versions.length !== SQLITE_SCHEMA_VERSION ||
      versions.some((row, index) => row.version !== index + 1)
    ) {
      throw new Error(
        `unsupported SQLite schema version: expected ${String(SQLITE_SCHEMA_VERSION)}, got ${String(maxVersion)}`,
      );
    }
    return {
      messages: sqlite.prepare(`
        SELECT chat_id, thread_id, tg_message_id, author_id, author_name,
          is_anonymous, text, reply_to_message_id, created_at, edited_at
        FROM messages ORDER BY id
      `).all() as LegacyMessageRow[],
      jobState: sqlite.prepare(`
        SELECT job_name, last_completed_at, last_outcome, item_count
        FROM job_state ORDER BY job_name
      `).all() as LegacyJobStateRow[],
      members: sqlite.prepare(`
        SELECT member_id, source, external_id, display_name, telegram_username,
          profile_text, content_hash, source_updated_at, active, updated_at
        FROM members ORDER BY member_id
      `).all() as LegacyMemberRow[],
      embeddings: sqlite.prepare(`
        SELECT member_id, model, dimensions, content_hash, vector
        FROM member_embeddings ORDER BY member_id
      `).all() as LegacyEmbeddingRow[],
      indexState: sqlite.prepare(`
        SELECT generation, last_success_at, embedding_model, dimensions
        FROM member_sync_state ORDER BY provider
      `).all() as LegacyIndexStateRow[],
      requests: sqlite.prepare(`
        SELECT chat_id, tg_message_id, thread_id, author_id, author_username,
          query_hash, status, match_count, response_message_id, error_code,
          started_at, completed_at
        FROM member_requests ORDER BY chat_id, tg_message_id
      `).all() as LegacyRequestRow[],
    };
  } finally {
    sqlite.close();
  }
}

function validateTelegramId(value: number | null, field: string): void {
  if (value !== null && !Number.isSafeInteger(value)) {
    throw new Error(`${field} contains an unsafe Telegram integer`);
  }
}

function decodeEmbedding(row: LegacyEmbeddingRow): number[] {
  if (
    row.dimensions !== VECTOR_DIMENSIONS ||
    !Buffer.isBuffer(row.vector) ||
    row.vector.byteLength !== VECTOR_DIMENSIONS * Float32Array.BYTES_PER_ELEMENT
  ) {
    throw new Error(`invalid embedding for member_id=${row.member_id}`);
  }
  const bytes = Uint8Array.from(row.vector);
  const values = [...new Float32Array(bytes.buffer)];
  if (values.some((value) => !Number.isFinite(value))) {
    throw new Error(`invalid embedding for member_id=${row.member_id}`);
  }
  return values;
}

async function assertApplicationTablesEmpty(client: PoolClient): Promise<void> {
  const result = await client.query<{ count: string }>(`
    SELECT (
      (SELECT COUNT(*) FROM messages) +
      (SELECT COUNT(*) FROM job_state) +
      (SELECT COUNT(*) FROM members) +
      (SELECT COUNT(*) FROM member_embeddings) +
      (SELECT COUNT(*) FROM member_index_state) +
      (SELECT COUNT(*) FROM member_source_state) +
      (SELECT COUNT(*) FROM member_requests)
    )::text AS count
  `);
  if (result.rows[0]?.count !== '0') {
    throw new Error('PostgreSQL application schema must be empty before import');
  }
}

async function insertMessages(client: PoolClient, rows: readonly LegacyMessageRow[]): Promise<void> {
  for (const row of rows) {
    validateTelegramId(row.chat_id, 'messages.chat_id');
    validateTelegramId(row.thread_id, 'messages.thread_id');
    validateTelegramId(row.tg_message_id, 'messages.tg_message_id');
    validateTelegramId(row.author_id, 'messages.author_id');
    validateTelegramId(row.reply_to_message_id, 'messages.reply_to_message_id');
    if (row.is_anonymous !== 0 && row.is_anonymous !== 1) {
      throw new Error('messages.is_anonymous must be 0 or 1');
    }
    await client.query(`
      INSERT INTO messages (
        chat_id, thread_id, tg_message_id, author_id, author_name,
        is_anonymous, text, reply_to_message_id, created_at, edited_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `, [
      row.chat_id,
      row.thread_id,
      row.tg_message_id,
      row.author_id,
      row.author_name,
      row.is_anonymous === 1,
      row.text,
      row.reply_to_message_id,
      row.created_at,
      row.edited_at,
    ]);
  }
}

async function insertJobState(client: PoolClient, rows: readonly LegacyJobStateRow[]): Promise<void> {
  for (const row of rows) {
    await client.query(`
      INSERT INTO job_state(job_name, last_completed_at, last_outcome, item_count)
      VALUES ($1, $2, $3, $4)
    `, [row.job_name, row.last_completed_at, row.last_outcome, row.item_count]);
  }
}

async function insertMembers(client: PoolClient, rows: readonly LegacyMemberRow[]): Promise<void> {
  for (const row of rows) {
    if (row.active !== 0 && row.active !== 1) {
      throw new Error('members.active must be 0 or 1');
    }
    await client.query(`
      INSERT INTO members (
        member_id, source, external_id, telegram_user_id, display_name,
        telegram_username, profile_text, content_hash, source_updated_at, active, updated_at
      ) VALUES ($1, $2, $3, NULL, $4, $5, $6, $7, $8, $9, $10)
    `, [
      row.member_id,
      row.source,
      row.external_id,
      row.display_name,
      row.telegram_username,
      row.profile_text,
      row.content_hash,
      row.source_updated_at,
      row.active === 1,
      row.updated_at,
    ]);
  }
}

async function insertEmbeddings(
  client: PoolClient,
  rows: readonly LegacyEmbeddingRow[],
  members: readonly LegacyMemberRow[],
): Promise<void> {
  const updatedAtByMember = new Map(members.map((member) => [member.member_id, member.updated_at]));
  for (const row of rows) {
    const values = decodeEmbedding(row);
    const updatedAt = updatedAtByMember.get(row.member_id);
    if (!updatedAt) throw new Error(`embedding references unknown member_id=${row.member_id}`);
    await client.query(`
      INSERT INTO member_embeddings (
        member_id, model, dimensions, content_hash, embedding, updated_at
      ) VALUES ($1, $2, $3, $4, $5::vector, $6)
    `, [
      row.member_id,
      row.model,
      row.dimensions,
      row.content_hash,
      toSql(values),
      updatedAt,
    ]);
  }
}

async function insertIndexState(
  client: PoolClient,
  rows: readonly LegacyIndexStateRow[],
): Promise<void> {
  if (rows.length > 1) throw new Error('multiple legacy member index states are unsupported');
  const row = rows[0];
  if (!row) return;
  if (row.dimensions !== VECTOR_DIMENSIONS) {
    throw new Error('invalid member index embedding dimensions');
  }
  const counts = await client.query<{ active_count: number; pending_count: number }>(`
    SELECT
      COUNT(*) FILTER (WHERE m.active)::integer AS active_count,
      COUNT(*) FILTER (WHERE m.active AND (
        e.member_id IS NULL OR e.model <> $1 OR
        e.content_hash <> m.content_hash OR e.dimensions <> $2
      ))::integer AS pending_count
    FROM members AS m
    LEFT JOIN member_embeddings AS e ON e.member_id = m.member_id
  `, [row.embedding_model, VECTOR_DIMENSIONS]);
  await client.query(`
    INSERT INTO member_index_state (
      provider, generation, last_success_at, embedding_model,
      dimensions, active_count, pending_count
    ) VALUES ('postgres', $1, $2, $3, $4, $5, $6)
  `, [
    row.generation,
    row.last_success_at,
    row.embedding_model,
    VECTOR_DIMENSIONS,
    counts.rows[0]?.active_count ?? 0,
    counts.rows[0]?.pending_count ?? 0,
  ]);
}

async function insertRequests(client: PoolClient, rows: readonly LegacyRequestRow[]): Promise<void> {
  for (const row of rows) {
    validateTelegramId(row.chat_id, 'member_requests.chat_id');
    validateTelegramId(row.tg_message_id, 'member_requests.tg_message_id');
    validateTelegramId(row.thread_id, 'member_requests.thread_id');
    validateTelegramId(row.author_id, 'member_requests.author_id');
    validateTelegramId(row.response_message_id, 'member_requests.response_message_id');
    await client.query(`
      INSERT INTO member_requests (
        chat_id, tg_message_id, thread_id, author_id, author_username,
        query_hash, status, match_count, response_message_id, error_code,
        started_at, completed_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    `, [
      row.chat_id,
      row.tg_message_id,
      row.thread_id,
      row.author_id,
      row.author_username,
      row.query_hash,
      row.status,
      row.match_count,
      row.response_message_id,
      row.error_code,
      row.started_at,
      row.completed_at,
    ]);
  }
}

async function verifyImportedCounts(
  client: PoolClient,
  snapshot: LegacySnapshot,
): Promise<void> {
  const result = await client.query<{
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
  const actual = result.rows[0];
  if (
    !actual ||
    actual.messages !== snapshot.messages.length ||
    actual.job_state !== snapshot.jobState.length ||
    actual.members !== snapshot.members.length ||
    actual.embeddings !== snapshot.embeddings.length ||
    actual.index_state !== snapshot.indexState.length ||
    actual.requests !== snapshot.requests.length
  ) {
    throw new Error('SQLite import row-count validation failed');
  }
}

export async function importSqlite(path: string, pool: Pool): Promise<ImportReport> {
  const snapshot = readLegacySnapshot(path);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [IMPORT_LOCK_ID]);
    await assertApplicationTablesEmpty(client);
    await insertMessages(client, snapshot.messages);
    await insertJobState(client, snapshot.jobState);
    await insertMembers(client, snapshot.members);
    await insertEmbeddings(client, snapshot.embeddings, snapshot.members);
    await insertIndexState(client, snapshot.indexState);
    await insertRequests(client, snapshot.requests);
    await verifyImportedCounts(client, snapshot);
    await client.query('COMMIT');
  } catch (error: unknown) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return {
    messages: snapshot.messages.length,
    jobState: snapshot.jobState.length,
    members: snapshot.members.length,
    embeddings: snapshot.embeddings.length,
    indexState: snapshot.indexState.length,
    requests: snapshot.requests.length,
  };
}

async function runImportCli(): Promise<void> {
  const path = process.argv[2];
  if (!path || !isAbsolute(path)) {
    throw new Error('Pass an absolute SQLite file path');
  }
  const database = readDatabaseConfig(process.env);
  const migrationPool = createPool(database);
  try {
    await runMigrations(migrationPool);
  } finally {
    await migrationPool.end();
  }
  const pool = createPool(database);
  try {
    const report = await importSqlite(path, pool);
    logger.info({ event: 'sqlite-import', ...report }, 'SQLite import complete');
  } finally {
    await pool.end();
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  void runImportCli().catch((error: unknown) => {
    logger.fatal(
      { errorClass: error instanceof Error ? error.name : 'unknown' },
      'SQLite import failed',
    );
    process.exitCode = 1;
  });
}
