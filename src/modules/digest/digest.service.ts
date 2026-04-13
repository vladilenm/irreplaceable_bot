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
}

interface PipelineState {
  lastDigestDate: string | null;
  lastSkipped: boolean;
}

const STATE_PATH = new URL('../../../data/state.json', import.meta.url);

function readState(): PipelineState {
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
      };
    }
    return { lastDigestDate: null, lastSkipped: false };
  } catch {
    logger.warn('State file not found or corrupted, using defaults');
    return { lastDigestDate: null, lastSkipped: false };
  }
}

function writeState(state: PipelineState): void {
  const statePath = fileURLToPath(STATE_PATH);
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
  logger.debug({ state }, 'Pipeline state saved');
}

function countDigestItems(text: string): number {
  const matches = text.match(/→ https?:\/\//g);
  return matches ? matches.length : 0;
}

export async function runDigestPipeline(): Promise<DigestResult> {
  const state = readState();
  const hoursBack = state.lastSkipped ? 48 : 24;

  logger.info(
    { hoursBack, lastSkipped: state.lastSkipped, lastDigestDate: state.lastDigestDate },
    'Starting digest pipeline',
  );

  const articles = await fetchFeeds(hoursBack);

  if (articles.length === 0) {
    logger.warn({ hoursBack }, 'No articles found in time window');
    writeState({ lastDigestDate: new Date().toISOString(), lastSkipped: true });
    return { text: '', itemCount: 0, skipped: true, date: new Date() };
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

  writeState({
    lastDigestDate: new Date().toISOString(),
    lastSkipped: skipped,
  });

  return { text, itemCount, skipped, date: new Date() };
}
