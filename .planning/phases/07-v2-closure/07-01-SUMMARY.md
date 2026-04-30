---
phase: 07-v2-closure
plan: 01
subsystem: retention
requirements_completed: [PRIV-03]
tags: [retention, cron, sqlite, batch-delete, observability, tdd]
dependency_graph:
  requires:
    - src/services/db.service.ts (getDb, initDb)
    - src/config.ts (config.messageRetentionDays, config.retentionSweepCron)
    - src/utils/logger.ts (logger.info)
    - src/scheduler/cron.ts (registerJob SCHED-04 wrapper)
  provides:
    - src/services/retention.service.ts (runRetentionSweep, RetentionSweepResult)
  affects:
    - src/scheduler/cron.ts (retentionSweepHandler body replaced)
tech_stack:
  added: []
  patterns:
    - Lazy-cached prepared statement via ??= (STORE-04 mirror)
    - Batched DELETE via correlated subquery (sqlite3 no LIMIT on DELETE without compile flag)
    - TDD red-green cycle (failing test first, then implementation)
key_files:
  created:
    - src/services/retention.service.ts
    - src/services/retention.service.test.ts
  modified:
    - src/scheduler/cron.ts
    - src/scheduler/cron.test.ts
decisions:
  - "Correlated subquery DELETE pattern chosen over DELETE...LIMIT (sqlite3 default build lacks SQLITE_ENABLE_UPDATE_DELETE_LIMIT)"
  - "BATCH_SIZE=1000 with MAX_ITER=10000 ceiling (T-07-01-02 DoS mitigation)"
  - "cutoff = Date.now() - messageRetentionDays*86400*1000 computed inside runRetentionSweep — no user-controlled input in SQL (T-07-01-01 + T-07-01-06)"
  - "Single structured pino INFO at sweep end, not per-iteration (PRIV-05 aggregate-only)"
  - "_resetRetentionServiceForTests() invalidates ??= cached statement between vitest cases"
metrics:
  duration: ~3 minutes
  completed: "2026-04-30T10:20:58Z"
  tasks_completed: 2
  tasks_total: 2
  files_created: 2
  files_modified: 2
  tests_added: 7
---

# Phase 7 Plan 01: Retention Sweep (PRIV-03) Summary

**One-liner:** 90-day batched DELETE LIMIT 1000 retention sweep with parameterised SQL, structured pino log, and cron handler wired from stub to real implementation.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Pure runRetentionSweep service + tests | 50a79f1 | src/services/retention.service.ts, src/services/retention.service.test.ts |
| 2 | Wire runRetentionSweep into cron + cron.test.ts assertions | 59538e9 | src/scheduler/cron.ts, src/scheduler/cron.test.ts |

## What Was Built

### retention.service.ts

Pure async function `runRetentionSweep(): Promise<RetentionSweepResult>` implementing PRIV-03:

- Computes `cutoffIso = new Date(Date.now() - config.messageRetentionDays * 86400 * 1000).toISOString()`
- Lazy-cached prepared statement via `??=` (mirrors message-store STORE-04 pattern)
- Correlated subquery pattern for batched DELETE (sqlite3 default build lacks `SQLITE_ENABLE_UPDATE_DELETE_LIMIT`):
  ```sql
  DELETE FROM messages WHERE created_at < ?
    AND id IN (SELECT id FROM messages WHERE created_at < ? ORDER BY created_at ASC LIMIT 1000)
  ```
- Loop until `info.changes === 0`, protective `MAX_ITER = 10_000` ceiling
- Emits exactly one `logger.info({ event: 'retention-sweep', rows_deleted: N, duration_ms: D })` at end
- Exports `_resetRetentionServiceForTests()` for test isolation

### retention.service.test.ts (5 tests)

- T1: empty table → rowsDeleted=0, durationMs is number
- T2: 5 old + 3 recent → rowsDeleted=5, 3 remain in DB
- T3: 2500 old rows → rowsDeleted=2500, multi-batch confirmed (rowsDeleted > BATCH_SIZE)
- T4: structured log shape `{event: 'retention-sweep', rows_deleted, duration_ms}` emitted exactly once
- T5: cutoff boundary — only messages older than messageRetentionDays deleted

### cron.ts changes

- Added import: `import { runRetentionSweep } from '../services/retention.service.js'`
- Replaced stub body with: `await runRetentionSweep()`
- Removed Phase 6 D-26 stub JSDoc from handler (top-of-file overview comment with retention-sweep 04:00 MSK preserved)

### cron.test.ts additions (2 new tests)

- R1: retention-sweep registered as third job, registry size === 3
- R2: static source grep — stub log line absent, `runRetentionSweep` import present

## Deviations from Plan

None — plan executed exactly as written.

## Threat Model Verification

All STRIDE threats from plan addressed:

| Threat | Status |
|--------|--------|
| T-07-01-01 Tampering (SQL interpolation) | Mitigated — `cutoffIso` bound as parameter, never in SQL string |
| T-07-01-02 DoS (WAL locking) | Mitigated — LIMIT 1000 per batch, MAX_ITER=10000 ceiling |
| T-07-01-03 DoS (double-fire) | Accepted — idempotent by design (DELETE WHERE created_at < monotone cutoff) |
| T-07-01-04 Repudiation | Accepted — aggregate pino log sufficient for club scale |
| T-07-01-05 Info disclosure | Accepted — log contains only aggregate count, no text/author_id |
| T-07-01-06 EoP (WHERE clause injection) | Mitigated — cutoff is fully data-driven, no user-controlled WHERE |

## Known Stubs

None.

## Threat Flags

None — no new network endpoints, auth paths, or trust boundaries introduced.

## Self-Check: PASSED

- `src/services/retention.service.ts` exists: FOUND
- `src/services/retention.service.test.ts` exists: FOUND
- Commit 50a79f1: FOUND
- Commit 59538e9: FOUND
- All 13 tests pass (5 retention + 8 cron): CONFIRMED
- `npm run typecheck` exits 0: CONFIRMED
