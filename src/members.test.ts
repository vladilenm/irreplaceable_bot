import { describe, expect, it, vi } from 'vitest';
import {
  buildMemberId,
  canonicalSearchText,
  memberContentHash,
  MemberIndex,
  MemberSyncService,
} from './members.js';
import type { IndexedMember, MemberSourceRecord } from './members.js';
import type {
  LegacyMemberRepository,
  MemberSnapshotCommit,
  MemberSyncStatus,
} from './members.repository.js';

describe('member identity', () => {
  it('uses provider-scoped IDs and canonical text', () => {
    expect(buildMemberId('notion', 'page-1')).toBe('notion:page-1');
    expect(canonicalSearchText({ displayName: 'Анна', profileText: 'B2B SaaS' }))
      .toBe('Анна\nB2B SaaS');
  });
});

const anna: MemberSourceRecord = {
  source: 'notion',
  externalId: 'page-1',
  displayName: 'Анна',
  telegramUsername: 'anna_product',
  profileText: 'B2B SaaS',
  sourceUpdatedAt: '2026-08-21T10:00:00.000Z',
  active: true,
};

const mikhail: MemberSourceRecord = {
  source: 'notion',
  externalId: 'page-2',
  displayName: 'Михаил',
  telegramUsername: 'mikhail_saas',
  profileText: 'Enterprise sales',
  sourceUpdatedAt: '2026-08-21T10:00:00.000Z',
  active: true,
};

const indexed = (record: MemberSourceRecord, embedding: number[]): IndexedMember => ({
  memberId: buildMemberId(record.source, record.externalId),
  displayName: record.displayName,
  telegramUsername: record.telegramUsername,
  profileText: record.profileText,
  embedding: new Float32Array(embedding),
  embeddingModel: 'model',
  generation: 1,
});

const status: MemberSyncStatus = {
  provider: 'notion',
  generation: 1,
  lastSuccessAt: '2026-08-21T10:01:00.000Z',
  embeddingModel: 'model',
  dimensions: 2,
  activeCount: 2,
};

function repository(options: {
  versions?: Map<string, { memberId: string; contentHash: string; embeddingModel: string | null; dimensions: number | null }>;
  index?: IndexedMember[];
  onCommit?: (input: MemberSnapshotCommit) => void;
} = {}): LegacyMemberRepository {
  return {
    readVersions: vi.fn(() => options.versions ?? new Map()),
    commitSnapshot: vi.fn((input: MemberSnapshotCommit) => {
      options.onCommit?.(input);
      return { ...status, activeCount: input.records.filter((record) => record.active).length };
    }),
    readActiveIndex: vi.fn(() => options.index ?? [indexed(anna, [1, 0]), indexed(mikhail, [0, 1])]),
    readStatus: vi.fn(() => null),
  };
}

describe('MemberIndex', () => {
  it('orders cosine matches and excludes requester', () => {
    const index = new MemberIndex();
    index.replace([
      { memberId: 'a', displayName: 'A', telegramUsername: 'requester', profileText: 'A',
        embedding: new Float32Array([1, 0]), embeddingModel: 'm', generation: 1 },
      { memberId: 'b', displayName: 'B', telegramUsername: 'best', profileText: 'B',
        embedding: new Float32Array([0.9, 0.1]), embeddingModel: 'm', generation: 1 },
      { memberId: 'c', displayName: 'C', telegramUsername: 'second', profileText: 'C',
        embedding: new Float32Array([0, 1]), embeddingModel: 'm', generation: 1 },
    ]);

    expect(index.search([1, 0], 20, 'REQUESTER').map((match) => match.member.memberId))
      .toEqual(['b', 'c']);
  });

  it('rejects query vectors with a different dimension', () => {
    const index = new MemberIndex();
    index.replace([indexed(anna, [1, 0])]);

    expect(() => index.search([1, 0, 0], 20)).toThrow('embedding dimension mismatch');
  });
});

describe('MemberSyncService', () => {
  it('embeds changed cards in canonical order and replaces the index after commit', async () => {
    const index = new MemberIndex();
    const provider = { listMembers: vi.fn().mockResolvedValue([mikhail, anna]) };
    const embeddings = {
      model: 'model',
      embed: vi.fn().mockResolvedValue([[1, 0], [0, 1]]),
    };
    const committed: MemberSnapshotCommit[] = [];
    const service = new MemberSyncService({
      provider,
      embeddings,
      repository: repository({ onCommit: (input) => committed.push(input) }),
      index,
      now: () => new Date('2026-08-21T10:01:00.000Z'),
    });

    await expect(service.sync()).resolves.toMatchObject({
      fetched: 2,
      active: 2,
      embedded: 2,
      generation: 1,
    });
    expect(embeddings.embed).toHaveBeenCalledWith([
      'Анна\nB2B SaaS',
      'Михаил\nEnterprise sales',
    ]);
    expect(committed[0]?.changedEmbeddings).toEqual(new Map([
      ['notion:page-1', [1, 0]],
      ['notion:page-2', [0, 1]],
    ]));
    expect(index.size).toBe(2);
  });

  it('skips embeddings for unchanged cards but re-embeds on a model change', async () => {
    const unchanged = new Map([['notion:page-1', {
      memberId: 'notion:page-1',
      contentHash: memberContentHash(anna),
      embeddingModel: 'model',
      dimensions: 2,
    }]]);
    const unchangedEmbeddings = { model: 'model', embed: vi.fn() };
    const first = new MemberSyncService({
      provider: { listMembers: vi.fn().mockResolvedValue([anna]) },
      embeddings: unchangedEmbeddings,
      repository: repository({ versions: unchanged, index: [indexed(anna, [1, 0])] }),
      index: new MemberIndex(),
      now: () => new Date(),
    });

    await first.sync();
    expect(unchangedEmbeddings.embed).not.toHaveBeenCalled();

    const changedEmbeddings = { model: 'new-model', embed: vi.fn().mockResolvedValue([[0, 1]]) };
    const second = new MemberSyncService({
      provider: { listMembers: vi.fn().mockResolvedValue([anna]) },
      embeddings: changedEmbeddings,
      repository: repository({ versions: unchanged, index: [indexed(anna, [0, 1])] }),
      index: new MemberIndex(),
      now: () => new Date(),
    });

    await second.sync();
    expect(changedEmbeddings.embed).toHaveBeenCalledWith(['Анна\nB2B SaaS']);
  });

  it('preserves the old in-memory index when the directory fails', async () => {
    const index = new MemberIndex();
    index.replace([indexed(anna, [1, 0])]);
    const service = new MemberSyncService({
      provider: { listMembers: vi.fn().mockRejectedValue(new Error('directory down')) },
      embeddings: { model: 'model', embed: vi.fn() },
      repository: repository(),
      index,
      now: () => new Date(),
    });

    await expect(service.sync()).rejects.toThrow('directory down');
    expect(index.size).toBe(1);
  });

  it('shares one operation for simultaneous sync calls', async () => {
    let resolveMembers: ((records: MemberSourceRecord[]) => void) | undefined;
    const pending = new Promise<MemberSourceRecord[]>((resolve) => {
      resolveMembers = resolve;
    });
    const provider = { listMembers: vi.fn(() => pending) };
    const service = new MemberSyncService({
      provider,
      embeddings: { model: 'model', embed: vi.fn().mockResolvedValue([[1, 0]]) },
      repository: repository({ index: [indexed(anna, [1, 0])] }),
      index: new MemberIndex(),
      now: () => new Date(),
    });

    const first = service.sync();
    const second = service.sync();
    expect(second).toBe(first);
    resolveMembers?.([anna]);
    await expect(first).resolves.toMatchObject({ embedded: 1 });
    expect(provider.listMembers).toHaveBeenCalledTimes(1);
  });
});
