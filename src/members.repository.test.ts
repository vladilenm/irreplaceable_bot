import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from './db/migrations.js';
import {
  PgMemberRepository,
  type MemberRepository,
} from './members.repository.js';
import { memberContentHash, type MemberSourceRecord } from './members.js';
import { createTestPool, resetPostgres } from './test/postgres.js';

const DIMENSIONS = 1536;
const MODEL = 'text-embedding-3-small';
const pool = createTestPool();
let repo: MemberRepository;

const vector = (entries: Readonly<Record<number, number>>): number[] => {
  const result = Array.from({ length: DIMENSIONS }, () => 0);
  for (const [index, value] of Object.entries(entries)) {
    result[Number(index)] = value;
  }
  return result;
};

const member = (
  externalId: string,
  profileText: string,
  overrides: Partial<MemberSourceRecord> = {},
): MemberSourceRecord => ({
  source: 'mock',
  externalId,
  displayName: `Участник ${externalId}`,
  telegramUsername: `member_${externalId}`,
  profileText,
  sourceUpdatedAt: '2026-08-21T10:00:00.000Z',
  active: true,
  ...overrides,
});

beforeEach(async () => {
  await resetPostgres(pool);
  await runMigrations(pool);
  repo = new PgMemberRepository(pool);
});

afterAll(async () => {
  await pool.end();
});

describe('PgMemberRepository cards and pending index', () => {
  it('upserts provider-scoped cards idempotently', async () => {
    await expect(repo.upsertCards([member('01', 'Product')])).resolves.toBe(1);
    await expect(repo.upsertCards([member('01', 'Product')])).resolves.toBe(1);

    await expect(repo.countBySource('mock')).resolves.toBe(1);
    await expect(repo.readPending(MODEL, 100)).resolves.toEqual([
      expect.objectContaining({
        source: 'mock',
        externalId: '01',
        telegramUsername: 'member_01',
      }),
    ]);
  });

  it('selects only active cards with missing, stale, wrong-model, or invalid-dimension vectors', async () => {
    const current = member('current', 'current');
    const stale = member('stale', 'before');
    const inactive = member('inactive', 'inactive', { active: false });
    await repo.upsertCards([current, stale, inactive]);
    await repo.upsertEmbedding(
      'mock:current',
      MODEL,
      memberContentHash(current),
      vector({ 0: 1 }),
    );
    await repo.upsertEmbedding(
      'mock:stale',
      MODEL,
      memberContentHash(stale),
      vector({ 1: 1 }),
    );
    await repo.upsertCards([member('stale', 'after')]);

    await expect(repo.readPending(MODEL, 100)).resolves.toEqual([
      expect.objectContaining({ externalId: 'stale', profileText: 'after' }),
    ]);
  });

  it('rejects non-finite or non-1536-dimensional embeddings', async () => {
    const card = member('01', 'Product');
    await repo.upsertCards([card]);

    await expect(repo.upsertEmbedding(
      'mock:01', MODEL, memberContentHash(card), [1, 0],
    )).rejects.toThrow('1536 finite values');
    await expect(repo.search([...vector({ 0: 1 }), Number.NaN], MODEL, 20))
      .rejects.toThrow('1536 finite values');
  });
});

describe('PgMemberRepository exact vector search', () => {
  it('excludes stale vectors and returns deterministic exact cosine order', async () => {
    const alpha = member('alpha', 'alpha');
    const beta = member('beta', 'beta');
    const gamma = member('gamma', 'gamma');
    await repo.upsertCards([alpha, beta, gamma]);
    await repo.upsertEmbedding('mock:alpha', MODEL, memberContentHash(alpha), vector({ 0: 1 }));
    await repo.upsertEmbedding('mock:beta', MODEL, memberContentHash(beta), vector({ 0: 0.8, 1: 0.6 }));
    await repo.upsertEmbedding('mock:gamma', MODEL, memberContentHash(gamma), vector({ 1: 1 }));

    const ranked = await repo.search(vector({ 0: 1 }), MODEL, 20);
    expect(ranked.map((row) => row.member.memberId)).toEqual([
      'mock:alpha',
      'mock:beta',
      'mock:gamma',
    ]);
    expect(ranked.map((row) => row.similarity)).toEqual([
      1,
      expect.closeTo(0.8, 6),
      0,
    ]);

    await repo.upsertCards([member('alpha', 'changed')]);
    const afterEdit = await repo.search(vector({ 0: 1 }), MODEL, 20);
    expect(afterEdit.map((row) => row.member.memberId)).toEqual(['mock:beta', 'mock:gamma']);
  });

  it('excludes the requester case-insensitively and respects limit', async () => {
    const requester = member('requester', 'requester', { telegramUsername: 'The_Requester' });
    const other = member('other', 'other');
    await repo.upsertCards([requester, other]);
    await repo.upsertEmbedding('mock:requester', MODEL, memberContentHash(requester), vector({ 0: 1 }));
    await repo.upsertEmbedding('mock:other', MODEL, memberContentHash(other), vector({ 0: 0.9, 1: 0.1 }));

    const rows = await repo.search(vector({ 0: 1 }), MODEL, 1, 'the_requester');
    expect(rows.map((row) => row.member.memberId)).toEqual(['mock:other']);
  });
});

describe('PgMemberRepository index status', () => {
  it('records generation and committed active/pending counts', async () => {
    const ready = member('ready', 'ready');
    const pending = member('pending', 'pending');
    await repo.upsertCards([ready, pending]);
    await repo.upsertEmbedding('mock:ready', MODEL, memberContentHash(ready), vector({ 0: 1 }));

    await expect(repo.recordIndexStatus(
      'postgres', MODEL, new Date('2026-08-21T10:10:00Z'),
    )).resolves.toEqual({
      provider: 'postgres',
      generation: 1,
      lastSuccessAt: '2026-08-21T10:10:00.000Z',
      embeddingModel: MODEL,
      dimensions: 1536,
      activeCount: 2,
      pendingCount: 1,
    });
    await repo.recordIndexStatus('postgres', MODEL, new Date('2026-08-21T10:20:00Z'));
    await expect(repo.readIndexStatus('postgres')).resolves.toMatchObject({
      generation: 2,
      activeCount: 2,
      pendingCount: 1,
    });
  });
});
