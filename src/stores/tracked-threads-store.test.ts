import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb, _resetForTests } from '../services/db.service.js';
import {
  listTracked,
  upsertThreadTitle,
  _resetTrackedThreadsStoreForTests,
} from './tracked-threads-store.js';

beforeEach(() => {
  _resetForTests();
  _resetTrackedThreadsStoreForTests();
  initDb();
});

describe('migration v2 — tracked_threads.title', () => {
  it('M1: tracked_threads has title TEXT column', () => {
    const cols = getDb()
      .prepare("PRAGMA table_info(tracked_threads)")
      .all() as Array<{ name: string; type: string }>;
    const titleCol = cols.find((c) => c.name === 'title');
    expect(titleCol).toBeDefined();
    expect(titleCol?.type).toBe('TEXT');
  });

  it('M2: schema_migrations contains versions 1 and 2', () => {
    const versions = (
      getDb()
        .prepare('SELECT version FROM schema_migrations ORDER BY version')
        .all() as Array<{ version: number }>
    ).map((r) => r.version);
    expect(versions).toContain(1);
    expect(versions).toContain(2);
  });
});

describe('upsertThreadTitle (U1, U2)', () => {
  it('U1: upserts title for existing thread, overwrites on second call, no-op on missing', () => {
    getDb()
      .prepare(
        'INSERT INTO tracked_threads (thread_id, chat_id, added_by, added_at) VALUES (?, ?, NULL, ?)',
      )
      .run(100, -1001, '2026-04-29T10:00:00.000Z');
    upsertThreadTitle(100, 'Стена результатов');
    expect(listTracked().find((t) => t.threadId === 100)?.title).toBe('Стена результатов');
    upsertThreadTitle(100, 'Renamed');
    expect(listTracked().find((t) => t.threadId === 100)?.title).toBe('Renamed');
    // No-op for missing thread:
    expect(() => upsertThreadTitle(999, 'NoSuch')).not.toThrow();
    expect(listTracked().find((t) => t.threadId === 999)).toBeUndefined();
  });

  it('U2: listTracked returns title=null for thread that was never refreshed', () => {
    getDb()
      .prepare(
        'INSERT INTO tracked_threads (thread_id, chat_id, added_by, added_at) VALUES (?, ?, NULL, ?)',
      )
      .run(101, -1001, '2026-04-29T10:00:00.000Z');
    expect(listTracked().find((t) => t.threadId === 101)?.title).toBeNull();
  });
});
