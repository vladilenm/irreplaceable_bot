import type { Api } from 'grammy';
import { logger, errMsg } from './logger.js';
import { config } from './config.js';
import { summarizeThread } from './summarizer.js';
import { sendMessageWithRetry } from './telegram.js';
import {
  readState,
  isThreadSummaryPublishedTodayWithState,
  selectMessagesInWindow,
} from './database.js';
import type {
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
    llmOutage: false,
  };
}

export async function runThreadSummaryPipeline(
  opts: RunThreadSummaryOptions = {},
): Promise<ThreadSummaryResult> {
  const skipIdempotency = opts.skipIdempotency ?? false;
  const persistState = opts.persistState ?? true;
  const windowHours = opts.windowHours ?? DEFAULT_WINDOW_HOURS;

  let state: ReturnType<typeof readState>;
  try {
    state = readState();
  } catch (err: unknown) {
    logger.error(
      { err },
      'runThreadSummaryPipeline: job state read failed, publish blocked',
    );
    return emptyResult(false, persistState);
  }

  if (!skipIdempotency && isThreadSummaryPublishedTodayWithState(state)) {
    logger.warn(
      { lastThreadSummaryDate: state.lastThreadSummaryDate },
      'Thread-summary already published today (MSK), skipping',
    );
    return emptyResult(true, persistState);
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
    // One broken thread must not abort summaries for the others.
    try {
      const messages = selectMessagesInWindow(config.targetChatId, threadId, sinceIso);
      // Count captured rows, not only summaries the LLM managed to interpret.
      // This keeps result metadata (and the rendered total on partial success)
      // truthful even when a sibling thread is skipped.
      totalMessageCount += messages.length;
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

  // Preserve first occurrence when the same external link appears in several topics.
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

  // A full transport outage is operationally different from a valid empty run:
  // publishing and job-state advancement are blocked so the next cycle can retry.
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
