import { Pool, type PoolClient } from 'pg';
import type { DatabaseConfig } from '../types.js';

export function createPool(config: DatabaseConfig, url = config.runtimeUrl): Pool {
  return new Pool({
    connectionString: url,
    max: config.poolMax,
    ssl: config.ssl ? { rejectUnauthorized: true } : false,
    options: `-c statement_timeout=${String(config.statementTimeoutMs)}`,
  });
}

export async function assertDatabaseReady(pool: Pool): Promise<void> {
  await pool.query('SELECT 1');
}

export async function withTransaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error: unknown) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
