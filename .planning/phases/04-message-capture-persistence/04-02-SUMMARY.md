---
phase: 04-message-capture-persistence
plan: 02
subsystem: database
tags: [sqlite, better-sqlite3, prepared-statements, idempotency, gdpr, whitelist, capture]

requires:
  - phase: 04-message-capture-persistence
    provides: db.service.ts (initDb/getDb/closeDb), MIGRATIONS v1 (4 product tables), CapturedMessage / TrackedThread types

provides:
  - message-store with idempotent UPSERT keyed on (chat_id, tg_message_id) and forgotten-user guard SELECT
  - tracked-threads-store read-side (listTracked) returning typed TrackedThread[]
  - tracking.service module-private Set<number> + load/check/list trio for capture hot path
  - Lazy module-level prepared statements via ??= (STORE-04 pattern)
  - Phase 5 extension contract documented (track/untrack will be added without refactor)

affects: [04-03-capture-handler, 05-thread-tracking-commands, 06-thread-summarizer, 07-daily-summary-delivery, 08-operational-privacy-commands]

tech-stack:
  added: []
  patterns:
    - "Lazy module-level prepared statement cache via ??= (defers .prepare() until first call so module load order does not depend on initDb)"
    - "Idempotent UPSERT with explicit DO UPDATE column allowlist (text, author_name, edited_at) — preserves created_at and identity columns on edit redelivery"
    - "Module-private Set<number> as O(1) source of truth for hot-path whitelist check; mutated only by loadTrackingWhitelist; readers receive a copy via [...set]"
    - "Explicit snake_case → camelCase row mapper (no as TrackedThread shortcut) — prevents schema column leakage into TS surface"

key-files:
  created:
    - src/stores/message-store.ts (63 LOC — upsertMessage + isAuthorForgotten with lazy prepared statements)
    - src/stores/tracked-threads-store.ts (37 LOC — listTracked with explicit row mapping)
    - src/services/tracking.service.ts (46 LOC — private Set + loadTrackingWhitelist/isThreadTracked/listTrackedThreadIds)
  modified: []

key-decisions:
  - "UPSERT uses ON CONFLICT(chat_id, tg_message_id) DO UPDATE SET text|author_name|edited_at — INSERT OR IGNORE rejected (drops edits, MSG-02 fail), INSERT OR REPLACE rejected (loses created_at)"
  - "DO UPDATE SET column allowlist (3 cols) excludes chat_id/thread_id/tg_message_id/author_id/is_anonymous/reply_to_message_id/created_at — those are row-identity invariants per RESEARCH §1.6"
  - "Prepared statements lazy via ??= — first call prepares against getDb(), subsequent calls reuse. Avoids module-load-order dependency on initDb()"
  - "tracking.service exposes Set via copy ([...trackedSet]) not direct reference — caller mutation cannot pollute internal state (T-04-13 mitigation)"
  - "Phase 4 ships read-side only (D-01): no track/untrack stubs. Phase 5 ADDS those functions; this file does not refactor."
  - "snake_case→camelCase mapping in tracked-threads-store is explicit (.map((r) => ({threadId: r.thread_id, ...}))) — never `as TrackedThread` cast, which would mask schema/TS drift"

patterns-established:
  - "Pattern: Lazy prepared-statement cache (let _stmt: Statement | null = null; function stmt() { _stmt ??= getDb().prepare(...); return _stmt; }) — reusable for every store that talks to db.service"
  - "Pattern: Idempotent UPSERT with explicit DO UPDATE column allowlist for telegram-redelivery resilience"
  - "Pattern: Module-private Set + module-public read/write trio (load/check/list) — clones on read so no caller can mutate internal state"

requirements-completed:
  - STORE-04
  - MSG-04

duration: ~3min
completed: 2026-04-28
---

# Phase 04 Plan 02: Stores + Tracking Service Summary

**Persistence + whitelist hot-path layer ready: idempotent UPSERT preserves created_at on edit, forgotten guard closes PRIV-02 ahead of Phase 8, module-private Set<number> serves O(1) thread-tracked check for capture handler.**

## Performance

- **Duration:** ~3 minutes
- **Started:** 2026-04-28T06:01:34Z
- **Completed:** 2026-04-28T06:04:20Z
- **Tasks:** 2 (atomic, no checkpoints, no deviations)
- **Files modified:** 3 (3 created, 0 modified)

## Accomplishments

- `src/stores/message-store.ts` — `upsertMessage(m)` and `isAuthorForgotten(authorId)` with module-level lazy prepared statements (cached via `??=`).
- `src/stores/tracked-threads-store.ts` — `listTracked()` returning `TrackedThread[]` with explicit snake_case→camelCase row mapping (no `as TrackedThread` cast).
- `src/services/tracking.service.ts` — module-private `Set<number>` + `loadTrackingWhitelist()` / `isThreadTracked(threadId)` / `listTrackedThreadIds()`. Phase 5 contract (track/untrack) documented in a comment but **not** stubbed (D-01).
- All four verification smokes pass: idempotency (3× upsert → 1 row), edit-preserves-created_at, forgotten guard hit/miss, whitelist load + caller-mutation-isolation.
- `npx tsc --noEmit` exits 0; zero `any`; zero forbidden patterns (`INSERT OR IGNORE`, `INSERT OR REPLACE`, `export trackedSet`, `export function (track|untrack)`).

## Task Commits

1. **Task 1: message-store.ts — lazy-prepared upsert + forgotten guard** — `de468e8` (feat)
2. **Task 2: tracked-threads-store.ts + tracking.service.ts** — `34481dc` (feat)

## Files Created/Modified

- **Created:** `src/stores/message-store.ts` (63 LOC) — `upsertMessage`, `isAuthorForgotten`.
- **Created:** `src/stores/tracked-threads-store.ts` (37 LOC) — `listTracked`.
- **Created:** `src/services/tracking.service.ts` (46 LOC) — `loadTrackingWhitelist`, `isThreadTracked`, `listTrackedThreadIds`.

## Final UPSERT Prepared Statement (full text — copied verbatim from `message-store.ts`)

```sql
INSERT INTO messages (
  chat_id, thread_id, tg_message_id,
  author_id, author_name, is_anonymous,
  text, reply_to_message_id, created_at, edited_at
) VALUES (
  @chatId, @threadId, @tgMessageId,
  @authorId, @authorName, @isAnonymous,
  @text, @replyToMessageId, @createdAt, @editedAt
)
ON CONFLICT(chat_id, tg_message_id) DO UPDATE SET
  text        = excluded.text,
  author_name = excluded.author_name,
  edited_at   = excluded.edited_at
```

**Rationale (from RESEARCH §1.6 + PITFALLS TG-01):**
- `INSERT OR IGNORE` rejected — would silently drop redelivered edits (MSG-02 fail).
- `INSERT OR REPLACE` rejected — would erase `created_at` on every edit (T-04-12 repudiation).
- DO UPDATE SET allowlist limited to `text`, `author_name`, `edited_at` — every other column is a row-identity invariant.

## Final Module Shape (3 files, 6 exported functions)

| Module | Exports | Purpose |
|---|---|---|
| `src/stores/message-store.ts` | `upsertMessage(m: CapturedMessage): void`, `isAuthorForgotten(authorId: number): boolean` | Idempotent persistence + pre-INSERT GDPR guard |
| `src/stores/tracked-threads-store.ts` | `listTracked(): TrackedThread[]` | Read-side of `tracked_threads` table |
| `src/services/tracking.service.ts` | `loadTrackingWhitelist(): void`, `isThreadTracked(threadId: number): boolean`, `listTrackedThreadIds(): number[]` | In-memory Set source of truth for capture hot path |

`trackedSet` itself is NOT exported — only the three accessor functions can interact with it.

## Lazy Prepared-Statement Pattern (one example, applies to all 3 statements in this plan)

```typescript
let _upsertStmt: Statement<[CapturedMessage]> | null = null;

function upsertStmt(): Statement<[CapturedMessage]> {
  _upsertStmt ??= getDb().prepare<[CapturedMessage]>(`...`);
  return _upsertStmt;
}

export function upsertMessage(m: CapturedMessage): void {
  upsertStmt().run(m);
}
```

Why lazy: `getDb()` throws if `initDb()` has not run, so eager `getDb().prepare(...)` at module top would force every importer to care about boot order. With `??=` the prepare happens on first call (after init), is cached forever, and the module is safe to import any time.

## Phase 5 Extension Hooks (documented contracts, no code in this plan)

`tracking.service.ts` ends with this comment:

```
// Phase 5 will add track(threadId, addedBy: number) and untrack(threadId)
// functions here that mutate trackedSet AND write through to the store.
// Phase 4 ships read-side only — no placeholders, no throwing stubs (D-01).
```

`tracked-threads-store.ts` will gain `insertTrackedThread(t)` and `deleteTrackedThread(threadId)` in Phase 5 — the lazy-prepared pattern is already established, so Phase 5 can append two more `let _xStmt = ...` lazy getters next to `_listStmt` without touching `listTracked()`.

## Verification Command Outputs (4 smoke tests)

| # | Test | Result |
|---|---|---|
| 1 | `npx tsc --noEmit` after each task | exit 0 (no output) |
| 2 | Idempotency: 3× `upsertMessage(m)` with same chat_id+tg_message_id | `idempotent rows: 1` |
| 3 | Edit preserves created_at: `upsertMessage(orig); upsertMessage(edit)` | `{"text":"edited","created_at":"2026-04-28T10:00:00.000Z","edited_at":"2026-04-28T10:05:00.000Z"}` |
| 4 | Forgotten guard: seed `forgotten_users(999)`; check 999 / check 42 | `forgotten 999: true` / `forgotten 42: false` |
| 5 | Whitelist load: seed tracked_threads={123,456}; loadTrackingWhitelist() | `Tracking whitelist loaded count=2 threadIds=[123,456]`; `123 tracked: true` / `456 tracked: true` / `789 tracked: false`; `list: [123,456]` |
| 6 | Caller mutation isolation: `arr = listTrackedThreadIds(); arr.push(99999)` | internal still `[123,456]` (T-04-13 mitigation verified) |
| 7 | Idempotent reload: second `loadTrackingWhitelist()` | same `[123,456]`, no doubling |

## Decisions Made

- None beyond locked CONTEXT.md decisions (D-01, D-12, D-09) and PLAN.md acceptance criteria. Plan executed exactly as written.

## Deviations from Plan

None — plan executed exactly as written. All file content matches the verbatim code blocks in the plan.

## Issues Encountered

None. TypeScript strict mode (`noUncheckedIndexedAccess`) accepted the prepared-statement generics (`Statement<[CapturedMessage]>`, `Statement<[number]>`, `Statement<[]>`) without complaint; the explicit `TrackedThreadRow` interface for snake_case columns satisfied the strict mapping requirement.

## Operational Note

Plan 04-03 (capture handler) will:
- Wire `loadTrackingWhitelist()` into `src/index.ts main()` BEFORE `bot.start()` (TRK-05 + T-04-14 mitigation).
- Call `isThreadTracked(threadId)` first thing in the capture handler (drop non-whitelisted before any other work).
- Call `isAuthorForgotten(authorId)` AFTER text/anon checks, BEFORE `upsertMessage(m)` (D-12 short-circuit; PRIV-02 closure).
- Wrap the whole capture body in try/catch and call `closeDb()` on shutdown AFTER `bot.stop()`.

## Next Phase Readiness

- **Plan 04-03 (capture handler) unblocked:** can `import { upsertMessage, isAuthorForgotten } from '../../stores/message-store.js'` and `import { isThreadTracked, loadTrackingWhitelist } from '../../services/tracking.service.js'`.
- **Phase 5 (`/track`, `/untrack`, `/tracked`) unblocked:** will append `track`/`untrack` to `tracking.service.ts` and `insertTrackedThread`/`deleteTrackedThread` to `tracked-threads-store.ts` — both files already use the lazy-prepared pattern, no refactor required.
- **No code blockers downstream.** Threat model items T-04-09 through T-04-15 (the seven STRIDE rows for this plan) all mitigated by the shipped code.

## Self-Check: PASSED

All claimed files and commits verified present:

- `src/stores/message-store.ts` — created, 63 LOC, contains `ON CONFLICT(chat_id, tg_message_id) DO UPDATE`, contains `SELECT 1 FROM forgotten_users WHERE author_id = ?`, exports exactly `upsertMessage` + `isAuthorForgotten`, no `INSERT OR IGNORE`, no `INSERT OR REPLACE`, no `any`. FOUND.
- `src/stores/tracked-threads-store.ts` — created, 37 LOC, exports exactly `listTracked`, explicit row mapping (no `as TrackedThread` cast on raw row), no `any`. FOUND.
- `src/services/tracking.service.ts` — created, 46 LOC, exports exactly 3 functions (`loadTrackingWhitelist`, `isThreadTracked`, `listTrackedThreadIds`), `trackedSet` not exported, no `track`/`untrack` exports, `loadTrackingWhitelist` calls `trackedSet.clear()` before populating, `listTrackedThreadIds` returns `[...trackedSet]`, no `any`. FOUND.
- Commit `de468e8` (Task 1, feat). FOUND in `git log`.
- Commit `34481dc` (Task 2, feat). FOUND in `git log`.

`npx tsc --noEmit` exits 0. Runtime smoke (host, fresh `/tmp/smoke-*.db` runs) confirms idempotent UPSERT (1 row from 3 inserts), edit preserves `created_at`, forgotten guard returns true/false correctly, whitelist load populates Set from DB, caller mutation of returned array does not leak into internal state.

---
*Phase: 04-message-capture-persistence*
*Plan: 02*
*Completed: 2026-04-28*
