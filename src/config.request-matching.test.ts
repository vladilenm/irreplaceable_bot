import { describe, expect, it } from 'vitest';
import { readRequestMatchingConfig } from './config.js';

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
