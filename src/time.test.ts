import { describe, expect, it } from 'vitest';
import { isExpired, moscowDateKey, nextMoscowMidnight } from './time.js';

describe('Moscow scheduling time helpers', () => {
  it('uses the Moscow calendar date instead of the host timezone', () => {
    expect(moscowDateKey(new Date('2026-08-22T20:59:59.000Z'))).toBe('2026-08-22');
    expect(moscowDateKey(new Date('2026-08-22T21:00:00.000Z'))).toBe('2026-08-23');
  });

  it('expires a publication at the next Moscow midnight', () => {
    const expiresAt = nextMoscowMidnight(new Date('2026-08-22T20:59:59.000Z'));

    expect(expiresAt.toISOString()).toBe('2026-08-22T21:00:00.000Z');
    expect(isExpired(expiresAt, new Date('2026-08-22T20:59:59.999Z'))).toBe(false);
    expect(isExpired(expiresAt, new Date('2026-08-22T21:00:00.000Z'))).toBe(true);
  });
});
