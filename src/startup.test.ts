import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { GrammyError } from 'grammy';
import {
  classifyStartupError,
  POLLING_CONFLICT_BACKOFF_MS,
} from './startup.js';

// Helper: build a GrammyError with the given error_code without calling the
// (private) constructor signature manually for every variant. The constructor
// signature is: (message, ApiError, method, payload).
function buildGrammyError(errorCode: number, description = 'Conflict'): GrammyError {
  return new GrammyError(
    `Call to getUpdates failed! (${errorCode}: ${description})`,
    { ok: false, error_code: errorCode, description },
    'getUpdates',
    {},
  );
}

describe('classifyStartupError', () => {
  it('D1: GrammyError with error_code 409 → polling-conflict-409', () => {
    const err = buildGrammyError(409, 'terminated by other getUpdates request');
    expect(classifyStartupError(err)).toBe('polling-conflict-409');
  });

  it('D2: GrammyError with error_code 401 (unauthorized) → unknown (not a 409)', () => {
    const err = buildGrammyError(401, 'Unauthorized');
    expect(classifyStartupError(err)).toBe('unknown');
  });

  it('D3: GrammyError with error_code 429 (rate-limit) → unknown', () => {
    const err = buildGrammyError(429, 'Too Many Requests');
    expect(classifyStartupError(err)).toBe('unknown');
  });

  it('D4: plain Error (non-grammy) with .error_code 409 → unknown (instanceof guard rejects look-alikes)', () => {
    const err: Error & { error_code?: number } = new Error('look-alike');
    err.error_code = 409;
    expect(classifyStartupError(err)).toBe('unknown');
  });

  it('D5: undefined / null / string rejection values → unknown (no crash)', () => {
    expect(classifyStartupError(undefined)).toBe('unknown');
    expect(classifyStartupError(null)).toBe('unknown');
    expect(classifyStartupError('boom')).toBe('unknown');
    expect(classifyStartupError(42)).toBe('unknown');
  });

  it('D6: backoff constant is at least 30s (sanity check that we are not busy-looping)', () => {
    expect(POLLING_CONFLICT_BACKOFF_MS).toBeGreaterThanOrEqual(30_000);
  });
});

describe('PostgreSQL deployment files', () => {
  it('passes managed database settings without SQLite disk assumptions', async () => {
    const [compose, dockerfile, env] = await Promise.all([
      readFile(new URL('../docker-compose.yml', import.meta.url), 'utf8'),
      readFile(new URL('../Dockerfile', import.meta.url), 'utf8'),
      readFile(new URL('../.env.example', import.meta.url), 'utf8'),
    ]);

    expect(compose).toContain('DATABASE_URL:');
    expect(compose).toContain('DATABASE_MIGRATION_URL:');
    expect(compose).toContain('ALLOW_MOCK_MEMBER_SEED:');
    expect(compose).not.toContain('DB_PATH:');
    expect(compose).not.toContain('NOTION_TOKEN:');
    expect(dockerfile).toContain('FROM node:22-alpine');
    expect(dockerfile).not.toContain('better-sqlite3');
    expect(dockerfile).not.toContain('/app/data');
    expect(compose).toContain('DATABASE_SSL: "${DATABASE_SSL:-true}"');
    expect(env).toContain('DATABASE_SSL=false');
    expect(env).toContain('MEMBER_INDEX_CRON=*/15 * * * *');
  });
});
