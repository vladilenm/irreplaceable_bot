import { describe, it, expect, beforeEach } from 'vitest';
import {
  existsSync,
  unlinkSync,
  writeFileSync as realWriteFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';

const STATE_PATH = fileURLToPath(new URL('../../data/state.json', import.meta.url));
const TMP_PATH = `${STATE_PATH}.tmp`;

beforeEach(() => {
  if (existsSync(STATE_PATH)) unlinkSync(STATE_PATH);
  if (existsSync(TMP_PATH)) unlinkSync(TMP_PATH);
});

import {
  readState,
  writeState,
  isDigestPublishedToday,
  isThreadSummaryPublishedToday,
} from './state.service.js';

describe('state.service atomic writes (STATE-01)', () => {
  it('S1: writeState then readState round-trip', () => {
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

  it('S3: missing file returns defaults', () => {
    const got = readState();
    expect(got).toEqual({
      lastDigestDate: null,
      lastSkipped: false,
      lastItemCount: 0,
      lastThreadSummaryDate: null,
    });
  });

  it('S4: corrupt JSON THROWS with State file corrupted message (STATE-02)', () => {
    realWriteFileSync(STATE_PATH, '{not valid json[');
    expect(() => readState()).toThrowError(/State file corrupted/);
  });

  it('S5: legacy v1.0 state file (no lastThreadSummaryDate) reads back with null in new field', () => {
    realWriteFileSync(
      STATE_PATH,
      JSON.stringify({
        lastDigestDate: '2026-04-29T06:00:00.000Z',
        lastSkipped: false,
        lastItemCount: 5,
      }),
    );
    const got = readState();
    expect(got.lastThreadSummaryDate).toBeNull();
    expect(got.lastDigestDate).toBe('2026-04-29T06:00:00.000Z');
  });

  it('S8: writeState then writeState preserves explicitly-passed shape', () => {
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
    const got = readState();
    expect(got.lastDigestDate).toBe('C');
    expect(got.lastThreadSummaryDate).toBe('B');
  });
});

describe('state.service idempotency checks (D-31)', () => {
  it('S6: isDigestPublishedToday — null → false; same MSK day → true', () => {
    expect(isDigestPublishedToday()).toBe(false);
    writeState({
      lastDigestDate: new Date().toISOString(),
      lastSkipped: false,
      lastItemCount: 1,
      lastThreadSummaryDate: null,
    });
    expect(isDigestPublishedToday()).toBe(true);
  });

  it('S7: isThreadSummaryPublishedToday — separate from digest, same MSK-day pattern', () => {
    writeState({
      lastDigestDate: null,
      lastSkipped: false,
      lastItemCount: 0,
      lastThreadSummaryDate: new Date().toISOString(),
    });
    expect(isThreadSummaryPublishedToday()).toBe(true);
    expect(isDigestPublishedToday()).toBe(false);
  });

  it('S6b: previous MSK day → false', () => {
    writeState({
      lastDigestDate: '2020-01-01T10:00:00.000Z',
      lastSkipped: false,
      lastItemCount: 1,
      lastThreadSummaryDate: null,
    });
    expect(isDigestPublishedToday()).toBe(false);
  });
});

describe('atomic write proof (STATE-01)', () => {
  it('S2: after writeState the .tmp file does not exist (was renamed) and final exists', () => {
    writeState({
      lastDigestDate: 'X',
      lastSkipped: false,
      lastItemCount: 0,
      lastThreadSummaryDate: null,
    });
    expect(existsSync(TMP_PATH)).toBe(false);
    expect(existsSync(STATE_PATH)).toBe(true);
  });
});
