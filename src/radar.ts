import type { Api } from 'grammy';
import { fetchFeeds } from './radar.sources.js';
import { filterArticles } from './radar.curator.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { sendMessageWithRetry } from './telegram.js';
import type { DigestCategory, DigestItem } from './types.js';
import {
  readState,
  writeState,
  isDigestPublishedToday,
} from './database.js';

export interface DigestResult {
  items: DigestItem[];
  itemCount: number;
  skipped: boolean;
  date: Date;
  alreadyPublished: boolean;
  /**
   * Phase 8 fix A: when true, sender persists `lastDigestDate` AFTER a successful
   * sendMessageWithRetry. When false (e.g. /dev-digest), sender does NOT touch
   * state.json. Skip-path state-writes (no-articles, itemCount<1) are still
   * applied INSIDE this pipeline because there is nothing to send.
   */
  persistState: boolean;
}

export interface RunPipelineOptions {
  /** If true, bypass isDigestPublishedToday() short-circuit. Default: false. */
  skipIdempotency?: boolean;
  /** If true, write data/state.json after the run. Default: true. */
  persistState?: boolean;
}

// Phase 6 D-28: state I/O extracted to ../../services/state.service.ts.
// Re-exported here for back-compat with existing callers (e.g. /dev-digest
// command in Phase 03.1) that imported these from the digest module.
export { readState, writeState, isDigestPublishedToday };

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

  // Idempotency guard (D-01, D-02): if a non-skipped digest already shipped
  // today in MSK, don't re-run or re-send.
  // Dev-run: skip MSK-day idempotency guard so /dev-digest can be called repeatedly.
  if (!skipIdempotency && isDigestPublishedToday() && state.lastSkipped === false) {
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
      // Phase 6 D-33: merge-write — preserve lastThreadSummaryDate across
      // digest cycle writes so the digest job never clobbers the thread-summary
      // idempotency field.
      const prev = readState();
      writeState({
        ...prev,
        lastDigestDate: new Date().toISOString(),
        lastSkipped: true,
        lastItemCount: 0,
      });
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

  // Phase 8 fix A: split state-write between skip-path (here, nothing to send)
  // and success-path (sender, after Telegram confirms delivery). The skip-path
  // write below preserves lastSkipped/lastItemCount semantics for the next
  // cycle's `hoursBack = 48` lookback. The success-path write was removed —
  // sendDigest now writes lastDigestDate ONLY after sendMessageWithRetry resolves.
  if (skipped && persistState) {
    // Phase 6 D-33: merge-write — preserve lastThreadSummaryDate.
    const prev = readState();
    writeState({
      ...prev,
      lastDigestDate: new Date().toISOString(),
      lastSkipped: true,
      lastItemCount: itemCount,
    });
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
    const prev = readState();
    writeState({
      ...prev,
      lastDigestDate: new Date().toISOString(),
      lastSkipped: false,
      lastItemCount: result.itemCount,
    });
  }

  logger.info(
    { itemCount: result.itemCount, date: result.date.toISOString() },
    'Digest published',
  );
}
