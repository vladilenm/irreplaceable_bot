---
phase: quick-260511-fkn
plan: 01
subsystem: thread-summary
tags: [llm-contract, schema, prompt, anti-hallucination, formatter]
dependency_graph:
  requires:
    - "src/types/index.ts (CapturedMessage, ThreadSummary, PipelineStateV2)"
    - "src/services/summarizer.service.ts (LLM dispatch, Zod last-gate)"
    - "src/modules/thread-summary/thread-summary.service.ts (orchestrator)"
    - "src/modules/thread-summary/thread-summary.formatter.ts (HTML chunker)"
    - "prompts/thread-summarizer.md (system prompt)"
  provides:
    - "Topic = {emoji,title,messageCount,firstMessageId,links}"
    - "LLMSummaryOutput = {topics: Topic[1..5]}"
    - "Post-validation invariant: every topic.firstMessageId ∈ Set(messages.tgMessageId)"
    - "Hallucinated-id distinct WARN log: event=schema-invalid-hallucinated-id"
    - "Transcript line format: [id=<tgMessageId> HH:MM] <DisplayName>: <text>"
    - "Formatter flat ranking: summaries.flatMap(s.topics).sort(mc DESC)"
  affects:
    - "Daily thread-summary post layout: 1 thread → 1..5 topic lines (was 1)"
    - "Deep-link target per topic line: t.me/c/<chat>/<thread>/<topic.firstMessageId>"
tech-stack:
  added: []
  patterns:
    - "Post-Zod semantic validation against input id-set (defence-in-depth beyond syntactic schema)"
    - "Distinct log event name for model-regression vs transport-failure routing"
    - "flatMap with explicit return-type annotation to avoid `as` casts under strict TS"
key-files:
  created: []
  modified:
    - "src/types/index.ts"
    - "src/services/summarizer.service.ts"
    - "src/services/summarizer.service.test.ts"
    - "src/services/summarizer.adversarial.test.ts"
    - "src/services/summarizer.anonymisation.test.ts"
    - "src/modules/thread-summary/thread-summary.service.ts"
    - "src/modules/thread-summary/thread-summary.service.test.ts"
    - "src/modules/thread-summary/thread-summary.formatter.ts"
    - "src/modules/thread-summary/thread-summary.formatter.test.ts"
    - "prompts/thread-summarizer.md"
decisions:
  - "ThreadSummary.messageCount stays as input-window count (messages.length); topic.messageCount is LLM-self-reported and may not sum — documented in prompt"
  - "tgMessageId exposed in transcript prefix is NOT PII (already public in t.me/c/ deep-links); authorId remains stripped (SUM-03)"
  - "Hallucinated firstMessageId → schema-invalid (NOT llm-error) with distinct event=schema-invalid-hallucinated-id WARN for grep-ability"
  - "Per-topic title truncation safeguard applied even though schema enforces ≤100 (defence-in-depth)"
  - "okSummary helper kept positional signature for back-compat; new okSummaryMulti helper covers multi-topic cases"
metrics:
  duration: "~45 min"
  completed_date: "2026-05-11"
  tasks: 2
  files_modified: 10
  tests_passed: 131
---

# Quick 260511-fkn: Thread-summary LLM-side segmentation Summary

One-liner: Switched thread-summary contract from "1 thread = 1 collapsed topic" to "1 thread = 1..5 LLM-segmented sub-topics" with per-topic deep-link targets and post-validation against the input tgMessageId set.

## Contract Change (top-level diff)

Before (quick-260507-cni):

```ts
LLMSummaryOutput = { emoji, title, links }                 // single dominant theme
ThreadSummary(non-skipped) = { ...meta, emoji, title, links, firstMessageId }
summarizeThread({ ..., firstMessageId })                   // orchestrator computed MIN(tgMessageId)
```

After (quick-260511-fkn):

```ts
Topic = { emoji, title, messageCount, firstMessageId, links }
LLMSummaryOutput = { topics: Topic[1..5] }                 // 1..5 sub-topics
ThreadSummary(non-skipped) = { ...meta, topics: Topic[] }
summarizeThread({ threadId, windowHours, messages })       // LLM picks firstMessageId per topic
```

Transcript line format also shifted: `[HH:MM] Name: text` → `[id=<tgMessageId> HH:MM] Name: text`. The numeric tgMessageId is exposed out-of-band so the LLM can cite it in `topic.firstMessageId`. authorId remains stripped (SUM-03 invariant intact).

## New Post-validation Invariant (T-260511-01)

Lives in `src/services/summarizer.service.ts` immediately after the Zod `safeParse` succeeds:

```ts
const inputIds = new Set<number>(messages.map((m) => m.tgMessageId));
for (const topic of validated.topics) {
  if (!inputIds.has(topic.firstMessageId)) {
    logger.warn({ event: 'schema-invalid-hallucinated-id', threadId, offendingId, inputIdsSize }, ...);
    return { skipped: true, reason: 'schema-invalid', ... };
  }
}
```

This blocks the formatter from ever emitting a `t.me/c/…/<thread>/<forged-id>` link. Hallucinated id is routed to `schema-invalid` (NOT `llm-error`) with a distinct event name so operators can grep `hallucinated-id` to spot model regressions separately from transport failures.

Tested by:
- `summarizer.service.test.ts` Test 11 (hallucinated id rejected) + Test 12 (in-set id accepted)
- `summarizer.adversarial.test.ts` ADV-1b (jailbreak with valid shape + hallucinated firstMessageId → schema-invalid)

## Untouched Shape-agnostic Consumers

These files were NOT modified — they consume `string[]` chunks or shape-agnostic metadata:

- `src/modules/thread-summary/thread-summary.sender.ts` (sends pre-built HTML chunks)
- `src/modules/thread-summary/thread-summary.sender.test.ts` (asserts iteration over `string[]`)
- `src/services/state.service.ts` (state.json mechanics)
- `src/services/tracking.service.ts` (tracked thread whitelist)
- `src/stores/message-store.ts` (DB queries)

Sender tests continue to pass without modification (S1/S2/S2b green).

## Test Count Delta

| File | Before | After | Δ |
|------|--------|-------|---|
| `summarizer.service.test.ts` | 14 (9 schema + 5 transcript) | 23 (12 schema + 6 transcript + 2 post-validation + 3 schema-mirror probes) | +9 |
| `summarizer.adversarial.test.ts` | 2 (ADV-1, ADV-2) | 3 (ADV-1, ADV-1b, ADV-2) | +1 |
| `summarizer.anonymisation.test.ts` | 4 | 4 (mock shapes updated to topics array) | 0 |
| `thread-summary.service.test.ts` | 18 (incl. O7-NEW MIN-id) | 19 (O7-NEW → O7-CONTRACT; +O7-MULTI; helpers rewritten) | +1 |
| `thread-summary.formatter.test.ts` | 14 | 16 (+FT-T3b flat-sort across multi-topic, +FT-T5 five-topics) | +2 |
| `thread-summary.sender.test.ts` | 3 | 3 (untouched) | 0 |

Total test suite: 131/131 green.

## Grep Evidence: no old-shape residue

```
grep -rn "headline\|bullets\|openQuestions" src/ prompts/
# → only digest.formatter.ts comments (different feature: AI-radar digest, not thread-summary)
# → confirms zero thread-summary residue from earlier (pre-260507-cni) bullet-style contract

grep -n "firstMessageId" src/services/summarizer.service.ts
# → 32: z.number().int() in Topic Zod schema
# → 65: integer in JSON-schema mirror
# → 84: required[] in JSON-schema mirror
# → 130: comment in buildTranscript
# → 335: post-validation comment
# → 342-351: hallucinated-id check + WARN log
# → confirms firstMessageId is NOT in SummarizeThreadInput

grep -n "messages.reduce" src/modules/thread-summary/thread-summary.service.ts
# → (no matches) — orchestrator no longer computes MIN(tgMessageId)
```

## Deviations from Plan

None — plan executed exactly as written. No Rule 1/2/3 auto-fixes were required; no architectural Rule 4 questions arose.

## Threat Flags

None. The change preserves all existing trust boundaries; the new `[id=N ...]` transcript prefix is bounded surface (T-260511-02 disposition: accept — tgMessageId is already public in t.me/c/ deep-links).

## Self-Check: PASSED

Files verified to exist with expected content:
- `src/types/index.ts` — `Topic` interface present, `LLMSummaryOutput = { topics: Topic[] }`, non-skipped ThreadSummary has `topics: Topic[]`
- `src/services/summarizer.service.ts` — Zod schema enforces `topics.min(1).max(5)`, post-validation block present, `SummarizeThreadInput` has no `firstMessageId` field
- `prompts/thread-summarizer.md` — topics array + [id=N] format + messageCount self-report disclosure
- `src/modules/thread-summary/thread-summary.service.ts` — `messages.reduce` removed, `summarizeThread` call passes `{threadId, windowHours, messages}` only, three-level link aggregation
- `src/modules/thread-summary/thread-summary.formatter.ts` — `TopicWithThread` flatMap, flat sort, per-topic deep-link

Commits verified:
- `4932c0e` (quick-260511-fkn-01): present in `git log --oneline`
- `36dcb9e` (quick-260511-fkn-02): present in `git log --oneline`

Verification commands all green:
- `npx tsc --noEmit`: clean
- `npx vitest run`: 17 test files, 131 tests, all passed
- Grep checks: zero old-shape residue in thread-summary surface
