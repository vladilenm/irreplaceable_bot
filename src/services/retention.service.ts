import type { Statement } from 'better-sqlite3';
import { getDb } from './db.service.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

export interface RetentionSweepResult {
  rowsDeleted: number;
  durationMs: number;
}

const BATCH_SIZE = 1000;

let _deleteBatchStmt: Statement<[string, string]> | null = null;

/**
 * Lazy-cached prepared statement for batched DELETE (mirrors message-store.ts STORE-04 pattern).
 *
 * Two parameters: outer cutoff (WHERE clause guard) and inner cutoff (subquery selector).
 * Both are bound as parameters — never interpolated into the SQL string (T-07-01-01 mitigation).
 *
 * sqlite3 does not support `DELETE ... LIMIT N` without SQLITE_ENABLE_UPDATE_DELETE_LIMIT
 * compile flag. We use a correlated subquery with ORDER BY created_at ASC LIMIT 1000
 * for predictable FIFO deletion (oldest-first) that leverages idx_messages_created.
 */
function deleteBatchStmt(): Statement<[string, string]> {
  _deleteBatchStmt ??= getDb().prepare<[string, string]>(`
    DELETE FROM messages
    WHERE created_at < ?
      AND id IN (
        SELECT id FROM messages
        WHERE created_at < ?
        ORDER BY created_at ASC
        LIMIT ${BATCH_SIZE}
      )
  `);
  return _deleteBatchStmt;
}

/**
 * PRIV-03: Delete messages older than config.messageRetentionDays (default 90).
 *
 * Batches deletions at ≤1000 rows per iteration, looping until DELETE returns 0
 * changed rows. This keeps WAL write locks short (~1ms per batch in WAL mode)
 * and prevents long-running transactions from blocking concurrent readers
 * (T-07-01-02 mitigation).
 *
 * Idempotency: a repeated sweep on the same dataset deletes 0 rows (the cutoff
 * is a monotone function of time). Double-fire from cron is safe (T-07-01-03).
 *
 * Emits exactly ONE structured pino INFO log at the end:
 *   { event: 'retention-sweep', rows_deleted: N, duration_ms: D }
 *
 * Designed to be called from src/scheduler/cron.ts retentionSweepHandler.
 * registerJob wraps the call in try/catch (SCHED-04) — this function may throw.
 *
 * SQL uses parameterised binding only — no string interpolation of user or env
 * values into the query body (T-07-01-01 + T-07-01-06 mitigations).
 */
export async function runRetentionSweep(): Promise<RetentionSweepResult> {
  const startedAt = Date.now();
  const cutoffMs = startedAt - config.messageRetentionDays * 86400 * 1000;
  const cutoffIso = new Date(cutoffMs).toISOString();

  const stmt = deleteBatchStmt();
  let rowsDeleted = 0;
  let iterations = 0;
  // Protective ceiling: 10_000 iterations × 1000 rows = 10M rows max.
  // If exceeded the index is likely broken or the table is unexpectedly huge —
  // better to throw and investigate than to loop forever (T-07-01-02).
  const MAX_ITER = 10_000;

  // better-sqlite3 is synchronous — `await` is not needed for the DB calls,
  // but we honour the async contract (cron handler signature, SCHED-04 wrapper).
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (iterations >= MAX_ITER) {
      throw new Error(`runRetentionSweep exceeded ${MAX_ITER} iterations — abort`);
    }
    const info = stmt.run(cutoffIso, cutoffIso);
    iterations++;
    if (info.changes === 0) break;
    rowsDeleted += info.changes;
  }

  const durationMs = Date.now() - startedAt;
  logger.info(
    { event: 'retention-sweep', rows_deleted: rowsDeleted, duration_ms: durationMs },
    'Retention sweep complete',
  );
  return { rowsDeleted, durationMs };
}

/**
 * Test-only: invalidate the cached prepared statement so that a fresh initDb()
 * (e.g. between vitest cases using _resetForTests) re-prepares against the new
 * in-memory connection. Never called by production code.
 */
export function _resetRetentionServiceForTests(): void {
  _deleteBatchStmt = null;
}
