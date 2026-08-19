import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb, getDb, _resetForTests } from './database.js';

import {
  readState,
  writeState,
  isDigestPublishedToday,
  isThreadSummaryPublishedTodayWithState,
  importLegacyState,
} from './database.js';
import type { PipelineStateV2 } from './types.js';

beforeEach(() => {
  _resetForTests();
  initDb();
});

describe('SQLite job state', () => {
  it('writeState then readState round-trips both independent jobs', () => {
    writeState({
      lastDigestDate: '2026-04-29T10:00:00.000Z',
      lastSkipped: false,
      lastItemCount: 3,
      lastThreadSummaryDate: null,
    });
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

    writeState({ ...got, lastDigestDate: 'newer' });
    expect(importLegacyState(legacyPath)).toBe(false);
    expect(readState().lastDigestDate).toBe('newer');
  });

  it('stores digest and thread-summary as separate rows', () => {
    writeState({
      lastDigestDate: 'A',
      lastSkipped: false,
      lastItemCount: 1,
      lastThreadSummaryDate: 'B',
    });
    writeState({
      lastDigestDate: 'C',
      lastSkipped: true,
      lastItemCount: 0,
      lastThreadSummaryDate: 'B',
    });
    const rows = getDb()
      .prepare('SELECT job_name FROM job_state ORDER BY job_name')
      .all() as Array<{ job_name: string }>;
    expect(rows.map((row) => row.job_name)).toEqual(['digest', 'thread-summary']);
    expect(readState().lastDigestDate).toBe('C');
    expect(readState().lastThreadSummaryDate).toBe('B');
  });
});

describe('job idempotency checks', () => {
  it('digest: null is false and the same MSK day is true', () => {
    expect(isDigestPublishedToday()).toBe(false);
    writeState({
      lastDigestDate: new Date().toISOString(),
      lastSkipped: false,
      lastItemCount: 1,
      lastThreadSummaryDate: null,
    });
    expect(isDigestPublishedToday()).toBe(true);
  });

  it('thread-summary remains independent from digest', () => {
    const state: PipelineStateV2 = {
      lastDigestDate: null,
      lastSkipped: false,
      lastItemCount: 0,
      lastThreadSummaryDate: new Date().toISOString(),
    };
    expect(isThreadSummaryPublishedTodayWithState(state)).toBe(true);
    expect(isDigestPublishedToday()).toBe(false);
  });

  it('previous MSK day is false', () => {
    writeState({
      lastDigestDate: '2020-01-01T10:00:00.000Z',
      lastSkipped: false,
      lastItemCount: 1,
      lastThreadSummaryDate: null,
    });
    expect(isDigestPublishedToday()).toBe(false);
  });
});
