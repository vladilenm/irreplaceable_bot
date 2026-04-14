# Phase 3: Delivery & Operations - Context

**Gathered:** 2026-04-14
**Status:** Ready for planning

<domain>
## Phase Boundary

Wire the digest pipeline (Phase 2) to Telegram delivery: cron-scheduled publishing to the AI-radar thread, HTML formatting, retry, idempotency, and operational commands (/digest, /status). After this phase, `docker compose up` starts a fully autonomous bot.

</domain>

<decisions>
## Implementation Decisions

### Idempotency (DLV-05)
- **D-01:** "Same day" determined by calendar date in MSK timezone (UTC+3) — compare `lastDigestDate` in `data/state.json` with current MSK date
- **D-02:** On duplicate run: skip silently — log warn, return result with `already_published` flag, do not run pipeline or send message

### Cron Scheduler (DLV-01)
- **D-03:** Use `node-cron` (per spec) with UTC cron expression `0 6 * * *` (06:00 UTC = 09:00 MSK). No timezone library needed — MSK does not observe DST
- **D-04:** Implement in existing stub `src/scheduler/cron.ts` — register cron job that calls `runDigestPipeline()` then publishes result
- **D-05:** Log cron start/stop and each trigger event via pino

### Telegram Sender (DLV-02)
- **D-06:** Use `bot.api.sendMessage()` from Grammy bot instance (exported from `bot.ts`) — works from both cron context and command handlers (no ctx dependency for cron)
- **D-07:** Implement in `src/modules/digest/digest.sender.ts` per SPEC.md structure
- **D-08:** Parameters: `chat_id` from `config.targetChatId`, `message_thread_id` from `config.aiRadarThreadId`, `parse_mode: "HTML"`, `disable_web_page_preview: true`

### HTML Formatting (DLV-03)
- **D-09:** `digest.formatter.ts` post-processes LLM text output into Telegram HTML — wrap headlines in `<b>`, URLs in `<a href>`, escape HTML entities in content
- **D-10:** LLM returns plain text with structure (Phase 2, D-07/D-10) — formatter parses and converts to HTML, not the other way around

### Retry (DLV-04)
- **D-11:** On Telegram API send error: 1 retry attempt (per spec). Log error on first failure, log fatal on second failure
- **D-12:** Delay between retries — Claude's discretion (reasonable delay, e.g. 2-5 seconds)

### Command /digest (CMD-02)
- **D-13:** Admin-only — check `ctx.from` against group admins via Grammy `getChatAdministrators` or similar
- **D-14:** Respects idempotency lock — if digest already published today (MSK), respond with "Дайджест уже опубликован сегодня" and do not run pipeline
- **D-15:** Immediate status message "Запускаю сборку дайджеста..." then edit message with result (success/error/skipped)
- **D-16:** Reply in same chat/thread where command was sent

### Command /status (CMD-03)
- **D-17:** Admin-only (same ACL check as /digest)
- **D-18:** Shows: date and result of last digest (ok/skipped), number of news items, next scheduled cron run time
- **D-19:** Reply in same chat/thread where command was sent
- **D-20:** Read info from `data/state.json` — no LLM calls, no token cost

### Claude's Discretion
- Retry delay between attempts (reasonable: 2-5 seconds)
- Exact error message text and log formats
- HTML formatter implementation details (regex vs parser for LLM output)
- Admin check caching strategy (if needed)
- Status message formatting details

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Specifications
- `SPEC.md` — Project structure (digest.sender.ts, digest.formatter.ts paths), .env variables, bot commands table, error handling principle ("ошибки логируются, не роняют бота, дайджест ретраит 1 раз при фейле"), idempotency principle
- `docs/rss.md` — Post format example, publication rules (time, thread, fallback), Bot API parameters (chat_id, message_thread_id, parse_mode: HTML, disable_web_page_preview), curator prompt (defines LLM output format that formatter must parse)

### Existing Code (Phase 1 + 2)
- `src/scheduler/cron.ts` — Stub with `startScheduler()` and `stopScheduler()`, called from `src/index.ts`
- `src/utils/telegram.ts` — Empty stub, to be populated with Telegram helpers
- `src/modules/digest/digest.service.ts` — `runDigestPipeline()` returns `DigestResult { text, itemCount, skipped, date }`
- `src/bot.ts` — Grammy bot instance with `/start` command and `bot.catch()` error handler
- `src/config.ts` — `targetChatId`, `aiRadarThreadId`, `digestCron` loaded from .env
- `src/types/index.ts` — `BotConfig`, `DigestItem`, `DigestCategory`, `DigestPayload`, `FeedConfig`, `RawArticle`
- `src/index.ts` — Entry point with graceful shutdown, calls `startScheduler()`/`stopScheduler()`

### Phase 2 Context
- `.planning/phases/02-digest-pipeline/02-CONTEXT.md` — Pipeline architecture decisions (D-07: LLM returns ready-made text, D-12: DigestResult interface, D-13: state.json persistence)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/scheduler/cron.ts` — Stub ready to be filled with node-cron job registration
- `src/utils/telegram.ts` — Empty stub for Telegram helpers (sendMessage wrapper, retry logic)
- `src/bot.ts` — Bot instance exported, can be imported for `bot.api.sendMessage()` calls
- `src/config.ts` — All delivery-related env vars already loaded (`targetChatId`, `aiRadarThreadId`, `digestCron`)
- `src/modules/digest/digest.service.ts` — `runDigestPipeline()` ready to be called from cron and /digest

### Established Patterns
- ESM modules with `.js` extensions in imports
- Config validation via `requireEnv()` for required vars
- Strict TypeScript (no `any`, `noUncheckedIndexedAccess`)
- Error handling: `bot.catch()` for command errors, `try/catch` with pino logging in services
- State persistence via `data/state.json` (read/write with `readFileSync`/`writeFileSync`)

### Integration Points
- `src/scheduler/cron.ts` `startScheduler()` — currently a stub, needs node-cron job that calls pipeline + sender
- `src/bot.ts` — Add `/digest` and `/status` command handlers (same pattern as `/start`)
- `src/modules/digest/digest.sender.ts` — New file, imports `bot` from `bot.ts` for `bot.api.sendMessage()`
- `src/modules/digest/digest.formatter.ts` — New file, transforms LLM plain text → Telegram HTML
- `src/index.ts` — No changes needed (already calls `startScheduler()` and handles shutdown)

</code_context>

<specifics>
## Specific Ideas

- After Phase 3, running `docker compose up` must start a fully working bot: cron publishes daily at 09:00 MSK, commands work, retry works, no duplicates
- Post format from `docs/rss.md` example: "📡 AI-радар | [дата]", news items with emoji+title+summary+link, footer "Дайджест Клуба Незаменимых / Система > Навык"
- Status message uses emoji for quick visual parsing (e.g., "📡 Последний дайджест: 14 апреля — 5 новостей")
- Admin check should be simple — don't over-engineer, basic Grammy admin verification

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 03-delivery-operations*
*Context gathered: 2026-04-14*
