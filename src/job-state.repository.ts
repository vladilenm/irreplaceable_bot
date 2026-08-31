import type { Queryable } from './db/types.js';
import type { PipelineState } from './types.js';

export interface JobStateRepository {
  read(): Promise<PipelineState>;
  recordDigest(completedAt: Date, skipped: boolean, itemCount: number): Promise<void>;
  recordThreadSummary(completedAt: Date): Promise<void>;
}

function sameMskDay(iso: string): boolean {
  const options = { timeZone: 'Europe/Moscow' } as const;
  return (
    new Date().toLocaleDateString('en-CA', options) ===
    new Date(iso).toLocaleDateString('en-CA', options)
  );
}

export function isThreadSummaryPublishedTodayWithState(state: PipelineState): boolean {
  return Boolean(state.lastThreadSummaryDate && sameMskDay(state.lastThreadSummaryDate));
}

interface JobStateRow {
  job_name: 'digest' | 'thread-summary';
  last_completed_at: Date | null;
  last_outcome: 'success' | 'skipped';
  item_count: number;
}

export class PgJobStateRepository implements JobStateRepository {
  constructor(private readonly db: Queryable) {}

  async read(): Promise<PipelineState> {
    const result = await this.db.query<JobStateRow>(`
      SELECT job_name, last_completed_at, last_outcome, item_count
      FROM job_state
      ORDER BY job_name
    `);
    const digest = result.rows.find((row) => row.job_name === 'digest');
    const summary = result.rows.find((row) => row.job_name === 'thread-summary');
    return {
      lastDigestDate: digest?.last_completed_at?.toISOString() ?? null,
      lastSkipped: digest?.last_outcome === 'skipped',
      lastItemCount: digest?.item_count ?? 0,
      lastThreadSummaryDate: summary?.last_completed_at?.toISOString() ?? null,
    };
  }

  async recordDigest(
    completedAt: Date,
    skipped: boolean,
    itemCount: number,
  ): Promise<void> {
    await this.db.query(`
      INSERT INTO job_state(job_name, last_completed_at, last_outcome, item_count)
      VALUES ('digest', $1, $2, $3)
      ON CONFLICT(job_name) DO UPDATE SET
        last_completed_at = EXCLUDED.last_completed_at,
        last_outcome = EXCLUDED.last_outcome,
        item_count = EXCLUDED.item_count
    `, [completedAt, skipped ? 'skipped' : 'success', itemCount]);
  }

  async recordThreadSummary(completedAt: Date): Promise<void> {
    await this.db.query(`
      INSERT INTO job_state(job_name, last_completed_at, last_outcome, item_count)
      VALUES ('thread-summary', $1, 'success', 0)
      ON CONFLICT(job_name) DO UPDATE SET
        last_completed_at = EXCLUDED.last_completed_at,
        last_outcome = 'success',
        item_count = 0
    `, [completedAt]);
  }
}
