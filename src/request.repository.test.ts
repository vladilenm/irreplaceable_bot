import { beforeEach, expect, it } from 'vitest';
import { _resetForTests, getDb, initDb } from './database.js';
import { SqliteRequestRepository } from './request.repository.js';

beforeEach(() => {
  _resetForTests();
  initDb();
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

it('reserves a Telegram message once', () => {
  const repo = new SqliteRequestRepository(getDb());

  expect(repo.reserve(input)).toBe(true);
  expect(repo.reserve(input)).toBe(false);
});

it('records completion and protects terminal states', () => {
  const repo = new SqliteRequestRepository(getDb());
  repo.reserve(input);

  repo.complete(-1001, 77, {
    responseMessageId: 88,
    matchCount: 3,
    completedAt: '2026-08-21T10:00:02.000Z',
  });
  repo.fail(-1001, 77, 'late-error', '2026-08-21T10:00:03.000Z');

  expect(repo.read(-1001, 77)).toMatchObject({ status: 'completed', matchCount: 3 });
});

it('records a no-match response and fails stale processing rows only', () => {
  const repo = new SqliteRequestRepository(getDb());
  repo.reserve(input);
  repo.noMatch(-1001, 77, {
    responseMessageId: 88,
    completedAt: '2026-08-21T10:00:02.000Z',
  });
  expect(repo.read(-1001, 77)).toMatchObject({ status: 'no_match', matchCount: 0 });

  expect(repo.reserve({ ...input, messageId: 78 })).toBe(true);
  expect(repo.failStale('2026-08-21T10:10:00.000Z')).toBe(1);
  expect(repo.read(-1001, 78)?.status).toBe('failed');
});
