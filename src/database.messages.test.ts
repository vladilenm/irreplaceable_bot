import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb, _resetForTests } from './database.js';
import {
  upsertMessage,
  selectMessagesInWindow,
  _resetMessageStoreForTests,
} from './database.js';
import type { CapturedMessage } from './types.js';

const baseMsg = (
  over: Partial<CapturedMessage> & { id: number },
): CapturedMessage => ({
  chatId: -1001,
  threadId: 100,
  tgMessageId: over.id,
  authorId: 100,
  authorName: 'Маша',
  isAnonymous: 0,
  text: 'hi',
  replyToMessageId: null,
  createdAt: '2026-04-29T11:00:00.000Z',
  editedAt: null,
  ...over,
});

beforeEach(() => {
  _resetForTests();
  _resetMessageStoreForTests();
  initDb();
  getDb().exec('DELETE FROM messages;');
});

describe('selectMessagesInWindow (W1, W2)', () => {
  it('W1: returns only in-window rows ordered ASC', () => {
    upsertMessage(baseMsg({ id: 1, createdAt: '2026-04-29T08:00:00.000Z' })); // before
    upsertMessage(baseMsg({ id: 2, createdAt: '2026-04-29T09:30:00.000Z' })); // before
    upsertMessage(baseMsg({ id: 3, createdAt: '2026-04-29T10:30:00.000Z' })); // in
    upsertMessage(baseMsg({ id: 4, createdAt: '2026-04-29T11:00:00.000Z' })); // in
    upsertMessage(baseMsg({ id: 5, createdAt: '2026-04-29T11:30:00.000Z' })); // in
    const got = selectMessagesInWindow(-1001, 100, '2026-04-29T10:00:00.000Z');
    expect(got).toHaveLength(3);
    expect(got.map((m) => m.tgMessageId)).toEqual([3, 4, 5]);
  });

  it('W2: filters by threadId — other threads excluded', () => {
    upsertMessage(
      baseMsg({ id: 10, threadId: 200, createdAt: '2026-04-29T11:00:00.000Z' }),
    );
    upsertMessage(
      baseMsg({ id: 11, threadId: 100, createdAt: '2026-04-29T11:00:00.000Z' }),
    );
    const got = selectMessagesInWindow(-1001, 100, '2026-04-29T10:00:00.000Z');
    expect(got).toHaveLength(1);
    expect(got[0]?.tgMessageId).toBe(11);
  });

  it('W3: does not mix matching thread ids from different chats', () => {
    upsertMessage(
      baseMsg({ id: 20, chatId: -1001, threadId: 100 }),
    );
    upsertMessage(
      baseMsg({ id: 21, chatId: -2002, threadId: 100 }),
    );

    const got = selectMessagesInWindow(-1001, 100, '2026-04-29T10:00:00.000Z');

    expect(got.map((m) => m.tgMessageId)).toEqual([20]);
  });
});
