import { afterAll, describe, expect, it, vi } from 'vitest';
import { POSTGRES_MIGRATIONS } from './migrations.js';
import { createTestPool, resetPostgres, TEST_DATABASE_URL } from '../test/postgres.js';

const pool = createTestPool();

afterAll(async () => {
  await pool.end();
});

describe('migrateDatabase', () => {
  it('runs migrations with an environment containing only DATABASE_URL', async () => {
    await resetPostgres(pool);

    const originalEnv = { ...process.env };
    try {
      for (const name of [
        'BOT_TOKEN',
        'TARGET_CHAT_ID',
        'AI_RADAR_THREAD_ID',
        'THREAD_SUMMARY_THREAD_ID',
        'TRACKED_THREAD_IDS',
        'TIMEWEB_AI_TOKEN',
        'DATABASE_URL',
      ]) {
        delete process.env[name];
      }
      vi.resetModules();

      const { migrateDatabase } = await import('./migrate.js');
      const applied = await migrateDatabase({ DATABASE_URL: TEST_DATABASE_URL });

      expect(applied).toBe(POSTGRES_MIGRATIONS.length);
    } finally {
      for (const name of Object.keys(process.env)) delete process.env[name];
      Object.assign(process.env, originalEnv);
    }
  });
});
