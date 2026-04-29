// Phase 6 orchestrator (D-32..D-35, DLV-06, DLV-07, DLV-10).
// Pulls together: tracking whitelist + DB queries + summarizer + formatter + state.
// Per-thread try/catch (D-34) — one LLM error doesn't abort cycle.
// Title-refresh via getForumTopic with per-thread try/catch (D-06).
// Sliding 24h window from cron-fire (CONTEXT "Window semantics" Claude's Discretion).

import { bot } from '../../bot.js';
import { logger } from '../../utils/logger.js';
import { listTrackedThreadIds } from '../../services/tracking.service.js';
import { listTracked, upsertThreadTitle } from '../../stores/tracked-threads-store.js';
import {
  selectMessagesInWindow,
  selectTopParticipants,
} from '../../stores/message-store.js';
import { summarizeThread } from '../../services/summarizer.service.js';
import {
  readState,
  writeState,
  isThreadSummaryPublishedToday,
} from '../../services/state.service.js';
import { formatThreadSummaryPost } from './thread-summary.formatter.js';
import { config } from '../../config.js';
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

// Telegram Bot API does not expose a documented `getForumTopic` method as of
// Bot API 7.x — only create/edit/close/etc. Some clients (e.g. raw HTTP) accept
// a `getForumTopic` call that returns a ForumTopic-shaped object; tests mock it.
// We type the bot.api surface narrowly here so the orchestrator can attempt the
// call. If the method is unavailable at runtime (older bot API or library),
// the call rejects and we fall back to cached title (D-06).
interface ForumTopicLike {
  message_thread_id: number;
  name: string;
}
interface ForumTopicCapableApi {
  getForumTopic?: (chatId: string, messageThreadId: number) => Promise<ForumTopicLike>;
}

async function refreshThreadTitle(threadId: number): Promise<string> {
  // D-06: 1 API call per thread per day. Per-thread try/catch — never blocks cycle.
  // On failure: read cached title from listTracked() snapshot or fall back to "Тред #N".
  const api = bot.api as unknown as ForumTopicCapableApi;
  try {
    if (typeof api.getForumTopic === 'function') {
      const topic = await api.getForumTopic(config.targetChatId, threadId);
      if (topic.name) {
        upsertThreadTitle(threadId, topic.name);
        return topic.name;
      }
    }
  } catch (err: unknown) {
    logger.warn({ err, threadId }, 'getForumTopic failed, falling back to cached title');
  }
  // Fallback: cached title from DB or generic.
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

  if (!skipIdempotency && isThreadSummaryPublishedToday()) {
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
      const title = await refreshThreadTitle(threadId);
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
