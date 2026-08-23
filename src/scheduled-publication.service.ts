import { formatDigestHtml, type DigestResult } from './radar.js';
import type { PublicationDispatcher } from './publication-dispatcher.js';
import type { JobStateRepository } from './job-state.repository.js';
import type { ScheduledPublicationRepository } from './scheduled-publication.repository.js';
import type { ThreadSummaryResult } from './types.js';
import { moscowDateKey, nextMoscowMidnight } from './time.js';

export interface PublicationDestination {
  targetChatId: number;
  threadId: number;
}

interface DigestPublicationPersistence {
  publications: ScheduledPublicationRepository;
  jobs: JobStateRepository;
}

interface SummaryPublicationPersistence {
  publications: ScheduledPublicationRepository;
}

export async function enqueueDigestPublication(
  result: DigestResult,
  persistence: DigestPublicationPersistence,
  dispatcher: PublicationDispatcher,
  destination: PublicationDestination,
): Promise<void> {
  if (result.alreadyPublished) return;
  if (result.skipped || result.items.length === 0) {
    await persistence.jobs.recordDigest(result.date, true, result.itemCount);
    return;
  }
  await persistence.publications.enqueue({
    pipeline: 'digest',
    publicationDate: moscowDateKey(result.date),
    targetChatId: destination.targetChatId,
    threadId: destination.threadId,
    chunks: [formatDigestHtml(result.items, result.date)],
    itemCount: result.itemCount,
    nextAttemptAt: result.date,
    expiresAt: nextMoscowMidnight(result.date),
  });
  await dispatcher.dispatchDue();
}

export async function enqueueThreadSummaryPublication(
  result: ThreadSummaryResult,
  persistence: SummaryPublicationPersistence,
  dispatcher: PublicationDispatcher,
  destination: PublicationDestination,
): Promise<void> {
  if (result.alreadyPublished || result.llmOutage || result.chunks.length === 0) return;
  await persistence.publications.enqueue({
    pipeline: 'thread-summary',
    publicationDate: moscowDateKey(result.date),
    targetChatId: destination.targetChatId,
    threadId: destination.threadId,
    chunks: result.chunks,
    itemCount: 0,
    nextAttemptAt: result.date,
    expiresAt: nextMoscowMidnight(result.date),
  });
  await dispatcher.dispatchDue();
}
