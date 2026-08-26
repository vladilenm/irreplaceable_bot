import { expect, it, vi } from 'vitest';
import pino from 'pino';
import { logger } from './logger.js';
import type { ClubMemberSourceRow, MemberSourceRepository } from './member-source.repository.js';
import type { MemberRepository, MemberSourceStatus } from './members.repository.js';
import { MemberSyncService } from './member-sync.service.js';

const sourceRow = (
  overrides: Partial<ClubMemberSourceRow> = {},
): ClubMemberSourceRow => ({
  telegramUserId: '1001',
  telegramUsername: 'member_1001',
  displayName: 'Анна Иванова',
  occupation: 'Продакт-менеджер',
  industry: 'B2B SaaS',
  expertise: 'Запускала продукты для бизнеса',
  canHelpWith: 'Стратегией продукта',
  skills: ['Product', 'B2B'],
  consentPolicyVersion: 'member-matching-v1',
  sourceUpdatedAt: '2026-08-26T09:00:00.000Z',
  ...overrides,
});

function memberRepository(initialStatus: MemberSourceStatus | null = null) {
  let sourceStatus = initialStatus;
  const repository = {
    upsertCards: vi.fn(async () => 0),
    replaceSourceSnapshot: vi.fn(async (input) => {
      sourceStatus = {
        provider: 'web' as const,
        generation: (sourceStatus?.generation ?? 0) + 1,
        lastSuccessAt: input.completedAt.toISOString(),
        fetchedCount: input.fetchedCount,
        activeCount: input.records.length,
        rejectedCount: input.rejectedCount,
        deactivatedCount: 3,
      };
      return sourceStatus;
    }),
    readSourceStatus: vi.fn(async () => sourceStatus),
    readPending: vi.fn(async () => []),
    upsertEmbedding: vi.fn(async () => undefined),
    search: vi.fn(async () => []),
    recordIndexStatus: vi.fn(async () => ({
      provider: 'postgres',
      generation: 1,
      lastSuccessAt: '2026-08-26T10:00:00.000Z',
      embeddingModel: 'text-embedding-3-small',
      dimensions: 1536 as const,
      activeCount: 0,
      pendingCount: 0,
    })),
    readIndexStatus: vi.fn(async () => null),
    countBySource: vi.fn(async () => 0),
  } satisfies MemberRepository;
  return repository;
}

function serviceFor({
  source,
  members = memberRepository(),
  directory = { indexPending: vi.fn().mockResolvedValue({ indexed: 1, failed: 0 }) },
}: {
  source: MemberSourceRepository;
  members?: MemberRepository;
  directory?: { indexPending: (limit?: number) => Promise<{ indexed: number; failed: number }> };
}) {
  return {
    members,
    directory,
    service: new MemberSyncService({
      source,
      members,
      directory,
      supportedPolicies: new Set(['member-matching-v1']),
      now: () => new Date('2026-08-26T10:00:00.000Z'),
    }),
  };
}

type CapturedLogCall = [Record<string, unknown>, string | undefined];
type PinoSerializer = (
  obj: Record<string, unknown>, msg: string | undefined, level: number, time: number,
) => string;

function renderPinoJson(call: CapturedLogCall): string {
  const serializer = (logger as unknown as { [pino.symbols.asJsonSym]: PinoSerializer })[
    pino.symbols.asJsonSym
  ];
  return serializer.call(logger, call[0], call[1], logger.levels.values.info!, 0);
}

it('commits accepted rows, deactivates rejected rows, then indexes pending cards', async () => {
  const source = { readSnapshot: vi.fn().mockResolvedValue([
    sourceRow({ telegramUserId: '1001' }),
    sourceRow({ telegramUserId: '1002', consentPolicyVersion: 'member-matching-v2' }),
    sourceRow({ telegramUserId: '9223372036854775808' }),
  ]) } satisfies MemberSourceRepository;
  const { service, members, directory } = serviceFor({ source });

  await expect(service.sync()).resolves.toEqual({
    fetched: 3,
    accepted: 1,
    rejected: 2,
    deactivated: 3,
    indexed: 1,
    failed: 0,
  });
  expect(members.replaceSourceSnapshot).toHaveBeenCalledWith(expect.objectContaining({
    source: 'web',
    fetchedCount: 3,
    rejectedCount: 2,
    records: [expect.objectContaining({ telegramUserId: '1001' })],
    completedAt: new Date('2026-08-26T10:00:00.000Z'),
  }));
  expect(directory.indexPending).toHaveBeenCalledWith(1000);
});

it('propagates a rejected source read without replacing the prior snapshot', async () => {
  const source = { readSnapshot: vi.fn().mockRejectedValue(new Error('source unavailable')) };
  const previous: MemberSourceStatus = {
    provider: 'web', generation: 7, lastSuccessAt: '2026-08-26T09:00:00.000Z',
    fetchedCount: 4, activeCount: 4, rejectedCount: 0, deactivatedCount: 0,
  };
  const { service, members, directory } = serviceFor({
    source,
    members: memberRepository(previous),
  });

  await expect(service.sync()).rejects.toThrow('source unavailable');
  expect(members.replaceSourceSnapshot).not.toHaveBeenCalled();
  expect(directory.indexPending).not.toHaveBeenCalled();
  await expect(members.readSourceStatus('web')).resolves.toEqual(previous);
});

it('commits an empty successful snapshot', async () => {
  const source = { readSnapshot: vi.fn().mockResolvedValue([]) } satisfies MemberSourceRepository;
  const { service, members } = serviceFor({ source });

  await service.sync();
  expect(members.replaceSourceSnapshot).toHaveBeenCalledWith(expect.objectContaining({
    records: [], fetchedCount: 0, rejectedCount: 0,
  }));
});

it('shares one source read between concurrent sync calls', async () => {
  let resolveSnapshot: ((rows: readonly ClubMemberSourceRow[]) => void) | undefined;
  const source = {
    readSnapshot: vi.fn(() => new Promise<readonly ClubMemberSourceRow[]>((resolve) => {
      resolveSnapshot = resolve;
    })),
  } satisfies MemberSourceRepository;
  const { service } = serviceFor({ source });

  const first = service.sync();
  const second = service.sync();
  expect(first).toBe(second);
  expect(source.readSnapshot).toHaveBeenCalledTimes(1);
  resolveSnapshot?.([sourceRow()]);

  await expect(Promise.all([first, second])).resolves.toHaveLength(2);
});

it('times out startup observation while the shared sync stays alive', async () => {
  let resolveSnapshot: ((rows: readonly ClubMemberSourceRow[]) => void) | undefined;
  const source = {
    readSnapshot: vi.fn(() => new Promise<readonly ClubMemberSourceRow[]>((resolve) => {
      resolveSnapshot = resolve;
    })),
  } satisfies MemberSourceRepository;
  const { service, directory } = serviceFor({ source });

  await expect(service.startupAttempt(10)).resolves.toBe('timed-out');
  expect(directory.indexPending).not.toHaveBeenCalled();
  resolveSnapshot?.([sourceRow()]);
  await expect(service.sync()).resolves.toMatchObject({ accepted: 1 });
  expect(directory.indexPending).toHaveBeenCalledWith(1000);
});

it('reports whether a successful source snapshot exists', async () => {
  const source = { readSnapshot: vi.fn().mockResolvedValue([sourceRow()]) };
  const { service } = serviceFor({ source });

  await expect(service.hasSuccessfulSnapshot()).resolves.toBe(false);
  await service.sync();
  await expect(service.hasSuccessfulSnapshot()).resolves.toBe(true);
});

it('serializes only sync counts and never profile contents', async () => {
  const secretProfile = 'СЕКРЕТНЫЙ ПРОФИЛЬ НИКОГДА НЕ ЛОГИРОВАТЬ';
  const source = { readSnapshot: vi.fn().mockResolvedValue([
    sourceRow({ expertise: secretProfile }),
  ]) } satisfies MemberSourceRepository;
  const infoLog = vi.spyOn(logger, 'info');
  const { service } = serviceFor({ source });

  await service.sync();

  const serialized = infoLog.mock.calls.map((call) =>
    renderPinoJson(call as CapturedLogCall)).join('\n');
  expect(serialized).not.toContain(secretProfile);
});
