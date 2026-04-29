import { fetchFeeds } from '../../services/rss.service.js';
import { filterArticles } from '../../services/ai.service.js';
import { logger } from '../../utils/logger.js';
import {
  readState,
  writeState,
  isDigestPublishedToday,
} from '../../services/state.service.js';

export interface DigestResult {
  text: string;
  itemCount: number;
  skipped: boolean;
  date: Date;
  alreadyPublished: boolean;
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
export { readState, writeState, isDigestPublishedToday } from '../../services/state.service.js';

function emptyResult(alreadyPublished: boolean, skipped: boolean): DigestResult {
  return { text: '', itemCount: 0, skipped, date: new Date(), alreadyPublished };
}

function countDigestItems(text: string): number {
  const matches = text.match(/→ https?:\/\//g);
  return matches ? matches.length : 0;
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
    return emptyResult(true, false);
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
    return { text: '', itemCount: 0, skipped: true, date: new Date(), alreadyPublished: false };
  }

  logger.info(
    { articleCount: articles.length },
    'Fetched articles, sending to AI filter',
  );

  const text = await filterArticles(articles);
  const itemCount = countDigestItems(text);
  const skipped = itemCount < 1;

  if (skipped) {
    logger.warn(
      { itemCount },
      'No items in digest, marking as skipped',
    );
  } else {
    logger.info({ itemCount }, 'Digest ready');
  }

  if (persistState) {
    // Phase 6 D-33: merge-write — preserve lastThreadSummaryDate.
    const prev = readState();
    writeState({
      ...prev,
      lastDigestDate: new Date().toISOString(),
      lastSkipped: skipped,
      lastItemCount: itemCount,
    });
  }

  return { text, itemCount, skipped, date: new Date(), alreadyPublished: false };
}
