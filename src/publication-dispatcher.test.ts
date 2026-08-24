import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPublicationDispatcher,
  retryDelayMs,
} from './publication-dispatcher.js';
import type { JobStateRepository } from './job-state.repository.js';
import type {
  ClaimedPublication,
  ScheduledPublicationRepository,
} from './scheduled-publication.repository.js';
import type { SendMessageOnceResult } from './telegram.js';
import { RUNTIME_DEFAULTS } from './runtime-defaults.js';

const now = new Date('2030-08-23T06:00:00.000Z');
const claimed = (overrides: Partial<ClaimedPublication> = {}): ClaimedPublication => ({
  id: '1',
  pipeline: 'digest',
  publicationDate: '2030-08-23',
  targetChatId: -100123,
  threadId: 6359,
  itemCount: 2,
  attemptCount: 1,
  expiresAt: new Date('2030-08-23T21:00:00.000Z'),
  chunk: { chunkIndex: 0, text: 'rendered post' },
  ...overrides,
});

function makeRepository(item: ClaimedPublication | null): ScheduledPublicationRepository {
  return {
    enqueue: vi.fn(),
    expireDue: vi.fn(async () => 0),
    claimDue: vi.fn()
      .mockResolvedValueOnce(item)
      .mockResolvedValue(null),
    recordChunkDelivered: vi.fn(async () => item && ({
      id: item.id,
      pipeline: item.pipeline,
      itemCount: item.itemCount,
      deliveredAt: now,
    })),
    scheduleRetry: vi.fn(),
    markFailed: vi.fn(),
    markExpired: vi.fn(),
    recover: vi.fn(),
    read: vi.fn(),
    getStatusCounts: vi.fn(),
    deleteExpiredPublications: vi.fn(),
  };
}

const jobs: JobStateRepository = {
  read: vi.fn(),
  recordDigest: vi.fn(),
  recordThreadSummary: vi.fn(),
};

beforeEach(() => {
  for (const job of Object.values(jobs)) {
    vi.mocked(job).mockReset();
  }
});

function sendResult(result: SendMessageOnceResult) {
  return vi.fn(async () => result);
}

describe('publication dispatcher', () => {
  it('persists a sent chunk then advances digest state only after final delivery', async () => {
    const publications = makeRepository(claimed());
    const send = sendResult({ ok: true, message: { message_id: 501 } as never, durationMs: 10 });
    const dispatcher = createPublicationDispatcher({ publications, jobs, sendMessageOnce: send });

    await dispatcher.dispatchDue(now);

    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      chatId: -100123,
      threadId: 6359,
      text: 'rendered post',
      pipeline: 'digest',
    }));
    expect(publications.recordChunkDelivered).toHaveBeenCalledWith('1', 0, 501, now);
    expect(jobs.recordDigest).toHaveBeenCalledWith(now, false, 2);
  });

  it('persists bounded retry timing for retryable network errors', async () => {
    const publications = makeRepository(claimed({ attemptCount: 2 }));
    const send = sendResult({
      ok: false,
      errorCode: 'telegram-network',
      retryable: true,
      retryAfterMs: null,
      errorMetadata: { errorClass: 'Error' },
      durationMs: 10,
    });
    const dispatcher = createPublicationDispatcher({ publications, jobs, sendMessageOnce: send });

    await dispatcher.dispatchDue(now);

    expect(publications.scheduleRetry).toHaveBeenCalledWith(
      '1',
      new Date('2030-08-23T06:00:15.000Z'),
      'telegram-network',
    );
    expect(jobs.recordDigest).not.toHaveBeenCalled();
  });

  it('marks permanent Telegram errors as failed without an in-memory retry', async () => {
    const publications = makeRepository(claimed());
    const send = sendResult({
      ok: false,
      errorCode: 'telegram-403',
      retryable: false,
      retryAfterMs: null,
      errorMetadata: { errorClass: 'GrammyError', status: 403 },
      durationMs: 10,
    });
    const dispatcher = createPublicationDispatcher({ publications, jobs, sendMessageOnce: send });

    await dispatcher.dispatchDue(now);

    expect(publications.markFailed).toHaveBeenCalledWith('1', 'telegram-403');
    expect(publications.scheduleRetry).not.toHaveBeenCalled();
  });

  it('does not send after a retry would cross the Moscow-midnight expiry', async () => {
    const publications = makeRepository(claimed({
      expiresAt: new Date('2030-08-23T06:00:02.000Z'),
    }));
    const send = sendResult({
      ok: false,
      errorCode: 'telegram-network',
      retryable: true,
      retryAfterMs: null,
      errorMetadata: { errorClass: 'Error' },
      durationMs: 10,
    });
    const dispatcher = createPublicationDispatcher({ publications, jobs, sendMessageOnce: send });

    await dispatcher.dispatchDue(now);

    expect(publications.markExpired).toHaveBeenCalledWith('1');
    expect(publications.scheduleRetry).not.toHaveBeenCalled();
  });

  it('uses the documented persisted retry backoff', () => {
    expect([1, 2, 3, 4, 5, 6, 99].map(retryDelayMs)).toEqual([
      3_000,
      15_000,
      60_000,
      5 * 60_000,
      15 * 60_000,
      30 * 60_000,
      30 * 60_000,
    ]);
  });

  it('keeps the durable lease at least three times longer than Telegram timeout', () => {
    expect(RUNTIME_DEFAULTS.publications.deliveryLeaseMs).toBeGreaterThanOrEqual(
      RUNTIME_DEFAULTS.telegram.requestTimeoutSeconds * 3_000,
    );
  });
});
