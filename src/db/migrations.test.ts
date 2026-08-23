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
});
