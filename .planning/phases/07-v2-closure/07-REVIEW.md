---
phase: 07-v2-closure
reviewed: 2026-04-30T00:00:00Z
depth: standard
files_reviewed: 8
files_reviewed_list:
  - src/modules/capture/capture.handler.ts
  - src/scheduler/cron.test.ts
  - src/scheduler/cron.ts
  - src/services/db.service.test.ts
  - src/services/db.service.ts
  - src/services/retention.service.test.ts
  - src/services/retention.service.ts
  - src/stores/message-store.ts
findings:
  critical: 0
  warning: 2
  info: 3
  total: 5
status: issues_found
---

# Phase 07: Code Review Report

**Reviewed:** 2026-04-30T00:00:00Z
**Depth:** standard
**Files Reviewed:** 8
**Status:** issues_found

## Summary

Eight files covering the Phase 7 v2.0 closure work were reviewed: the capture
handler, the cron scheduler and its test, the DB service with migration v3, the
new retention sweep service and its tests, and the message store. The code is
well-structured and the safety-critical areas (SQL parameterisation, WAL mode
enforcement, error isolation via `registerJob` try/catch) are sound.

Two warnings were identified: a lazy-cached prepared statement in
`retention.service.ts` that silently serves stale queries after a DB reconnect,
and a subtle test-reliability gap in `cron.test.ts` (C5 is a no-op assertion that
permanently passes regardless of the implementation). Three info-level items cover
a template-literal LIMIT interpolation (safe but worth a note), a dead-code stale
comment, and an unchecked return value in the capture handler.

---

## Warnings

### WR-01: Stale prepared-statement cache across DB reconnects in `retention.service.ts`

**File:** `src/services/retention.service.ts:26-36`

**Issue:** `_deleteBatchStmt` is lazily cached at module level with `??=`. In
production this is fine because `initDb()` runs once per process. However, in tests
`_resetForTests()` closes the underlying `better-sqlite3` connection and opens a
fresh `:memory:` database, while `_resetRetentionServiceForTests()` must be called
separately to null out the cached statement. If a test calls `runRetentionSweep()`
without first calling `_resetRetentionServiceForTests()`, `deleteBatchStmt()`
returns a `Statement` that was prepared against the now-closed connection.
`better-sqlite3` will throw `SqliteError: Database was closed` at `.run()` time,
which is an unobvious failure mode. The pairing is documented and tested correctly
in `retention.service.test.ts` (`beforeEach` calls both resets), so there is no
current test failure. The risk is that any future test file that imports
`runRetentionSweep` and forgets `_resetRetentionServiceForTests()` will see a
cryptic error instead of a clear contract violation.

**Fix:** Tie statement invalidation to the DB reset so it is impossible to forget.
Add a callback registration to `db.service.ts`, or — more simply — guard
`deleteBatchStmt()` with a connection-identity check:

```typescript
// retention.service.ts
function deleteBatchStmt(): Statement<[string, string]> {
  const db = getDb();
  // Re-prepare if the DB reference changed (e.g. test reset).
  if (_deleteBatchStmt === null || (_deleteBatchStmt as any).database !== db) {
    _deleteBatchStmt = db.prepare<[string, string]>(`...`);
  }
  return _deleteBatchStmt;
}
```

Alternatively, expose a `onDbReset` hook in `db.service.ts` that all stores/services register with, and call it from `_resetForTests()`. The current pattern (dual reset functions in `beforeEach`) also works as long as the constraint is documented — at minimum add a JSDoc note to `_resetRetentionServiceForTests` warning callers that it must be paired with `_resetForTests`.

---

### WR-02: No-op test assertion in `cron.test.ts` — C5 always passes regardless of behaviour

**File:** `src/scheduler/cron.test.ts:49-52`

**Issue:** Test C5 (`'C5: thread-summary handler is currently a stub (presence checked via grep)'`) contains only `expect(true).toBe(true)`. The comment says the real check is done via a "source-level grep in CI" that is not present in this file. If that CI grep step were removed or renamed, C5 would continue passing while the intended invariant (stub log message absent / real handler wired) is silently untested. This is dead test logic — the test adds no coverage and is permanently green regardless of implementation state.

**Fix:** Either delete C5 entirely (it was a placeholder comment while the real handler was being wired), or replace it with a real assertion. Given that the thread-summary handler is now wired (Phase 6), a source-level grep can be inlined similarly to how R2 is done:

```typescript
it('C5: thread-summary handler is wired — no stub log present', async () => {
  const src = await readFile(new URL('./cron.ts', import.meta.url), 'utf-8');
  expect(src).not.toContain('thread-summary stub');
  expect(src).toContain('runThreadSummaryPipeline');
});
```

---

## Info

### IN-01: Template-literal LIMIT interpolation in SQL — safe but diverges from parameterisation convention

**File:** `src/services/retention.service.ts:33`

**Issue:** `LIMIT ${BATCH_SIZE}` uses JavaScript template interpolation inside a
`.prepare()` call. `BATCH_SIZE` is a module-level numeric constant (`1000`), so
there is zero injection risk. However, the surrounding code and all other SQL in
the project use `?` positional binding for all variable values. This is a stylistic
inconsistency — a future reader may copy the pattern and interpolate a non-constant
value. SQLite does not support `LIMIT ?` in some versions, which is why the
interpolation was likely chosen; the comment on line 21 confirms this. A short
inline note clarifying that `LIMIT` cannot be a bound parameter in standard SQLite
would pre-empt confusion:

```typescript
// BATCH_SIZE is a compile-time constant — safe to interpolate.
// SQLite does not support `LIMIT ?` as a bound parameter without
// SQLITE_ENABLE_UPDATE_DELETE_LIMIT, so template interpolation is intentional.
LIMIT ${BATCH_SIZE}
```

---

### IN-02: Stale comment in `cron.ts` refers to Phase 6 plan as future work

**File:** `src/scheduler/cron.ts:141-143`

**Issue:** Lines 141–143 contain:
```
// Test-only export for Plan 06-03 to swap in real thread-summary handler
// without re-instantiating the registry. Plan 06-03 WILL replace this function
// when it lands; for now Plan 06-02 ships only the stub.
```
Plan 06-03 has already landed — the real `threadSummaryHandler` is wired. The
comment is now inaccurate and implies work that was already done is still pending.

**Fix:** Update the comment to reflect the current state:
```typescript
// Test-only: returns a copy of the task-name keys for test assertions.
// Production code must not call this.
export function _getRegisteredJobNames(): string[] {
```

---

### IN-03: `upsertMessage` return value not checked in `capture.handler.ts`

**File:** `src/modules/capture/capture.handler.ts:56`

**Issue:** `upsertMessage(captured)` is called without checking any return value.
`upsertMessage` in `message-store.ts` returns `void` (calls `stmt.run()` and
discards the `RunResult`). This means the number of affected rows (`changes`) is
never inspected; a silent UPSERT failure (e.g. constraint violation other than the
expected `ON CONFLICT`) would be swallowed. This is low-risk given the `try/catch`
wrapper on the handler, but worth documenting: `better-sqlite3` throws synchronously
on errors, so a failure would be caught by the outer `try/catch` — the pattern is
safe, just not explicit.

**Fix:** No code change required. Consider adding a debug-level log of the `RunResult`
from `upsertMessage` if future observability of UPSERT conflict counts is desired.
Alternatively, note in `upsertMessage`'s JSDoc that the `RunResult` is intentionally
discarded because errors throw synchronously.

---

_Reviewed: 2026-04-30T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
