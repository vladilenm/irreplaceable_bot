import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from './db/migrations.js';
import {
  PgMemberRepository,
  type MemberSourceStatus,
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
  telegramUserId: null,
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

  it('persists Telegram IDs as decimal strings', async () => {
    await repo.upsertCards([member('web-01', 'Product', {
      source: 'web',
      telegramUserId: '94659185',
    })]);

    await expect(repo.readPending(MODEL, 100)).resolves.toEqual([
      expect.objectContaining({
        source: 'web',
        externalId: 'web-01',
        telegramUserId: '94659185',
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

describe('PgMemberRepository web source snapshots', () => {
  it('atomically replaces a complete web snapshot', async () => {
    const first = [
      member('1001', 'Имя: Первый', {
        source: 'web',
        telegramUserId: '1001',
        telegramUsername: 'first_user',
      }),
      member('1002', 'Имя: Второй', {
        source: 'web',
        telegramUserId: '1002',
        telegramUsername: 'second_user',
      }),
    ];
    await repo.replaceSourceSnapshot({
      source: 'web',
      records: first,
      fetchedCount: 2,
      rejectedCount: 0,
      completedAt: new Date('2026-08-26T10:00:00.000Z'),
    });

    const status = await repo.replaceSourceSnapshot({
      source: 'web',
      records: [first[0]!],
      fetchedCount: 1,
      rejectedCount: 0,
      completedAt: new Date('2026-08-26T10:05:00.000Z'),
    });
    expect(status).toMatchObject({
      generation: 2,
      fetchedCount: 1,
      activeCount: 1,
      rejectedCount: 0,
      deactivatedCount: 1,
    });
    expect(await repo.readSourceStatus('web')).toEqual(status);
  });

  it('accepts a successful empty snapshot', async () => {
    await repo.replaceSourceSnapshot({
      source: 'web',
      records: [member('1001', 'Имя: Первый', {
        source: 'web', telegramUserId: '1001', telegramUsername: 'first_user',
      })],
      fetchedCount: 1,
      rejectedCount: 0,
      completedAt: new Date('2026-08-26T10:00:00.000Z'),
    });
    const status = await repo.replaceSourceSnapshot({
      source: 'web',
      records: [],
      fetchedCount: 0,
      rejectedCount: 0,
      completedAt: new Date('2026-08-26T10:05:00.000Z'),
    });
    expect(status).toMatchObject({ activeCount: 0, deactivatedCount: 1 });
  });

  it('rolls back cards and source state when a snapshot has duplicate Telegram IDs', async () => {
    const completedAt = new Date('2026-08-26T10:00:00.000Z');
    const status = await repo.replaceSourceSnapshot({
      source: 'web',
      records: [
        member('1001', 'Имя: Первый', {
          source: 'web', telegramUserId: '1001', telegramUsername: 'first_user',
        }),
        member('1002', 'Имя: Второй', {
          source: 'web', telegramUserId: '1002', telegramUsername: 'second_user',
        }),
      ],
      fetchedCount: 2,
      rejectedCount: 0,
      completedAt,
    });
    const beforeRows = await pool.query<{
      member_id: string;
      active: boolean;
      telegram_user_id: string | null;
    }>(`
      SELECT member_id, active, telegram_user_id
      FROM members
      WHERE source = 'web'
      ORDER BY member_id
    `);
    const beforeStatus: MemberSourceStatus | null = await repo.readSourceStatus('web');

    await expect(repo.replaceSourceSnapshot({
      source: 'web',
      records: [
        member('1003', 'Имя: Третий', {
          source: 'web', telegramUserId: '1003', telegramUsername: 'third_user',
        }),
        member('1004', 'Имя: Четвёртый', {
          source: 'web', telegramUserId: '1003', telegramUsername: 'fourth_user',
        }),
      ],
      fetchedCount: 2,
      rejectedCount: 0,
      completedAt: new Date('2026-08-26T10:05:00.000Z'),
    })).rejects.toThrow('duplicate-web-snapshot-record');

    await expect(pool.query(`
      SELECT member_id, active, telegram_user_id
      FROM members
      WHERE source = 'web'
      ORDER BY member_id
    `)).resolves.toMatchObject({ rows: beforeRows.rows });
    await expect(repo.readSourceStatus('web')).resolves.toEqual(beforeStatus);
    expect(status).toEqual(beforeStatus);
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

  it('excludes a web requester by Telegram ID after their username changes', async () => {
    const requester = member('1001', 'requester', {
      source: 'web',
      telegramUserId: '1001',
      telegramUsername: 'renamed_username',
    });
    const other = member('1002', 'other', {
      source: 'web',
      telegramUserId: '1002',
      telegramUsername: 'other_user',
    });
    await repo.upsertCards([requester, other]);
    await repo.upsertEmbedding('web:1001', MODEL, memberContentHash(requester), vector({ 0: 1 }));
    await repo.upsertEmbedding('web:1002', MODEL, memberContentHash(other), vector({ 0: 0.9, 1: 0.1 }));

    const rows = await repo.search(vector({ 0: 1 }), MODEL, 20, '1001');
    expect(rows.map((row) => row.member.memberId)).toEqual(['web:1002']);
  });

  it('rejects malformed requester Telegram IDs', async () => {
    await expect(repo.search(vector({ 0: 1 }), MODEL, 20, '0'))
      .rejects.toThrow('requester Telegram user ID must be a positive decimal string');
    await expect(repo.search(vector({ 0: 1 }), MODEL, 20, '001'))
      .rejects.toThrow('requester Telegram user ID must be a positive decimal string');
    await expect(repo.search(vector({ 0: 1 }), MODEL, 20, '123abc'))
      .rejects.toThrow('requester Telegram user ID must be a positive decimal string');
    await expect(repo.search(vector({ 0: 1 }), MODEL, 20, '9223372036854775808'))
      .rejects.toThrow('requester Telegram user ID must be a positive decimal string');
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
