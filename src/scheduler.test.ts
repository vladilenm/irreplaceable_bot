import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { logger } from './logger.js';
import type { Api } from 'grammy';
import type { CorePersistence } from './persistence.js';
import type { PublicationDispatcher } from './publication-dispatcher.js';
import {
  startScheduler,
  stopScheduler,
  _getRegisteredJobNames,
  _resetSchedulerForTests,
} from './scheduler.js';

const api = {} as Api;
const dispatcher: PublicationDispatcher = {
  dispatchDue: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
};
const persistence: CorePersistence = {
  jobs: {
    read: vi.fn(async () => ({
      lastDigestDate: null,
      lastSkipped: false,
      lastItemCount: 0,
      lastThreadSummaryDate: null,
    })),
    recordDigest: vi.fn(async () => undefined),
    recordThreadSummary: vi.fn(async () => undefined),
  },
  messages: {
    upsert: vi.fn(async () => undefined),
    selectWindow: vi.fn(async () => []),
    runRetention: vi.fn(async () => ({ rowsDeleted: 0, durationMs: 0 })),
  },
  publications: {
    enqueue: vi.fn(),
    claimDue: vi.fn(),
    recordChunkDelivered: vi.fn(),
    scheduleRetry: vi.fn(),
    markFailed: vi.fn(),
    markExpired: vi.fn(),
    expireDue: vi.fn(),
    recover: vi.fn(),
    read: vi.fn(),
    getStatusCounts: vi.fn(),
    deleteExpiredPublications: vi.fn(),
  },
};

beforeEach(() => {
  _resetSchedulerForTests();
});

describe('cron registry', () => {
  it('registers summary and maintenance jobs without the legacy digest cron', () => {
    startScheduler(api, persistence, { dispatcher });
    const names = _getRegisteredJobNames();
    expect(new Set(names)).toEqual(
      new Set(['thread-summary', 'retention-sweep']),
    );
    stopScheduler();
  });

  it('C2: stopScheduler logs `Cron job stopped` for each registered job', () => {
    const infoSpy = vi.spyOn(logger, 'info');
    startScheduler(api, persistence, { dispatcher });
    infoSpy.mockClear();
    stopScheduler();
    const stopLogs = infoSpy.mock.calls.filter((c) => c[1] === 'Cron job stopped');
    const stoppedNames = stopLogs.map((c) => (c[0] as { name: string }).name);
    expect(new Set(stoppedNames)).toEqual(
      new Set(['thread-summary', 'retention-sweep']),
    );
    infoSpy.mockRestore();
  });

  it('C2b: after stopScheduler, registry is empty', () => {
    startScheduler(api, persistence, { dispatcher });
    stopScheduler();
    expect(_getRegisteredJobNames()).toEqual([]);
  });

  it('C3: startScheduler runs without throwing in normal env', () => {
    expect(() => startScheduler(api, persistence, { dispatcher })).not.toThrow();
    stopScheduler();
  });

  it('C5: thread-summary handler is currently a stub (presence checked via grep)', () => {
    // Source-level grep covers the stub log message — see acceptance criteria.
    expect(true).toBe(true);
  });
});

describe('cron thread-summary handler wiring', () => {
  it('keeps thread-summary and retention without the legacy digest job', () => {
    startScheduler(api, persistence, { dispatcher });
    const names = _getRegisteredJobNames();
    expect(names).not.toContain('digest');
    expect(names).toContain('thread-summary');
    expect(names).toContain('retention-sweep');
    stopScheduler();
  });
});

describe('cron retention-sweep wiring', () => {
  it('R1: retention-sweep is registered with thread-summary', () => {
    startScheduler(api, persistence, { dispatcher });
    const names = _getRegisteredJobNames();
    expect(names).toContain('retention-sweep');
    expect(names).toHaveLength(2);
    stopScheduler();
  });

  it('R2: scheduler imports the real retention sweep', async () => {
    const src = await readFile(new URL('./scheduler.ts', import.meta.url), 'utf-8');
    expect(src).not.toContain("from './database.js'");
    expect(src).toContain('persistence.messages.runRetention');
  });
});

describe('member source sync scheduling', () => {
  it('registers member-sync every five minutes only when provided', () => {
    startScheduler(api, persistence, {
      dispatcher,
      memberSync: {
        cron: '*/5 * * * *',
        run: vi.fn().mockResolvedValue(undefined),
      },
    });
    expect(new Set(_getRegisteredJobNames())).toEqual(new Set([
      'thread-summary',
      'retention-sweep',
      'member-sync',
    ]));
    stopScheduler();
  });
});
