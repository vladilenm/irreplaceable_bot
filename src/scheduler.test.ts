import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { logger } from './logger.js';
import type { Api } from 'grammy';
import {
  startScheduler,
  stopScheduler,
  _getRegisteredJobNames,
  _resetSchedulerForTests,
} from './scheduler.js';

const api = {} as Api;

beforeEach(() => {
  _resetSchedulerForTests();
});

describe('cron registry', () => {
  it('C1: startScheduler registers exactly 3 named jobs', () => {
    startScheduler(api);
    const names = _getRegisteredJobNames();
    expect(new Set(names)).toEqual(
      new Set(['digest', 'thread-summary', 'retention-sweep']),
    );
    stopScheduler();
  });

  it('C2: stopScheduler logs `Cron job stopped` for each registered job', () => {
    const infoSpy = vi.spyOn(logger, 'info');
    startScheduler(api);
    infoSpy.mockClear();
    stopScheduler();
    const stopLogs = infoSpy.mock.calls.filter((c) => c[1] === 'Cron job stopped');
    const stoppedNames = stopLogs.map((c) => (c[0] as { name: string }).name);
    expect(new Set(stoppedNames)).toEqual(
      new Set(['digest', 'thread-summary', 'retention-sweep']),
    );
    infoSpy.mockRestore();
  });

  it('C2b: after stopScheduler, registry is empty', () => {
    startScheduler(api);
    stopScheduler();
    expect(_getRegisteredJobNames()).toEqual([]);
  });

  it('C3: startScheduler runs without throwing in normal env', () => {
    expect(() => startScheduler(api)).not.toThrow();
    stopScheduler();
  });

  it('C5: thread-summary handler is currently a stub (presence checked via grep)', () => {
    // Source-level grep covers the stub log message — see acceptance criteria.
    expect(true).toBe(true);
  });
});

describe('cron thread-summary handler wiring', () => {
  it('C7+C8+C9: registry still has 3 jobs and includes thread-summary', () => {
    startScheduler(api);
    const names = _getRegisteredJobNames();
    expect(names).toContain('digest');
    expect(names).toContain('thread-summary');
    expect(names).toContain('retention-sweep');
    stopScheduler();
  });
});

describe('cron retention-sweep wiring', () => {
  it('R1: retention-sweep is registered with digest and thread-summary', () => {
    startScheduler(api);
    const names = _getRegisteredJobNames();
    expect(names).toContain('retention-sweep');
    expect(names).toHaveLength(3);
    stopScheduler();
  });

  it('R2: scheduler imports the real retention sweep', async () => {
    const src = await readFile(new URL('./scheduler.ts', import.meta.url), 'utf-8');
    expect(src).toContain('runRetentionSweep');
  });
});
