import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  existsSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../utils/logger.js';
import type { PipelineStateV2 } from '../types/index.js';

// state.json lives in data/ (Phase 4 mounts as Docker volume).
// Same path as v1.0 — backward-compatible.
const STATE_PATH = new URL('../../data/state.json', import.meta.url);

const DEFAULT_STATE: PipelineStateV2 = {
  lastDigestDate: null,
  lastSkipped: false,
  lastItemCount: 0,
  lastThreadSummaryDate: null,
};

/**
 * Read pipeline state from data/state.json.
 *
 * STATE-02 / D-30 behaviour change: corrupt JSON THROWS (was silent default
 * fallback). Caller (digest cycle, thread-summary cycle) MUST catch + log
 * ERROR + skip publish. Silent fallback would lose idempotency on a
 * corrupt-state edge case → duplicate publish.
 *
 * Missing file is NOT corrupt — returns defaults (first-boot path).
 */
export function readState(): PipelineStateV2 {
  const path = fileURLToPath(STATE_PATH);
  if (!existsSync(path)) {
    return { ...DEFAULT_STATE };
  }
  const raw = readFileSync(path, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`State file corrupted at ${path}: ${msg}`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`State file corrupted at ${path}: not a JSON object`);
  }
  const state = parsed as Record<string, unknown>;
  return {
    lastDigestDate:
      typeof state['lastDigestDate'] === 'string' ? state['lastDigestDate'] : null,
    lastSkipped: typeof state['lastSkipped'] === 'boolean' ? state['lastSkipped'] : false,
    lastItemCount:
      typeof state['lastItemCount'] === 'number' ? state['lastItemCount'] : 0,
    // Phase 6 D-28: new field. v1.0 state files lack it → default null (back-compat).
    lastThreadSummaryDate:
      typeof state['lastThreadSummaryDate'] === 'string'
        ? state['lastThreadSummaryDate']
        : null,
  };
}

/**
 * Write pipeline state atomically: writeFileSync(tmp) + renameSync(tmp, final).
 * STATE-01 / D-29: rename is atomic on POSIX (single inode flip). A SIGKILL in
 * the middle leaves either the old final file or a stranded .tmp — never a
 * truncated final file.
 */
export function writeState(state: PipelineStateV2): void {
  const finalPath = fileURLToPath(STATE_PATH);
  const tmpPath = `${finalPath}.tmp`;
  mkdirSync(dirname(finalPath), { recursive: true });
  writeFileSync(tmpPath, JSON.stringify(state, null, 2) + '\n');
  renameSync(tmpPath, finalPath);
  logger.debug({ state }, 'Pipeline state saved (atomic)');
}

function todayMsk(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' });
}

function toMskDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' });
}

/**
 * Idempotency check for digest job. Reads state — if read throws, the caller
 * (cron handler) catches and decides (skip publish for this cycle).
 */
export function isDigestPublishedToday(): boolean {
  const state = readState();
  if (state.lastDigestDate === null) return false;
  return todayMsk() === toMskDate(state.lastDigestDate);
}

/**
 * WR-03 helper: pure idempotency check on a caller-provided state snapshot.
 * Use this in pipelines that already loaded `state` via `readState()` to avoid
 * a second `readFileSync` + `JSON.parse` per cycle.
 */
export function isThreadSummaryPublishedTodayWithState(state: PipelineStateV2): boolean {
  if (state.lastThreadSummaryDate === null) return false;
  return todayMsk() === toMskDate(state.lastThreadSummaryDate);
}
