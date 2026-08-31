import { expect, it, vi } from 'vitest';
import type { Update } from 'grammy/types';
import type { JobStateRepository } from './job-state.repository.js';
import type { MessageRepository } from './messages.repository.js';
import type { MemberRepository } from './members.repository.js';
import type { RequestMatchingRuntime } from './request.runtime.js';
import type { ScheduledPublicationRepository } from './scheduled-publication.repository.js';

const mocks = vi.hoisted(() => {
  const order: string[] = [];
  return {
    order,
    registerCaptureHandlers: vi.fn(() => order.push('capture')),
    registerPrivateRequestCommand: vi.fn((_bot: unknown, _options: unknown) =>
      order.push('private-request')),
    registerRequestHandlers: vi.fn(() => order.push('request')),
  };
});

vi.mock('./capture.js', () => ({ registerCaptureHandlers: mocks.registerCaptureHandlers }));
vi.mock('./private-request-command.js', () => ({
  registerPrivateRequestCommand: mocks.registerPrivateRequestCommand,
}));
vi.mock('./requests.js', () => ({ registerRequestHandlers: mocks.registerRequestHandlers }));
vi.mock('./config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./config.js')>();
  return {
    ...actual,
    config: { ...actual.config, privateTestAdminId: 101 },
  };
});

import { createBot } from './bot.js';
import { config } from './config.js';

const adminId = 101;
type StatusRuntime = {
  handlerOptions: RequestMatchingRuntime['handlerOptions'];
  memberRepository: Pick<MemberRepository, 'readSourceStatus' | 'readIndexStatus'>;
};

function statusUpdate(): Update {
  return {
    update_id: 1,
    message: {
      message_id: 2,
      date: 1_777_500_000,
      chat: { id: -1001, type: 'supergroup', title: 'Club' },
      from: { id: adminId, is_bot: false, first_name: 'Admin' },
      text: '/status',
      entities: [{ offset: 0, length: 7, type: 'bot_command' }],
    },
  };
}

async function runStatus(
  requestMatching: StatusRuntime,
): Promise<string> {
  const bot = createBot({
    persistence: { jobs, messages, publications },
    requestMatching: requestMatching as RequestMatchingRuntime,
  });
  bot.botInfo = { id: 999, is_bot: true, first_name: 'Club bot', username: 'club_bot' } as never;
  const replies: string[] = [];
  bot.api.config.use(async (_previous, method, payload) => {
    if (method === 'getChatAdministrators') {
      return {
        ok: true,
        result: [{
          status: 'administrator',
          user: { id: adminId, is_bot: false, first_name: 'Admin' },
        }],
      } as never;
    }
    if (method === 'sendMessage') {
      if (!('text' in payload)) throw new Error('sendMessage payload must include text');
      replies.push(String(payload.text));
      return { ok: true, result: { message_id: 3, date: 1, chat: { id: -1001, type: 'supergroup' } } } as never;
    }
    throw new Error(`Unexpected Telegram API method: ${method}`);
  });

  await bot.handleUpdate(statusUpdate());
  expect(replies).toHaveLength(1);
  return replies[0]!;
}

const jobs: JobStateRepository = {
  read: vi.fn(async () => ({
    lastDigestDate: null,
    lastSkipped: false,
    lastItemCount: 0,
    lastThreadSummaryDate: null,
  })),
  recordDigest: vi.fn(async () => undefined),
  recordThreadSummary: vi.fn(async () => undefined),
};
const messages: MessageRepository = {
  upsert: vi.fn(async () => undefined),
  selectWindow: vi.fn(async () => []),
  runRetention: vi.fn(async () => ({ rowsDeleted: 0, durationMs: 0 })),
};
const publications: ScheduledPublicationRepository = {
  enqueue: vi.fn(),
  claimDue: vi.fn(),
  recordChunkDelivered: vi.fn(),
  scheduleRetry: vi.fn(),
  markFailed: vi.fn(),
  markExpired: vi.fn(),
  expireDue: vi.fn(),
  recover: vi.fn(),
  read: vi.fn(),
  getStatusCounts: vi.fn(async () => []),
  deleteExpiredPublications: vi.fn(),
};

it('registers member requests before terminal capture middleware', () => {
  mocks.order.length = 0;
  const matcher = { match: vi.fn() };
  const isMatchingReady = vi.fn().mockResolvedValue(true);

  createBot({
    persistence: { jobs, messages, publications },
    requestMatching: {
      matcher,
      handlerOptions: { isMatchingReady },
    } as unknown as RequestMatchingRuntime,
  });

  expect(mocks.order).toEqual(['private-request', 'request', 'capture']);
  expect(mocks.registerPrivateRequestCommand.mock.calls.at(-1)?.[1]).toMatchObject({
    adminUserId: adminId,
    matcher,
    isMatchingReady,
  });
  expect(mocks.registerCaptureHandlers).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ messages }),
  );
});

it('does not register the private request command when the owner ID is absent', () => {
  mocks.order.length = 0;
  const configuredAdminId = config.privateTestAdminId;
  config.privateTestAdminId = null;
  try {
    createBot({
      persistence: { jobs, messages, publications },
      requestMatching: {
        matcher: { match: vi.fn() },
        handlerOptions: { isMatchingReady: vi.fn().mockResolvedValue(true) },
      } as unknown as RequestMatchingRuntime,
    });
  } finally {
    config.privateTestAdminId = configuredAdminId;
  }

  expect(mocks.order).toEqual(['request', 'capture']);
});

it('passes the scoped API client options to grammY', () => {
  const agent = {} as never;
  const bot = createBot({
    persistence: { jobs, messages, publications },
    telegramClientOptions: {
      timeoutSeconds: 60,
      baseFetchConfig: { agent },
    },
  });
  expect(bot.api.options).toMatchObject({
    timeoutSeconds: 60,
    baseFetchConfig: { agent },
  });
});

it('reports count-only web source and index state to an administrator', async () => {
  const profileFixtureValue = 'private canonical profile value';
  const sourceStatus = {
    provider: 'web' as const,
    generation: 4,
    lastSuccessAt: '2026-08-26T10:05:00.000Z',
    fetchedCount: 8,
    activeCount: 7,
    rejectedCount: 1,
    deactivatedCount: 2,
    profileText: profileFixtureValue,
  };
  const reply = await runStatus({
    handlerOptions: {} as never,
    memberRepository: {
      readSourceStatus: vi.fn(async () => sourceStatus),
      readIndexStatus: vi.fn(async () => ({
        provider: 'postgres',
        generation: 5,
        lastSuccessAt: '2026-08-26T10:06:00.000Z',
        embeddingModel: 'openai/text-embedding-3-small',
        dimensions: 1536 as const,
        activeCount: 7,
        pendingCount: 0,
      })),
    },
  });

  expect(reply).toContain('🗂 Источник анкет: 7 активных, 1 отклонена, поколение 4, синхронизация 26.08.2026');
  expect(reply).toContain('🧩 Индекс: 7 активных, 0 ожидают индексации, openai/text-embedding-3-small');
  expect(reply).not.toContain(profileFixtureValue);
});

it('reports that the web source has never synchronized', async () => {
  const reply = await runStatus({
    handlerOptions: {} as never,
    memberRepository: {
      readSourceStatus: vi.fn(async () => null),
      readIndexStatus: vi.fn(async () => null),
    },
  });

  expect(reply).toContain('🗂 Источник анкет: успешной синхронизации ещё не было');
  expect(reply).toContain('🧩 Индекс: ещё не готов');
  expect(reply).toContain('🗞 Дайджест: автоматически после публикации Topic Digest');
  expect(reply).not.toContain('⏰ Расписание:');
});

it('keeps the status command available when matching status reads fail', async () => {
  const reply = await runStatus({
    handlerOptions: {} as never,
    memberRepository: {
      readSourceStatus: vi.fn(async () => { throw new Error('private source failure'); }),
      readIndexStatus: vi.fn(async () => { throw new Error('private index failure'); }),
    },
  });

  expect(reply).toContain('🗂 Источник анкет: нет данных');
  expect(reply).toContain('🧩 Индекс: нет данных');
  expect(reply).not.toContain('private source failure');
  expect(reply).not.toContain('private index failure');
});
