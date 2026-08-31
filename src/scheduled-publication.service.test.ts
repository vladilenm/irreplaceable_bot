import { describe, expect, it, vi } from 'vitest';
import { enqueueDigestPublication, enqueueThreadSummaryPublication } from './scheduled-publication.service.js';
import type { PublicationDispatcher } from './publication-dispatcher.js';
import type { ScheduledPublicationRepository } from './scheduled-publication.repository.js';
import type { DigestResult } from './radar.js';
import type { ThreadSummaryResult } from './types.js';
import type { JobStateRepository } from './job-state.repository.js';

const publications: ScheduledPublicationRepository = {
  enqueue: vi.fn(async () => ({ id: '1', created: true })),
  claimDue: vi.fn(),
  recordChunkDelivered: vi.fn(),
  scheduleRetry: vi.fn(),
  markFailed: vi.fn(),
  markExpired: vi.fn(),
  expireDue: vi.fn(),
  recover: vi.fn(),
  read: vi.fn(),
  getStatusCounts: vi.fn(),
  deleteExpiredPublications: vi.fn(),
};
const jobs: JobStateRepository = {
  read: vi.fn(),
  recordDigest: vi.fn(),
  recordThreadSummary: vi.fn(),
};
const dispatcher: PublicationDispatcher = {
  dispatchDue: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
};
const destination = { targetChatId: -100123, threadId: 6359 };

function resetMocks(): void {
  for (const value of [...Object.values(publications), ...Object.values(jobs), ...Object.values(dispatcher)]) {
    if (typeof value === 'function') vi.mocked(value).mockClear();
  }
}

describe('scheduled publication handoff', () => {
  it('stores the rendered digest before asking the dispatcher to send it', async () => {
    resetMocks();
    const result: DigestResult = {
      items: [{ title: 'Title', summary: 'Summary', url: 'https://example.com', category: 'agents' }],
      itemCount: 1,
      skipped: false,
      date: new Date('2030-08-23T06:00:00.000Z'),
      alreadyPublished: false,
      persistState: false,
    };

    await enqueueDigestPublication(result, { publications, jobs }, dispatcher, destination);

    expect(publications.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      pipeline: 'digest',
      messageFormat: 'regular-html',
      originDigestId: null,
      publicationDate: '2030-08-23',
      targetChatId: -100123,
      threadId: 6359,
      itemCount: 1,
      chunks: [expect.stringContaining('Title')],
    }));
    expect(dispatcher.dispatchDue).toHaveBeenCalledOnce();
  });

  it('records an empty digest as skipped without creating a Telegram publication', async () => {
    resetMocks();
    const result: DigestResult = {
      items: [], itemCount: 0, skipped: true,
      date: new Date('2030-08-23T06:00:00.000Z'), alreadyPublished: false, persistState: false,
    };

    await enqueueDigestPublication(result, { publications, jobs }, dispatcher, destination);

    expect(jobs.recordDigest).toHaveBeenCalledWith(result.date, true, 0);
    expect(publications.enqueue).not.toHaveBeenCalled();
    expect(dispatcher.dispatchDue).not.toHaveBeenCalled();
  });

  it('stores all rendered summary chunks in their configured shared topic', async () => {
    resetMocks();
    const result: ThreadSummaryResult = {
      alreadyPublished: false,
      threadsSummarised: 1,
      threadsSkippedLowVolume: 0,
      threadsSkippedError: 0,
      totalMessageCount: 10,
      date: new Date('2030-08-23T06:30:00.000Z'),
      chunks: ['one', 'two'],
      persistState: false,
      llmOutage: false,
    };

    await enqueueThreadSummaryPublication(result, { publications }, dispatcher, destination);

    expect(publications.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      pipeline: 'thread-summary',
      messageFormat: 'regular-html',
      originDigestId: null,
      threadId: 6359,
      chunks: ['one', 'two'],
    }));
    expect(dispatcher.dispatchDue).toHaveBeenCalledOnce();
  });
});
