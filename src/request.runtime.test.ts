import { expect, it, vi } from 'vitest';
import type { EmbeddingProvider } from './members.js';
import type { Persistence } from './persistence.js';
import { createRequestMatchingRuntime } from './request.runtime.js';
import type { RequestMatchingConfig } from './types.js';

const feature: RequestMatchingConfig = {
  embeddingApiKey: 'embedding-key',
  embeddingModel: 'text-embedding-3-small',
  memberIndexCron: '*/15 * * * *',
  concurrency: 2,
  queueLimit: 50,
  processingTimeoutMinutes: 10,
};

it('fails stale reservations and constructs PostgreSQL-backed matching without indexing', async () => {
  const persistence = {
    jobs: {},
    messages: {},
    members: {
      search: vi.fn(),
      readPending: vi.fn(),
      upsertCards: vi.fn(),
      upsertEmbedding: vi.fn(),
      recordIndexStatus: vi.fn(),
      readIndexStatus: vi.fn(),
      countBySource: vi.fn(),
    },
    requests: {
      reserve: vi.fn(),
      complete: vi.fn(),
      noMatch: vi.fn(),
      fail: vi.fn(),
      failStale: vi.fn().mockResolvedValue(2),
      read: vi.fn(),
    },
  } as unknown as Persistence;
  const embeddings: EmbeddingProvider = {
    model: 'text-embedding-3-small',
    embed: vi.fn(),
  };

  const runtime = await createRequestMatchingRuntime(feature, persistence, {
    embeddings,
    now: () => new Date('2026-08-21T10:00:00.000Z'),
  });

  expect(persistence.requests.failStale).toHaveBeenCalledWith('2026-08-21T09:50:00.000Z');
  expect(persistence.members.readPending).not.toHaveBeenCalled();
  expect(runtime.memberDirectory).toBeDefined();
  expect(runtime.handlerOptions.repository).toBe(persistence.requests);
  expect(runtime.handlerOptions.matcher).toBe(runtime.matcher);
});
