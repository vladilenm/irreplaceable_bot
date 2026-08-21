import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { runMigrations } from './db/migrations.js';
import { MemberDirectoryService } from './member-directory.service.js';
import { seedMockMembers } from './member.seed.js';
import { PgMemberRepository } from './members.repository.js';
import { createTestPool, resetPostgres } from './test/postgres.js';

const pool = createTestPool();
const repository = new PgMemberRepository(pool);
const vector = Array.from({ length: 1536 }, (_, index) => index === 0 ? 1 : 0);
const embeddings = {
  model: 'text-embedding-3-small',
  embed: vi.fn(async (texts: readonly string[]) => texts.map(() => vector)),
};
const service = new MemberDirectoryService({
  repository,
  embeddings,
  now: () => new Date('2026-08-21T10:01:00Z'),
});

beforeEach(async () => {
  embeddings.embed.mockClear();
  await resetPostgres(pool);
  await runMigrations(pool);
});

afterAll(async () => {
  await pool.end();
});

it('seeds exactly 20 deterministic mock members twice without duplicates', async () => {
  await expect(seedMockMembers(service, { NODE_ENV: 'development' })).resolves.toEqual({
    upserted: 20,
    indexed: 20,
  });
  await expect(seedMockMembers(service, { NODE_ENV: 'development' })).resolves.toEqual({
    upserted: 20,
    indexed: 0,
  });

  await expect(repository.countBySource('mock')).resolves.toBe(20);
  const rows = await pool.query<{
    external_id: string;
    telegram_username: string;
    active: boolean;
  }>(`
    SELECT external_id, telegram_username, active
    FROM members WHERE source = 'mock' ORDER BY external_id
  `);
  expect(rows.rows[0]).toEqual({
    external_id: 'mock-01',
    telegram_username: 'club_demo_member_01',
    active: true,
  });
  expect(rows.rows[19]).toMatchObject({ external_id: 'mock-20', active: true });
});

it('blocks production seed without the explicit guard', async () => {
  await expect(seedMockMembers(service, { NODE_ENV: 'production' }))
    .rejects.toThrow('ALLOW_MOCK_MEMBER_SEED=true is required');
  await expect(repository.countBySource('mock')).resolves.toBe(0);
});
