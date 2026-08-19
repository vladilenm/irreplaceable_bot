---
status: resolved
trigger: "Daily thread summary published 'Всего было написано 0 сообщений' although the tracked chat had messages"
created: 2026-08-19T00:00:00+03:00
updated: 2026-08-19T13:00:00+03:00
---

## Current Focus

hypothesis: CONFIRMED — the low-volume gate skipped 1-4 real messages, the orchestrator excluded skipped messages from its count, and the formatter published a header-only fallback when every thread was skipped
test: RED/GREEN regressions cover one-message summarisation, actual selected-message counting, and zero chunks when no topic can be rendered
expecting: verified
next_action: none

## Symptoms

expected: |
  If captured messages exist, publish a substantive topic summary in the normal format.
  If no substantive summary can be produced, publish nothing.
actual: |
  For a quiet day with 1-4 messages per tracked thread, summarizeThread returns
  reason:'low-volume' without calling the LLM. The orchestrator reports zero because
  it increments totalMessageCount only for non-skipped summaries. The formatter then
  intentionally creates a header + "Всего было написано 0 сообщений" + hashtag chunk.

## Evidence

- `src/services/summarizer.service.ts`: `LOW_VOLUME_THRESHOLD = 5` and `< threshold` returns `low-volume` before constructing an LLM client.
- `src/modules/thread-summary/thread-summary.service.ts`: `totalMessageCount` is incremented only in the non-skipped branch.
- `src/modules/thread-summary/thread-summary.formatter.ts`: zero topics returns a non-empty fallback chunk.
- Existing tests explicitly lock in all three behaviours (`L1`, `B4`, `FT-EDGE-1/2`).

## Root Cause

The pipeline conflates "not enough messages for the old product threshold" with
"there were no messages" and treats "no usable LLM result" as publishable content.
That combination creates a user-visible false statement instead of a summary.

## Intended Resolution

1. Treat only an actually empty transcript as low-volume; 1-4 messages go through the normal LLM summariser.
2. Count every selected message so observability/result metadata reflects captured reality.
3. Make the formatter return zero chunks when there is no renderable topic; the existing cron guard then skips Telegram send and does not advance `lastThreadSummaryDate`.

## Resolution

root_cause: The old five-message product threshold and the formatter's publishable empty fallback jointly converted real low-volume chat activity into a false zero-message post.

fix: |
  `LOW_VOLUME_THRESHOLD` is now 1, so every non-empty transcript reaches the LLM.
  `totalMessageCount` now counts rows selected from the message store before summarisation.
  The formatter now returns `[]` unless at least one substantive topic is available.
  The existing cron zero-chunk guard therefore performs no send and no publication-state write.

verification: |
  RED 1: one-message summariser regression failed with skipped:true / no LLM call.
  RED 2: six formatter/orchestrator regressions failed on fallback chunks and zero count.
  GREEN focused: 4/4 summariser gating tests and 36/36 formatter/orchestrator tests passed.
  Full: 17/17 test files, 134/134 tests passed; `tsc --noEmit` exited 0; `git diff --check` exited 0.

files_changed:
  - src/services/summarizer.service.ts
  - src/services/summarizer.anonymisation.test.ts
  - src/modules/thread-summary/thread-summary.service.ts
  - src/modules/thread-summary/thread-summary.service.test.ts
  - src/modules/thread-summary/thread-summary.formatter.ts
  - src/modules/thread-summary/thread-summary.formatter.test.ts
  - src/types/index.ts
