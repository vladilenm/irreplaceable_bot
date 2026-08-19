# Thread Summary Without Empty Posts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Always attempt a substantive summary when at least one captured message exists, and never publish a misleading empty daily-summary card.

**Architecture:** Keep the existing capture → summarizer → orchestrator → formatter → cron/sender flow. Change the summarizer's empty-input gate from five messages to one, make pipeline metadata count selected messages independently of LLM success, and make the formatter's empty-topic result `[]`; the cron handler already treats zero chunks as a no-send and does not persist publication state.

**Tech Stack:** Node.js 20+, TypeScript strict mode, Vitest, Grammy.

## Global Constraints

- Preserve strict TypeScript and the existing module boundaries.
- Do not publish a fallback when zero topic blocks are available.
- Do not advance `lastThreadSummaryDate` when nothing is sent.
- Keep partial success: if at least one thread produces topics, publish those topics even when sibling threads fail.
- Use test-first RED → GREEN cycles.

---

### Task 1: Summarise Any Non-Empty Transcript

**Files:**
- Modify: `src/services/summarizer.anonymisation.test.ts`
- Modify: `src/services/summarizer.service.ts`

**Interfaces:**
- Consumes: `summarizeThread(input: SummarizeThreadInput): Promise<ThreadSummary>`.
- Produces: `LOW_VOLUME_THRESHOLD = 1`; only `messages.length === 0` returns `reason:'low-volume'` without an LLM call.

- [x] **Step 1: Write the failing regression test**

Replace the old `<5` expectation with a one-message case using the existing valid provider mock. Assert the result is non-skipped, has `messageCount: 1`, and the configured provider was called once. Retain the zero-message test and assert no provider call.

- [x] **Step 2: Run the focused test and verify RED**

Run: `npm test -- src/services/summarizer.anonymisation.test.ts`

Expected: the one-message test fails because the current `<5` gate returns `reason:'low-volume'` and never calls the provider.

- [x] **Step 3: Implement the minimal gate change**

Set `LOW_VOLUME_THRESHOLD` to `1` and update the contract/comments from `<5 messages` to `0 messages`. Keep the token-size, schema, hallucinated-id, and transport-error behaviour unchanged.

- [x] **Step 4: Run the focused test and verify GREEN**

Run: `npm test -- src/services/summarizer.anonymisation.test.ts`

Expected: all tests in the file pass.

### Task 2: Suppress Empty Cards and Preserve the Real Count

**Files:**
- Modify: `src/modules/thread-summary/thread-summary.formatter.test.ts`
- Modify: `src/modules/thread-summary/thread-summary.formatter.ts`
- Modify: `src/modules/thread-summary/thread-summary.service.test.ts`
- Modify: `src/modules/thread-summary/thread-summary.service.ts`

**Interfaces:**
- Consumes: `formatThreadSummaryPost(input): string[]` and `runThreadSummaryPipeline(): Promise<ThreadSummaryResult>`.
- Produces: formatter returns `[]` when flattening yields zero topics; pipeline `totalMessageCount` equals the number of rows selected from tracked threads, including rows whose summarisation later fails.

- [x] **Step 1: Write the failing formatter regressions**

Change `FT-EDGE-1` and `FT-EDGE-2` to expect `[]` for zero summaries and all-skipped summaries. This directly encodes "no substantive summary means no Telegram payload."

- [x] **Step 2: Write the failing orchestrator regressions**

Change `B3` and `B4` to expect zero chunks when every result is skipped, and extend `B5` to expect zero chunks for zero tracked threads. Add a test where selected message arrays contain real rows but the summarizer returns skipped results; assert `totalMessageCount` equals the sum of the selected array lengths rather than zero. Retain `B6` to prove partial success still renders chunks.

- [x] **Step 3: Run focused tests and verify RED**

Run: `npm test -- src/modules/thread-summary/thread-summary.formatter.test.ts src/modules/thread-summary/thread-summary.service.test.ts`

Expected: empty/all-skipped cases receive one fallback chunk and selected messages from skipped summaries are reported as zero.

- [x] **Step 4: Implement the minimal formatter and counter changes**

In `formatThreadSummaryPost`, flatten topics before constructing the header and immediately return `[]` when the flattened list is empty. In the orchestrator, add `messages.length` to `totalMessageCount` immediately after selection and remove the increment from the successful-summary branch. Do not change cron/sender code: its existing `chunks.length === 0` return already prevents send and state advancement.

- [x] **Step 5: Run focused tests and verify GREEN**

Run: `npm test -- src/modules/thread-summary/thread-summary.formatter.test.ts src/modules/thread-summary/thread-summary.service.test.ts`

Expected: all focused tests pass, including partial-success rendering.

### Task 3: Verify the Complete Change

**Files:**
- Modify: `.planning/debug/empty-thread-summary-zero-messages.md`

**Interfaces:**
- Consumes: project scripts in `package.json`.
- Produces: verified bugfix plus resolved GSD debug record.

- [x] **Step 1: Run full verification**

Run: `npm test && npm run typecheck`

Expected: all test files pass and TypeScript exits zero.

- [x] **Step 2: Review the diff against the request**

Run: `git diff --check && git diff -- src/services/summarizer.service.ts src/modules/thread-summary/thread-summary.service.ts src/modules/thread-summary/thread-summary.formatter.ts`

Expected: no whitespace errors; only the non-empty summarisation gate, real message counting, and empty-output suppression changed.

- [x] **Step 3: Resolve the GSD debug record**

Set `status: resolved`, record the failing/passing test evidence, and list the changed files. Do not create a commit unless the user explicitly requests one.
