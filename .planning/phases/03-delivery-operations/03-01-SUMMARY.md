---
phase: 03-delivery-operations
plan: 01
subsystem: delivery
tags: [telegram, cron, idempotency, html-formatter, retry]
requirements: [DLV-01, DLV-02, DLV-03, DLV-04, DLV-05]
dependency_graph:
  requires:
    - src/modules/digest/digest.service.ts (runDigestPipeline)
    - src/bot.ts (Grammy Bot instance)
    - src/config.ts (targetChatId, aiRadarThreadId, digestCron)
  provides:
    - formatDigestHtml (digest.formatter.ts)
    - sendDigest (digest.sender.ts)
    - sendMessageWithRetry (utils/telegram.ts)
    - startScheduler / stopScheduler (scheduler/cron.ts)
    - isDigestPublishedToday, readState, PipelineState (digest.service.ts)
  affects:
    - src/index.ts (already wired to startScheduler/stopScheduler; no change needed)
tech_stack:
  added: []
  patterns:
    - "HTML-escape-then-transform for safe Telegram HTML rendering"
    - "Single-retry with fixed backoff for outbound API calls"
    - "Local state.json + MSK date compare for cron idempotency"
key_files:
  created:
    - src/modules/digest/digest.formatter.ts
    - src/modules/digest/digest.sender.ts
  modified:
    - src/utils/telegram.ts
    - src/modules/digest/digest.service.ts
    - src/scheduler/cron.ts
decisions:
  - "Used link_preview_options: { is_disabled: true } (newer Grammy/Bot API) instead of deprecated disable_web_page_preview — same behavior, forward-compatible"
  - "Idempotency keyed on MSK calendar day via toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' }) — avoids timezone drift at UTC midnight"
  - "alreadyPublished returned as a new DigestResult field rather than throwing — keeps cron handler branching explicit and testable"
metrics:
  completed: 2026-04-14
  tasks: 2
  files_touched: 5
---

# Phase 3 Plan 1: Delivery Pipeline — Formatter, Sender, Retry, Cron, Idempotency

Complete delivery loop: cron job triggers the digest pipeline at 09:00 MSK, pipeline hits RSS + LLM, result is formatted as Telegram HTML, sent with one-retry safety net to the AI-radar thread, and an MSK-day idempotency guard prevents double-sends.

## What Was Built

### Task 1 — Formatter, sender, telegram helper, idempotency (commit 981d52f)

- **`src/modules/digest/digest.formatter.ts`** — `formatDigestHtml(plainText)`: escapes `&`, `<`, `>` first, then wraps `📡`-prefixed header lines and category-emoji (🤖 🔗 🧠 🛠 ⚡ 💰) headlines in `<b>…</b>`, converts `→ https://…` into `→ <a href="…">ссылка</a>` (un-escaping `&amp;` inside the href so query strings survive).
- **`src/utils/telegram.ts`** — `sendMessageWithRetry({ chatId, threadId, text, parseMode })`: calls `bot.api.sendMessage` with `message_thread_id`, `parse_mode: 'HTML'`, `link_preview_options: { is_disabled: true }`. On failure: logs `error`, waits 3s, retries once; on second failure logs `fatal` and re-throws. On success logs only metadata (chatId, threadId) per T-03-04.
- **`src/modules/digest/digest.sender.ts`** — `sendDigest(result)`: early-returns on `skipped` or empty text (warn log), otherwise formats and sends. Logs `{ itemCount, date }` on success.
- **`src/modules/digest/digest.service.ts`** — extended:
  - `DigestResult` gains `alreadyPublished: boolean`.
  - `PipelineState` gains `lastItemCount: number` (for future `/status`).
  - `readState` and `PipelineState` are now exported.
  - New `isDigestPublishedToday()` — compares today vs `state.lastDigestDate` in the Europe/Moscow calendar via `toLocaleDateString('en-CA', …)`.
  - `runDigestPipeline` starts with an idempotency short-circuit: if already published today (MSK) and last run was not skipped → returns `{ alreadyPublished: true }` without touching RSS/LLM.

### Task 2 — Cron scheduler (commit e36ea3d)

- **`src/scheduler/cron.ts`** — replaces stub with a real `node-cron` scheduler:
  - Validates the cron expression (`cron.validate`) — invalid expression logs error and does not schedule.
  - Schedules an async handler that runs the pipeline, honours `alreadyPublished`, then calls `sendDigest`.
  - Entire handler is wrapped in `try/catch` so pipeline/send failures log but never crash the bot (REL-02 / T-03-03).
  - `stopScheduler` calls `task.stop()` and nulls the reference.
  - Uses `ScheduledTask` typing from `node-cron` — no `any`.

`src/index.ts` was already wired to call `startScheduler()`/`stopScheduler()`, so no change there.

## Truths Verified

- [x] Cron fires at configured MSK time and triggers pipeline + publish — `startScheduler` registers handler via `cron.schedule(config.digestCron, …)`
- [x] Digest text formatted as Telegram HTML with category emoji, bold titles, hyperlinked URLs — formatter regex + `<b>` wrap + `<a href>` conversion
- [x] Message sent to AI-radar thread with HTML parse mode and disabled preview — `message_thread_id` + `parse_mode: 'HTML'` + `link_preview_options.is_disabled`
- [x] On send error retries once after delay — `sendMessageWithRetry` 3s delay + single retry
- [x] Running pipeline twice on same MSK day does not duplicate the message — `isDigestPublishedToday` short-circuits inside `runDigestPipeline`, and cron handler also bails on `alreadyPublished`

## Threat Model Mitigations

| Threat ID | Where mitigated |
|-----------|-----------------|
| T-03-01 (HTML injection from LLM/RSS) | `escapeHtml` applied to full text before tag wrapping |
| T-03-03 (Cron handler crashes bot) | `try/catch` around the whole cron handler body |
| T-03-04 (Leaking message text in logs) | sendMessageWithRetry logs only `{ chatId, threadId }`, not text |
| T-03-06 (Repudiation) | structured pino logs at every send step (`info`/`error`/`fatal`) |

## Verification

- `npx tsc --noEmit` → exit 0 (both after Task 1 and Task 2).
- `grep -E ": any|<any>|as any"` on the four touched files → no matches.
- All acceptance criteria for both tasks satisfied (formatter regex, `<b>`/`<a>` conversions, retry in catch, fatal log on second failure, MSK tz string, `alreadyPublished`/`lastItemCount` fields, `cron.validate`, `task.stop()`, Scheduler info logs).

## Deviations from Plan

**None that change behavior.** One small spec clarification the plan anticipated:

- The plan allowed either `disable_web_page_preview: true` or `link_preview_options: { is_disabled: true }` depending on Grammy types — chose `link_preview_options` because it is the current Bot API shape and cleanly typed in Grammy 1.42.

All other code follows the plan verbatim.

## Known Stubs

None. All four delivery-pipeline files are fully implemented.

## Commits

- `981d52f` — feat(03-01): add digest formatter, sender, telegram helper, idempotency
- `e36ea3d` — feat(03-01): wire cron scheduler to digest pipeline and sender

## Self-Check: PASSED

- src/modules/digest/digest.formatter.ts — FOUND
- src/modules/digest/digest.sender.ts — FOUND
- src/utils/telegram.ts — FOUND (replaced stub)
- src/scheduler/cron.ts — FOUND (replaced stub)
- src/modules/digest/digest.service.ts — FOUND (extended)
- Commit 981d52f — FOUND in git log
- Commit e36ea3d — FOUND in git log
- `npx tsc --noEmit` — exit 0
