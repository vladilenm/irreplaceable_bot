---
phase: 260503-cq1
plan: 01
subsystem: telegram-diagnostics
tags: [diagnostic, logging, telegram, prod-digest-delivery-conflict]
status: complete
type: quick
requirements: [DIAG-260503-cq1-01]
dependency-graph:
  requires: [grammy>=1.0 (GrammyError class), pino logger]
  provides: [describeSendError helper (private), diagnostic msg-string format]
  affects: [src/utils/telegram.ts, src/utils/telegram.test.ts]
tech-stack:
  added: []
  patterns:
    - "Inline-into-msg diagnostic suffix — workaround for Timeweb dashboard which renders only pino `msg`, hiding structured `err` binding"
    - "Three-tier err narrowing: GrammyError → Error → unknown (mirrors src/utils/startup-error.ts:30 precedent)"
key-files:
  created: []
  modified:
    - src/utils/telegram.ts
    - src/utils/telegram.test.ts
decisions:
  - "Use `instanceof GrammyError` (not duck-typing) — proven pattern from startup-error.ts, narrowest type guard, satisfies strict-TS no-`any` constraint"
  - "Preserve existing `{ ...logBinding, err }` bindings — only the second-arg msg string is upgraded; structured-log consumers keep working"
  - "Add both `startsWith` AND `toContain` test assertions — they catch independent regression modes (msg renamed vs. extractor removed)"
  - "Mark patch with `TODO(prod-digest-delivery-conflict)` so revert site is obvious to next session"
metrics:
  duration: 1min 19s
  completed: 2026-05-03
  tasks_completed: 3
  tasks_total: 3
  files_modified: 2
---

# Quick Task 260503-cq1: Surface Telegram sendMessage Failure Details in Pino msg Summary

**One-liner:** Inlined `error_code`/`description`/`chatId`/`threadId` directly into both Telegram-failure pino msg strings via a safe `describeSendError(err, chatId, threadId)` extractor — Timeweb dashboard now reveals the actual Telegram API rejection without needing to expand structured log payloads.

## Result

3/3 tasks complete. Two files modified. Full repo typecheck passes; full vitest suite green (17 files, 114 tests).

| Task | Name                                                                       | Commit  | Files                       |
| ---- | -------------------------------------------------------------------------- | ------- | --------------------------- |
| 1    | Add diagnostic msg-string interpolation to both sendMessage failure logs   | 896ade5 | src/utils/telegram.ts       |
| 2    | Update telegram.test.ts assertions C3 + C4 to match new msg substring      | 53d3329 | src/utils/telegram.test.ts  |
| 3    | Full repo typecheck + full vitest suite — confirm no collateral damage     | (none, verify-only) | (no file changes) |

## Diff Stats

```
src/utils/telegram.test.ts | 16 ++++++++++++++--
src/utils/telegram.ts      | 32 ++++++++++++++++++++++++++++++--
2 files changed, 44 insertions(+), 4 deletions(-)
```

## msg-String Format Shipped to Prod

Operators can grep the Timeweb dashboard for these prefixes:

**First-attempt failure (level 50, error):**

```
Telegram sendMessage failed, retrying in 3s: error_code=<code|no-code> description=<desc|err.message|String(err)> chatId=<id> threadId=<id>
```

**Post-retry failure (level 60, fatal):**

```
Telegram sendMessage failed after retry: error_code=<code|no-code> description=<desc|err.message|String(err)> chatId=<id> threadId=<id>
```

Concrete example captured from vitest run (plain `Error('flaky-2')` → fallback path):

```
Telegram sendMessage failed after retry: error_code=no-code description=flaky-2 chatId=-100 threadId=42
```

For a real GrammyError (e.g. 400 Bad Request) the dashboard would show e.g.:

```
Telegram sendMessage failed after retry: error_code=400 description=Bad Request: message thread not found chatId=-1001234567890 threadId=42
```

## Verification Outcomes

- `grep -E "error_code=\$\{errorCode\}" src/utils/telegram.ts` → matches the helper return statement.
- `grep -c "describeSendError" src/utils/telegram.ts` → 3 (1 definition + 2 call sites).
- `grep -c "TODO(prod-digest-delivery-conflict)" src/utils/telegram.ts` → 1 (above the helper).
- `npx tsc --noEmit` → exit 0, no errors anywhere in the repo.
- `npx vitest run src/utils/telegram.test.ts` → 5/5 tests pass (C1-C5).
- `npx vitest run` (full suite) → 114/114 tests pass across 17 files.
- Existing `{ ...logBinding, err }` and `{ ...logBinding, err: retryErr }` bindings unchanged — verified by reading the patched file (success-path log lines also untouched).
- C1, C2, C5 tests untouched (only C3 + C4 updated as planned).

## Deviations from Plan

None — plan executed exactly as written. All 3 tasks ran sequentially with verification commands matching the planned `<verify>` blocks, and all `<done>` criteria satisfied without auto-fix triggers.

## Diagnostic-Only — Revert Owed

This patch is **temporary diagnostic instrumentation**, paired with the in-flight prod-digest-delivery-conflict investigation. It belongs to the same diagnostic family as recent commits:

- `eb7ae3d` — debug: add step counter to main() entry log
- `de0dc70` — debug: stamp bootId on every log entry

**Revert plan** (3 surgical edits, anchored by the `TODO(prod-digest-delivery-conflict)` marker):

1. Remove `import { GrammyError } from 'grammy';` (line 2 of telegram.ts) **only if** no other code in telegram.ts uses GrammyError after revert (currently true).
2. Delete the `describeSendError` function and its leading TODO comment block (telegram.ts ~lines 25-44).
3. Restore the two log calls to their single-line single-arg form:
   ```typescript
   logger.error({ ...logBinding, err }, 'Telegram sendMessage failed, retrying in 3s');
   logger.fatal({ ...logBinding, err: retryErr }, 'Telegram sendMessage failed after retry');
   ```
4. In telegram.test.ts: revert C3/C4 matchers to exact-equality string comparison and remove the `toContain('error_code=')` / `chatId=` / `threadId=` / `description=flaky-2` assertions. C1, C2, C5 already untouched.

**Trigger for revert:** Once an operator captures a real failure msg from the Timeweb dashboard and the root cause of `Telegram sendMessage failed after retry` is identified and fixed in a separate plan.

## Self-Check: PASSED

- FOUND: src/utils/telegram.ts (modified, contains `describeSendError` + TODO comment + GrammyError import)
- FOUND: src/utils/telegram.test.ts (modified, contains startsWith + error_code= assertions in C3/C4)
- FOUND: commit 896ade5 (Task 1)
- FOUND: commit 53d3329 (Task 2)
- All `<done>` criteria from plan satisfied; full-suite typecheck + vitest both green.
