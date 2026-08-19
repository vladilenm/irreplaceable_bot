import type { Api } from 'grammy';
import { fetchFeeds } from './radar.sources.js';
import { filterArticles } from './radar.curator.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { sendMessageWithRetry } from './telegram.js';
import type { DigestCategory, DigestItem } from './types.js';
import {
  readState,
  recordDigestCompletion,
  isDigestPublishedTodayWithState,
} from './database.js';

export interface DigestResult {
  items: DigestItem[];
  itemCount: number;
  skipped: boolean;
  date: Date;
  alreadyPublished: boolean;
  /** Record completion only after Telegram confirms delivery. */
  persistState: boolean;
}

export interface RunPipelineOptions {
  /** If true, bypass isDigestPublishedToday() short-circuit. Default: false. */
  skipIdempotency?: boolean;
  /** Persist the job result. Default: true. */
  persistState?: boolean;
}

function emptyResult(
  alreadyPublished: boolean,
  skipped: boolean,
  persistState: boolean,
): DigestResult {
  return { items: [], itemCount: 0, skipped, date: new Date(), alreadyPublished, persistState };
}

export async function runDigestPipeline(
  opts: RunPipelineOptions = {},
): Promise<DigestResult> {
  const skipIdempotency = opts.skipIdempotency ?? false;
  const persistState = opts.persistState ?? true;

  const state = readState();

  // Manual development runs can bypass the Moscow-day idempotency guard.
  if (!skipIdempotency && isDigestPublishedTodayWithState(state)) {
    logger.warn(
      { lastDigestDate: state.lastDigestDate },
      'Digest already published today (MSK), skipping',
    );
    return emptyResult(true, false, persistState);
  }

  const hoursBack = state.lastSkipped ? 48 : 24;

  logger.info(
    {
      hoursBack,
      lastSkipped: state.lastSkipped,
      lastDigestDate: state.lastDigestDate,
      skipIdempotency,
      persistState,
    },
    'Starting digest pipeline',
  );

  const articles = await fetchFeeds(hoursBack);

  if (articles.length === 0) {
    logger.warn({ hoursBack }, 'No articles found in time window');
    if (persistState) {
      recordDigestCompletion(new Date(), true, 0);
    }
    return {
      items: [],
      itemCount: 0,
      skipped: true,
      date: new Date(),
      alreadyPublished: false,
      persistState,
    };
  }

  logger.info(
    { articleCount: articles.length },
    'Fetched articles, sending to AI filter',
  );

  const items = await filterArticles(articles);
  const itemCount = items.length;
  const skipped = itemCount < 1;

  if (skipped) {
    logger.warn(
      { itemCount },
      'No items in digest, marking as skipped',
    );
  } else {
    logger.info({ itemCount }, 'Digest ready');
  }

  // A skipped run has nothing to deliver, so it can be recorded immediately.
  // A successful run is recorded by sendDigest only after Telegram accepts it.
  if (skipped && persistState) {
    recordDigestCompletion(new Date(), true, itemCount);
  }

  return {
    items,
    itemCount,
    skipped,
    date: new Date(),
    alreadyPublished: false,
    persistState,
  };
}

const CATEGORY_EMOJI: Record<DigestCategory, string> = {
  agents: '🤖',
  orchestration: '🔗',
  models: '🧠',
  tools: '🛠',
  technologies: '⚡',
  business: '💰',
};

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttribute(input: string): string {
  return escapeHtml(input).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function formatDigestHtml(items: DigestItem[], date: Date): string {
  const header = `<b>📡 AI-радар | ${date.toLocaleDateString('ru-RU', {
    timeZone: 'Europe/Moscow',
  })}</b>`;
  const blocks = items.map((item) => {
    const title = `${CATEGORY_EMOJI[item.category]} ${escapeHtml(item.title)}`;
    return [
      `<b><a href="${escapeAttribute(item.url)}">${title}</a></b>`,
      escapeHtml(item.summary),
    ].join('\n');
  });
  return [header, ...blocks, '———\nДайджест Клуба Незаменимых'].join('\n\n');
}

export async function sendDigest(api: Api, result: DigestResult): Promise<void> {
  if (result.skipped || result.items.length === 0) {
    logger.warn({ itemCount: result.itemCount }, 'Digest skipped, not sending');
    return;
  }

  await sendMessageWithRetry(api, {
    chatId: config.targetChatId,
    threadId: config.aiRadarThreadId,
    text: formatDigestHtml(result.items, result.date),
    parseMode: 'HTML',
    pipeline: 'digest',
  });

  if (result.persistState) {
    recordDigestCompletion(new Date(), false, result.itemCount);
  }

  logger.info(
    { itemCount: result.itemCount, date: result.date.toISOString() },
    'Digest published',
  );
}
