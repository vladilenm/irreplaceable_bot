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
 * Phase 5 (`/track` command which would have INSERTed titles) was cancelled
 * 2026-04-29; the title-writer function was removed in Phase 7. As a result,
 * `tracked_threads.title` is NULL for every thread today — this resolver always
 * returns the `Тред #{threadId}` fallback. If a future phase reintroduces a
 * title-writer, this function continues to work without modification.
 */
function refreshThreadTitle(threadId: number): string {
  const cached = listTracked().find((t) => t.threadId === threadId)?.title;
  return cached ?? `Тред #${threadId}`;
}

function emptyResult(
  alreadyPublished: boolean,
  prevState: PipelineStateV2,
  persistState: boolean,
): ThreadSummaryResult {
  return {
    alreadyPublished,
    threadsSummarised: 0,
    threadsSkippedLowVolume: 0,
    threadsSkippedError: 0,
    totalMessageCount: 0,
    date: new Date(),
    chunks: [],
    persistState,
    prevState,
  };
}

const FALLBACK_STATE: PipelineStateV2 = {
  lastDigestDate: null,
  lastSkipped: false,
  lastItemCount: 0,
  lastThreadSummaryDate: null,
};

/**
 * Phase 8 fix A: post-send state-write helper. Cron handler (or any caller)
 * invokes this AFTER sendThreadSummary resolves successfully so
 * lastThreadSummaryDate is persisted ONLY on confirmed delivery. Idempotent
 * — safe to call multiple times in the same cycle (it just overwrites with
 * the same value). Honours the D-33 merge-write contract by passing
 * prevState through unchanged for non-thread-summary fields.
 */
export function markThreadSummaryPublished(
  prevState: PipelineStateV2,
  date: Date,
): void {
  writeState({
    ...prevState,
    lastThreadSummaryDate: date.toISOString(),
  });
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
    return emptyResult(false, FALLBACK_STATE, persistState);
  }

  // WR-03: idempotency check uses already-loaded prevState (single readState per cycle).
  if (!skipIdempotency && isThreadSummaryPublishedTodayWithState(prevState)) {
    logger.warn(
      { lastThreadSummaryDate: prevState.lastThreadSummaryDate },
      'Thread-summary already published today (MSK), skipping',
    );
    return emptyResult(true, prevState, persistState);
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

  // Phase 8 fix A: state-write was here. Moved to cron handler / sender path —
  // markThreadSummaryPublished(prevState, date) is now called ONLY after
  // sendThreadSummary resolves successfully, so a Telegram failure does not
  // burn the idempotency flag for the remainder of the MSK day.

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
    persistState,
    prevState,
  };
}
