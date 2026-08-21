import { expect, it, vi } from 'vitest';
import type { RequestMatchingConfig } from './types.js';
import type { MemberDirectoryProvider, EmbeddingProvider } from './members.js';
import type { LegacyMemberRepository } from './members.repository.js';
import type { RequestRepository } from './request.repository.js';
import { createRequestMatchingRuntime } from './request.runtime.js';

const feature: RequestMatchingConfig = {
  notionToken: 'notion-token',
  notionDataSourceId: 'data-source',
  embeddingApiKey: 'embedding-key',
  embeddingModel: 'model',
  memberSyncCron: '*/15 * * * *',
  concurrency: 2,
  queueLimit: 50,
  processingTimeoutMinutes: 10,
};

it('hydrates the local index and fails stale reservations without a network sync', () => {
  const memberRepository: LegacyMemberRepository = {
    readVersions: vi.fn(() => new Map()),
    commitSnapshot: vi.fn(),
    readActiveIndex: vi.fn(() => []),
    readStatus: vi.fn(() => null),
  };
  const requestRepository: RequestRepository = {
    reserve: vi.fn(async () => true),
    complete: vi.fn(async () => undefined),
    noMatch: vi.fn(async () => undefined),
    fail: vi.fn(async () => undefined),
    failStale: vi.fn(async () => 0),
    read: vi.fn(async () => null),
  };
  const directory: MemberDirectoryProvider = { listMembers: vi.fn() };
  const embeddings: EmbeddingProvider = { model: 'model', embed: vi.fn() };

  const runtime = createRequestMatchingRuntime(feature, {
    memberRepository,
    requestRepository,
    directory,
    embeddings,
    now: () => new Date('2026-08-21T10:00:00.000Z'),
  });

  expect(memberRepository.readActiveIndex).toHaveBeenCalledWith('model');
  expect(requestRepository.failStale).toHaveBeenCalledWith('2026-08-21T09:50:00.000Z');
  expect(runtime.index.size).toBe(0);
  expect(directory.listMembers).not.toHaveBeenCalled();
});
