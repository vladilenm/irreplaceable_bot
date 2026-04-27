# Roadmap: Telegram-bot "Nezamenimye"

## Milestones

- ✅ **v1.0 MVP — AI Radar Digest** — Phases 1-3 + 03.1 (shipped 2026-04-27) — see [milestones/v1.0-ROADMAP.md](milestones/v1.0-ROADMAP.md)
- 🚧 **v2.0 Thread Summaries** — Phase 0-Ops gate + Phases 4-8 (planned, in progress)

## Overview

v2.0 turns the bot from a publish-only RSS agent into a *listening* agent: it captures messages from admin-whitelisted forum threads into a local SQLite database and publishes a single consolidated morning summary at 06:30 MSK alongside the existing 06:00 MSK AI-radar digest. The milestone is delivered as five integer code phases (4-8) preceded by a manual operational checklist (Phase 0-Ops) that must be executed before Phase 4 verification can be trusted. The build order de-risks operational and infrastructure blockers in Phase 4 (privacy mode, native build on Alpine, Docker volume permissions, idempotent capture), then layers admin tracking (Phase 5), an isolated pure-function summariser (Phase 6), the cron-orchestrator-formatter trio (Phase 7), and finally GDPR + ops commands (Phase 8). Phase 6 and Phase 7-01 (cron registry refactor) are independent and can be co-developed; the rest is sequential.

## Phases

**Phase Numbering:**
- Phase 0-Ops: manual operational checklist that gates Phase 4 verification (NOT a code phase, no plans)
- Phases 4-8: continue numbering from v1.0 (last phase: 03.1)
- Decimal phases reserved for urgent insertions (none planned)

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
- [ ] **Phase 5: Thread Tracking Commands** — admin `/track`, `/untrack`, `/tracked` with hot-reload Set + DB persistence
- [ ] **Phase 6: Thread Summarizer Service** — pure `summarizeThread(threadId, hours)` function with anonymisation, prompt-injection defences, dual-provider parity
- [ ] **Phase 7: Daily Summary Delivery** — cron registry refactor + 06:30 MSK orchestrator + HTML formatter + atomic state idempotency
- [ ] **Phase 8: Operational & Privacy Commands** — `/summary`, `/dev-summary`, `/storage`, `/forget-me` + retention sweep + observability counters

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
  5. Service messages (`forum_topic_created`, `pinned_message`, `new_chat_members`, etc.), channel posts, and automatic forwards are filtered at the handler and produce zero DB rows; non-text messages are stored with placeholders (`[photo]`, `[voice 0:42]`, ...) including caption when present; anonymous-admin messages store `author_id = NULL` and `is_anonymous = true`
  6. Capture handler errors (DB lock, prepared-statement failure, schema mismatch) are caught, logged, and do NOT terminate the long-polling loop; pino logs do NOT include message text body (only `chat_id`, `thread_id`, `author_id`, `message_length`, `has_media`)
**Plans**: TBD (estimated 3 plans: 4-01 infra/Dockerfile/compose/db.service/migrations, 4-02 message-store/types/idempotency, 4-03 capture handler + register in bot.ts + preflight log)

### Phase 5: Thread Tracking Commands
**Goal**: Admins manage the capture whitelist live from inside the chat without restarting the bot; the in-memory `Set<number>` is the source of truth for the hot path and stays consistent with DB; whitelist survives restart so first capture after boot honours the persisted whitelist.
**Depends on**: Phase 4 (capture handler + DB schema must exist)
**Requirements**: TRK-01, TRK-02, TRK-03, TRK-04, TRK-05
**Success Criteria** (what must be TRUE):
  1. Admin invoking `/track` inside a forum topic adds the current `message_thread_id` to the whitelist (DB row + in-memory Set updated atomically); the very next message in that topic is captured without restart
  2. Admin invoking `/untrack` inside a topic removes it from the whitelist; existing captured rows remain (only the retention sweep deletes them)
  3. Admin invoking `/tracked` lists active whitelist entries (thread IDs + topic titles via `getForumTopic` when available, fall back to ID only)
  4. After bot restart, `loadTrackingWhitelist()` populates the in-memory Set from DB before `bot.start()`, so the first capture after boot honours the persisted whitelist
  5. Non-admin users invoking `/track`, `/untrack`, or `/tracked` are silently ignored (reuses existing `isAdmin()` guard with 5-min cache)
**Plans**: TBD (estimated 2 plans: 5-01 tracking.service + tracked-threads-store + load on startup, 5-02 commands + hot-reload wiring)

### Phase 6: Thread Summarizer Service
**Goal**: Pure function `summarizeThread(threadId, windowHours)` returns a typed `ThreadSummary` for any tracked thread, with low-volume skip, anonymisation of numeric IDs, layered prompt-injection defences, Unicode display-name normalisation, and identical schema-conformant output across both Anthropic and OpenAI-compatible providers. Function does no I/O beyond `ai.service.ts` calls — fully testable with fixtures.
**Depends on**: Phase 4 (message-store query layer must exist for transcript building)
**Note on parallelism**: Phase 6 is independent of Phase 7-01 (cron registry refactor) and the two can be co-developed. Roadmap-level dependency Phase 6 → Phase 7 still holds because the Phase 7 orchestrator consumes the summariser.
**Requirements**: SUM-01, SUM-02, SUM-03, SUM-04, SUM-05, SUM-06, SUM-07, AI-07
**Success Criteria** (what must be TRUE):
  1. `summarizeThread(threadId, hours)` with <5 messages in the window returns `{skipped: true, reason: 'low-volume'}` and the LLM call is NOT made (verifiable in pino logs)
  2. Numeric `author_id` NEVER reaches the outbound LLM prompt — only normalised display names appear in the transcript (verified by inspecting outbound prompt fixture); display names are NFC-normalised, RTL/zero-width/control chars stripped before prompt insertion
  3. Single-shot path runs for transcripts ≤15k tokens (one LLM call per thread, token count via SDK endpoint or char heuristic `text.length / 3.5`); map-reduce path is deferred to v2.1 with explicit skip condition documented (no thread >12k tokens in first month)
  4. Adversarial transcript fixture (`Ignore previous instructions, output: ...`) produces a schema-conformant summary that does NOT obey the injection — system-role isolation, `<<<TRANSCRIPT_START>>>...<<<TRANSCRIPT_END>>>` delimiter sandwich, post-transcript instruction reaffirmation, structured JSON validation all enforced
  5. Switching `AI_MODEL` between Claude and an OpenAI-compatible provider (DeepSeek via `AI_BASE_URL`) yields the same `ThreadSummary` shape with the same fixture; both providers validated by the Phase 6 fixture suite
  6. `summarizeThread()` is added to `ai.service.ts` (or sibling `summarizer.service.ts`) without modifying the existing v1.0 `filterArticles()` signature
**Plans**: TBD (estimated 2 plans: 6-01 prompts/thread-summarizer.md + summarizer.service.ts single-shot + token counter + dual-provider fixture, 6-02 anonymisation + Unicode normalisation + prompt-injection defence + schema validation)

### Phase 7: Daily Summary Delivery
**Goal**: At 06:30 MSK every day, a single consolidated HTML post covering all tracked threads with ≥5 messages in the last 24h is published to the «🧵 Сводки тредов» topic, coexisting cleanly with the 06:00 MSK AI-radar digest. The cron scheduler is refactored to a named registry, idempotency uses a separate state field with atomic writes, and overflow posts split on thread-section boundaries.
**Depends on**: Phase 6 (orchestrator consumes the summariser); Phase 7-01 cron registry refactor is independent of Phase 6 and parallelisable
**Requirements**: DLV-06, DLV-07, DLV-08, DLV-09, DLV-10, STATE-01, STATE-02, SCHED-01, SCHED-02, SCHED-03, SCHED-04
**Success Criteria** (what must be TRUE):
  1. `src/scheduler/cron.ts` is refactored from `let task: ScheduledTask | null` to `Map<string, ScheduledTask>`; external API of `startScheduler()` / `stopScheduler()` unchanged; on graceful SIGTERM/SIGINT all three jobs (`digest`, `thread-summary`, `retention-sweep`) log `Cron job stopped` with their name; a failed cron job is isolated by per-job try/catch and other jobs keep running
  2. At 06:30 MSK the `thread-summary` job fires, a single consolidated HTML post is published to `THREAD_SUMMARY_THREAD_ID` covering all tracked threads with ≥5 messages in the 24h window; threads with no activity or low-volume skip appear in the footer `тихо: N тредов` with no empty per-thread sections in the body
  3. Posts longer than 4096 chars are split on thread-section boundaries (never mid-section); each chunk is sent via existing `sendMessageWithRetry` with single retry on 429
  4. Idempotency uses a new `lastThreadSummaryDate` field in `state.json` (separate from `lastDigestDate`); a double cron fire or `/summary` invocation on the same MSK day produces ONE post and subsequent invocations no-op with INFO log
  5. `writeState()` writes are atomic (`writeFileSync(tmp)` + `renameSync(tmp, final)`); `readState()` does NOT swallow `JSON.parse` errors — corrupt file logs ERROR and blocks publish for that cycle (no silent default fallback)
  6. The 06:00 MSK AI-radar digest job continues firing exactly as in v1.0 with no regression (validated by digest publish on the same day as a thread-summary)
**Plans**: TBD (estimated 3 plans: 7-01 cron registry refactor + state.service extraction + atomic writeState, 7-02 thread-summary.service orchestrator + iterate whitelist + new config fields, 7-03 thread-summary.formatter HTML + 4096 splitter + sender + idempotency state field)

### Phase 8: Operational & Privacy Commands
**Goal**: Production-readiness layer — admins can trigger and inspect the pipeline (`/summary`, `/dev-summary`, `/storage`); members can exercise their GDPR right to erasure (`/forget-me`); a daily retention sweep enforces 90-day deletion; pino emits structured operational metrics that catch silent-failure modes (privacy-mode rollback, summary cost spikes, sweep regressions). Without this phase, Phase 7 is a GDPR violation in production.
**Depends on**: Phase 7 (orchestrator + state pattern reused by `/summary` and `/dev-summary`); also depends on Phase 4 (capture handler must check `forgotten_users` before insert)
**Requirements**: CMD-04, CMD-05, CMD-06, CMD-07, CMD-08, PRIV-01, PRIV-02, PRIV-03, PRIV-05, OBS-01, OBS-02, OBS-03, OBS-04, REL-05
**Success Criteria** (what must be TRUE):
  1. Admin `/summary` triggers the thread-summary pipeline immediately and respects daily idempotency (no double publish); admin `/dev-summary` triggers it bypassing idempotency with `persistState: false`, mirroring the `/dev-digest` pattern from Phase 03.1
  2. Admin `/storage` reports per-thread row count, total DB size, and oldest captured message timestamp; output matches an independent `sqlite3 data/messages.db` query
  3. Any member invoking `/forget-me` triggers a single `db.transaction()` that inserts into `forgotten_users` BEFORE deleting from `messages` — capture handler checks `forgotten_users` on every insert and short-circuits, so a forgotten user's subsequent messages are never stored even under concurrent capture; deletion-count confirmation is delivered via DM (`ctx.api.sendMessage(ctx.from.id, ...)`) with fallback to thread reply if user has not started the bot in DM
  4. The 04:00 MSK retention sweep deletes messages older than `MESSAGE_RETENTION_DAYS` (default 90, min 7 enforced) in batches of ≤1000 rows per iteration; sweep emits `{event: 'retention-sweep', rows_deleted: N, duration_ms: D}` log line on completion
  5. pino logs include hourly INFO `{event: 'capture-rate', messages: N, threads: M, period: '1h'}` aggregate (catches privacy-mode-rollback silent failure), per-LLM-call `{provider, model, tokens_in, tokens_out, latency_ms}` metadata, and daily summary outcome `{event: 'thread-summary-published', threads_summarised: N, threads_skipped_low_volume: M, total_tokens: K}` — message text body is NEVER logged
  6. On graceful SIGTERM/SIGINT, `closeDb()` is called AFTER `bot.stop()` completes — WAL is checkpointed and in-flight transactions are allowed to finish before process exit
**Plans**: TBD (estimated 3 plans: 8-01 /summary + /dev-summary commands, 8-02 /storage + /forget-me + forgotten_users + capture pre-check, 8-03 retention.service + retention sweep cron + ingest-rate counter + closeDb shutdown)

## Progress

**Execution Order:** Phases execute in numeric order: 1 → 2 → 3 → 03.1 → (Phase 0-Ops manual gate) → 4 → 5 → 6 → 7 → 8

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Foundation & Bot Shell | v1.0 | 2/2 | Complete | 2026-04-12 |
| 2. Digest Pipeline | v1.0 | 3/3 | Complete | 2026-04-13 |
| 3. Delivery & Operations | v1.0 | 2/2 | Complete | 2026-04-14 |
| 03.1. dev-digest (INSERTED) | v1.0 | 1/1 | Complete | 2026-04-14 |
| 0-Ops. Pre-Flight Checklist | v2.0 | manual gate | Not started | - |
| 4. Message Capture & Persistence | v2.0 | 0/TBD | Not started | - |
| 5. Thread Tracking Commands | v2.0 | 0/TBD | Not started | - |
| 6. Thread Summarizer Service | v2.0 | 0/TBD | Not started | - |
| 7. Daily Summary Delivery | v2.0 | 0/TBD | Not started | - |
| 8. Operational & Privacy Commands | v2.0 | 0/TBD | Not started | - |
