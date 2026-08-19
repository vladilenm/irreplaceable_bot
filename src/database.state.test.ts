import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb, getDb, _resetForTests } from './database.js';

import {
  readState,
  recordDigestCompletion,
  recordThreadSummaryCompletion,
  isDigestPublishedToday,
  isThreadSummaryPublishedTodayWithState,
  importLegacyState,
} from './database.js';
import type { PipelineState } from './types.js';

beforeEach(() => {
  _resetForTests();
  initDb();
});

describe('SQLite job state', () => {
  it('completion records round-trip both independent jobs', () => {
    recordDigestCompletion(new Date('2026-04-29T10:00:00.000Z'), false, 3);
    const got = readState();
    expect(got.lastDigestDate).toBe('2026-04-29T10:00:00.000Z');
    expect(got.lastItemCount).toBe(3);
    expect(got.lastSkipped).toBe(false);
    expect(got.lastThreadSummaryDate).toBeNull();
  });

  it('missing rows return defaults', () => {
    const got = readState();
    expect(got).toEqual({
      lastDigestDate: null,
      lastSkipped: false,
      lastItemCount: 0,
      lastThreadSummaryDate: null,
    });
  });

  it('imports a legacy state.json only when job_state is empty', () => {
    const legacyPath = join(mkdtempSync(join(tmpdir(), 'club-bot-state-')), 'state.json');
    writeFileSync(
      legacyPath,
      JSON.stringify({
        lastDigestDate: '2026-04-29T06:00:00.000Z',
        lastSkipped: false,
        lastItemCount: 5,
      }),
    );

    expect(importLegacyState(legacyPath)).toBe(true);
    const got = readState();
    expect(got.lastThreadSummaryDate).toBeNull();
    expect(got.lastDigestDate).toBe('2026-04-29T06:00:00.000Z');
    expect(got.lastItemCount).toBe(5);

    recordDigestCompletion(new Date('2026-04-30T06:00:00.000Z'), false, got.lastItemCount);
    expect(importLegacyState(legacyPath)).toBe(false);
    expect(readState().lastDigestDate).toBe('2026-04-30T06:00:00.000Z');
  });

  it('stores digest and thread-summary as separate rows', () => {
    recordThreadSummaryCompletion(new Date('2026-04-29T03:30:00.000Z'));
    recordDigestCompletion(new Date('2026-04-29T06:00:00.000Z'), false, 1);
    recordDigestCompletion(new Date('2026-04-30T06:00:00.000Z'), true, 0);
    const rows = getDb()
      .prepare('SELECT job_name FROM job_state ORDER BY job_name')
      .all() as Array<{ job_name: string }>;
    expect(rows.map((row) => row.job_name)).toEqual(['digest', 'thread-summary']);
    expect(readState().lastDigestDate).toBe('2026-04-30T06:00:00.000Z');
    expect(readState().lastThreadSummaryDate).toBe('2026-04-29T03:30:00.000Z');
  });

  it('targeted completion updates never overwrite the other job', () => {
    recordThreadSummaryCompletion(new Date('2026-05-01T03:30:00.000Z'));
    recordDigestCompletion(new Date('2026-05-01T06:00:00.000Z'), false, 4);
    recordDigestCompletion(new Date('2026-05-02T06:00:00.000Z'), true, 0);

    expect(readState()).toEqual({
      lastDigestDate: '2026-05-02T06:00:00.000Z',
      lastSkipped: true,
      lastItemCount: 0,
      lastThreadSummaryDate: '2026-05-01T03:30:00.000Z',
    });

    recordThreadSummaryCompletion(new Date('2026-05-02T03:30:00.000Z'));
    expect(readState().lastDigestDate).toBe('2026-05-02T06:00:00.000Z');
  });
});

describe('job idempotency checks', () => {
  it('digest: null is false and the same MSK day is true', () => {
    expect(isDigestPublishedToday()).toBe(false);
    recordDigestCompletion(new Date(), false, 1);
    expect(isDigestPublishedToday()).toBe(true);
  });

  it('thread-summary remains independent from digest', () => {
    const state: PipelineState = {
      lastDigestDate: null,
      lastSkipped: false,
      lastItemCount: 0,
      lastThreadSummaryDate: new Date().toISOString(),
    };
    expect(isThreadSummaryPublishedTodayWithState(state)).toBe(true);
    expect(isDigestPublishedToday()).toBe(false);
  });

  it('previous MSK day is false', () => {
    recordDigestCompletion(new Date('2020-01-01T10:00:00.000Z'), false, 1);
    expect(isDigestPublishedToday()).toBe(false);
  });
});
