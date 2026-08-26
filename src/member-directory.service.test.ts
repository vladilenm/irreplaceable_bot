import { expect, it, vi } from 'vitest';
import { logger } from './logger.js';
import { memberContentHash, type MemberSourceRecord } from './members.js';
import type { MemberRepository } from './members.repository.js';
import {
  MemberDirectoryService,
  normalizeMemberCard,
} from './member-directory.service.js';

const MODEL = 'text-embedding-3-small';
const embedding = () => Array.from({ length: 1536 }, (_, index) => index === 0 ? 1 : 0);
const card = (
  id: string,
  profileText = 'B2B SaaS',
  overrides: Partial<MemberSourceRecord> = {},
): MemberSourceRecord => ({
  source: 'web',
  externalId: id,
  telegramUserId: '94659185',
  displayName: ' Анна\u0000  Иванова ',
  telegramUsername: ' @ANNA_Product ',
  profileText,
  sourceUpdatedAt: '2026-08-21T10:00:00.000Z',
  active: true,
  ...overrides,
});

function repository(pending: MemberSourceRecord[] = []) {
  return {
    upsertCards: vi.fn(async (records: readonly MemberSourceRecord[]) => records.length),
    readPending: vi.fn(async () => pending),
    upsertEmbedding: vi.fn(async () => undefined),
    search: vi.fn(async () => []),
    recordIndexStatus: vi.fn(async () => ({
      provider: 'postgres',
      generation: 1,
      lastSuccessAt: '2026-08-21T10:01:00.000Z',
      embeddingModel: MODEL,
      dimensions: 1536 as const,
      activeCount: pending.length,
      pendingCount: 0,
    })),
    readIndexStatus: vi.fn(async () => null),
    countBySource: vi.fn(async () => 0),
  } satisfies MemberRepository;
}

it('normalizes cards before PostgreSQL upsert and deactivates incomplete cards', async () => {
  const members = repository();
  const service = new MemberDirectoryService({
    repository: members,
    embeddings: { model: MODEL, embed: vi.fn() },
  });

  await expect(service.upsert([
    card(' member-1 ', '  Запускала\n B2B\u0000  SaaS  '),
    card('member-2', '', { telegramUsername: 'bad username' }),
  ])).resolves.toBe(2);

  expect(members.upsertCards).toHaveBeenCalledWith([
    expect.objectContaining({
      externalId: 'member-1',
      displayName: 'Анна Иванова',
      telegramUsername: 'anna_product',
      profileText: 'Запускала\nB2B SaaS',
      active: true,
    }),
    expect.objectContaining({
      externalId: 'member-2',
      telegramUsername: '',
      profileText: '',
      active: false,
    }),
  ]);
});

it('embeds pending canonical text and records index status', async () => {
  const pending = [normalizeMemberCard(card('member-1', 'B2B SaaS'))];
  const members = repository(pending);
  const embeddings = { model: MODEL, embed: vi.fn().mockResolvedValue([embedding()]) };
  const service = new MemberDirectoryService({
    repository: members,
    embeddings,
    now: () => new Date('2026-08-21T10:01:00Z'),
  });

  await expect(service.indexPending()).resolves.toEqual({ indexed: 1, failed: 0 });
  expect(embeddings.embed).toHaveBeenCalledWith(['B2B SaaS']);
  expect(members.upsertEmbedding).toHaveBeenCalledWith(
    'web:member-1',
    MODEL,
    memberContentHash(pending[0]!),
    expect.any(Array),
  );
  expect(members.recordIndexStatus).toHaveBeenCalledWith(
    'postgres',
    MODEL,
    new Date('2026-08-21T10:01:00Z'),
  );
});

it('rejects oversized profiles and web cards without Telegram IDs before upsert', async () => {
  const members = repository();
  const service = new MemberDirectoryService({
    repository: members,
    embeddings: { model: MODEL, embed: vi.fn() },
  });

  await expect(service.upsert([card('oversized', 'x'.repeat(2501))]))
    .rejects.toThrow('member-profile-text-too-long');
  await expect(service.upsert([card('missing-id', 'Profile', { telegramUserId: null })]))
    .rejects.toThrow('member-telegram-id-required');
  expect(members.upsertCards).not.toHaveBeenCalled();
});

it('continues with the next batch after an embedding failure without logging profiles', async () => {
  const secret = 'СЕКРЕТНЫЙ ПРОФИЛЬ';
  const pending = Array.from({ length: 101 }, (_, index) =>
    card(String(index).padStart(3, '0'), `${secret} ${String(index)}`));
  const members = repository(pending);
  const embeddings = {
    model: MODEL,
    embed: vi.fn()
      .mockRejectedValueOnce(new Error('OpenAI unavailable'))
      .mockResolvedValueOnce([embedding()]),
  };
  const errorLog = vi.spyOn(logger, 'error');
  const service = new MemberDirectoryService({ repository: members, embeddings });

  await expect(service.indexPending(101)).resolves.toEqual({ indexed: 1, failed: 100 });
  expect(embeddings.embed).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(errorLog.mock.calls)).not.toContain(secret);
});
