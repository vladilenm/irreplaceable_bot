import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestPool, resetPostgres, TEST_DATABASE_URL } from '../test/postgres.js';
import { assertDatabaseReady, createPool, withTransaction } from './pool.js';
import type { DatabaseConfig } from '../types.js';

const databaseConfig: DatabaseConfig = {
  runtimeUrl: TEST_DATABASE_URL,
  migrationUrl: TEST_DATABASE_URL,
  ssl: false,
  poolMax: 3,
  statementTimeoutMs: 2500,
};

const contractPool = createTestPool();

beforeEach(async () => {
  await resetPostgres(contractPool);
});

afterAll(async () => {
  await contractPool.end();
});

describe('PostgreSQL pool', () => {
  it('applies bounded pool and statement timeout settings', async () => {
    const pool = createPool(databaseConfig);
    try {
      expect(pool.options.max).toBe(3);
      expect(pool.options.options).toBe('-c statement_timeout=2500');
      expect(pool.options.ssl).toBe(false);
      await assertDatabaseReady(pool);
    } finally {
      await pool.end();
    }
  });

  it('commits a successful transaction', async () => {
    await contractPool.query('CREATE TABLE tx_probe(id integer PRIMARY KEY)');
    await withTransaction(contractPool, async (client) => {
      await client.query('INSERT INTO tx_probe(id) VALUES ($1)', [1]);
    });
    const result = await contractPool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM tx_probe',
    );
    expect(result.rows[0]?.count).toBe('1');
  });

  it('rolls back a failed transaction', async () => {
    await contractPool.query('CREATE TABLE tx_probe(id integer PRIMARY KEY)');
    await expect(withTransaction(contractPool, async (client) => {
      await client.query('INSERT INTO tx_probe(id) VALUES ($1)', [1]);
      throw new Error('stop');
    })).rejects.toThrow('stop');
    const result = await contractPool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM tx_probe',
    );
    expect(result.rows[0]?.count).toBe('0');
  });
});
