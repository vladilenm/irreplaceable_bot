import type { PublicationDispatcher } from './publication-dispatcher.js';
import type { ScheduledPublicationRepository } from './scheduled-publication.repository.js';
import type { ThreadSummaryResult } from './types.js';
import { moscowDateKey, nextMoscowMidnight } from './time.js';

export interface PublicationDestination {
  targetChatId: number;
  threadId: number;
}

interface SummaryPublicationPersistence {
  publications: ScheduledPublicationRepository;
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
    messageFormat: 'regular-html',
    originDigestId: null,
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
