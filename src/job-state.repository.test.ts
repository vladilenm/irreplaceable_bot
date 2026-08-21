import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from './db/migrations.js';
import { createTestPool, resetPostgres } from './test/postgres.js';
import { PgJobStateRepository } from './job-state.repository.js';

const pool = createTestPool();
const repo = new PgJobStateRepository(pool);

beforeEach(async () => {
  await resetPostgres(pool);
  await runMigrations(pool);
});

afterAll(async () => {
  await pool.end();
});

describe('PgJobStateRepository', () => {
  it('returns empty pipeline state before the first run', async () => {
    await expect(repo.read()).resolves.toEqual({
      lastDigestDate: null,
      lastSkipped: false,
      lastItemCount: 0,
      lastThreadSummaryDate: null,
    });
  });

  it('keeps digest and thread-summary state independently', async () => {
    await repo.recordThreadSummary(new Date('2026-08-20T03:30:00Z'));
    await repo.recordDigest(new Date('2026-08-21T06:00:00Z'), true, 0);

    await expect(repo.read()).resolves.toEqual({
      lastDigestDate: '2026-08-21T06:00:00.000Z',
      lastSkipped: true,
      lastItemCount: 0,
      lastThreadSummaryDate: '2026-08-20T03:30:00.000Z',
    });
  });

  it('upserts later digest outcomes without duplicating job rows', async () => {
    await repo.recordDigest(new Date('2026-08-20T06:00:00Z'), false, 4);
    await repo.recordDigest(new Date('2026-08-21T06:00:00Z'), true, 0);

    const count = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM job_state WHERE job_name = 'digest'",
    );
    expect(count.rows[0]?.count).toBe('1');
    await expect(repo.read()).resolves.toMatchObject({
      lastDigestDate: '2026-08-21T06:00:00.000Z',
      lastSkipped: true,
      lastItemCount: 0,
    });
  });
});
