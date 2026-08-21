import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from './db/migrations.js';
import { logger } from './logger.js';
import { PgMessageRepository } from './messages.repository.js';
import { createTestPool, resetPostgres } from './test/postgres.js';
import type { CapturedMessage } from './types.js';

const pool = createTestPool();
const repo = new PgMessageRepository(pool);

const message = (
  overrides: Partial<CapturedMessage> & { tgMessageId: number },
): CapturedMessage => {
  const { tgMessageId, ...optionalOverrides } = overrides;
  return {
    chatId: -1001,
    threadId: 100,
    tgMessageId,
    authorId: 100,
    authorName: 'Маша',
    isAnonymous: 0,
    text: 'hi',
    replyToMessageId: null,
    createdAt: '2026-08-21T11:00:00.000Z',
    editedAt: null,
    ...optionalOverrides,
  };
};

beforeEach(async () => {
  vi.restoreAllMocks();
  await resetPostgres(pool);
  await runMigrations(pool);
});

afterAll(async () => {
  await pool.end();
});

describe('PgMessageRepository', () => {
  it('returns only the requested chat, thread, and time window in ascending order', async () => {
    await repo.upsert(message({ tgMessageId: 1, createdAt: '2026-08-21T09:00:00Z' }));
    await repo.upsert(message({ tgMessageId: 2, createdAt: '2026-08-21T10:30:00Z' }));
    await repo.upsert(message({ tgMessageId: 3, createdAt: '2026-08-21T11:30:00Z' }));
    await repo.upsert(message({ tgMessageId: 4, chatId: -2002 }));
    await repo.upsert(message({ tgMessageId: 5, threadId: 200 }));

    const rows = await repo.selectWindow(-1001, 100, '2026-08-21T10:00:00Z');

    expect(rows.map((row) => row.tgMessageId)).toEqual([2, 3]);
  });

  it('updates editable fields without duplicating a Telegram message', async () => {
    await repo.upsert(message({ tgMessageId: 42, text: 'before' }));
    await repo.upsert(message({
      tgMessageId: 42,
      authorName: 'Мария',
      text: 'after',
      editedAt: '2026-08-21T12:00:00Z',
    }));

    const rows = await repo.selectWindow(-1001, 100, '2026-08-21T00:00:00Z');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      authorName: 'Мария',
      text: 'after',
      editedAt: '2026-08-21T12:00:00.000Z',
    });
  });

  it('maps anonymous flags and nullable Telegram fields', async () => {
    await repo.upsert(message({
      tgMessageId: 7,
      authorId: null,
      isAnonymous: 1,
      replyToMessageId: 6,
    }));
    const rows = await repo.selectWindow(-1001, 100, '2026-08-21T00:00:00Z');
    expect(rows[0]).toMatchObject({ authorId: null, isAnonymous: 1, replyToMessageId: 6 });
  });

  it('deletes old messages in bounded batches and logs counts only', async () => {
    await pool.query(`
      INSERT INTO messages (
        chat_id, thread_id, tg_message_id, author_name, is_anonymous,
        text, created_at
      )
      SELECT -1001, 100, value, 'test', false, 'old', '2020-01-01T00:00:00Z'
      FROM generate_series(1, 2500) AS value
    `);
    await repo.upsert(message({ tgMessageId: 3000, createdAt: new Date().toISOString() }));
    const info = vi.spyOn(logger, 'info');

    const result = await repo.runRetention(90);

    expect(result.rowsDeleted).toBe(2500);
    const count = await pool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM messages',
    );
    expect(count.rows[0]?.count).toBe('1');
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'retention-sweep', rows_deleted: 2500 }),
      'Retention sweep complete',
    );
  });

  it('returns zero from retention on an empty table', async () => {
    await expect(repo.runRetention(90)).resolves.toMatchObject({ rowsDeleted: 0 });
  });

  it('rejects bigint values that cannot be represented safely by Telegram number APIs', async () => {
    await pool.query(`
      INSERT INTO messages (
        chat_id, thread_id, tg_message_id, author_name, is_anonymous,
        text, created_at
      ) VALUES (-1001, 100, 9007199254740992, 'test', false, 'unsafe', now())
    `);
    await expect(repo.selectWindow(-1001, 100, '2020-01-01T00:00:00Z'))
      .rejects.toThrow('unsafe Telegram bigint');
  });
});
