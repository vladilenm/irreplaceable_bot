import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestPool, resetPostgres } from '../test/postgres.js';
import { POSTGRES_MIGRATIONS, runMigrations } from './migrations.js';

const pool = createTestPool();

beforeEach(async () => {
  await resetPostgres(pool);
});

afterAll(async () => {
  await pool.end();
});

describe('runMigrations', () => {
  it('creates pgvector and the complete schema exactly once', async () => {
    const first = await runMigrations(pool);
    const second = await runMigrations(pool);

    expect(first).toBe(POSTGRES_MIGRATIONS.length);
    expect(second).toBe(0);

    const tables = await pool.query<{ table_name: string }>(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      'job_state',
      'member_embeddings',
      'member_index_state',
      'member_requests',
      'member_source_state',
      'members',
      'messages',
      'scheduled_publication_chunks',
      'scheduled_publications',
      'schema_migrations',
    ]);

    const extension = await pool.query<{ extname: string }>(
      "SELECT extname FROM pg_extension WHERE extname = 'vector'",
    );
    expect(extension.rows).toEqual([{ extname: 'vector' }]);
  });

  it('serializes concurrent migration runners with an advisory lock', async () => {
    const secondPool = createTestPool();
    try {
      const results = await Promise.all([
        runMigrations(pool),
        runMigrations(secondPool),
      ]);
      expect(results.reduce((sum, value) => sum + value, 0))
        .toBe(POSTGRES_MIGRATIONS.length);
    } finally {
      await secondPool.end();
    }
  });

  it('rolls back a failed migration without recording its version', async () => {
    await runMigrations(pool);
    const invalid = [
      ...POSTGRES_MIGRATIONS,
      {
        version: 999,
        description: 'invalid migration for rollback contract',
        sql: 'CREATE TABLE migration_probe(id integer); SELECT missing_column;',
      },
    ];

    await expect(runMigrations(pool, invalid)).rejects.toThrow();

    const recorded = await pool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM schema_migrations WHERE version = 999',
    );
    expect(recorded.rows[0]?.count).toBe('0');
    const probe = await pool.query<{ present: string | null }>(
      "SELECT to_regclass('public.migration_probe')::text AS present",
    );
    expect(probe.rows[0]?.present).toBeNull();
  });

  it('adds stable Telegram identity and source snapshot state', async () => {
    await runMigrations(pool);

    const columns = await pool.query<{ column_name: string; is_nullable: string }>(`
      SELECT column_name, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'members'
        AND column_name = 'telegram_user_id'
    `);
    expect(columns.rows).toEqual([
      { column_name: 'telegram_user_id', is_nullable: 'YES' },
    ]);

    const index = await pool.query<{ indexname: string }>(`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname = 'idx_members_telegram_user_id_uidx'
    `);
    expect(index.rows).toEqual([
      { indexname: 'idx_members_telegram_user_id_uidx' },
    ]);

    const sourceState = await pool.query<{ present: string | null }>(
      "SELECT to_regclass('public.member_source_state')::text AS present",
    );
    expect(sourceState.rows[0]?.present).toBe('member_source_state');
  });

  it('adds idempotent Rich Message origin metadata while preserving existing rows', async () => {
    await runMigrations(pool, POSTGRES_MIGRATIONS.slice(0, 3));
    await pool.query(`
      INSERT INTO scheduled_publications (
        pipeline, publication_date, target_chat_id, thread_id, item_count, status,
        next_attempt_at, expires_at
      ) VALUES (
        'thread-summary', '2030-08-23', -100123, 77, 0, 'ready',
        '2030-08-23T06:00:00.000Z', '2030-08-23T21:00:00.000Z'
      )
    `);

    expect(await runMigrations(pool)).toBe(1);
    expect(await runMigrations(pool)).toBe(0);

    const existing = await pool.query<{
      message_format: string;
      origin_digest_id: string | null;
    }>(`
      SELECT message_format, origin_digest_id
      FROM scheduled_publications
      WHERE pipeline = 'thread-summary'
    `);
    expect(existing.rows).toEqual([{
      message_format: 'regular-html',
      origin_digest_id: null,
    }]);

    await expect(pool.query(`
      INSERT INTO scheduled_publications (
        pipeline, publication_date, target_chat_id, thread_id, item_count, status,
        next_attempt_at, expires_at, message_format
      ) VALUES (
        'digest', '2030-08-24', -100123, 77, 1, 'ready',
        '2030-08-24T06:00:00.000Z', '2030-08-24T21:00:00.000Z', 'markdown'
      )
    `)).rejects.toThrow();
  });
});
