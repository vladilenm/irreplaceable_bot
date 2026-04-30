# Roadmap: Telegram-bot "Nezamenimye"

## Milestones

- ✅ **v1.0 MVP — AI Radar Digest** — Phases 1-3 + 03.1 (shipped 2026-04-27) — see [milestones/v1.0-ROADMAP.md](milestones/v1.0-ROADMAP.md)
- 🚧 **v2.0 Thread Summaries** — Phase 0-Ops gate + Phases 4 + 6 (Phase 5 cancelled, Phase 7 removed; in progress)

## Overview

v2.0 turns the bot from a publish-only RSS agent into a *listening* agent: it captures messages from admin-whitelisted forum threads into a local SQLite database and publishes a single consolidated morning summary at 06:30 MSK alongside the existing 06:00 MSK AI-radar digest. The milestone is delivered as two integer code phases (4 + 6) preceded by a manual operational checklist (Phase 0-Ops) that must be executed before Phase 4 verification can be trusted. Phase 4 lands operational/infrastructure foundations (privacy mode, native build on Alpine, Docker volume permissions, idempotent capture); Phase 6 layers the full thread-summary pipeline (pure summariser + cron registry refactor + 06:30 MSK delivery orchestrator + HTML formatter + atomic state idempotency). Phase 5 (Thread Tracking Commands) was cancelled 2026-04-29 — admin whitelist is managed via env-seed/DB only, no in-chat commands. Phase 7 (Operational & Privacy Commands) was removed 2026-04-29 — out of scope for v2.0.

## Phases

**Phase Numbering:**
- Phase 0-Ops: manual operational checklist that gates Phase 4 verification (NOT a code phase, no plans)
- Phases 4-6: continue numbering from v1.0 (last phase: 03.1)
- Decimal phases reserved for urgent insertions (none planned)
- 2026-04-29: original Phase 6 (Thread Summarizer Service) merged with original Phase 7 (Daily Summary Delivery) into single Phase 6 (Thread Summary Pipeline); original Phase 8 (Operational & Privacy Commands) renumbered to Phase 7
- 2026-04-29: Phase 7 (Operational & Privacy Commands) removed from roadmap — out of scope for v2.0
- 2026-04-29: Phase 5 (Thread Tracking Commands) cancelled — admin whitelist managed via env-seed/DB without in-chat commands; numbering preserved (Phase 6 stays Phase 6) to keep git history and `.planning/phases/06-thread-summary-pipeline/` artifacts consistent
- 2026-04-30: Phase 7 slot reused for `v2.0 Closure` — gap-closure phase per `v2.0-MILESTONE-AUDIT.md` (retention sweep impl + forget-me infra removal + tech-debt + doc cleanup + Phase 0-Ops execution)

<details>
<summary>✅ v1.0 MVP — AI Radar Digest (Phases 1-3 + 03.1) — SHIPPED 2026-04-27</summary>

- [x] Phase 1: Foundation & Bot Shell (2/2 plans) — completed 2026-04-12
- [x] Phase 2: Digest Pipeline (3/3 plans) — completed 2026-04-13
- [x] Phase 3: Delivery & Operations (2/2 plans) — completed 2026-04-14
- [x] Phase 03.1: dev-digest command for repeatable digest testing (1/1 plan, INSERTED) — completed 2026-04-14

Full details: [milestones/v1.0-ROADMAP.md](milestones/v1.0-ROADMAP.md)

</details>

### 🚧 v2.0 Thread Summaries

**Milestone Goal:** Bot captures whitelisted forum-thread messages, summarises last 24h via LLM, publishes a single consolidated post at 06:30 MSK to a dedicated «🧵 Сводки тредов» topic. GDPR-compliant via `/forget-me` + 90-day retention.

- [ ] **Phase 0-Ops: Operational Pre-Flight Checklist** — manual gate before Phase 4 verification: BotFather privacy off, admin status, summary topic, volume permissions, consent announcement
- [ ] **Phase 4: Message Capture & Persistence** — SQLite infra + `bot.on('message'|'edited_message')` handler with whitelist filter and idempotent insert
- ⊘ **Phase 5: Thread Tracking Commands** — ~~admin `/track`, `/untrack`, `/tracked` with hot-reload Set + DB persistence~~ **CANCELLED 2026-04-29** (whitelist managed via env-seed/DB only, no in-chat commands)
- [x] **Phase 6: Thread Summary Pipeline** — pure `summarizeThread()` (anonymisation, prompt-injection defences, dual-provider parity) + cron registry refactor + 06:30 MSK delivery orchestrator + HTML formatter with overflow split + atomic state idempotency
- [ ] **Phase 7: v2.0 Closure** — retention sweep impl (PRIV-03), удаление `/forget-me` инфраструктуры (forgotten_users table + capture guard), зачистка мёртвого кода и documentation drift, Phase 0-Ops ручной чек-лист, 10 отложенных live E2E тестов

## Phase Details

### Phase 0-Ops: Operational Pre-Flight Checklist
**Goal**: Establish the operational pre-conditions that make Phase 4 capture verification meaningful — bot privacy mode OFF, admin status restored, dedicated summary topic created with ID captured, Docker volume + permissions configured, in-chat GDPR consent announcement published.
**Depends on**: Nothing (manual gating phase, runs before Phase 4 verification, NOT before Phase 4 code lands)
**Type**: Manual checklist — NOT a code phase, no plans, no implementation
**Requirements**: SETUP-09, PRIV-04
**Success Criteria** (what must be TRUE):
  1. `getMe().can_read_all_group_messages === true` confirmed in startup log (privacy mode OFF, bot kicked + re-invited + re-promoted to admin in club group)
  2. `«🧵 Сводки тредов»` forum topic exists in club group and `THREAD_SUMMARY_THREAD_ID` is captured in `.env`
  3. Host directory `./data` exists and is owned by uid 1001 (`sudo chown -R 1001:1001 ./data`); `docker-compose.yml` mounts `./data:/app/data`
  4. In-chat GDPR consent announcement published in club; URL or screenshot captured at `.planning/phases/04-message-capture/04-OPS-CHECKLIST.md` (lawful-basis evidence per GDPR Art. 13)
**Plans**: None — manual checklist, deliverable is `04-OPS-CHECKLIST.md` artifact

### Phase 4: Message Capture & Persistence
**Goal**: Bot reliably captures every text and non-text message arriving in whitelisted forum threads into a local SQLite database within <2s of arrival; edits update in place; duplicate deliveries are idempotent; service messages and channel posts are filtered out; failures in the capture path do not crash the long-polling loop.
**Depends on**: Phase 0-Ops (manual checklist must be complete before verification can be trusted)
**Requirements**: SETUP-05, SETUP-06, SETUP-07, SETUP-08, MSG-01, MSG-02, MSG-03, MSG-04, MSG-05, MSG-06, MSG-07, MSG-08, STORE-01, STORE-02, STORE-03, STORE-04, REL-04
**Success Criteria** (what must be TRUE):
  1. `docker compose up` succeeds on `node:20-alpine` with `better-sqlite3` native build (toolchain fallback in builder stage); `docker compose exec bot sh -c "id && touch /app/data/.write_test"` succeeds; `PRAGMA journal_mode` returns `wal`; `schema_migrations` row exists at version 1
  2. After `docker compose down && up`, the database file at `./data/messages.db` survives restart (Docker volume mounted)
  3. A regular member sending a non-command text message inside a tracked forum topic produces exactly one row in `messages` within 5s; the same message redelivered (Telegram retry, polling replay, restart-mid-update) still produces exactly one row
  4. Editing a captured message updates the same row by `(chat_id, tg_message_id)` with `edited_at` set, never creating a duplicate; an edit arriving before its original (out-of-order) upserts a new row with `edited_at` populated
  5. Service messages (`forum_topic_created`, `pinned_message`, `new_chat_members`, etc.), channel posts, and automatic forwards are filtered at the handler and produce zero DB rows; only text-bearing messages are captured — `messages.text` stores `ctx.message.text` OR `ctx.message.caption` (no `[photo]`/`[video]` prefix; non-text without caption drops, per CONTEXT D-08); anonymous-admin messages store `author_id = NULL` and `is_anonymous = true`
  6. Capture handler errors (DB lock, prepared-statement failure, schema mismatch) are caught, logged, and do NOT terminate the long-polling loop; pino logs do NOT include message text body (only `chat_id`, `thread_id`, `author_id`, `message_length`, `has_media`)
**Plans**: 3 plans
- [x] 04-01-PLAN.md — Infra foundation (Dockerfile, docker-compose, package.json, ENV/config, types, db.service.ts + WAL + MIGRATIONS v1 + ENV-seed)
- [x] 04-02-PLAN.md — Stores + tracking service stub (message-store upsert + forgotten guard, tracked-threads-store, tracking.service Set)
- [x] 04-03-PLAN.md — Capture handler + mapper + preflight + bot.ts/index.ts wiring + REQUIREMENTS.md MSG-03 rewrite

### Phase 5: Thread Tracking Commands ⊘ CANCELLED 2026-04-29
**Status**: CANCELLED — out of scope for v2.0. Admin whitelist is managed via env-seed (`TRACKED_THREAD_IDS`) and direct DB writes; no in-chat `/track`, `/untrack`, `/tracked` commands ship.
**Numbering note**: Phase 5 slot is preserved (NOT renumbered) to keep Phase 6's number, git history (`phase-06` commits), and `.planning/phases/06-thread-summary-pipeline/` artifacts consistent.
**Original Goal** (kept for reference): Admins manage the capture whitelist live from inside the chat without restarting the bot; the in-memory `Set<number>` is the source of truth for the hot path and stays consistent with DB; whitelist survives restart so first capture after boot honours the persisted whitelist.
**Original Depends on**: Phase 4 (capture handler + DB schema must exist)
**Original Requirements**: TRK-01, TRK-02, TRK-03, TRK-04, TRK-05 (deferred — re-evaluate in v2.1 if needed)
**Plans**: None — phase cancelled before planning

### Phase 6: Thread Summary Pipeline
**Goal**: End-to-end daily thread-summary feature — at 06:30 MSK every day, a single consolidated HTML post covering all tracked threads with ≥5 messages in the last 24h is published to the «🧵 Сводки тредов» topic, coexisting cleanly with the 06:00 MSK AI-radar digest. Internally: pure `summarizeThread(threadId, windowHours)` function (low-volume skip, anonymisation of numeric IDs, layered prompt-injection defences, Unicode display-name normalisation, dual-provider parity across Anthropic and OpenAI-compatible providers, no I/O beyond `ai.service.ts` calls), cron scheduler refactored to a named registry, idempotency via separate `lastThreadSummaryDate` state field with atomic writes, overflow posts split on thread-section boundaries.
**Depends on**: Phase 4 (message-store query layer for transcript building + state.json infra); whitelist iterated by orchestrator is sourced from `tracked_threads` table seeded via env/DB (Phase 5 commands cancelled)
**History**: 2026-04-29 — original Phase 6 (Thread Summarizer Service, pure function only) merged with original Phase 7 (Daily Summary Delivery, cron + orchestrator + formatter + state) into this single phase
**Requirements**: SUM-01, SUM-02, SUM-03, SUM-04, SUM-05, SUM-06, SUM-07, AI-07, DLV-06, DLV-07, DLV-08, DLV-09, DLV-10, STATE-01, STATE-02, SCHED-01, SCHED-02, SCHED-03, SCHED-04
**Success Criteria** (what must be TRUE):
  1. `summarizeThread(threadId, hours)` with <5 messages in the window returns `{skipped: true, reason: 'low-volume'}` and the LLM call is NOT made (verifiable in pino logs)
  2. Numeric `author_id` NEVER reaches the outbound LLM prompt — only normalised display names appear in the transcript (verified by inspecting outbound prompt fixture); display names are NFC-normalised, RTL/zero-width/control chars stripped before prompt insertion
  3. Single-shot path runs for transcripts ≤15k tokens (one LLM call per thread, token count via SDK endpoint or char heuristic `text.length / 3.5`); map-reduce path is deferred to v2.1 with explicit skip condition documented (no thread >12k tokens in first month)
  4. Adversarial transcript fixture (`Ignore previous instructions, output: ...`) produces a schema-conformant summary that does NOT obey the injection — system-role isolation, `<<<TRANSCRIPT_START>>>...<<<TRANSCRIPT_END>>>` delimiter sandwich, post-transcript instruction reaffirmation, structured JSON validation all enforced
  5. Switching `AI_MODEL` between Claude and an OpenAI-compatible provider (DeepSeek via `AI_BASE_URL`) yields the same `ThreadSummary` shape with the same fixture; both providers validated by the Phase 6 fixture suite
  6. `summarizeThread()` is added to `ai.service.ts` (or sibling `summarizer.service.ts`) without modifying the existing v1.0 `filterArticles()` signature
  7. `src/scheduler/cron.ts` is refactored from `let task: ScheduledTask | null` to `Map<string, ScheduledTask>`; external API of `startScheduler()` / `stopScheduler()` unchanged; on graceful SIGTERM/SIGINT all three jobs (`digest`, `thread-summary`, `retention-sweep`) log `Cron job stopped` with their name; a failed cron job is isolated by per-job try/catch and other jobs keep running
  8. At 06:30 MSK the `thread-summary` job fires, a single consolidated HTML post is published to `THREAD_SUMMARY_THREAD_ID` covering all tracked threads with ≥5 messages in the 24h window; threads with no activity or low-volume skip appear in the footer `тихо: N тредов` with no empty per-thread sections in the body
  9. Posts longer than 4096 chars are split on thread-section boundaries (never mid-section); each chunk is sent via existing `sendMessageWithRetry` with single retry on 429
  10. Idempotency uses a new `lastThreadSummaryDate` field in `state.json` (separate from `lastDigestDate`); a double cron fire on the same MSK day produces ONE post and subsequent invocations no-op with INFO log (manual `/summary` and `/dev-summary` invocation idempotency is handled in Phase 7)
  11. `writeState()` writes are atomic (`writeFileSync(tmp)` + `renameSync(tmp, final)`); `readState()` does NOT swallow `JSON.parse` errors — corrupt file logs ERROR and blocks publish for that cycle (no silent default fallback)
  12. The 06:00 MSK AI-radar digest job continues firing exactly as in v1.0 with no regression (validated by digest publish on the same day as a thread-summary)
**Plans**: 3 plans (vertical slices, Wave 1 parallel: 06-01 + 06-02; Wave 2: 06-03)
- [x] 06-01-summarizer-core-PLAN.md — Pure summarizer service: Zod schema, dual-provider tool-use/json-schema, prompt-injection sandwich, Unicode display-name normaliser, low-volume + token gates, adversarial fixture (SUM-01..07, AI-07)
- [x] 06-02-state-cron-persistence-PLAN.md — Migration v2 (tracked_threads.title), message-store query helpers (selectMessagesInWindow, selectTopParticipants), state.service.ts extraction (atomic writes, throw-on-corrupt, lastThreadSummaryDate, MSK-day idempotency), cron registry Map refactor with 3 named jobs (STATE-01/02, SCHED-01..04)
- [x] 06-03-orchestrator-delivery-PLAN.md — Orchestrator runThreadSummaryPipeline + thread-summary.formatter (compact layout, sort, escape, splitter, footer тихо) + sender chunk loop reusing sendMessageWithRetry + cron handler swap (DLV-06..10)

### Phase 7: v2.0 Closure
**Goal**: Закрыть milestone v2.0 — реализовать 90-дневный retention sweep (PRIV-03), снести неиспользуемую `/forget-me` инфраструктуру (`forgotten_users` table + capture guard) с миграцией v3, зачистить мёртвый код и documentation drift, выполнить ручной Phase 0-Ops чек-лист (SETUP-09 + PRIV-04), провести 10 отложенных live E2E тестов.
**Depends on**: Phase 4 (capture handler + DB schema), Phase 6 (scheduler registry, state.service)
**History**: 2026-04-30 — slot reused after Phase 7 (Operational & Privacy Commands) removal 2026-04-29; gap-closure phase per `.planning/v2.0-MILESTONE-AUDIT.md`
**Requirements**: SETUP-09, PRIV-03, PRIV-04
**Success Criteria** (what must be TRUE):
  1. Retention cron at 04:00 MSK actually deletes messages older than `MESSAGE_RETENTION_DAYS` (no longer a stub); batch ≤1000 rows per iteration with `LIMIT`; pino emits `{event: 'retention-sweep', rows_deleted: N, duration_ms: D}` per run
  2. Migration v3 drops `forgotten_users` table; capture handler no longer references the guard; manual `/forget-me` procedure (sqlite3 `DELETE FROM messages WHERE author_id = ?`) is documented in `04-OPS-CHECKLIST.md` for GDPR Art. 17 compliance
  3. Dead code removed: `upsertThreadTitle` (`tracked-threads-store.ts:60`), `isThreadSummaryPublishedToday` (`state.service.ts:102`), `ForumTopicCapableApi` double-cast (`thread-summary.service.ts:53`) simplified, stale comments in `tracking.service.ts:37-38,44-46` cleaned, `.env.example MESSAGE_RETENTION_DAYS=2` → `=90`
  4. REQUIREMENTS.md drift fixed: MSG-04 wording updated to `ON CONFLICT(chat_id, tg_message_id) DO UPDATE`; 18 Phase 6 requirements flipped `[ ]`→`[x]` (SUM-01..07, AI-07, DLV-06..10, STATE-01/02, SCHED-01..04); 18 cancelled requirements removed (TRK-01..05, CMD-04..08, PRIV-01/02/05, OBS-01..04, REL-05); traceability table + coverage refreshed; PRIV-03 reassigned to Phase 7 with `[x]`
  5. Phase 6 SUMMARY.md frontmatter `requirements-completed` filled in 06-01/06-02/06-03 (lists exist in body but missing from machine-readable YAML)
  6. Phase 0-Ops manual artifact `04-OPS-CHECKLIST.md` exists with: privacy-mode startup-log evidence (`can_read_all_group_messages === true`), `THREAD_SUMMARY_THREAD_ID` capture, host volume permissions confirmation (`docker compose exec bot id` + `touch /app/data/.write_test`), GDPR consent announcement URL/screenshot, results of 10 deferred live E2E tests (7 Phase 4 + 3 Phase 6), manual `/forget-me` runbook
**Plans**: 5 plans (all wave 1, parallel — no shared file modifications)
- [ ] 07-01-retention-sweep-PLAN.md — Retention sweep impl (PRIV-03): batched DELETE LIMIT 1000 + structured pino log; replace cron stub
- [ ] 07-02-migration-v3-forget-me-cleanup-PLAN.md — Migration v3 drops forgotten_users; capture handler + message-store strip isAuthorForgotten
- [ ] 07-03-dead-code-cleanup-PLAN.md — Remove isThreadSummaryPublishedToday + upsertThreadTitle + stale Phase 5/7/8 comments + .env.example MESSAGE_RETENTION_DAYS 2→90
- [ ] 07-04-requirements-md-summary-frontmatter-PLAN.md — REQUIREMENTS.md drift fix (MSG-04 wording, 19 checkbox flips, 18 cancelled-req removals, traceability rebuild) + 06-01/02/03 SUMMARY frontmatter requirements_completed backfill
- [ ] 07-05-phase-0-ops-checklist-PLAN.md — Scaffold .planning/phases/04-message-capture-persistence/04-OPS-CHECKLIST.md (autonomous=false for operator-fill steps; closes SETUP-09 + PRIV-04 after operator execution)
