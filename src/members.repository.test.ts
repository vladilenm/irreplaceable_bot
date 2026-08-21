import { beforeEach, expect, it } from 'vitest';
import { _resetForTests, getDb, initDb } from './database.js';
import { SqliteMemberRepository } from './members.repository.js';

beforeEach(() => {
  _resetForTests();
  initDb();
});

const anna = {
  source: 'notion' as const,
  externalId: 'page-1',
  displayName: 'Анна',
  telegramUsername: 'anna_product',
  profileText: 'B2B SaaS',
  sourceUpdatedAt: '2026-08-21T10:00:00.000Z',
  active: true,
};

it('commits and hydrates a Float32 snapshot', () => {
  const repo = new SqliteMemberRepository(getDb());

  const status = repo.commitSnapshot({
    provider: 'notion',
    model: 'model',
    completedAt: '2026-08-21T10:01:00.000Z',
    records: [anna],
    changedEmbeddings: new Map([['notion:page-1', [1, 0]]]),
  });

  expect(status).toMatchObject({ generation: 1, activeCount: 1, dimensions: 2 });
  const [member] = repo.readActiveIndex('model');
  expect(member).toMatchObject({ memberId: 'notion:page-1', generation: 1 });
  expect([...member!.embedding]).toEqual([1, 0]);
});

it('deactivates cards absent from the next snapshot', () => {
  const repo = new SqliteMemberRepository(getDb());
  repo.commitSnapshot({
    provider: 'notion',
    model: 'model',
    completedAt: '2026-08-21T10:01:00.000Z',
    records: [anna],
    changedEmbeddings: new Map([['notion:page-1', [1, 0]]]),
  });

  const status = repo.commitSnapshot({
    provider: 'notion',
    model: 'model',
    completedAt: '2026-08-21T10:16:00.000Z',
    records: [],
    changedEmbeddings: new Map(),
  });

  expect(status).toMatchObject({ generation: 2, activeCount: 0 });
  expect(repo.readActiveIndex('model')).toEqual([]);
});

it('rolls back when an active card has no current-model embedding', () => {
  const repo = new SqliteMemberRepository(getDb());

  expect(() => repo.commitSnapshot({
    provider: 'notion',
    model: 'model',
    completedAt: '2026-08-21T10:01:00.000Z',
    records: [anna],
    changedEmbeddings: new Map(),
  })).toThrow('active member missing embedding');
  expect(repo.readStatus()).toBeNull();
  expect(repo.readActiveIndex('model')).toEqual([]);
});

it('replaces vectors when the embedding model changes', () => {
  const repo = new SqliteMemberRepository(getDb());
  repo.commitSnapshot({
    provider: 'notion',
    model: 'old-model',
    completedAt: '2026-08-21T10:01:00.000Z',
    records: [anna],
    changedEmbeddings: new Map([['notion:page-1', [1, 0]]]),
  });

  const status = repo.commitSnapshot({
    provider: 'notion',
    model: 'new-model',
    completedAt: '2026-08-21T10:16:00.000Z',
    records: [anna],
    changedEmbeddings: new Map([['notion:page-1', [0, 1]]]),
  });

  expect(status.generation).toBe(2);
  expect(repo.readActiveIndex('old-model')).toEqual([]);
  expect(repo.readActiveIndex('new-model')).toHaveLength(1);
  expect(repo.readVersions().get('notion:page-1')).toMatchObject({
    embeddingModel: 'new-model',
    dimensions: 2,
  });
});
