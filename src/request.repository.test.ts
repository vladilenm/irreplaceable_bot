import { afterAll, beforeEach, expect, it } from 'vitest';
import { runMigrations } from './db/migrations.js';
import { PgRequestRepository } from './request.repository.js';
import { createTestPool, resetPostgres } from './test/postgres.js';

const pool = createTestPool();
const repo = new PgRequestRepository(pool);

beforeEach(async () => {
  await resetPostgres(pool);
  await runMigrations(pool);
});

afterAll(async () => {
  await pool.end();
});

const input = {
  chatId: -1001,
  messageId: 77,
  threadId: 10,
  authorId: 5,
  authorUsername: 'author',
  queryHash: 'hash',
  startedAt: '2026-08-21T10:00:00.000Z',
};

it('reserves a Telegram message once', async () => {
  await expect(repo.reserve(input)).resolves.toBe(true);
  await expect(repo.reserve(input)).resolves.toBe(false);
});

it('records completion and protects terminal states', async () => {
  await repo.reserve(input);

  await repo.complete(-1001, 77, {
    responseMessageId: 88,
    matchCount: 3,
    completedAt: '2026-08-21T10:00:02.000Z',
  });
  await repo.fail(-1001, 77, 'late-error', '2026-08-21T10:00:03.000Z');

  await expect(repo.read(-1001, 77)).resolves.toEqual({
    status: 'completed',
    matchCount: 3,
    responseMessageId: 88,
    errorCode: null,
  });
});

it('records a no-match response and fails stale processing rows only', async () => {
  await repo.reserve(input);
  await repo.noMatch(-1001, 77, {
    responseMessageId: 88,
    completedAt: '2026-08-21T10:00:02.000Z',
  });
  await expect(repo.read(-1001, 77)).resolves.toMatchObject({
    status: 'no_match',
    matchCount: 0,
  });

  await expect(repo.reserve({ ...input, messageId: 78 })).resolves.toBe(true);
  await expect(repo.failStale('2026-08-21T10:10:00.000Z')).resolves.toBe(1);
  await expect(repo.read(-1001, 78)).resolves.toMatchObject({
    status: 'failed',
    errorCode: 'processing-timeout',
  });
});

it('returns null for an unknown Telegram message', async () => {
  await expect(repo.read(-1001, 404)).resolves.toBeNull();
});
