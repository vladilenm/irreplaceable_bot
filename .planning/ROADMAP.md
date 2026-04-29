# Roadmap: Telegram-bot "Nezamenimye"

## Milestones

- ✅ **v1.0 MVP — AI Radar Digest** — Phases 1-3 + 03.1 (shipped 2026-04-27) — see [milestones/v1.0-ROADMAP.md](milestones/v1.0-ROADMAP.md)
- 🚧 **v2.0 Thread Summaries** — Phase 0-Ops gate + Phases 4-7 (planned, in progress)

## Overview

v2.0 turns the bot from a publish-only RSS agent into a *listening* agent: it captures messages from admin-whitelisted forum threads into a local SQLite database and publishes a single consolidated morning summary at 06:30 MSK alongside the existing 06:00 MSK AI-radar digest. The milestone is delivered as four integer code phases (4-7) preceded by a manual operational checklist (Phase 0-Ops) that must be executed before Phase 4 verification can be trusted. The build order de-risks operational and infrastructure blockers in Phase 4 (privacy mode, native build on Alpine, Docker volume permissions, idempotent capture), then layers admin tracking (Phase 5), the full thread-summary pipeline (Phase 6 — pure summariser + cron registry refactor + 06:30 MSK delivery orchestrator + HTML formatter + atomic state idempotency), and finally GDPR + ops commands (Phase 7).

## Phases

**Phase Numbering:**
- Phase 0-Ops: manual operational checklist that gates Phase 4 verification (NOT a code phase, no plans)
- Phases 4-7: continue numbering from v1.0 (last phase: 03.1)
- Decimal phases reserved for urgent insertions (none planned)
- 2026-04-29: original Phase 6 (Thread Summarizer Service) merged with original Phase 7 (Daily Summary Delivery) into single Phase 6 (Thread Summary Pipeline); original Phase 8 (Operational & Privacy Commands) renumbered to Phase 7

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
- [ ] **Phase 6: Thread Summary Pipeline** — pure `summarizeThread()` (anonymisation, prompt-injection defences, dual-provider parity) + cron registry refactor + 06:30 MSK delivery orchestrator + HTML formatter with overflow split + atomic state idempotency
- [ ] **Phase 7: Operational & Privacy Commands** — `/summary`, `/dev-summary`, `/storage`, `/forget-me` + retention sweep + observability counters

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

### Phase 6: Thread Summary Pipeline
**Goal**: End-to-end daily thread-summary feature — at 06:30 MSK every day, a single consolidated HTML post covering all tracked threads with ≥5 messages in the last 24h is published to the «🧵 Сводки тредов» topic, coexisting cleanly with the 06:00 MSK AI-radar digest. Internally: pure `summarizeThread(threadId, windowHours)` function (low-volume skip, anonymisation of numeric IDs, layered prompt-injection defences, Unicode display-name normalisation, dual-provider parity across Anthropic and OpenAI-compatible providers, no I/O beyond `ai.service.ts` calls), cron scheduler refactored to a named registry, idempotency via separate `lastThreadSummaryDate` state field with atomic writes, overflow posts split on thread-section boundaries.
**Depends on**: Phase 4 (message-store query layer for transcript building + state.json infra); Phase 5 whitelist iterated by orchestrator
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

### Phase 7: Operational & Privacy Commands
**Goal**: Production-readiness layer — admins can trigger and inspect the pipeline (`/summary`, `/dev-summary`, `/storage`); members can exercise their GDPR right to erasure (`/forget-me`); a daily retention sweep enforces 90-day deletion; pino emits structured operational metrics that catch silent-failure modes (privacy-mode rollback, summary cost spikes, sweep regressions). Without this phase, Phase 6's daily delivery is a GDPR violation in production.
**Depends on**: Phase 6 (orchestrator + state pattern reused by `/summary` and `/dev-summary`); also depends on Phase 4 (capture handler must check `forgotten_users` before insert)
**History**: 2026-04-29 — renumbered from Phase 8 after Phase 6/7 merge
**Requirements**: CMD-04, CMD-05, CMD-06, CMD-07, CMD-08, PRIV-01, PRIV-02, PRIV-03, PRIV-05, OBS-01, OBS-02, OBS-03, OBS-04, REL-05
**Success Criteria** (what must be TRUE):
  1. Admin `/summary` triggers the thread-summary pipeline immediately and respects daily idempotency (no double publish); admin `/dev-summary` triggers it bypassing idempotency with `persistState: false`, mirroring the `/dev-digest` pattern from Phase 03.1
  2. Admin `/storage` reports per-thread row count, total DB size, and oldest captured message timestamp; output matches an independent `sqlite3 data/messages.db` query
  3. Any member invoking `/forget-me` triggers a single `db.transaction()` that inserts into `forgotten_users` BEFORE deleting from `messages` — capture handler checks `forgotten_users` on every insert and short-circuits, so a forgotten user's subsequent messages are never stored even under concurrent capture; deletion-count confirmation is delivered via DM (`ctx.api.sendMessage(ctx.from.id, ...)`) with fallback to thread reply if user has not started the bot in DM
  4. The 04:00 MSK retention sweep deletes messages older than `MESSAGE_RETENTION_DAYS` (default 90, min 7 enforced) in batches of ≤1000 rows per iteration; sweep emits `{event: 'retention-sweep', rows_deleted: N, duration_ms: D}` log line on completion
  5. pino logs include hourly INFO `{event: 'capture-rate', messages: N, threads: M, period: '1h'}` aggregate (catches privacy-mode-rollback silent failure), per-LLM-call `{provider, model, tokens_in, tokens_out, latency_ms}` metadata, and daily summary outcome `{event: 'thread-summary-published', threads_summarised: N, threads_skipped_low_volume: M, total_tokens: K}` — message text body is NEVER logged
  6. On graceful SIGTERM/SIGINT, `closeDb()` is called AFTER `bot.stop()` completes — WAL is checkpointed and in-flight transactions are allowed to finish before process exit
**Plans**: TBD (estimated 3 plans: 7-01 /summary + /dev-summary commands, 7-02 /storage + /forget-me + forgotten_users + capture pre-check, 7-03 retention.service + retention sweep cron + ingest-rate counter + closeDb shutdown)

## Progress

**Execution Order:** Phases execute in numeric order: 1 → 2 → 3 → 03.1 → (Phase 0-Ops manual gate) → 4 → 5 → 6 → 7

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Foundation & Bot Shell | v1.0 | 2/2 | Complete | 2026-04-12 |
| 2. Digest Pipeline | v1.0 | 3/3 | Complete | 2026-04-13 |
| 3. Delivery & Operations | v1.0 | 2/2 | Complete | 2026-04-14 |
| 03.1. dev-digest (INSERTED) | v1.0 | 1/1 | Complete | 2026-04-14 |
| 0-Ops. Pre-Flight Checklist | v2.0 | manual gate | Not started | - |
| 4. Message Capture & Persistence | v2.0 | 0/3 | Not started | - |
| 5. Thread Tracking Commands | v2.0 | 0/TBD | Not started | - |
| 6. Thread Summary Pipeline | v2.0 | 0/3 | Planned | - |
| 7. Operational & Privacy Commands | v2.0 | 0/TBD | Not started | - |
