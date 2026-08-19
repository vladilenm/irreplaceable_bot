// Phase 6 orchestrator (D-32..D-35, DLV-06, DLV-07, DLV-10).
// quick-260507-cni: topic-style format.
// quick-260511-fkn: LLM-side segmentation — the orchestrator no longer computes
// message ids; the LLM picks them (post-validated against the input set).
// summary-doc-260607: bullet-substance contract. Each topic carries bullets
// ({summary, msgId}); the formatter keeps topics grouped by thread and renders
// each bullet's summary as the deep-link. Link aggregation still walks
// summaries[i].topics[j].links.

import type { Api } from 'grammy';
import { logger, errMsg } from './logger.js';
import { config } from './config.js';
import { summarizeThread } from './summarizer.js';
import { sendMessageWithRetry } from './telegram.js';
import {
  readState,
  writeState,
  isThreadSummaryPublishedTodayWithState,
  selectMessagesInWindow,
} from './database.js';
import type {
  PipelineStateV2,
  RunThreadSummaryOptions,
  ThreadSummary,
  ThreadSummaryResult,
  Topic,
} from './types.js';

const DEFAULT_WINDOW_HOURS = 24;

function nowMinusHoursIso(hours: number): string {
  return new Date(Date.now() - hours * 3600 * 1000).toISOString();
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
    llmOutage: false,
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
  const threadIds = opts.trackedThreadIds ?? config.trackedThreadIds;
  logger.info(
    { threadCount: threadIds.length, windowHours, sinceIso, skipIdempotency, persistState },
    'Starting thread-summary pipeline',
  );

  const summaries: ThreadSummary[] = [];
  let threadsSummarised = 0;
  let threadsSkippedLowVolume = 0;
  let threadsSkippedError = 0;
  let totalMessageCount = 0;

  for (const threadId of threadIds) {
    // Per-thread try/catch (D-34) — one fail doesn't abort cycle.
    try {
      const messages = selectMessagesInWindow(config.targetChatId, threadId, sinceIso);
      // Count captured rows, not only summaries the LLM managed to interpret.
      // This keeps result metadata (and the rendered total on partial success)
      // truthful even when a sibling thread is skipped.
      totalMessageCount += messages.length;
      // summary-doc-260607: the LLM picks a msgId per bullet from the
      // [id=N ...] prefixes in the transcript. Orchestrator computes no ids.
      const summary = await summarizeThread({ threadId, windowHours, messages });
      summaries.push(summary);

      if (summary.skipped) {
        if (summary.reason === 'low-volume') {
          threadsSkippedLowVolume++;
        } else {
          threadsSkippedError++;
        }
      } else {
        threadsSummarised++;
      }
    } catch (err: unknown) {
      logger.error({ err, threadId }, `Per-thread summary failed, isolating: threadId=${threadId} err=${errMsg(err)}`);
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

  // quick-260511-fkn: aggregate links across non-skipped summaries. The walk
  // is now three-level (summaries → topics → links) because the LLM contract
  // moved from one-{emoji,title,links}-per-thread to N-topics-per-thread.
  // Dedup key + first-occurrence-wins semantics unchanged.
  const seenUrls = new Set<string>();
  const aggregatedLinks: Array<{ url: string; description: string }> = [];
  for (const s of summaries) {
    if (s.skipped) continue;
    for (const t of s.topics) {
      for (const link of t.links) {
        const key = link.url.trim().toLowerCase();
        if (key === '' || seenUrls.has(key)) continue;
        seenUrls.add(key);
        aggregatedLinks.push(link);
      }
    }
  }

  const date = new Date();

  // Phase 8 fix B: distinguish a full LLM transport outage for operations. If
  // every tracked thread skipped with reason:'llm-error', the pipeline returns
  // chunks=[] and llmOutage=true; the cron handler refuses to publish AND
  // refuses to advance lastThreadSummaryDate.
  // Other all-skipped combinations also yield zero chunks in the formatter;
  // `llmOutage` remains a narrower operational signal for transport outages.
  const llmOutage =
    summaries.length > 0 &&
    summaries.every(
      (s): s is Extract<ThreadSummary, { skipped: true }> =>
        s.skipped === true && s.reason === 'llm-error',
    );

  const chunks = llmOutage
    ? []
    : formatThreadSummaryPost({
        summaries,
        date,
        totalMessageCount,
        aggregatedLinks,
        chatId: config.targetChatId,
      });

  if (llmOutage) {
    logger.error(
      {
        event: 'thread-summary-llm-outage',
        threadsSkippedError,
        totalThreads: summaries.length,
        model: undefined,
      },
      'Thread-summary: ALL threads failed with llm-error — refusing to publish a misleading «тихо» post; lastThreadSummaryDate NOT advanced so the next cycle can retry',
    );
  }

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
      llmOutage,
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
    llmOutage,
  };
}

type TopicWithThread = Topic & { threadId: number };

export const MAX_CHUNK_LENGTH = 4096;
const FOOTER_TAG = '#dailysummary';
const SECTION_SEPARATOR = '\n\n';

function escapeHtml(input: string): string {
  return input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function stripChatIdPrefix(chatId: number): string {
  const value = String(chatId);
  return value.startsWith('-100') ? value.slice(4) : value.replace(/^-/, '');
}

function buildTopicBlock(topic: TopicWithThread, chatId: string): string {
  const header = `${topic.emoji} <b>${escapeHtml(topic.title)}</b>`;
  const bullets = topic.bullets.map(
    (bullet) =>
      `• <a href="https://t.me/c/${chatId}/${topic.threadId}/${bullet.msgId}">${escapeHtml(bullet.summary)}</a>`,
  );
  return [header, ...bullets].join('\n');
}

function buildLinkLine(link: { url: string; description: string }): string | null {
  if (link.url.includes('"')) return null;
  return `<a href="${link.url}">${escapeHtml(link.description)}</a>`;
}

export interface FormatThreadSummaryInput {
  summaries: ThreadSummary[];
  date: Date;
  totalMessageCount: number;
  aggregatedLinks: Array<{ url: string; description: string }>;
  chatId: number;
}

export function formatThreadSummaryPost(input: FormatThreadSummaryInput): string[] {
  const topics = input.summaries.flatMap(
    (summary): TopicWithThread[] =>
      summary.skipped
        ? []
        : summary.topics.map((topic) => ({ ...topic, threadId: summary.threadId })),
  );
  if (topics.length === 0) return [];

  const prefix = `📆 Что обсуждалось вчера ${input.date.toLocaleDateString('ru-RU', {
    timeZone: 'Europe/Moscow',
  })}\nВсего было написано ${input.totalMessageCount} сообщений`;
  const chatId = stripChatIdPrefix(input.chatId);
  const sections: string[] = topics.map((topic) => buildTopicBlock(topic, chatId));
  const links = input.aggregatedLinks
    .map(buildLinkLine)
    .filter((line): line is string => line !== null);
  if (links.length > 0) sections.push('Интересные ссылки:', ...links);
  sections.push(FOOTER_TAG);

  const chunks: string[] = [];
  let current = prefix;
  for (const section of sections) {
    const candidate = `${current}${SECTION_SEPARATOR}${section}`;
    if (candidate.length <= MAX_CHUNK_LENGTH) {
      current = candidate;
      continue;
    }
    chunks.push(current);
    current = `${prefix}${SECTION_SEPARATOR}${section}`;
    if (current.length > MAX_CHUNK_LENGTH) {
      logger.warn(
        { sectionLength: section.length, limit: MAX_CHUNK_LENGTH },
        'Single thread-summary section exceeds Telegram limit',
      );
    }
  }
  chunks.push(current);
  return chunks;
}

export async function sendThreadSummary(api: Api, chunks: string[]): Promise<void> {
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk) continue;
    await sendMessageWithRetry(api, {
      chatId: config.targetChatId,
      threadId: config.threadSummaryThreadId,
      text: chunk,
      parseMode: 'HTML',
      pipeline: 'thread-summary',
    });
    logger.info(
      { chunkIndex: i + 1, chunkCount: chunks.length, chunkLength: chunk.length },
      'Thread-summary chunk sent',
    );
  }
}
