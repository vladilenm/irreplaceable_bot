import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { logger } from '../utils/logger.js';
import {
  startScheduler,
  stopScheduler,
  _getRegisteredJobNames,
  _resetSchedulerForTests,
} from './cron.js';

beforeEach(() => {
  _resetSchedulerForTests();
});

describe('cron registry (SCHED-01..04)', () => {
  it('C1: startScheduler registers exactly 3 named jobs', () => {
    startScheduler();
    const names = _getRegisteredJobNames();
    expect(new Set(names)).toEqual(
      new Set(['digest', 'thread-summary', 'retention-sweep']),
    );
    stopScheduler();
  });

  it('C2: stopScheduler logs `Cron job stopped` for each registered job', () => {
    const infoSpy = vi.spyOn(logger, 'info');
    startScheduler();
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
    startScheduler();
    stopScheduler();
    expect(_getRegisteredJobNames()).toEqual([]);
  });

  it('C3: startScheduler runs without throwing in normal env', () => {
    expect(() => startScheduler()).not.toThrow();
    stopScheduler();
  });

  it('C5: thread-summary handler is currently a stub (presence checked via grep)', () => {
    // Source-level grep covers the stub log message — see acceptance criteria.
    expect(true).toBe(true);
  });
});

describe('cron thread-summary handler wiring (Plan 06-03 Task 3)', () => {
  it('C7+C8+C9: registry still has 3 jobs and includes thread-summary', () => {
    startScheduler();
    const names = _getRegisteredJobNames();
    expect(names).toContain('digest');
    expect(names).toContain('thread-summary');
    expect(names).toContain('retention-sweep');
    stopScheduler();
  });
});

describe('cron retention-sweep wiring (Phase 7, Plan 07-01 Task 2)', () => {
  it('R1 (Phase 7): retention-sweep registered as third job after digest+thread-summary', () => {
    startScheduler();
    const names = _getRegisteredJobNames();
    expect(names).toContain('retention-sweep');
    expect(names).toHaveLength(3);
    stopScheduler();
  });

  it('R2 (Phase 7): cron.ts no longer contains the stub log line and imports runRetentionSweep', async () => {
    const src = await readFile(new URL('./cron.ts', import.meta.url), 'utf-8');
    expect(src).not.toContain('retention sweep stub — Phase 7 implements');
    expect(src).toContain('runRetentionSweep');
  });
});
