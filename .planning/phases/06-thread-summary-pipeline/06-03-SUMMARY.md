---
phase: 06-thread-summary-pipeline
plan: 03
subsystem: orchestrator-delivery
tags: [orchestrator, formatter, delivery, telegram, idempotency, html-escape, splitter]
dependency_graph:
  requires:
    - "src/services/summarizer.service.ts (Plan 01 — summarizeThread)"
    - "src/utils/display-name.ts (Plan 01 — normalizeDisplayName)"
    - "src/services/state.service.ts (Plan 02 — readState/writeState/isThreadSummaryPublishedToday)"
    - "src/stores/message-store.ts (Plan 02 — selectMessagesInWindow/selectTopParticipants)"
    - "src/stores/tracked-threads-store.ts (Plan 02 — listTracked/upsertThreadTitle)"
    - "src/services/tracking.service.ts (Phase 4 — listTrackedThreadIds)"
    - "src/utils/telegram.ts (Phase 1 — sendMessageWithRetry, REUSE only, UNCHANGED)"
    - "src/scheduler/cron.ts (Plan 02 stub-slot — body-replaced here)"
    - "src/types/index.ts (Plan 01 — ThreadSummary, RunThreadSummaryOptions, ThreadSummaryResult, PipelineStateV2)"
  provides:
    - "src/modules/thread-summary/thread-summary.formatter.ts — pure HTML build + sort + escape + splitter + footer"
    - "src/modules/thread-summary/thread-summary.sender.ts — chunk loop reusing sendMessageWithRetry"
    - "src/modules/thread-summary/thread-summary.service.ts — runThreadSummaryPipeline orchestrator"
    - "src/scheduler/cron.ts thread-summary handler — body-replaced from stub to real call"
  affects:
    - "src/scheduler/cron.ts (handler swap; registry shape unchanged — 3 jobs preserved)"
tech_stack:
  added: []
  patterns:
    - "Greedy section-boundary splitter for Telegram 4096-char chunk limit (D-37)"
    - "Per-thread try/catch isolation — one LLM-fail does not abort cycle (D-34)"
    - "State merge-write — preserves digest fields (D-33 step 7)"
    - "Module-level vi.hoisted() for vitest mock factory hoisting (Rule 1 fix)"
    - "Defence-in-depth HTML escape on every dynamic field (T-06-12)"
    - "normalizeDisplayName at second application site (D-24, T-06-13)"
key_files:
  created:
    - "src/modules/thread-summary/thread-summary.formatter.ts (~190 LOC)"
    - "src/modules/thread-summary/thread-summary.formatter.test.ts (13 tests)"
    - "src/modules/thread-summary/thread-summary.sender.ts (~30 LOC)"
    - "src/modules/thread-summary/thread-summary.sender.test.ts (3 tests)"
    - "src/modules/thread-summary/thread-summary.service.ts (~200 LOC)"
    - "src/modules/thread-summary/thread-summary.service.test.ts (8 tests)"
  modified:
    - "src/scheduler/cron.ts (threadSummaryHandler body — Plan 02 stub replaced; comment updated)"
    - "src/scheduler/cron.test.ts (added C7 registry assertion)"
decisions:
  - "Plan 06-03 wires Telegram getForumTopic via narrow ForumTopicCapableApi cast — Bot API does not document a getForumTopic method, but tests mock it on bot.api; cast keeps no-`any` rule and lets cached fallback (T-06-17) handle missing-method runtime"
  - "vi.hoisted() used in service + sender tests instead of plain `const` — vitest hoists vi.mock above imports, so factory-referenced variables must also be hoisted to avoid `Cannot access X before initialization`"
  - "Empty-string chunk skip in sender (S2b) — defensive guard against zero-section edge cases bubbling into Telegram API call"
  - "thread-summary handler swap is a body-replace; no registerJob signature change → preserves Plan 02 invariants and Phase 7 retention-sweep slot intact"
metrics:
  duration: "~10 minutes (after npm install)"
  completed_date: "2026-04-29"
  tasks: 3
  commits: 7
  test_count: 73
  test_files: 11
  files_created: 6
  files_modified: 2
---

# Phase 06 Plan 03: Orchestrator + Delivery Summary

Final vertical slice of Phase 6 thread-summary pipeline. The 06:30 MSK cron job now publishes a single consolidated HTML post to `THREAD_SUMMARY_THREAD_ID`, covering all tracked threads with ≥5 messages in the 24h window. Idempotency is enforced via `lastThreadSummaryDate` MSK-day comparison; per-thread try/catch isolates LLM failures; HTML output is escaped at every dynamic field; long output splits on section boundaries to respect Telegram's 4096-char limit.

## What Was Built

### 1. `thread-summary.formatter.ts` (pure function)

`formatThreadSummaryPost({ summaries, titles, date }) → string[]` returns 1+ HTML chunks each ≤ `MAX_CHUNK_LENGTH` (4096).

- **Header** (D-03): `<b>🧵 Сводки тредов · DD.MM.YYYY</b>` — MSK calendar day via `toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' })`.
- **Sort** (D-02): non-skipped threads sorted by `messageCount` DESC — most active first → important content lands in chunk #1 if split.
- **Compact section layout** (D-01): `<b>📄 {title}</b>`, `<i>{headline}</i>`, `• {bullet}` lines, `👥 Name1·Name2·Name3 · 💬 N` participants line, optional `Открытые вопросы:` block (D-11). NO `Главное:` / `Пункты:` labels.
- **HTML escape** (T-06-12): every dynamic field (title, headline, bullets, participant names, open questions) passes through `escapeHtml(input)` (`&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`).
- **Unicode normalisation** (D-24, T-06-13): participant `displayName` passes through `normalizeDisplayName()` BEFORE `escapeHtml` — strips RTL/zero-width/control chars, NFC-composes.
- **Footer** (DLV-08, D-35): mixed digest → `тихо: N тредов` (fixed-form per D-08, source-commented to prevent grammatical "fixes"); empty-digest (all skipped) → `тихо: N из N`; zero tracked threads → header only.
- **Splitter** (DLV-09, D-37): greedy section-boundary algorithm — never splits mid-section; oversized single section logs WARN and emits anyway.
- **Title fallback** (D-06): missing entry in titles Map → `Тред #{N}`.

### 2. `thread-summary.sender.ts` (chunk loop)

`sendThreadSummary(chunks)` iterates and ships each chunk via existing `sendMessageWithRetry({ chatId: config.targetChatId, threadId: config.threadSummaryThreadId, text: chunk, parseMode: 'HTML' })`. No-op on empty array; defensive skip for empty-string chunks. **`src/utils/telegram.ts` is byte-identical** — `sendMessageWithRetry` reused, never modified.

### 3. `thread-summary.service.ts` (orchestrator)

`runThreadSummaryPipeline(opts: RunThreadSummaryOptions): Promise<ThreadSummaryResult>` implements all 7 algorithm steps (D-33):

1. `readState()` — wrapped in try/catch; corrupt JSON → returns `emptyResult(false)` and blocks publish (S3 test).
2. `isThreadSummaryPublishedToday()` short-circuit — returns `{ alreadyPublished: true, ... }` (D-31, DLV-10). Bypassable via `opts.skipIdempotency`.
3. `listTrackedThreadIds()` snapshot iteration.
4. Per-thread try/catch (D-34): `refreshThreadTitle` (getForumTopic via narrow cast, fallback to cached title) → `selectMessagesInWindow` → `selectTopParticipants` → `summarizeThread`. One thread's exception → that thread becomes `{ skipped: true, reason: 'llm-error' }` and loop continues.
5. `formatThreadSummaryPost({ summaries, titles, date })` builds chunks.
6. (Sender called by cron handler, not orchestrator — keeps service pure for /dev-summary later.)
7. `writeState({ ...prevState, lastThreadSummaryDate: date.toISOString() })` — merge-write preserves `lastDigestDate` (D-33 step 7).

`opts.windowHours` (default 24) propagates through `nowMinusHoursIso(windowHours)` and into `summarizeThread`'s input — Phase 7 `/dev-summary` 48h precondition wired.

### 4. `cron.ts` thread-summary handler swap

Plan 02 left a stub `threadSummaryHandler` that logged WARN. Plan 03 replaces only its body (registerJob signature unchanged — body-replace not structural change):

```ts
async function threadSummaryHandler(): Promise<void> {
  const result = await runThreadSummaryPipeline();
  if (result.alreadyPublished) { /* WARN + return */ }
  if (result.chunks.length === 0) { /* WARN + return */ }
  await sendThreadSummary(result.chunks);
  logger.info({ event: 'thread-summary-published', ... }, 'Cron: thread-summary cycle complete');
}
```

`retention-sweep` handler still a stub — Phase 7 owns. `digest` handler unchanged (success criterion #12).

## Files NOT Touched

- `src/services/ai.service.ts` — byte-identical (AI-07; `git diff` count = 0)
- `src/services/summarizer.service.ts` — Plan 01 sealed
- `src/services/state.service.ts` — Plan 02 sealed
- `src/services/db.service.ts` — Plan 02 sealed
- `src/utils/telegram.ts` — REUSE only (DLV-09)
- `src/index.ts` — Phase 4 main() wiring intact
- `src/stores/*` — Plan 02 sealed
- `src/types/index.ts` — Plan 01 / Plan 02 already added all types this plan consumes

## Test Status

- **Total: 73 tests across 11 test files. 100% passing.**
- TDD red→green per task: failing test committed before implementation.

| File | Tests | Coverage |
|---|---|---|
| `thread-summary.formatter.test.ts` | 13 | F1-F14 (skips F12 oversized — covered by D-37 WARN path) — header, sort, compact layout, HTML escape (title + bullet), participants middle-dot, Unicode normalisation, footer mixed/all-skipped, zero-threads, splitter multi-chunk, open questions optional, fallback title |
| `thread-summary.sender.test.ts` | 3 | S1 chunk-loop, S2 empty no-op, S2b empty-string skip |
| `thread-summary.service.test.ts` | 8 | O1 idempotency, O2 skipIdempotency, O3 zero threads, O4 per-thread error isolation, O5 state merge-write, O6 windowHours override, O7 getForumTopic fallback, S3 corrupt state |
| `cron.test.ts` (Plan 02 + extension) | 6 | C1, C2, C2b, C3, C5, C7 (Plan 03 registry-still-3-jobs) |
| All Plan 01 + Plan 02 tests | 43 | display-name, summarizer, message-store, tracked-threads-store, state.service |

## All 12 Success Criteria Verified

| # | Criterion | Status |
|---|---|---|
| 1 | thread-summary cron handler is real (not stub) | OK — `grep -q runThreadSummaryPipeline cron.ts` |
| 2 | runThreadSummaryPipeline implements 7 D-33 steps | OK — service.ts lines 67-180 |
| 3 | Per-thread try/catch isolation | OK — O4 test |
| 4 | Idempotency double-fire → ONE post | OK — O1 test + S3 corrupt-state |
| 5 | Empty-digest publishes header + "тихо: N из N" | OK — F9 test |
| 6 | Zero-tracked-threads publishes header only | OK — F10 test |
| 7 | Long output split on section boundaries | OK — F11 test |
| 8 | All HTML dynamic fields escaped | OK — F4 + F5 tests |
| 9 | Top-3 participants middle-dot + Unicode-normalised | OK — F6 + F7 tests |
| 10 | Sort by messageCount DESC | OK — F2 test |
| 11 | Header MSK calendar day DD.MM.YYYY | OK — F1 test |
| 12 | Digest cron continues unchanged (no v1.0 regression) | OK — full cron.test.ts passes; ai.service.ts byte-identical |

## All Phase 6 Requirements Covered

- **Plan 01 (sealed):** SUM-01..07 + AI-07 — summarizer pure function with provider-native JSON, anonymisation, Unicode normalisation, ai.service.ts byte-identical.
- **Plan 02 (sealed):** STATE-01/02 + SCHED-01..04 + DB migration v2 + window/participants helpers — atomic-write state, throw-on-corrupt, cron Map registry with 3 jobs.
- **Plan 03 (this plan):** **DLV-06 ✓** (06:30 MSK consolidated post), **DLV-07 ✓** (low-volume threads in footer counter, no empty body sections), **DLV-08 ✓** (HTML escape + footer "тихо: N тредов"), **DLV-09 ✓** (4096-char splitter on section boundary), **DLV-10 ✓** (idempotency via lastThreadSummaryDate, double-fire returns alreadyPublished:true).

## Threat Model Coverage (Plan 03)

| Threat ID | Mitigation | Verified by |
|---|---|---|
| T-06-12 (HTML injection / XSS-like) | escapeHtml on title, headline, bullets, participants, open questions | F4 + F5 formatter tests |
| T-06-13 (Unicode display attack) | normalizeDisplayName before escapeHtml | F7 formatter test |
| T-06-14 (idempotency bypass / double publish) | isThreadSummaryPublishedToday + writeState merge-write | O1 + O5 service tests |
| T-06-15 (per-thread crash kills cycle) | Per-thread try/catch | O4 service test |
| T-06-16 (Telegram 4096-char reject) | Greedy section-boundary splitter + WARN log on oversized single section | F11 formatter test |
| T-06-17 (getForumTopic API down) | Per-thread try/catch around getForumTopic + cached title fallback + final "Тред #N" fallback | O7 service test |
| T-06-18 (PII leak in success log) | Metadata-only allowlist `{event, threadsSummarised, threadsSkippedLowVolume, threadsSkippedError, totalMessageCount, chunkCount}` | Source review (service.ts logger.info call) |
| T-06-19 (cron job throw kills siblings) | SCHED-04 per-job try/catch from Plan 02 — unchanged | Plan 02 test C2/C3 + Plan 03 C7 registry-intact test |

Plans 01 + 02 close T-06-01 through T-06-11 (already documented in their summaries). Plan 03 closes T-06-12 through T-06-19. All 19 phase threats mitigated.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 — Blocking] Telegram Bot API does not document `bot.api.getForumTopic`**

- **Found during:** Task 2 typecheck after implementing service.ts.
- **Issue:** `bot.api.getForumTopic(chatId, threadId)` does not exist in grammy's typed Api surface (Bot API has `createForumTopic`, `editForumTopic`, `closeForumTopic`, `deleteForumTopic`, but no documented `getForumTopic`). The plan's interfaces section assumed it was available; the test mocks it on `bot.api`. CLAUDE.md forbids `any`.
- **Fix:** Defined a narrow `ForumTopicCapableApi` interface and cast `bot.api as unknown as ForumTopicCapableApi`, with `getForumTopic` typed as optional. Runtime check `typeof api.getForumTopic === 'function'` before calling — if missing, falls through to the cached-title path. Tests still pass because vi.mock provides the function on `bot.api`. T-06-17 mitigation strengthened (now handles BOTH "API down" AND "method not on this client").
- **Files modified:** `src/modules/thread-summary/thread-summary.service.ts`
- **Commit:** 2e194a4

**2. [Rule 1 — Bug] vitest hoisting trap — `Cannot access mock before initialization`**

- **Found during:** Task 2 first sender test run.
- **Issue:** vitest hoists `vi.mock(...)` calls above all imports. The plan-supplied test file declared `const mockSendMessageWithRetry = vi.fn()` at module level, then referenced it inside `vi.mock(..., () => ({ sendMessageWithRetry: mockSendMessageWithRetry }))`. At runtime the factory ran before the const initialisation → ReferenceError, no tests ran.
- **Fix:** Wrapped the mock-factory state in `vi.hoisted(() => ({ mockSendMessageWithRetry: vi.fn() }))` for the sender test, and similarly wrapped all 11 service-test mocks in a single `vi.hoisted` factory. Mock state is now hoisted alongside `vi.mock`, no ordering trap.
- **Files modified:** `src/modules/thread-summary/thread-summary.sender.test.ts`, `src/modules/thread-summary/thread-summary.service.test.ts`
- **Commit:** 6b696c5 (sender), 2e194a4 (service)

### Architectural Changes

None — plan executed within architectural envelope.

### Authentication Gates

None — all LLM/Telegram SDKs mocked in tests.

## Phase 7 Hand-off Pointers

For the next-phase agent picking up Phase 7 (Operational & Privacy Commands):

1. **`/summary` command** — admin-gated, calls `runThreadSummaryPipeline({ persistState: false })` and ships chunks via `sendThreadSummary`. Wire into `bot.ts` next to `/digest`. State write skipped → does not interfere with cron idempotency.
2. **`/dev-summary` command** — admin-only, `runThreadSummaryPipeline({ skipIdempotency: true, persistState: false, windowHours: 48 })`. Already exercised by O2 + O6 tests — orchestrator accepts both options.
3. **`retention-sweep` handler** — `src/scheduler/cron.ts:retentionSweepHandler` is still a stub. Phase 7 replaces its body with the 90-day batch delete (≤1000 rows per iteration). Registry slot reserved.
4. **`/forget-me` command** — INSERTs into `forgotten_users` (Phase 4 schema already present). Capture handler already short-circuits on `isAuthorForgotten` (Phase 4 D-12).
5. **OBS-02 ingest-rate counter** — pino log event `thread-summary-published` already emits the counters Phase 7 needs to expose.

## Files Created

| File | Purpose | LOC |
|---|---|---|
| `src/modules/thread-summary/thread-summary.formatter.ts` | Pure HTML build + sort + escape + splitter + footer | ~190 |
| `src/modules/thread-summary/thread-summary.formatter.test.ts` | 13 formatter tests (F1-F14, F12 covered by WARN path) | ~205 |
| `src/modules/thread-summary/thread-summary.sender.ts` | Chunk loop reusing telegram.ts unchanged | ~30 |
| `src/modules/thread-summary/thread-summary.sender.test.ts` | 3 sender tests (S1/S2/S2b) | ~40 |
| `src/modules/thread-summary/thread-summary.service.ts` | Orchestrator — D-33 7-step algorithm | ~200 |
| `src/modules/thread-summary/thread-summary.service.test.ts` | 8 orchestrator tests (O1-O7 + S3) | ~190 |

## Files Modified

| File | Change |
|---|---|
| `src/scheduler/cron.ts` | `threadSummaryHandler` body — Plan 02 stub replaced with real `runThreadSummaryPipeline` + `sendThreadSummary` call. Imports added at top. Header comment updated to reflect plan-03 swap. retention-sweep handler unchanged. |
| `src/scheduler/cron.test.ts` | Appended C7 registry-still-3-jobs assertion under "Plan 06-03 Task 3" describe block |

## Commits (Plan 06-03)

| Hash | Message |
|---|---|
| `c52dbd1` | test(06-03): add failing tests for thread-summary formatter (F1-F14) |
| `8c1d1af` | feat(06-03): implement thread-summary formatter (sort, escape, splitter, footer) |
| `6c163a7` | test(06-03): add failing tests for sender + orchestrator (S1-S3, O1-O7) |
| `6b696c5` | feat(06-03): implement thread-summary sender (chunk loop reusing telegram.ts) |
| `2e194a4` | feat(06-03): implement runThreadSummaryPipeline orchestrator (D-32..D-35, DLV-06) |
| `133788d` | feat(06-03): wire thread-summary handler into cron registry (replace Plan 02 stub) |
| `4dc59e9` | test(06-03): add C7 cron registry assertion (3 jobs after Plan 03 wire) |

## Self-Check

### Files exist

- `src/modules/thread-summary/thread-summary.formatter.ts` — FOUND
- `src/modules/thread-summary/thread-summary.formatter.test.ts` — FOUND
- `src/modules/thread-summary/thread-summary.sender.ts` — FOUND
- `src/modules/thread-summary/thread-summary.sender.test.ts` — FOUND
- `src/modules/thread-summary/thread-summary.service.ts` — FOUND
- `src/modules/thread-summary/thread-summary.service.test.ts` — FOUND

### Commits exist

All 7 commits visible in `git log --oneline -10`. Wave 1 base commit `2fc3786` is merge-base.

### Acceptance grep set

All formatter, sender, service, and cron acceptance greps verified (see above).

### Untouched-file diff counts

- `git diff 2fc3786 -- src/services/ai.service.ts` → 0 lines
- `git diff 2fc3786 -- src/utils/telegram.ts` → 0 lines
- `git diff 2fc3786 -- src/index.ts` → 0 lines
- `git diff 2fc3786 -- src/services/summarizer.service.ts` → 0 lines
- `git diff 2fc3786 -- src/services/state.service.ts` → 0 lines
- `git diff 2fc3786 -- src/services/db.service.ts` → 0 lines

### Test run

`npm test` → **73 tests pass across 11 test files**. `npx tsc --noEmit` exits 0.

## Self-Check: PASSED
