---
gsd_state_version: 1.0
milestone: v2.0
milestone_name: Thread Summaries
status: executing
stopped_at: Phase 6 context gathered
last_updated: "2026-04-30T09:06:05.140Z"
last_activity: 2026-04-30 -- Phase 07 planning complete
progress:
  total_phases: 4
  completed_phases: 2
  total_plans: 6
  completed_plans: 6
  percent: 100
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-04-27)

**Core value:** Participants get a quality-filtered AI digest every morning — builds the habit and saves 30-60 minutes of daily scrolling. v2.0 extends this with morning thread summaries so participants reconnect to club discussions without scrolling.
**Current focus:** Phase 06 — thread-summary-pipeline

## Current Position

Phase: 7
Plan: Not started
Status: Ready to execute
Last activity: 2026-04-30 -- Phase 07 planning complete

Progress: [░░░░░░░░░░] 0%

Note: `total_phases: 5` counts the integer code phases (4-8). Phase 0-Ops is a manual gating checklist, not a code phase, and is excluded from phase counts and plan counts.

## Performance Metrics

**Velocity (v2.0):**

- Total plans completed: 6
- Average duration: —
- Total execution time: 0h

**By Phase (v2.0):**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 4. Message Capture & Persistence | 0/3 | — | — |
| 5. Thread Tracking Commands | 0/TBD | — | — |
| 6. Thread Summarizer Service | 0/TBD | — | — |
| 7. Daily Summary Delivery | 0/TBD | — | — |
| 8. Operational & Privacy Commands | 0/TBD | — | — |
| 04 | 3 | - | - |
| 06 | 3 | - | - |

**Recent Trend:**

- Last 5 plans: — (none in v2.0 yet)
- Trend: —

*v1.0 velocity archived in `milestones/v1.0-ROADMAP.md` (10 plans across Phases 1-3 + 03.1).*
| Phase 04 P01 | 4min | 3 tasks | 7 files |
| Phase 04-message-capture-persistence P02 | 3min | 2 tasks | 3 files |
| Phase 04-message-capture-persistence P03 | 5min32s | 3 tasks | 6 files |

## Accumulated Context

### Decisions

Full decision log lives in PROJECT.md Key Decisions table. v1.0 patterns still load-bearing for v2.0:

- Long-polling, dual-provider LLM (`AI_BASE_URL` switch), MSK calendar day idempotency, admin-list cache 5-min TTL, options-object service signature, strict TypeScript no `any`, `requireEnv` / `requireEnvInt` fail-fast env, `bot.catch()` before commands.

v2.0-specific decisions (locked, see PROJECT.md):

- Single consolidated summary post (not per-thread)
- `better-sqlite3` (sync, file in Docker volume)
- No backfill — start «from the moment of activation»
- Whitelist via admin `/track` persisted in DB
- 06:30 MSK schedule (after 06:00 MSK AI-radar)
- `state.json` retained for cron idempotency with atomic-rename mitigation; SQLite migration deferred to v2.1
- [Phase 04]: WAL pragma applied first + verify-active throw defends DB-01 silent fallback
- [Phase 04]: In-code MIGRATIONS array with per-migration db.transaction() — forward-only
- [Phase 04]: Migration v1 ships ALL 4 product tables (D-06): no schema change in Phase 5-8
- [Phase 04]: ENV-seed dual-gated (empty table + non-empty CSV) for clean post-Phase-5 deactivation (D-02)
- [Phase 04]: MESSAGE_RETENTION_DAYS readEnvIntWithDefault enforces MIN=7 to defeat PRIV-02 typo regression
- [Phase 04]: THREAD_SUMMARY_THREAD_ID is requireEnvInt (no default) — gates Phase 6 delivery, fail-fast at boot
- [Phase 04]: No FKs in v1 (4 candidates rejected with documented rationale per RESEARCH §3)
- [Phase 04]: [Phase 04 P02] Lazy module-level prepared statements via ??= cache pattern (STORE-04) — first call prepares, subsequent reuse
- [Phase 04]: [Phase 04 P02] UPSERT uses ON CONFLICT(chat_id, tg_message_id) DO UPDATE with 3-column allowlist (text, author_name, edited_at) — preserves created_at on edit; INSERT OR IGNORE/REPLACE rejected
- [Phase 04]: [Phase 04 P02] Module-private trackedSet + read/write trio (load/check/list); listTrackedThreadIds returns [...set] copy — caller cannot mutate internal state (T-04-13)
- [Phase 04]: [Phase 04 P02] D-01 honoured: no track/untrack stubs in tracking.service — Phase 5 will ADD the writers without refactor
- [Phase 04-message-capture-persistence]: [Phase 04 P03] Single combined Grammy filter ['message:text','message:caption','edited_message:text','edited_message:caption'] — Pattern 3 from RESEARCH §1.1 chosen over 4 separate bot.on calls
- [Phase 04-message-capture-persistence]: [Phase 04 P03] 5-step guard chain order is_topic_message → is_automatic_forward → sender_chat.type → isThreadTracked → mapper → isAuthorForgotten → upsertMessage; entire body in try/catch (REL-04); metadata-only debug log (PRIV-05)
- [Phase 04-message-capture-persistence]: [Phase 04 P03] index.ts main() ordering initDb → loadTrackingWhitelist → startScheduler → bot.start (with runPreflight inside onStart); shutdown closeDb AFTER await bot.stop for REL-05 WAL checkpoint
- [Phase 04-message-capture-persistence]: [Phase 04 P03] REQUIREMENTS.md MSG-03 rewritten per D-08: 'Phase 4 captures only text-bearing messages' (text or caption, no placeholder rows for non-text)

### Pending Todos

None.

### Blockers/Concerns

**Phase 0-Ops manual checklist (gates Phase 4 verification):**

- BotFather privacy mode currently ON → must be OFF, bot kicked + re-invited + re-promoted to admin
- `«🧵 Сводки тредов»` forum topic must be created and `THREAD_SUMMARY_THREAD_ID` captured
- Host `./data` ownership for uid 1001; `docker-compose.yml` volume entry
- In-chat consent announcement (GDPR Art. 13) URL/screenshot captured at `.planning/phases/04-message-capture/04-OPS-CHECKLIST.md`

**Tech-debt items rolled into v2.0 phases (no longer blockers, owned by phases):**

- Dockerfile native-build toolchain → owned by Phase 4
- `state.json` not in volume + non-atomic write → owned by Phase 4 (volume) + Phase 6 (atomic write)
- `cron.ts` single-task slot → owned by Phase 6 (cron registry refactor)

### Quick Tasks Completed

| # | Description | Date | Commit | Directory |
|---|-------------|------|--------|-----------|
| 260428-m57 | Снизить порог публикации дайджеста с 3 до 1 и смягчить prompts/curator.md (3-5 новостей, гибкая квота vc.ru 0-2, ослаблять критерии когда новостей мало) | 2026-04-28 | 4ee9e7e | [260428-m57-3-1-prompts-curator-md-3-5-vc-ru-0-2](./quick/260428-m57-3-1-prompts-curator-md-3-5-vc-ru-0-2/) |
| 260428-mn8 | Восстановить формат "→ https://…" в prompts/curator.md под digest.formatter.ts и прописать императив 5-7 новостей минимум | 2026-04-28 | 403a744 | [260428-mn8-https-prompts-curator-md-formatter-5-7](./quick/260428-mn8-https-prompts-curator-md-formatter-5-7/) |
| 260428-n29 | Логировать сырой ответ LLM в ai.service.ts для диагностики (rawResponseHead/Length перед return) | 2026-04-28 | 97c9c2e | [260428-n29-llm-ai-service-ts-rawresponsehead-length](./quick/260428-n29-llm-ai-service-ts-rawresponsehead-length/) |
| 260428-n9u | Расширить диагностический лог в ai.service.ts (finish_reason, refusal, reasoning_content, usage, choice JSON) и поднять max_tokens до 4000 | 2026-04-28 | 74ed5a6 | [260428-n9u-ai-service-ts-finish-reason-refusal-reas](./quick/260428-n9u-ai-service-ts-finish-reason-refusal-reas/) |
| 260428-npl | max_tokens 4000 → 16000 + ужать description до 200 символов в formatArticlesForLLM | 2026-04-28 | b35a222 | [260428-npl-max-tokens-4000-16000-description-200-fo](./quick/260428-npl-max-tokens-4000-16000-description-200-fo/) |
| 260428-o92 | Заголовок новости в дайджесте сделать кликабельной ссылкой вместо отдельной строки → ссылка | 2026-04-29 | 0347c6e | [260428-o92-digest-formatter-clickable-headline-link](./quick/260428-o92-digest-formatter-clickable-headline-link/) |
| 260429-rm3 | Обновить устаревшие 06:00→09:00 MSK комментарии для digest в cron.ts и .env.example, добавить TZ=UTC заголовок ко всем cron-переменным | 2026-04-29 | 4f0ec5c | [260429-rm3-06-00-msk-09-00-msk-digest-src-scheduler](./quick/260429-rm3-06-00-msk-09-00-msk-digest-src-scheduler/) |

### Roadmap Evolution

- v1.0 (shipped 2026-04-27): Phases 1, 2, 3 + 03.1 (INSERTED) — 26/26 requirements
- v2.0 (in progress): Phase 0-Ops manual gate + Phases 4-8 — 57 requirements mapped 100%

## Session Continuity

Last session: 2026-04-29T10:58:56.494Z
Stopped at: Phase 6 context gathered
Resume file: .planning/phases/06-thread-summary-pipeline/06-CONTEXT.md
