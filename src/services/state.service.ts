import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getDb } from './db.service.js';
import { logger } from '../utils/logger.js';
import type { PipelineStateV2 } from '../types/index.js';

const LEGACY_STATE_PATH = fileURLToPath(
  new URL('../../data/state.json', import.meta.url),
);

const DEFAULT_STATE: PipelineStateV2 = {
  lastDigestDate: null,
  lastSkipped: false,
  lastItemCount: 0,
  lastThreadSummaryDate: null,
};

interface JobStateRow {
  job_name: 'digest' | 'thread-summary';
  last_completed_at: string | null;
  last_outcome: 'success' | 'skipped';
  item_count: number;
}

function parseLegacyState(raw: string): PipelineStateV2 {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('not a JSON object');
  }
  const state = parsed as Record<string, unknown>;
  return {
    lastDigestDate:
      typeof state['lastDigestDate'] === 'string' ? state['lastDigestDate'] : null,
    lastSkipped:
      typeof state['lastSkipped'] === 'boolean' ? state['lastSkipped'] : false,
    lastItemCount:
      typeof state['lastItemCount'] === 'number' ? state['lastItemCount'] : 0,
    lastThreadSummaryDate:
      typeof state['lastThreadSummaryDate'] === 'string'
        ? state['lastThreadSummaryDate']
        : null,
  };
}

export function readState(): PipelineStateV2 {
  const rows = getDb()
    .prepare(
      `SELECT job_name, last_completed_at, last_outcome, item_count
       FROM job_state`,
    )
    .all() as JobStateRow[];
  const digest = rows.find((row) => row.job_name === 'digest');
  const threadSummary = rows.find((row) => row.job_name === 'thread-summary');

  return {
    lastDigestDate: digest?.last_completed_at ?? DEFAULT_STATE.lastDigestDate,
    lastSkipped: digest?.last_outcome === 'skipped',
    lastItemCount: digest?.item_count ?? DEFAULT_STATE.lastItemCount,
    lastThreadSummaryDate:
      threadSummary?.last_completed_at ?? DEFAULT_STATE.lastThreadSummaryDate,
  };
}

export function writeState(state: PipelineStateV2): void {
  const db = getDb();
  const upsert = db.prepare(`
    INSERT INTO job_state (job_name, last_completed_at, last_outcome, item_count)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(job_name) DO UPDATE SET
      last_completed_at = excluded.last_completed_at,
      last_outcome = excluded.last_outcome,
      item_count = excluded.item_count
  `);

  db.transaction(() => {
    upsert.run(
      'digest',
      state.lastDigestDate,
      state.lastSkipped ? 'skipped' : 'success',
      state.lastItemCount,
    );
    upsert.run('thread-summary', state.lastThreadSummaryDate, 'success', 0);
  })();
}

/**
 * Import the old JSON state exactly once on the first boot after upgrading.
 * The file is left in place as a rollback aid; non-empty SQLite state always
 * wins on subsequent starts.
 */
export function importLegacyState(legacyPath = LEGACY_STATE_PATH): boolean {
  const count = (
    getDb().prepare('SELECT COUNT(*) AS count FROM job_state').get() as { count: number }
  ).count;
  if (count > 0 || !existsSync(legacyPath)) return false;

  try {
    writeState(parseLegacyState(readFileSync(legacyPath, 'utf8')));
    logger.info({ legacyPath }, 'Imported legacy job state into SQLite');
    return true;
  } catch (err: unknown) {
    logger.warn({ err, legacyPath }, 'Legacy state.json could not be imported');
    return false;
  }
}

function todayMsk(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' });
}

function toMskDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' });
}

export function isDigestPublishedToday(): boolean {
  const state = readState();
  if (state.lastDigestDate === null || state.lastSkipped) return false;
  return todayMsk() === toMskDate(state.lastDigestDate);
}

export function isThreadSummaryPublishedTodayWithState(
  state: PipelineStateV2,
): boolean {
  if (state.lastThreadSummaryDate === null) return false;
  return todayMsk() === toMskDate(state.lastThreadSummaryDate);
}
