---
phase: quick-260428-n9u
plan: 01
subsystem: ai-service
tags: [diagnostics, logging, llm, observability, deepseek, anthropic]
requires: []
provides:
  - "Diagnostic info-level log of LLM termination reason: finish_reason+refusal (OpenAI/DeepSeek) or stop_reason+stop_sequence (Anthropic), unified into finishReason/refusal fields"
affects:
  - src/services/ai.service.ts
tech_added: []
patterns_added:
  - "Inline narrow type assertion `as { refusal?: string | null } | undefined` for DeepSeek-specific OpenAI-SDK-untyped fields — keeps strict TS without introducing a named type or `any`"
key_files:
  modified:
    - src/services/ai.service.ts
  created: []
decisions:
  - "Unified field names finishReason/refusal across both providers (Anthropic stop_reason→finishReason, stop_sequence→refusal) so a single log shape works for both code paths"
  - "Inline cast at access site (`firstChoice?.message as { refusal?: string | null } | undefined`) rather than a hoisted named type — minimises blast radius of a diagnostic-only field"
  - "Field accessor `firstChoice?.message?.refusal` (not `firstChoice?.refusal`) — DeepSeek puts refusal on the message body, mirroring where `content` lives"
  - "Defaults to null (not undefined) via `?? null` so pino emits `\"refusal\": null` rather than dropping the field — easier to grep for in logs"
metrics:
  duration: 1min
  completed: 2026-04-28
  tasks: 1
  files_modified: 1
requirements_completed:
  - QUICK-260428-n9u-FINISH-REASON-REFUSAL
---

# Quick 260428-n9u: AI service finish_reason / refusal diagnostic log Summary

**One-liner:** Extended `'AI raw response (debug)'` log in `filterArticles` with `finishReason` (Anthropic `stop_reason` / OpenAI-DeepSeek `finish_reason`) and `refusal` (Anthropic `stop_sequence` / DeepSeek-only `message.refusal`, accessed via inline narrow cast `as { refusal?: string | null } | undefined` — no `any`).

## Objective

The previous diagnostic log (added in quick-260428-n29) records the body of the LLM response (first 800 chars + total length) but cannot answer "WHY is it empty/short?". `finish_reason=length` means the model hit `max_tokens=2000`; `finish_reason=content_filter` plus DeepSeek's `refusal` text means a moderation refusal; Anthropic's `stop_reason=end_turn` vs `max_tokens` similarly distinguishes a clean completion from a truncated one. Capturing these turns the existing log into an actionable diagnostic.

## Tasks Completed

| # | Task | Commit | Files |
|---|------|--------|-------|
| 1 | Capture `finish_reason` / `refusal` (OpenAI/DeepSeek) and `stop_reason` / `stop_sequence` (Anthropic) into the diagnostic log via two unified `finishReason` / `refusal` locals | 722b8df | src/services/ai.service.ts |

## Implementation Details

In `src/services/ai.service.ts`:

1. Two diagnostic locals declared alongside `result`:

   ```ts
   let finishReason: string | null | undefined;
   let refusal: string | null | undefined;
   ```

2. Anthropic branch (after `result = firstBlock.text;`):

   ```ts
   finishReason = response.stop_reason ?? null;
   refusal = response.stop_sequence ?? null;
   ```

3. OpenAI/DeepSeek branch (replacing the previous one-liner choices access):

   ```ts
   const firstChoice = response.choices[0];
   result = firstChoice?.message?.content ?? '';
   finishReason = firstChoice?.finish_reason ?? null;
   refusal =
     (firstChoice?.message as { refusal?: string | null } | undefined)
       ?.refusal ?? null;
   ```

   The inline cast `as { refusal?: string | null } | undefined` is required because DeepSeek's `refusal` field is not declared on the OpenAI SDK's `ChatCompletionMessage` type — the cast targets the message-shaped child where DeepSeek actually places `refusal`, NOT the choice itself.

4. Both new fields are surfaced inside the existing log object:

   ```ts
   logger.info(
     {
       rawResponseHead: result.slice(0, 800),
       rawResponseLength: result.length,
       finishReason,
       refusal,
       model: config.aiModel,
     },
     'AI raw response (debug)',
   );
   ```

- Diff: `1 file changed, 12 insertions(+), 1 deletion(-)`.
- Single hunk, single file (`src/services/ai.service.ts`).
- No changes to `filterArticles` signature, return type, system prompt, curator prompt loading, types module, or any other file.
- No `any` introduced; only the inline narrow cast `as { refusal?: string | null } | undefined`.

## Verification Results

- `npx tsc --noEmit` → exit 0 (strict TS, no `any`).
- `grep -n "finishReason" src/services/ai.service.ts` → 4 matches (line 33 declaration, 50 Anthropic assign, 68 OpenAI assign, 78 log object).
- `grep -n "refusal" src/services/ai.service.ts` → 6 matches (line 34 declaration, 51 Anthropic assign, 69-71 OpenAI cast block, 79 log object).
- `grep -n "as { refusal?: string | null } | undefined" src/services/ai.service.ts` → exactly 1 match (line 70, OpenAI branch).
- `grep -c "AI raw response (debug)"` → 1 (still exactly one diagnostic log).
- `grep -c "AI filtering complete"` → 1 (existing metadata log preserved).
- `git diff --stat` → only `src/services/ai.service.ts`, single-file change.
- `git log --oneline -1` → `722b8df feat(quick-260428-n9u): log finish_reason and refusal in ai.service diagnostic`.

## Deviations from Plan

None — plan executed exactly as written.

## Decisions Made

- **Unified field names across providers:** Anthropic's `stop_reason` is logged under `finishReason` and `stop_sequence` under `refusal`, matching the OpenAI/DeepSeek field names. This keeps a single log shape so a single grep query (`finishReason: "length"`) works across providers without per-branch field names.
- **Inline cast, no hoisted named type:** A diagnostic-only field shouldn't pollute the type module. Inline `as { refusal?: string | null } | undefined` keeps the surface area at the access site; if DeepSeek removes the field tomorrow only this log breaks.
- **Cast targets `message`, not `choice`:** DeepSeek's `refusal` lives on the message body (parallel to `content`), not on the choice envelope. Casting `firstChoice?.message` is the smaller and correct shape.
- **`?? null` (not `?? undefined`):** Pino drops `undefined` fields from the JSON object but emits `null` as `"refusal": null`. Explicit `null` is easier to grep and signals "we looked, it wasn't there" vs "we forgot to log it".

## Known Stubs

None.

## Threat Flags

None — change is observability-only, same trust posture as the prior quick-260428-n29 log. Note: `refusal` text from DeepSeek may include the moderation reason (e.g. "I cannot help with..."), which is LLM-generated, not user-private. Input articles remain RSS-public — no user chat content reaches this log path.

## Self-Check: PASSED

- FOUND: src/services/ai.service.ts (modified, 12 insertions / 1 deletion)
- FOUND: commit 722b8df in `git log --oneline`
- FOUND: all required grep markers (finishReason ×4, refusal ×6, narrow cast ×1, both existing log messages preserved at count 1)
- FOUND: `npx tsc --noEmit` exit 0
