import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb, _resetForTests } from '../services/db.service.js';
import {
  upsertMessage,
  selectMessagesInWindow,
  selectTopParticipants,
  _resetMessageStoreForTests,
} from './message-store.js';
import type { CapturedMessage } from '../types/index.js';

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
  getDb().exec('DELETE FROM messages; DELETE FROM tracked_threads;');
});

describe('selectMessagesInWindow (W1, W2)', () => {
  it('W1: returns only in-window rows ordered ASC', () => {
    upsertMessage(baseMsg({ id: 1, createdAt: '2026-04-29T08:00:00.000Z' })); // before
    upsertMessage(baseMsg({ id: 2, createdAt: '2026-04-29T09:30:00.000Z' })); // before
    upsertMessage(baseMsg({ id: 3, createdAt: '2026-04-29T10:30:00.000Z' })); // in
    upsertMessage(baseMsg({ id: 4, createdAt: '2026-04-29T11:00:00.000Z' })); // in
    upsertMessage(baseMsg({ id: 5, createdAt: '2026-04-29T11:30:00.000Z' })); // in
    const got = selectMessagesInWindow(100, '2026-04-29T10:00:00.000Z');
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
    const got = selectMessagesInWindow(100, '2026-04-29T10:00:00.000Z');
    expect(got).toHaveLength(1);
    expect(got[0]?.tgMessageId).toBe(11);
  });
});

describe('selectTopParticipants (P1, P2, P3)', () => {
  it('P1: top-3 by count DESC', () => {
    // 5 messages by author 100, 3 by 200, 3 by 300, 1 by 400
    for (let i = 0; i < 5; i++)
      upsertMessage(baseMsg({ id: 100 + i, authorId: 100, authorName: 'A' }));
    for (let i = 0; i < 3; i++)
      upsertMessage(baseMsg({ id: 200 + i, authorId: 200, authorName: 'B' }));
    for (let i = 0; i < 3; i++)
      upsertMessage(baseMsg({ id: 300 + i, authorId: 300, authorName: 'C' }));
    upsertMessage(baseMsg({ id: 400, authorId: 400, authorName: 'D' }));
    const got = selectTopParticipants(100, '2026-04-29T10:00:00.000Z', 3);
    expect(got).toHaveLength(3);
    expect(got[0]?.messageCount).toBe(5);
    expect(got[1]?.messageCount).toBe(3);
    expect(got[2]?.messageCount).toBe(3);
  });

  it('P2: anon admins (author_id=NULL) do not merge across distinct tg_message_ids', () => {
    upsertMessage(
      baseMsg({ id: 500, authorId: null, isAnonymous: 1, authorName: 'AnonA' }),
    );
    upsertMessage(
      baseMsg({ id: 501, authorId: null, isAnonymous: 1, authorName: 'AnonB' }),
    );
    const got = selectTopParticipants(100, '2026-04-29T10:00:00.000Z', 3);
    // Two separate anon channels — both appear with count 1 each
    expect(got).toHaveLength(2);
    expect(new Set(got.map((p) => p.authorName))).toEqual(
      new Set(['AnonA', 'AnonB']),
    );
  });

  it('P3: latest author_name used per group (rename mid-window)', () => {
    upsertMessage(
      baseMsg({
        id: 600,
        authorId: 600,
        authorName: 'OldName',
        createdAt: '2026-04-29T10:30:00.000Z',
      }),
    );
    upsertMessage(
      baseMsg({
        id: 601,
        authorId: 600,
        authorName: 'NewName',
        createdAt: '2026-04-29T11:30:00.000Z',
      }),
    );
    upsertMessage(
      baseMsg({
        id: 602,
        authorId: 600,
        authorName: 'NewName',
        createdAt: '2026-04-29T12:00:00.000Z',
      }),
    );
    const got = selectTopParticipants(100, '2026-04-29T10:00:00.000Z', 3);
    expect(got).toHaveLength(1);
    expect(got[0]?.authorName).toBe('NewName');
    expect(got[0]?.messageCount).toBe(3);
  });
});
