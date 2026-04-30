# Requirements

**Project:** Telegram-бот «Незаменимые»
**Active milestone:** v2.0 Thread Summaries
**Last updated:** 2026-04-27

REQ-IDs continue from v1.0 archive (`.planning/milestones/v1.0-REQUIREMENTS.md`). Validated v1.0 requirements live in PROJECT.md "Validated" section.

---

## Milestone v2.0 Requirements

### Operational Setup (SETUP-*)

> Extends v1.0 SETUP-01..04 (project bootstrap, env config, pino, Dockerfile).

- [x] **SETUP-05**: Dockerfile builder stage installs `apk add --no-cache python3 make g++` as fallback for native `better-sqlite3` build (prebuild for Node ABI 115 / linuxmusl-x64 is happy path; build deps cover the fallback)
- [x] **SETUP-06**: `docker-compose.yml` mounts `./data:/app/data` named volume so SQLite + `state.json` survive `docker compose down`
- [x] **SETUP-07**: Dockerfile creates `/app/data` with `botuser:botuser` ownership before `USER botuser` directive (uid 1001 must own the volume mount-point)
- [x] **SETUP-08**: 5 new ENV vars loaded via existing `requireEnv` / `requireEnvInt` at config boundary with sane defaults: `THREAD_SUMMARY_THREAD_ID`, `THREAD_SUMMARY_CRON` (default `30 3 * * *` = 06:30 MSK), `MESSAGE_RETENTION_DAYS` (default 90, min=7 enforced), `RETENTION_SWEEP_CRON` (default `0 1 * * *` = 04:00 MSK), `DB_PATH` (default `data/messages.db`)
- [ ] **SETUP-09 (Phase 0-Ops, manual checklist — gating)**: BotFather privacy mode OFF; bot kicked + re-invited + re-promoted to admin in club group; «🧵 Сводки тредов» forum topic created and `THREAD_SUMMARY_THREAD_ID` captured; in-chat consent announcement published; checklist artifact stored at `.planning/phases/04-message-capture/04-OPS-CHECKLIST.md`

### Message Capture (MSG-*)

- [x] **MSG-01**: `bot.on('message')` captures every text/non-text message in tracked forum threads within <2s of arrival; non-tracked threads filtered out at handler before any DB touch
- [x] **MSG-02**: `bot.on('edited_message')` updates the same row by `(chat_id, tg_message_id)` and sets `edited_at`; does NOT create a duplicate row
- [x] **MSG-03**: Phase 4 captures only text-bearing messages — `messages.text` stores `ctx.message.text` OR `ctx.message.caption` (no prefix, no `[photo]`/`[video]` placeholder). Pure non-text messages without caption (photo/voice/video/document/sticker/poll/animation/video_note/audio/dice/location/contact) drop with zero rows in DB. Originally specified as "placeholder rows for non-text"; changed in Phase 4 per CONTEXT decision D-08 (cleaner summarizer transcript, no placeholder noise; media-activity signal deferred — if needed in Phase 6, will be added as a separate `media_count` aggregate query column, not via duplicate rows).
- [x] **MSG-04**: Idempotent insert via `UNIQUE(chat_id, tg_message_id)` and `INSERT OR IGNORE` — same message delivered twice (Telegram retry, polling replay) results in one row
- [x] **MSG-05**: Service messages (`forum_topic_created`, `pinned_message`, `new_chat_members`, `forum_topic_edited`, `forum_topic_closed`), channel posts (`channel_post`/`edited_channel_post`), and automatic forwards (`is_automatic_forward === true`) filtered out at handler
- [x] **MSG-06**: Anonymous admins handled — when `from` is missing and `sender_chat` present, store `author_id = NULL` and `is_anonymous = true`
- [x] **MSG-07**: Reply context preserved — `reply_to_message_id` stored as nullable column, no recursive parent fetch
- [x] **MSG-08**: Startup preflight check — `getMe().can_read_all_group_messages` logged at WARN level if false (detects misconfigured BotFather privacy state)

### Storage (STORE-*)

- [x] **STORE-01**: `better-sqlite3` connection singleton with `journal_mode=WAL`, `foreign_keys=ON`, `synchronous=NORMAL`; opened during `initDb()` before scheduler/polling
- [x] **STORE-02**: `schema_migrations(version, applied_at)` table from day one; migrations array applied inside a single transaction; on each boot, only un-applied versions run
- [x] **STORE-03**: Schema includes `messages`, `tracked_threads`, `users`, `forgotten_users` tables with proper FKs and indexes
- [x] **STORE-04**: Prepared statements cached per store as module-level constants (lazy-init on first `getDb()` call); capture insert latency p95 <50ms in WAL mode

### Thread Tracking (TRK-*)

- [ ] **TRK-01**: Admin-only `/track` invoked inside a forum topic adds current `message_thread_id` to whitelist (DB row + in-memory Set updated atomically); reuses existing `isAdmin()` guard with 5-min cache
- [ ] **TRK-02**: Admin-only `/untrack` invoked inside a topic removes thread from whitelist; existing captured rows are NOT deleted (sweep handles them on retention boundary)
- [ ] **TRK-03**: Admin-only `/tracked` lists active whitelist (thread IDs + titles via `getForumTopic` if available, fall back to ID only)
- [ ] **TRK-04**: Whitelist hot-reload — capture handler honours `/track` / `/untrack` on the very next message without bot restart; in-memory `Set<number>` is the source of truth for the hot path
- [ ] **TRK-05**: Whitelist restart-resilient — `loadTrackingWhitelist()` populates Set from DB before `bot.start()`, so first capture after boot honours the persisted whitelist

### Summarizer (SUM-*)

- [ ] **SUM-01**: `summarizeThread(threadId, windowHours): ThreadSummary` returns typed object with `headline` (≤80 chars), `bullets` (3-6 items), `participants` (top 3-5 display names by message count), `openQuestions` (0-3), `messageCount`, `windowHours`, `skipped` flag with optional reason
- [ ] **SUM-02**: `< 5 messages` in window → `{skipped: true, reason: 'low-volume'}` returned; LLM call NOT made (verifiable in logs)
- [ ] **SUM-03**: Numeric `author_id` NEVER reaches LLM prompt — transcript builder maps id→display_name and emits only the display name; verified by inspecting outbound prompt fixture
- [ ] **SUM-04**: Single-shot path for transcripts ≤15k tokens (token count via `client.messages.countTokens` if available, char heuristic `text.length / 3.5` otherwise); one LLM call per thread; map-reduce path deferred to v2.1 (skip condition: first month shows no thread >12k tokens)
- [ ] **SUM-05**: Layered prompt-injection defence — HTML-escape user messages + `<<<TRANSCRIPT_START>>> ... <<<TRANSCRIPT_END>>>` delimiter sandwich + system-role isolation (user content never in system prompt) + structured JSON output schema validation + reaffirm instructions after transcript
- [ ] **SUM-06**: Dual-provider parity — switching `AI_MODEL` between Claude and OpenAI-compatible (DeepSeek via `AI_BASE_URL`) yields the same `ThreadSummary` shape; both providers validated by Phase 6-01 fixture
- [ ] **SUM-07**: Display-name Unicode normalisation — NFC + strip RTL override / zero-width / control chars before prompt insertion AND before HTML render (defends against homoglyph + RTL display attacks)

### AI service extension (AI-*)

> Extends v1.0 AI-01..06 (dual-provider abstraction, curator prompt, 6 categories, vc.ru quota).

- [ ] **AI-07**: New `summarizeThread()` function added to `ai.service.ts` (or sibling `summarizer.service.ts`) reuses dual-provider abstraction without modifying existing `filterArticles` signature

### Daily Delivery (DLV-*)

> Extends v1.0 DLV-01..05 (digest cron, HTML to thread, retry, MSK-day idempotency).

- [ ] **DLV-06**: Cron 06:30 MSK (`THREAD_SUMMARY_CRON`) triggers thread-summary pipeline; coexists with 06:00 MSK digest cron without race
- [ ] **DLV-07**: Single consolidated HTML post published to `THREAD_SUMMARY_THREAD_ID` covering all tracked threads with ≥5 messages in 24h window
- [ ] **DLV-08**: Tracked threads with no activity OR skipped low-volume listed in footer "тихо: N тредов" — no empty per-thread sections in body
- [ ] **DLV-09**: Post >4096 chars splittered on thread-section boundaries (never mid-section); each chunk sent via existing `sendMessageWithRetry({chatId, threadId, text, parseMode: 'HTML'})` with single retry on 429
- [ ] **DLV-10**: Idempotency — `lastThreadSummaryDate` in `state.json` (separate field from `lastDigestDate`); double pipeline run on same MSK day produces ONE post (subsequent runs no-op with INFO log)

### State management (STATE-*)

- [ ] **STATE-01**: All `writeState()` writes atomic via `writeFileSync(tmp)` + `renameSync(tmp, final)` (CRIT-05 mitigation)
- [ ] **STATE-02**: `readState()` does NOT swallow `JSON.parse` errors — corrupt file logs ERROR and blocks publish for that cycle (no silent default fallback that would lose idempotency)

### Scheduler (SCHED-*)

- [ ] **SCHED-01**: `src/scheduler/cron.ts` refactored from `let task: ScheduledTask | null` to `Map<string, ScheduledTask>` registry; external API of `startScheduler()` / `stopScheduler()` unchanged
- [ ] **SCHED-02**: `startScheduler()` registers `digest` (06:00 MSK), `thread-summary` (06:30 MSK), and `retention-sweep` (04:00 MSK) jobs by name
- [ ] **SCHED-03**: `stopScheduler()` iterates Map; every job logs `Cron job stopped` with its name on graceful shutdown
- [ ] **SCHED-04**: Failed cron job logs error and is skipped; other registered jobs unaffected (per-job try/catch wrapper inside `registerJob`)

### Operational Commands (CMD-*)

> Extends v1.0 CMD-01..03 (`/start`, `/digest`, `/status`) plus bonus `/dev-digest`.

- [ ] **CMD-04**: Admin-only `/summary` triggers thread-summary pipeline immediately and respects daily idempotency (no double publish)
- [ ] **CMD-05**: Admin-only `/dev-summary` triggers pipeline bypassing idempotency and `persistState: false` — does not pollute `state.json` (mirrors `/dev-digest` pattern from Phase 03.1)
- [ ] **CMD-06**: Admin-only `/storage` reports per-thread row count, total DB size, oldest captured message timestamp; output matches independent `sqlite3 data/messages.db` query
- [ ] **CMD-07**: User-facing `/forget-me` (the only non-admin command in the bot) — hard `DELETE FROM messages WHERE author_id = ctx.from.id` + nullify `users` row + insert into `forgotten_users` audit table; replies with deleted-row count
- [ ] **CMD-08**: `/forget-me` confirmation reply preferred via DM (`ctx.api.sendMessage(ctx.from.id, ...)`); falls back to thread reply on Telegram error if user has not started bot in DM

### Privacy (PRIV-*)

- [ ] **PRIV-01**: `/forget-me` runs in single `db.transaction()` — `INSERT INTO forgotten_users` + `DELETE FROM messages` atomic so capture cannot interleave a new row mid-deletion
- [ ] **PRIV-02**: Capture handler checks `forgotten_users` before every `INSERT` via prepared statement — forgotten user's subsequent messages NOT stored (closes the post-deletion replay window)
- [ ] **PRIV-03**: 90-day retention sweep (`RETENTION_SWEEP_CRON`, default 04:00 MSK) deletes messages older than `MESSAGE_RETENTION_DAYS`; batched at ≤1000 rows per iteration with `LIMIT` to avoid lock storms
- [ ] **PRIV-04**: Phase 0-Ops checklist captures URL or screenshot of in-chat consent announcement to club before Phase 4 production-side verification (lawful-basis evidence per GDPR Art. 13)
- [ ] **PRIV-05**: pino logs MUST NOT contain message `text` body — capture log emits only metadata (`chat_id`, `thread_id`, `author_id`, `message_length`, `has_media`); per-message DEBUG level off in production, hourly INFO aggregate replaces

### Observability (OBS-*)

- [ ] **OBS-01**: Hourly pino INFO ingest-rate counter — `{event: 'capture-rate', messages: N, threads: M, period: '1h'}` (catches privacy-mode-rollback silent failure mode)
- [ ] **OBS-02**: Daily summary outcome — `{event: 'thread-summary-published', threads_summarised: N, threads_skipped_low_volume: M, total_tokens: K}` log line emitted within 1 min of cron fire
- [ ] **OBS-03**: Per-LLM-call metadata logged on every `summarizeThread` call — `{provider, model, tokens_in, tokens_out, latency_ms}`
- [ ] **OBS-04**: Retention sweep emits `{event: 'retention-sweep', rows_deleted: N, duration_ms: D}` at end of each run

### Reliability (REL-*)

> Extends v1.0 REL-01..03 (graceful shutdown, error resilience, strict TypeScript).

- [x] **REL-04**: Capture handler body wrapped in try/catch — DB errors, schema mismatch, prepared-statement failures logged but DO NOT crash the long-polling loop (extends existing `bot.catch()` pattern)
- [ ] **REL-05**: `closeDb()` called in shutdown handler AFTER `bot.stop()` completes — checkpoints WAL on graceful SIGTERM/SIGINT (in-flight transactions allowed to finish)

---

## Future Requirements (deferred to v2.1, validated by first-month production data)

- Map-reduce summarisation path for transcripts >15k tokens (chunk on reply-tree + temporal boundaries at 8k-token windows; reduce step deduplicates open questions)
- Decisions/commitments callout in summary bullets ("Маша обязалась проверить MCP timeout до пятницы")
- Quote-of-the-thread (≤140 chars, attributed)
- Links-mentioned section (aggregate URLs shared in window, cap 5)
- Per-call `costEstimateUsd` in pino + rolling 7-day sum surfaced in `/storage`
- Migration of `lastDigestDate` / `lastThreadSummaryDate` from `state.json` into SQLite `pipeline_state` table (architectural cleanup; v2.0 keeps `state.json` + atomic rename)

## Out of Scope (explicit exclusions for v2.x)

| Feature | Reason |
|---------|--------|
| MTProto user-bot for backfill of pre-launch messages | Decided in milestone scope: v2.0 starts «from moment of activation»; ToS risk + complexity > value |
| Real-time deletion-event handling | Telegram Bot API does not push individual `messageDeleted` events to bots — physically impossible |
| Reaction tracking (`message_reaction`/`message_reaction_count`) | Defer to v3 if "what was hot" becomes felt gap; new update type, separate schema |
| Channel post capture (`channel_post`/`edited_channel_post`) | Club is supergroup, not channel |
| Inline-button reactions on summaries (🔥 / 💤) | After v2.0 launch, validate by participant behaviour |
| `/analytics` command | v3 |
| Real-time / per-message live summaries | Daily batch is the product; live = 100× cost & complexity |
| Sentiment / mood scoring | Pseudo-precision, no actionable use |
| Multi-language summary output | Single locale (RU) |
| Per-message `/forget MSG-ID` | `/forget-me` covers GDPR Art. 17 obligation |
| `/my-data` automatic export | Closed community ≤200, admin-mediated escalation acceptable |
| Auto-PII-scrubber | Massive complexity, false positives, prompt-injection vector |
| Encryption at rest for `messages.text` | `/forget-me` + retention is the threat model; key management dominates complexity |
| Auto-discover whitelist | Surprise capture violates GDPR consent posture |
| Per-user activity dashboard | Privacy-hostile, no product use |
| Vector embeddings / semantic history search | New infra, no validated use |
| Postgres / Supabase migration | Local SQLite sufficient for ≤200 users |
| Webhook switch from long-polling | Long-polling sufficient for club-scale traffic |
| Telegram Mini App | Separate project, different stack |
| Multi-tenant (multiple clubs in one bot) | Single-tenant intent |
| Cross-provider LLM fallback ("if Claude fails, try OpenAI") | Adds chained-failure complexity, blurs cost monitoring; manual `/dev-summary` re-run instead |
| Prometheus / Grafana / OpenTelemetry exporter | Massive ops debt for ≤200-user club; pino + `docker logs` + `/storage` is enough |

## Traceability

> Maps each v2.0 REQ-ID → Phase that owns it. Generated by gsd-roadmapper 2026-04-27 against `.planning/ROADMAP.md`. 57/57 v2.0 requirements mapped (100% coverage).

| Requirement | Phase | Status |
|-------------|-------|--------|
| SETUP-05 | Phase 4 | Complete |
| SETUP-06 | Phase 4 | Complete |
| SETUP-07 | Phase 4 | Complete |
| SETUP-08 | Phase 4 | Complete |
| SETUP-09 | Phase 7 | Pending |
| MSG-01 | Phase 4 | Complete |
| MSG-02 | Phase 4 | Complete |
| MSG-03 | Phase 4 | Complete |
| MSG-04 | Phase 4 | Complete |
| MSG-05 | Phase 4 | Complete |
| MSG-06 | Phase 4 | Complete |
| MSG-07 | Phase 4 | Complete |
| MSG-08 | Phase 4 | Complete |
| STORE-01 | Phase 4 | Complete |
| STORE-02 | Phase 4 | Complete |
| STORE-03 | Phase 4 | Complete |
| STORE-04 | Phase 4 | Complete |
| TRK-01 | Phase 5 | Pending |
| TRK-02 | Phase 5 | Pending |
| TRK-03 | Phase 5 | Pending |
| TRK-04 | Phase 5 | Pending |
| TRK-05 | Phase 5 | Pending |
| SUM-01 | Phase 6 | Pending |
| SUM-02 | Phase 6 | Pending |
| SUM-03 | Phase 6 | Pending |
| SUM-04 | Phase 6 | Pending |
| SUM-05 | Phase 6 | Pending |
| SUM-06 | Phase 6 | Pending |
| SUM-07 | Phase 6 | Pending |
| AI-07 | Phase 6 | Pending |
| DLV-06 | Phase 6 | Pending |
| DLV-07 | Phase 6 | Pending |
| DLV-08 | Phase 6 | Pending |
| DLV-09 | Phase 6 | Pending |
| DLV-10 | Phase 6 | Pending |
| STATE-01 | Phase 6 | Pending |
| STATE-02 | Phase 6 | Pending |
| SCHED-01 | Phase 6 | Pending |
| SCHED-02 | Phase 6 | Pending |
| SCHED-03 | Phase 6 | Pending |
| SCHED-04 | Phase 6 | Pending |
| CMD-04 | Phase 7 | Pending |
| CMD-05 | Phase 7 | Pending |
| CMD-06 | Phase 7 | Pending |
| CMD-07 | Phase 7 | Pending |
| CMD-08 | Phase 7 | Pending |
| PRIV-01 | Phase 7 | Pending |
| PRIV-02 | Phase 7 | Pending |
| PRIV-03 | Phase 7 | Pending |
| PRIV-04 | Phase 7 | Pending |
| PRIV-05 | Phase 7 | Pending |
| OBS-01 | Phase 7 | Pending |
| OBS-02 | Phase 7 | Pending |
| OBS-03 | Phase 7 | Pending |
| OBS-04 | Phase 7 | Pending |
| REL-04 | Phase 4 | Complete |
| REL-05 | Phase 7 | Pending |

### Coverage by Phase

> 2026-04-29: original Phase 6 (Thread Summarizer Service) merged with original Phase 7 (Daily Summary Delivery) into Phase 6 (Thread Summary Pipeline); original Phase 8 renumbered to Phase 7.

| Phase | REQ Count | REQ-IDs |
|-------|-----------|---------|
| Phase 0-Ops | 2 | SETUP-09, PRIV-04 |
| Phase 4 | 17 | SETUP-05/06/07/08, MSG-01..08, STORE-01..04, REL-04 |
| Phase 5 | 5 | TRK-01..05 |
| Phase 6 | 19 | SUM-01..07, AI-07, DLV-06..10, STATE-01..02, SCHED-01..04 |
| Phase 7 | 14 | CMD-04..08, PRIV-01/02/03/05, OBS-01..04, REL-05 |
| **Total** | **57** | **100% coverage** |
