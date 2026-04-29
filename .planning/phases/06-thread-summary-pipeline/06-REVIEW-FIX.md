---
phase: 06-thread-summary-pipeline
fixed_at: 2026-04-29T00:00:00Z
review_path: .planning/phases/06-thread-summary-pipeline/06-REVIEW.md
iteration: 1
findings_in_scope: 3
fixed: 3
skipped: 0
status: all_fixed
---

# Phase 06: Code Review Fix Report

**Fixed at:** 2026-04-29T00:00:00Z
**Source review:** .planning/phases/06-thread-summary-pipeline/06-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 3 (Critical + Warning)
- Fixed: 3
- Skipped: 0
- Info findings (out of scope, deferred): 5

Baseline test suite: 73 tests passing before fixes; 74 tests passing after fixes (added one new assertion test for WR-03). `npm run typecheck` passes cleanly throughout. Each fix was verified independently before commit.

## Fixed Issues

### WR-01: `bot.api.getForumTopic` does not exist — title refresh is permanently a no-op

**Files modified:** `src/modules/thread-summary/thread-summary.service.ts`, `src/modules/thread-summary/thread-summary.service.test.ts`
**Commit:** `0939601`
**Applied fix:** Adopted reviewer's option (b). Removed the speculative `bot.api.getForumTopic` call entirely (which would always be a no-op given grammy 1.42.0 only exposes `getForumTopicIconStickers`). Dropped the unused imports (`bot`, `config`, `upsertThreadTitle`) and the `ForumTopicLike` / `ForumTopicCapableApi` type-cast workaround. `refreshThreadTitle` is now a synchronous cached-only resolver that reads from `listTracked()` and falls back to `Тред #N` — exactly matching the reviewer's sketch. Updated JSDoc to document the `WR-01` decision so a future reader understands why the Bot-API path is absent. Updated `O7` test to reflect the new contract: it now asserts the cache lookup occurs and the pipeline still completes successfully (the prior failure-path assertion no longer applies because there is no API call to fail). Removed unused `mockGetForumTopic`, `mockUpsertThreadTitle`, and the `bot.js` vi.mock from the test harness.

### WR-02: Malformed JSON from OpenAI-compatible provider classified as `llm-error` instead of `schema-invalid`

**Files modified:** `src/services/summarizer.service.ts`
**Commit:** `fbb4319`
**Applied fix:** Wrapped the `JSON.parse(content)` call in `callOpenAICompatible` with a try/catch. On parse failure, throw a new `Error` carrying a `kind: 'schema-invalid'` tag (preserving the underlying parse error via the standard `cause` property) and a 100-char content preview to aid log triage. Updated the outer `summarizeThread` catch block to inspect `err.kind` and route tagged errors to `reason: 'schema-invalid'` (with a `WARN`-level log distinguishing it from transport failures), while untagged errors continue to fall through to `reason: 'llm-error'` (logged at `ERROR`). The Anthropic path is unaffected because tool_choice forces structured `tool_use` output. The existing Zod last-gate still catches structurally-valid-JSON-but-schema-violating payloads. No tests broke; existing schema tests continue to pass against the unchanged Zod surface.

### WR-03: `runThreadSummaryPipeline` reads state twice with no consistency guarantee

**Files modified:** `src/services/state.service.ts`, `src/modules/thread-summary/thread-summary.service.ts`, `src/modules/thread-summary/thread-summary.service.test.ts`
**Commit:** `3c4276f`
**Applied fix:** Added `isThreadSummaryPublishedTodayWithState(state: PipelineStateV2): boolean` to `state.service.ts` — a pure idempotency check that operates on a caller-provided snapshot, no I/O. Kept the existing `isThreadSummaryPublishedToday()` (which still does its own read) for callers that don't already have a state in hand. In `thread-summary.service.ts`, switched the import to `isThreadSummaryPublishedTodayWithState` and changed the gate at line 89 to call it with the already-loaded `prevState`. This eliminates the second `readFileSync` + `JSON.parse` per cycle and removes the (theoretical) consistency hazard between the two reads. Added an explanatory inline comment referencing the `WR-03` decision. Updated the test mock surface accordingly and added a new assertion test (`O1b`) that locks in the behaviour: `mockReadState` is called exactly once and `mockIsThreadSummaryPublishedTodayWithState` is invoked with the snapshot returned from the first read.

## Skipped Issues

None — all 3 in-scope warnings were fixed cleanly.

---

_Fixed: 2026-04-29T00:00:00Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
