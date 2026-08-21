import { expect, it, vi } from 'vitest';
import type { EmbeddingProvider } from './members.js';
import type { Persistence } from './persistence.js';
import { createRequestMatchingRuntime } from './request.runtime.js';
import type { RequestMatchingConfig } from './types.js';

const { openAiConstructor } = vi.hoisted(() => ({
  openAiConstructor: vi.fn(),
}));

vi.mock('openai', () => ({
  default: openAiConstructor.mockImplementation(() => ({
    embeddings: { create: vi.fn() },
    chat: { completions: { create: vi.fn() } },
  })),
}));

const feature: RequestMatchingConfig = {
  embeddingApiKey: 'gateway-token',
  embeddingBaseUrl: 'https://api.timeweb.ai/v1',
  embeddingModel: 'openai/text-embedding-3-large',
  embeddingDimensions: 1536,
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

it('constructs the default embedding client with the Timeweb Gateway configuration', async () => {
  openAiConstructor.mockClear();
  const persistence = {
    members: {},
    requests: { failStale: vi.fn().mockResolvedValue(0) },
  } as unknown as Persistence;

  await createRequestMatchingRuntime(feature, persistence);

  expect(openAiConstructor).toHaveBeenCalledWith({
    apiKey: 'gateway-token',
    baseURL: 'https://api.timeweb.ai/v1',
    maxRetries: 1,
  });
});
