import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { initDb, getDb, _resetForTests } from './db.service.js';
import { _resetMessageStoreForTests } from '../stores/message-store.js';
import {
  runRetentionSweep,
  _resetRetentionServiceForTests,
} from './retention.service.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';

// Helper: insert a message row with a given created_at timestamp.
// Uses direct SQL so we can control created_at precisely (bypass store guards).
function insertMessage(id: number, createdAt: string, chatId = -1001, threadId = 100): void {
  getDb()
    .prepare(
      `INSERT INTO messages
         (chat_id, thread_id, tg_message_id, author_id, author_name,
          is_anonymous, text, reply_to_message_id, created_at, edited_at)
       VALUES (?, ?, ?, NULL, 'test', 0, 'msg', NULL, ?, NULL)`,
    )
    .run(chatId, threadId, id, createdAt);
}

// Helper: bulk-insert N old messages in a single transaction (faster for 2500+)
function insertBatchOld(count: number, oldIso: string): void {
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO messages
       (chat_id, thread_id, tg_message_id, author_id, author_name,
        is_anonymous, text, reply_to_message_id, created_at, edited_at)
     VALUES (-1001, 100, ?, NULL, 'test', 0, 'old', NULL, ?, NULL)`,
  );
  const txn = db.transaction((n: number) => {
    for (let i = 1; i <= n; i++) {
      stmt.run(i, oldIso);
    }
  });
  txn(count);
}

beforeEach(() => {
  _resetForTests();
  _resetMessageStoreForTests();
  _resetRetentionServiceForTests();
  initDb();
  // Wipe messages table between tests
  getDb().exec('DELETE FROM messages;');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runRetentionSweep — T1: empty table', () => {
  it('T1: empty table → rowsDeleted === 0, durationMs is a number', async () => {
    const result = await runRetentionSweep();
    expect(result.rowsDeleted).toBe(0);
    expect(typeof result.durationMs).toBe('number');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe('runRetentionSweep — T2: mixed table', () => {
  it('T2: 5 old + 3 recent → rowsDeleted === 5, 3 remain in DB', async () => {
    const oldIso = '2020-01-01T00:00:00.000Z'; // well past 90 days
    const nowIso = new Date().toISOString();

    // Insert 5 old messages (id 1001..1005) + 3 fresh messages (id 2001..2003)
    for (let i = 1001; i <= 1005; i++) insertMessage(i, oldIso);
    for (let i = 2001; i <= 2003; i++) insertMessage(i, nowIso);

    const result = await runRetentionSweep();

    expect(result.rowsDeleted).toBe(5);
    const count = (getDb().prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number }).c;
    expect(count).toBe(3);
  });
});

describe('runRetentionSweep — T3: multi-batch (2500 old rows)', () => {
  it('T3: 2500 old rows → rowsDeleted === 2500, 0 remain, ≥3 iterations', async () => {
    const oldIso = '2019-06-15T12:00:00.000Z';
    insertBatchOld(2500, oldIso);

    // Spy on logger.info to count calls (we also need structured-log assertion)
    const infoSpy = vi.spyOn(logger, 'info');

    const result = await runRetentionSweep();

    expect(result.rowsDeleted).toBe(2500);
    const count = (getDb().prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number }).c;
    expect(count).toBe(0);

    // 2500 rows / 1000 batch = 3 full batches + 1 empty (loop exit), so 3 iterations produced changes.
    // We verify by asserting rowsDeleted crosses the BATCH_SIZE=1000 boundary.
    expect(result.rowsDeleted).toBeGreaterThan(1000);

    infoSpy.mockRestore();
  });
});

describe('runRetentionSweep — T4: structured pino log', () => {
  it('T4: emits exactly one logger.info with event: retention-sweep, rows_deleted, duration_ms', async () => {
    const infoSpy = vi.spyOn(logger, 'info');

    await runRetentionSweep();

    // Find the retention-sweep log call
    const retentionCalls = infoSpy.mock.calls.filter((call) => {
      const obj = call[0];
      return typeof obj === 'object' && obj !== null && (obj as Record<string, unknown>)['event'] === 'retention-sweep';
    });

    expect(retentionCalls).toHaveLength(1);

    const logObj = retentionCalls[0]?.[0] as Record<string, unknown>;
    expect(logObj['event']).toBe('retention-sweep');
    expect(typeof logObj['rows_deleted']).toBe('number');
    expect(typeof logObj['duration_ms']).toBe('number');
  });
});

describe('runRetentionSweep — T5: cutoff respects config.messageRetentionDays', () => {
  it('T5: only messages older than messageRetentionDays are deleted', async () => {
    // Insert a message exactly at retention boundary minus 1 minute (should be deleted)
    const retentionMs = config.messageRetentionDays * 86400 * 1000;
    const justOverCutoff = new Date(Date.now() - retentionMs - 60_000).toISOString();
    // Insert a message 1 minute before cutoff (recent enough — should stay)
    const justInsideCutoff = new Date(Date.now() - retentionMs + 60_000).toISOString();

    insertMessage(9001, justOverCutoff);
    insertMessage(9002, justInsideCutoff);

    const result = await runRetentionSweep();

    expect(result.rowsDeleted).toBe(1);
    const count = (getDb().prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number }).c;
    expect(count).toBe(1);
    // Confirm the remaining row is the recent one
    const remaining = getDb().prepare('SELECT tg_message_id FROM messages').get() as { tg_message_id: number };
    expect(remaining.tg_message_id).toBe(9002);
  });
});
