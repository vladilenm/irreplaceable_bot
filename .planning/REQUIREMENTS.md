# Requirements

**Project:** Telegram-бот «Незаменимые»
**Active milestone:** v2.0 Thread Summaries
**Last updated:** 2026-04-30

REQ-IDs continue from v1.0 archive (`.planning/milestones/v1.0-REQUIREMENTS.md`). Validated v1.0 requirements live in PROJECT.md "Validated" section.

---

## Milestone v2.0 Requirements

### Operational Setup (SETUP-*)

> Extends v1.0 SETUP-01..04 (project bootstrap, env config, pino, Dockerfile).

- [x] **SETUP-05**: Dockerfile builder stage installs `apk add --no-cache python3 make g++` as fallback for native `better-sqlite3` build (prebuild for Node ABI 115 / linuxmusl-x64 is happy path; build deps cover the fallback)
- [x] **SETUP-06**: `docker-compose.yml` mounts `./data:/app/data` named volume so SQLite + `state.json` survive `docker compose down`
- [x] **SETUP-07**: Dockerfile creates `/app/data` with `botuser:botuser` ownership before `USER botuser` directive (uid 1001 must own the volume mount-point)
- [x] **SETUP-08**: 5 new ENV vars loaded via existing `requireEnv` / `requireEnvInt` at config boundary with sane defaults: `THREAD_SUMMARY_THREAD_ID`, `THREAD_SUMMARY_CRON` (default `30 3 * * *` = 06:30 MSK), `MESSAGE_RETENTION_DAYS` (default 90, min=7 enforced), `RETENTION_SWEEP_CRON` (default `0 1 * * *` = 04:00 MSK), `DB_PATH` (default `data/messages.db`)
- [ ] **SETUP-09 (Phase 0-Ops, manual checklist — gating)**: BotFather privacy mode OFF; bot kicked + re-invited + re-promoted to admin in club group; «🧵 Сводки тредов» forum topic created and `THREAD_SUMMARY_THREAD_ID` captured; in-chat consent announcement published; checklist artifact stored at `.planning/phases/04-message-capture-persistence/04-OPS-CHECKLIST.md`

### Message Capture (MSG-*)

- [x] **MSG-01**: `bot.on('message')` captures every text/non-text message in tracked forum threads within <2s of arrival; non-tracked threads filtered out at handler before any DB touch
- [x] **MSG-02**: `bot.on('edited_message')` updates the same row by `(chat_id, tg_message_id)` and sets `edited_at`; does NOT create a duplicate row
- [x] **MSG-03**: Phase 4 captures only text-bearing messages — `messages.text` stores `ctx.message.text` OR `ctx.message.caption` (no prefix, no `[photo]`/`[video]` placeholder). Pure non-text messages without caption (photo/voice/video/document/sticker/poll/animation/video_note/audio/dice/location/contact) drop with zero rows in DB. Originally specified as "placeholder rows for non-text"; changed in Phase 4 per CONTEXT decision D-08 (cleaner summarizer transcript, no placeholder noise; media-activity signal deferred — if needed in Phase 6, will be added as a separate `media_count` aggregate query column, not via duplicate rows).
- [x] **MSG-04**: Idempotent upsert via `UNIQUE(chat_id, tg_message_id)` and `ON CONFLICT(chat_id, tg_message_id) DO UPDATE SET text/author_name/edited_at` — preserves `created_at` on edit redelivery; `INSERT OR IGNORE` was rejected (PITFALLS TG-01) because it silently ignores edits and breaks MSG-02.
- [x] **MSG-05**: Service messages (`forum_topic_created`, `pinned_message`, `new_chat_members`, `forum_topic_edited`, `forum_topic_closed`), channel posts (`channel_post`/`edited_channel_post`), and automatic forwards (`is_automatic_forward === true`) filtered out at handler
- [x] **MSG-06**: Anonymous admins handled — when `from` is missing and `sender_chat` present, store `author_id = NULL` and `is_anonymous = true`
- [x] **MSG-07**: Reply context preserved — `reply_to_message_id` stored as nullable column, no recursive parent fetch
- [x] **MSG-08**: Startup preflight check — `getMe().can_read_all_group_messages` logged at WARN level if false (detects misconfigured BotFather privacy state)

### Storage (STORE-*)

- [x] **STORE-01**: `better-sqlite3` connection singleton with `journal_mode=WAL`, `foreign_keys=ON`, `synchronous=NORMAL`; opened during `initDb()` before scheduler/polling
- [x] **STORE-02**: `schema_migrations(version, applied_at)` table from day one; migrations array applied inside a single transaction; on each boot, only un-applied versions run
- [x] **STORE-03**: Schema includes `messages`, `tracked_threads`, `users` tables with proper FKs and indexes (`forgotten_users` was added in Phase 4 migration v2 and dropped in Phase 7 migration v3 — CMD-07 de-scoped 2026-04-29)
- [x] **STORE-04**: Prepared statements cached per store as module-level constants (lazy-init on first `getDb()` call); capture insert latency p95 <50ms in WAL mode

### Summarizer (SUM-*)

- [x] **SUM-01**: `summarizeThread(threadId, windowHours): ThreadSummary` returns typed object with `headline` (≤80 chars), `bullets` (3-6 items), `participants` (top 3-5 display names by message count), `openQuestions` (0-3), `messageCount`, `windowHours`, `skipped` flag with optional reason
- [x] **SUM-02**: `< 5 messages` in window → `{skipped: true, reason: 'low-volume'}` returned; LLM call NOT made (verifiable in logs)
- [x] **SUM-03**: Numeric `author_id` NEVER reaches LLM prompt — transcript builder maps id→display_name and emits only the display name; verified by inspecting outbound prompt fixture
- [x] **SUM-04**: Single-shot path for transcripts ≤15k tokens (token count via `client.messages.countTokens` if available, char heuristic `text.length / 3.5` otherwise); one LLM call per thread; map-reduce path deferred to v2.1 (skip condition: first month shows no thread >12k tokens)
- [x] **SUM-05**: Layered prompt-injection defence — HTML-escape user messages + `<<<TRANSCRIPT_START>>> ... <<<TRANSCRIPT_END>>>` delimiter sandwich + system-role isolation (user content never in system prompt) + structured JSON output schema validation + reaffirm instructions after transcript
- [x] **SUM-06**: Dual-provider parity — switching `AI_MODEL` between Claude and OpenAI-compatible (DeepSeek via `AI_BASE_URL`) yields the same `ThreadSummary` shape; both providers validated by Phase 6-01 fixture
- [x] **SUM-07**: Display-name Unicode normalisation — NFC + strip RTL override / zero-width / control chars before prompt insertion AND before HTML render (defends against homoglyph + RTL display attacks)

### AI service extension (AI-*)

> Extends v1.0 AI-01..06 (dual-provider abstraction, curator prompt, 6 categories, vc.ru quota).

- [x] **AI-07**: New `summarizeThread()` function added to `ai.service.ts` (or sibling `summarizer.service.ts`) reuses dual-provider abstraction without modifying existing `filterArticles` signature

### Daily Delivery (DLV-*)

> Extends v1.0 DLV-01..05 (digest cron, HTML to thread, retry, MSK-day idempotency).

- [x] **DLV-06**: Cron 06:30 MSK (`THREAD_SUMMARY_CRON`) triggers thread-summary pipeline; coexists with 06:00 MSK digest cron without race
- [x] **DLV-07**: Single consolidated HTML post published to `THREAD_SUMMARY_THREAD_ID` covering all tracked threads with ≥5 messages in 24h window
- [x] **DLV-08**: Tracked threads with no activity OR skipped low-volume listed in footer "тихо: N тредов" — no empty per-thread sections in body
- [x] **DLV-09**: Post >4096 chars splittered on thread-section boundaries (never mid-section); each chunk sent via existing `sendMessageWithRetry({chatId, threadId, text, parseMode: 'HTML'})` with single retry on 429
- [x] **DLV-10**: Idempotency — `lastThreadSummaryDate` in `state.json` (separate field from `lastDigestDate`); double pipeline run on same MSK day produces ONE post (subsequent runs no-op with INFO log)

### State management (STATE-*)

- [x] **STATE-01**: All `writeState()` writes atomic via `writeFileSync(tmp)` + `renameSync(tmp, final)` (CRIT-05 mitigation)
- [x] **STATE-02**: `readState()` does NOT swallow `JSON.parse` errors — corrupt file logs ERROR and blocks publish for that cycle (no silent default fallback that would lose idempotency)

### Scheduler (SCHED-*)

- [x] **SCHED-01**: `src/scheduler/cron.ts` refactored from `let task: ScheduledTask | null` to `Map<string, ScheduledTask>` registry; external API of `startScheduler()` / `stopScheduler()` unchanged
- [x] **SCHED-02**: `startScheduler()` registers `digest` (06:00 MSK), `thread-summary` (06:30 MSK), and `retention-sweep` (04:00 MSK) jobs by name
- [x] **SCHED-03**: `stopScheduler()` iterates Map; every job logs `Cron job stopped` with its name on graceful shutdown
- [x] **SCHED-04**: Failed cron job logs error and is skipped; other registered jobs unaffected (per-job try/catch wrapper inside `registerJob`)

### Privacy (PRIV-*)

- [x] **PRIV-03**: 90-day retention sweep (`RETENTION_SWEEP_CRON`, default 04:00 MSK) deletes messages older than `MESSAGE_RETENTION_DAYS`; batched at ≤1000 rows per iteration with `LIMIT` to avoid lock storms (implemented by Plan 07-01 in this same milestone close)
- [ ] **PRIV-04**: Phase 0-Ops manual checklist captures URL or screenshot of in-chat consent announcement (lawful-basis evidence per GDPR Art. 13). Closes when `.planning/phases/04-message-capture-persistence/04-OPS-CHECKLIST.md` section 4 is filled by operator post-deploy.

### Reliability (REL-*)

> Extends v1.0 REL-01..03 (graceful shutdown, error resilience, strict TypeScript).

- [x] **REL-04**: Capture handler body wrapped in try/catch — DB errors, schema mismatch, prepared-statement failures logged but DO NOT crash the long-polling loop (extends existing `bot.catch()` pattern)

---

## Future Requirements (deferred to v2.1, validated by first-month production data)

- Map-reduce summarisation path for transcripts >15k tokens (chunk on reply-tree + temporal boundaries at 8k-token windows; reduce step deduplicates open questions)
- Decisions/commitments callout in summary bullets ("Маша обязалась проверить MCP timeout до пятницы")
- Quote-of-the-thread (≤140 chars, attributed)
- Links-mentioned section (aggregate URLs shared in window, cap 5)
- Per-call `costEstimateUsd` in pino + rolling 7-day sum surfaced in `/storage`
- Migration of `lastDigestDate` / `lastThreadSummaryDate` from `state.json` into SQLite `pipeline_state` table (architectural cleanup; v2.0 keeps `state.json` + atomic rename)

### v2.0 originally-scoped requirements deferred 2026-04-29

The following 18 requirements were part of the v2.0 milestone draft but moved out of scope during planning. They are kept here for historical traceability and may be reconsidered in v2.1 once first-month production data informs priority:

- **Phase 5 cancelled (in-chat tracking commands):** TRK-01, TRK-02, TRK-03, TRK-04, TRK-05 — admin whitelist is now managed via env-seed (`INITIAL_TRACKED_THREAD_IDS`) and direct DB writes; in-chat commands are not required for ≤200-user club.
- **Phase 7 originals removed (operational/privacy/observability commands + REL-05):** CMD-04, CMD-05, CMD-06, CMD-07, CMD-08, PRIV-01, PRIV-02, PRIV-05, OBS-01, OBS-02, OBS-03, OBS-04, REL-05 — operator-side maintenance is performed via direct sqlite3 CLI and pino-log inspection (see `.planning/phases/04-message-capture-persistence/04-OPS-CHECKLIST.md` for runbooks). Note: PRIV-03 is RETAINED in v2.0 and is implemented by Phase 7 closure (current milestone gap-closure phase, Plan 07-01); PRIV-04 is RETAINED as Phase 0-Ops manual gate.

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

> Maps each v2.0 REQ-ID → Phase that owns it. Generated 2026-04-30 against `.planning/ROADMAP.md` (post-cleanup). 39/39 in-scope v2.0 requirements mapped (100% coverage). 36 Complete + 3 Pending (SETUP-09 + PRIV-04 manual gates; PRIV-03 prose flipped to Complete in this plan, code lands in Plan 07-01 within the same wave).

| Requirement | Phase | Status |
|-------------|-------|--------|
| SETUP-05 | Phase 4 | Complete |
| SETUP-06 | Phase 4 | Complete |
| SETUP-07 | Phase 4 | Complete |
| SETUP-08 | Phase 4 | Complete |
| SETUP-09 | Phase 0-Ops | Pending |
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
| SUM-01 | Phase 6 | Complete |
| SUM-02 | Phase 6 | Complete |
| SUM-03 | Phase 6 | Complete |
| SUM-04 | Phase 6 | Complete |
| SUM-05 | Phase 6 | Complete |
| SUM-06 | Phase 6 | Complete |
| SUM-07 | Phase 6 | Complete |
| AI-07 | Phase 6 | Complete |
| DLV-06 | Phase 6 | Complete |
| DLV-07 | Phase 6 | Complete |
| DLV-08 | Phase 6 | Complete |
| DLV-09 | Phase 6 | Complete |
| DLV-10 | Phase 6 | Complete |
| STATE-01 | Phase 6 | Complete |
| STATE-02 | Phase 6 | Complete |
| SCHED-01 | Phase 6 | Complete |
| SCHED-02 | Phase 6 | Complete |
| SCHED-03 | Phase 6 | Complete |
| SCHED-04 | Phase 6 | Complete |
| PRIV-03 | Phase 7 (v2.0 closure) | Complete |
| PRIV-04 | Phase 0-Ops | Pending |
| REL-04 | Phase 4 | Complete |

### Coverage by Phase

> 2026-04-30: post Phase 7 v2.0-closure cleanup. Phase 5 (Thread Tracking Commands) cancelled; original Phase 7 (Operational & Privacy Commands) deferred to v2.1; Phase 7 slot reused for v2.0 closure (PRIV-03 retention sweep + Phase 0-Ops execution).

| Phase | REQ Count | REQ-IDs |
|-------|-----------|---------|
| Phase 0-Ops | 2 | SETUP-09, PRIV-04 |
| Phase 4 | 17 | SETUP-05/06/07/08, MSG-01..08, STORE-01..04, REL-04 |
| Phase 6 | 19 | SUM-01..07, AI-07, DLV-06..10, STATE-01..02, SCHED-01..04 |
| Phase 7 (v2.0 closure) | 1 | PRIV-03 (retention sweep impl by Plan 07-01) |
| **Total** | **39** | **100% in-scope coverage; 36 Complete + 3 Pending (SETUP-09, PRIV-04 Phase 0-Ops manual gates; PRIV-03 flipped to Complete, code lands in Plan 07-01 within the same wave)** |
