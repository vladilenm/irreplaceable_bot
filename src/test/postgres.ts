import { Pool } from 'pg';

export const TEST_DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ??
  'postgresql://club_bot:club_bot@127.0.0.1:55432/club_bot_test';

export function createTestPool(): Pool {
  return new Pool({ connectionString: TEST_DATABASE_URL, ssl: false, max: 4 });
}

export async function resetPostgres(pool: Pool): Promise<void> {
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
  await pool.query('CREATE SCHEMA public');
}
