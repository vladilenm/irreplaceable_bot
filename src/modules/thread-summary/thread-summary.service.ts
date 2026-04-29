// Phase 6 orchestrator (D-32..D-35, DLV-06, DLV-07, DLV-10).
// Pulls together: tracking whitelist + DB queries + summarizer + formatter + state.
// Per-thread try/catch (D-34) — one LLM error doesn't abort cycle.
// Title resolution: cached-only (DB) — see refreshThreadTitle JSDoc (WR-01 fix).
// Sliding 24h window from cron-fire (CONTEXT "Window semantics" Claude's Discretion).

import { logger } from '../../utils/logger.js';
import { listTrackedThreadIds } from '../../services/tracking.service.js';
import { listTracked } from '../../stores/tracked-threads-store.js';
import {
  selectMessagesInWindow,
  selectTopParticipants,
} from '../../stores/message-store.js';
import { summarizeThread } from '../../services/summarizer.service.js';
import {
  readState,
  writeState,
  isThreadSummaryPublishedTodayWithState,
} from '../../services/state.service.js';
import { formatThreadSummaryPost } from './thread-summary.formatter.js';
import type {
  PipelineStateV2,
  RunThreadSummaryOptions,
  ThreadSummary,
  ThreadSummaryResult,
} from '../../types/index.js';

const DEFAULT_WINDOW_HOURS = 24;

function nowMinusHoursIso(hours: number): string {
  return new Date(Date.now() - hours * 3600 * 1000).toISOString();
}

/**
 * Resolve a thread title for display.
 *
 * Phase 6 originally attempted to call `bot.api.getForumTopic(chatId, threadId)`
 * before each cycle to refresh `tracked_threads.title`. That method does NOT
 * exist on Telegram Bot API 7.x (only `getForumTopicIconStickers` is exposed
 * by grammy 1.42.0), so the runtime guard `typeof api.getForumTopic === 'function'`
 * was always false — the refresh was permanently dead code (WR-01).
 *
 * Until Telegram exposes a real source-of-truth, this resolver is cached-only:
 * it reads the title written by `/track` (Phase 5) or migration v2 bootstrap.
 * If no cached title exists, fall back to a generic `Тред #N` label.
 */
function refreshThreadTitle(threadId: number): string {
  const cached = listTracked().find((t) => t.threadId === threadId)?.title;
  return cached ?? `Тред #${threadId}`;
}

function emptyResult(alreadyPublished: boolean): ThreadSummaryResult {
  return {
    alreadyPublished,
    threadsSummarised: 0,
    threadsSkippedLowVolume: 0,
    threadsSkippedError: 0,
    totalMessageCount: 0,
    date: new Date(),
    chunks: [],
  };
}

export async function runThreadSummaryPipeline(
  opts: RunThreadSummaryOptions = {},
): Promise<ThreadSummaryResult> {
  const skipIdempotency = opts.skipIdempotency ?? false;
  const persistState = opts.persistState ?? true;
  const windowHours = opts.windowHours ?? DEFAULT_WINDOW_HOURS;

  // D-33 step 1: idempotency. State read may throw (STATE-02 — corrupt JSON);
  // outer cron-handler try/catch from Plan 02 logs ERROR and skips publish.
  // We catch here too so the pipeline returns a meaningful result instead of throwing.
  let prevState: PipelineStateV2;
  try {
    prevState = readState();
  } catch (err: unknown) {
    logger.error(
      { err },
      'runThreadSummaryPipeline: state read failed (corrupt state.json), publish blocked',
    );
    return emptyResult(false);
  }

  // WR-03 fix: idempotency check uses the already-loaded prevState — no second
  // readState() call. The prior implementation read state.json twice per cycle
  // (once here, once inside isThreadSummaryPublishedToday) with no consistency
  // guarantee between reads.
  if (!skipIdempotency && isThreadSummaryPublishedTodayWithState(prevState)) {
    logger.warn(
      { lastThreadSummaryDate: prevState.lastThreadSummaryDate },
      'Thread-summary already published today (MSK), skipping',
    );
    return emptyResult(true);
  }

  const sinceIso = nowMinusHoursIso(windowHours);
  const threadIds = listTrackedThreadIds();
  logger.info(
    { threadCount: threadIds.length, windowHours, sinceIso, skipIdempotency, persistState },
    'Starting thread-summary pipeline',
  );

  const summaries: ThreadSummary[] = [];
  const titles = new Map<number, string>();
  let threadsSummarised = 0;
  let threadsSkippedLowVolume = 0;
  let threadsSkippedError = 0;
  let totalMessageCount = 0;

  for (const threadId of threadIds) {
    // Per-thread try/catch (D-34) — one fail doesn't abort cycle.
    try {
      const title = refreshThreadTitle(threadId);
      titles.set(threadId, title);

      const messages = selectMessagesInWindow(threadId, sinceIso);
      const participants = selectTopParticipants(threadId, sinceIso, 3).map((p) => ({
        displayName: p.authorName,
        messageCount: p.messageCount,
      }));

      const summary = await summarizeThread({ threadId, windowHours, messages, participants });
      summaries.push(summary);

      if (summary.skipped) {
        if (summary.reason === 'low-volume') {
          threadsSkippedLowVolume++;
        } else {
          threadsSkippedError++;
        }
      } else {
        threadsSummarised++;
        totalMessageCount += summary.messageCount;
      }
    } catch (err: unknown) {
      logger.error({ err, threadId }, 'Per-thread summary failed, isolating');
      summaries.push({
        skipped: true,
        threadId,
        windowHours,
        messageCount: 0,
        reason: 'llm-error',
      });
      threadsSkippedError++;
    }
  }

  const date = new Date();
  const chunks = formatThreadSummaryPost({ summaries, titles, date });

  // D-33 step 7: merge-write — preserve digest fields.
  if (persistState) {
    writeState({
      ...prevState,
      lastThreadSummaryDate: date.toISOString(),
    });
  }

  logger.info(
    {
      event: 'thread-summary-pipeline-complete',
      threadsSummarised,
      threadsSkippedLowVolume,
      threadsSkippedError,
      totalMessageCount,
      chunkCount: chunks.length,
    },
    'Thread-summary pipeline complete',
  );

  return {
    alreadyPublished: false,
    threadsSummarised,
    threadsSkippedLowVolume,
    threadsSkippedError,
    totalMessageCount,
    date,
    chunks,
  };
}
