import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchFeeds } from '../../services/rss.service.js';
import { filterArticles } from '../../services/ai.service.js';
import { logger } from '../../utils/logger.js';

export interface DigestResult {
  text: string;
  itemCount: number;
  skipped: boolean;
  date: Date;
  alreadyPublished: boolean;
}

export interface PipelineState {
  lastDigestDate: string | null;
  lastSkipped: boolean;
  lastItemCount: number;
}

export interface RunPipelineOptions {
  /** If true, bypass isDigestPublishedToday() short-circuit. Default: false. */
  skipIdempotency?: boolean;
  /** If true, write data/state.json after the run. Default: true. */
  persistState?: boolean;
}

const STATE_PATH = new URL('../../../data/state.json', import.meta.url);

export function readState(): PipelineState {
  try {
    const raw = readFileSync(STATE_PATH, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'lastDigestDate' in parsed &&
      'lastSkipped' in parsed
    ) {
      const state = parsed as Record<string, unknown>;
      return {
        lastDigestDate:
          typeof state['lastDigestDate'] === 'string' ? state['lastDigestDate'] : null,
        lastSkipped: typeof state['lastSkipped'] === 'boolean' ? state['lastSkipped'] : false,
        lastItemCount:
          typeof state['lastItemCount'] === 'number' ? state['lastItemCount'] : 0,
      };
    }
    return { lastDigestDate: null, lastSkipped: false, lastItemCount: 0 };
  } catch {
    logger.warn('State file not found or corrupted, using defaults');
    return { lastDigestDate: null, lastSkipped: false, lastItemCount: 0 };
  }
}

function toMskDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' });
}

export function isDigestPublishedToday(): boolean {
  const state = readState();
  if (state.lastDigestDate === null) {
    return false;
  }
  const todayMsk = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' });
  const lastMsk = toMskDate(state.lastDigestDate);
  return todayMsk === lastMsk;
}

function writeState(state: PipelineState): void {
  const statePath = fileURLToPath(STATE_PATH);
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
  logger.debug({ state }, 'Pipeline state saved');
}

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
      writeState({
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
  const skipped = itemCount < 3;

  if (skipped) {
    logger.warn(
      { itemCount },
      'Fewer than 3 items in digest, marking as skipped',
    );
  } else {
    logger.info({ itemCount }, 'Digest ready');
  }

  if (persistState) {
    writeState({
      lastDigestDate: new Date().toISOString(),
      lastSkipped: skipped,
      lastItemCount: itemCount,
    });
  }

  return { text, itemCount, skipped, date: new Date(), alreadyPublished: false };
}
