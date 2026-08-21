import { describe, expect, it } from 'vitest';
import { readDatabaseConfig, readRequestMatchingConfig } from './config.js';

const enabled = {
  REQUEST_MATCHING_ENABLED: 'true',
  NOTION_TOKEN: 'notion',
  NOTION_DATA_SOURCE_ID: 'source',
  EMBEDDING_API_KEY: 'openai',
  EMBEDDING_MODEL: 'text-embedding-3-small',
};

describe('readRequestMatchingConfig', () => {
  it('is disabled without requiring credentials', () => {
    expect(readRequestMatchingConfig({})).toBeNull();
  });

  it('returns exact defaults when enabled', () => {
    expect(readRequestMatchingConfig(enabled)).toEqual({
      notionToken: 'notion',
      notionDataSourceId: 'source',
      embeddingApiKey: 'openai',
      embeddingModel: 'text-embedding-3-small',
      memberSyncCron: '*/15 * * * *',
      concurrency: 2,
      queueLimit: 50,
      processingTimeoutMinutes: 10,
    });
  });

  it('fails fast for missing secrets and invalid limits', () => {
    expect(() => readRequestMatchingConfig({ REQUEST_MATCHING_ENABLED: 'true' }))
      .toThrow('Missing required environment variable: NOTION_TOKEN');
    expect(() => readRequestMatchingConfig({ ...enabled, REQUEST_QUEUE_LIMIT: '0' }))
      .toThrow('REQUEST_QUEUE_LIMIT must be >= 1');
  });
});

describe('readDatabaseConfig', () => {
  const valid = {
    DATABASE_URL: 'postgresql://runtime@db/club',
    DATABASE_MIGRATION_URL: 'postgresql://owner@db/club',
  };

  it('requires PostgreSQL URLs and returns safe defaults', () => {
    expect(readDatabaseConfig(valid)).toEqual({
      runtimeUrl: 'postgresql://runtime@db/club',
      migrationUrl: 'postgresql://owner@db/club',
      ssl: true,
      poolMax: 5,
      statementTimeoutMs: 10_000,
    });
    expect(() => readDatabaseConfig({})).toThrow(
      'Missing required environment variable: DATABASE_URL',
    );
  });

  it('parses explicit database limits and TLS mode', () => {
    expect(readDatabaseConfig({
      ...valid,
      DATABASE_SSL: 'false',
      DATABASE_POOL_MAX: '7',
      DATABASE_STATEMENT_TIMEOUT_MS: '2500',
    })).toEqual({
      runtimeUrl: 'postgresql://runtime@db/club',
      migrationUrl: 'postgresql://owner@db/club',
      ssl: false,
      poolMax: 7,
      statementTimeoutMs: 2500,
    });
  });

  it('rejects invalid booleans and non-positive limits', () => {
    expect(() => readDatabaseConfig({ ...valid, DATABASE_SSL: 'yes' }))
      .toThrow('DATABASE_SSL must be true or false');
    expect(() => readDatabaseConfig({ ...valid, DATABASE_POOL_MAX: '0' }))
      .toThrow('DATABASE_POOL_MAX must be >= 1');
    expect(() => readDatabaseConfig({ ...valid, DATABASE_STATEMENT_TIMEOUT_MS: '1.5' }))
      .toThrow('DATABASE_STATEMENT_TIMEOUT_MS must be >= 1');
  });
});
