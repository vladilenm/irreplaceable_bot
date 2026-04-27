# Research Synthesis — v2.0 Thread Summaries

**Synthesised:** 2026-04-27
**Consumer:** gsd-roadmapper → produces Phase 4-8 plan + Phase 0-Ops checklist
**Phase numbering:** continues from v1.0 (last phase: 03.1). v2.0 = Phases 4-8 + Phase 0-Ops.

---

## 1. Executive Summary

v2.0 transforms the bot from a publish-only RSS agent into a listening agent that captures Telegram forum messages from admin-whitelisted threads into a local SQLite database and publishes a single consolidated morning summary at 06:30 MSK. The product is additive to v1.0 — exactly two new npm packages (`better-sqlite3@^12.9.0` + `@types/better-sqlite3@^7.6.13`), two invasive file edits (`cron.ts` scheduler refactor, `index.ts` startup sequence), and 16 new source files across a clean module hierarchy that mirrors v1.0 conventions.

The critical constraints are operational (privacy mode OFF in BotFather, admin status restored post-rejoin, Docker volume permissions for uid 1001, in-chat GDPR consent announcement) and must be executed as a gating Phase 0-Ops checklist before any code lands. The MVP for v2.0 is all 5 phases (4-8) shipped together — omitting Phase 8 would make Phase 7 a GDPR violation in production. Map-reduce summarisation is the only deferrable sub-feature, pending first-month token usage data.

---

## 2. Stack Additions

All from STACK.md (HIGH confidence, verified against npm registry + GitHub release assets 2026-04-27).

| Package | Version | Role | Rationale |
|---------|---------|------|-----------|
| `better-sqlite3` | `^12.9.0` | SQLite driver (runtime) | Sync API matches single-process bot; 2.8x-24x faster than async `sqlite3`; ships prebuilt `linuxmusl-x64` binary for Node ABI 115 → no native compile on `node:20-alpine` happy path; active maintenance (pushed 2026-04-27). |
| `@types/better-sqlite3` | `^7.6.13` | TypeScript types (dev) | Required by `strict` + no-`any` rule. Major-version mismatch (`^7` types / `^12` runtime) is intentional — types track v12 API surface. |

**Nothing else.** Migration library, ORM, sanitisation lib, rate-limit lib, anonymisation lib — all rejected. Each is 1-30 LOC of in-code implementation that fits the "one small module, no framework" philosophy.

**New environment variables** (reuse existing `requireEnv` / `requireEnvInt`, no new loader):
```
THREAD_SUMMARY_THREAD_ID=<int>      # forum topic ID for "🧵 Сводки тредов"
THREAD_SUMMARY_CRON=30 3 * * *      # 06:30 MSK = 03:30 UTC
MESSAGE_RETENTION_DAYS=90           # min=7 enforced at startup
RETENTION_SWEEP_CRON=0 1 * * *      # 04:00 MSK = 01:00 UTC
DB_PATH=data/messages.db
```

**Dockerfile delta (builder stage only):**
```
RUN apk add --no-cache python3 make g++
RUN mkdir -p /app/data && chown -R botuser:botuser /app/data  # before USER botuser
```
`docker-compose.yml`: add `volumes: - ./data:/app/data`.

---

## 3. Feature Scope

From FEATURES.md (MEDIUM-HIGH confidence overall).

### Table Stakes — must ship in v2.0

**Message Capture (Phase 4)**
- `bot.on('message')` + `bot.on('edited_message')` filtered by `message_thread_id ∈ whitelist` AND `is_topic_message === true` AND `ctx.chat.is_forum === true`
- Idempotent `INSERT OR IGNORE` on `UNIQUE(chat_id, tg_message_id)`; edits use `ON CONFLICT DO UPDATE SET text, edited_at`
- Non-text placeholders: `[photo]`, `[voice 0:42]`, `[video]`, `[document: name.pdf]`, `[sticker 🔥]`, `[poll: "Q?"]`
- Caption capture for media messages
- Skip service messages (`forum_topic_created`, `pinned_message`, `new_chat_members`)
- Skip channel posts and automatic forwards (`is_automatic_forward === true`)
- Anonymous admin handling: `author_id = NULL`, `is_anonymous = true`
- Do NOT log message text body in pino (PRIV-05)
- Startup preflight: `getMe().can_read_all_group_messages` logged WARN if false

**Thread Tracking (Phase 5)**
- Admin-only `/track`, `/untrack`, `/tracked` (reuse existing `isAdmin()` + 5-min cache)
- In-memory `Set<number>` loaded from DB at startup, hot-reloaded on command (no restart)
- DB-first ordering on `/track`; `/untrack` does NOT delete historical rows

**Summariser (Phase 6)**
- Pure function `summarizeThread(threadId, hours): ThreadSummary`
- Low-volume skip: < 5 messages → no summary, counted in "тихо: N тредов" footer
- Single-shot path (≤ 15k tokens): one LLM call
- Strip numeric `author_id`; only `display_name` reaches LLM
- HTML-escape all user messages before prompt (reuse existing `escapeHtml`)
- `<<<TRANSCRIPT_START>>> ... <<<TRANSCRIPT_END>>>` delimiters + system role isolation
- Structured JSON output with schema validation; parse failure = skip thread + log ERROR
- Normalise Unicode display names (NFC, strip RTL overrides, zero-width chars)

**Daily Delivery (Phase 7)**
- Cron 06:30 MSK; idempotency via `lastThreadSummaryDate` in `state.json` (separate key from `lastDigestDate`)
- Single consolidated HTML post to `THREAD_SUMMARY_THREAD_ID`; ≤ 4000 chars target
- Cron registry refactored from `let task` → `Map<string, ScheduledTask>` BEFORE adding new jobs
- `state.json` writes made atomic via `writeFileSync(tmp) + renameSync(tmp, final)`
- Thread entry: headline + 3-6 bullets + participants (top 3-5 by count) + open questions (0-3) + `за 24ч · N сообщений · M участников` footer

**Operational & Privacy (Phase 8)**
- Admin: `/summary`, `/dev-summary`, `/storage` (row counts, DB size, token cost)
- User-facing: `/forget-me` — hard `DELETE FROM messages WHERE author_id = ?` + `users` row nullification + `forgotten_users` audit row
- Capture handler checks `forgotten_users` before every insert
- 90-day retention sweep at 04:00 MSK; batched ≤ 1000 rows/iteration
- Hourly pino INFO: `{event: 'capture-rate', messages: N, threads: M, period: '1h'}`
- `schema_migrations` table from Phase 4-01; every schema change = new migration version

### Differentiators — defer to v2.1

- Map-reduce path (> 15k tokens): chunk on reply-tree + temporal boundaries at 8k-token windows; reduce step deduplicates open questions
- Decisions/commitments callout in summary bullets
- Quote-of-the-thread (≤ 140 chars, attributed)
- Links-mentioned section (aggregate URLs, cap at 5)
- Per-call `costEstimateUsd` in pino; rolling 7-day sum in `/storage`

### Anti-Features — do not build

Capture: MTProto backfill, real-time deletion sync, reaction tracking, channel post capture. Summary: sentiment scoring, action items with due dates, multi-language. Tracking: user-driven opt-in, auto-discover. Privacy: per-message `/forget`, `/my-data` export, PII scrubber, encryption at rest. Ops: Prometheus/Grafana, per-user activity dashboard. Infra: Postgres, webhooks, multi-tenant.

---

## 4. Integration Plan

From ARCHITECTURE.md (HIGH confidence — grounded in actual repo source).

**Key invariant: v2.0 is mostly additive.** Exactly two files require invasive edits.

### Invasive edits (blocking — do first)

| File | Change | Phase |
|------|--------|-------|
| `src/scheduler/cron.ts` | `let task: ScheduledTask \| null` → `Map<string, ScheduledTask>` registry | 7-01 |
| `src/index.ts` | Insert `initDb(); loadTrackingWhitelist();` before `startScheduler()`; `closeDb()` in shutdown | 4-01 |

### New module layout (16 new files)

```
src/
├── modules/
│   ├── digest/                          [UNCHANGED]
│   ├── thread-summary/                  [NEW — Phase 7]
│   │   ├── thread-summary.service.ts
│   │   ├── thread-summary.formatter.ts
│   │   └── thread-summary.sender.ts
│   └── capture/                         [NEW — Phase 4]
│       ├── capture.handler.ts
│       └── capture.mapper.ts
├── services/
│   ├── db.service.ts                    [NEW — Phase 4-01]
│   ├── summarizer.service.ts            [NEW — Phase 6]
│   ├── tracking.service.ts              [NEW — Phase 5]
│   ├── retention.service.ts             [NEW — Phase 8-03]
│   └── state.service.ts                 [NEW — Phase 7-03, extracted]
└── stores/
    ├── message-store.ts                 [NEW — Phase 4-02]
    └── tracked-threads-store.ts         [NEW — Phase 5-01]
```

Modified files (10): `src/index.ts`, `src/bot.ts`, `src/scheduler/cron.ts`, `src/config.ts`, `src/types/index.ts`, `src/modules/digest/digest.service.ts`, `Dockerfile`, `docker-compose.yml`, `package.json`, `.env.example`.

Unchanged (proves additive shape): `ai.service.ts`, `rss.service.ts`, `telegram.ts`, `logger.ts`, `digest.formatter.ts`, `digest.sender.ts`, `prompts/curator.md`, `config/feeds.json`.

### Build order

```
Phase 0-Ops (human, blocking)
  → Phase 4-01 (DB infra + Dockerfile + compose + config + types)
  → Phase 4-02 (message-store + schema)
  → Phase 4-03 (capture.handler + capture.mapper + register in bot.ts)
  → [FIRST E2E: real messages in DB]
  → Phase 5-01 (tracking.service + tracked-threads-store)
  → Phase 5-02 (/track, /untrack, /tracked + hot-reload)
  → [SECOND E2E: admins manage whitelist live]
  → Phase 6-01 + Phase 7-01 (parallel: summariser single-shot | cron registry refactor)
  → Phase 6-02 (map-reduce, conditional — see MVP recommendation)
  → Phase 7-02 (thread-summary.service orchestrator)
  → Phase 7-03 (formatter + idempotency + atomic state write)
  → [THIRD E2E: 06:30 MSK post published]
  → Phase 8-01 (/summary, /dev-summary)
  → Phase 8-02 (/storage, /forget-me, forgotten_users)
  → Phase 8-03 (retention sweep + ingest-rate counter)
```

### Startup sequence (exact order required)

```
dotenv/config → initDb() → loadTrackingWhitelist() → startScheduler() → bot.start()
```

### Handler registration order in bot.ts

```
bot.catch() → bot.command(...)×N → registerCaptureHandlers(bot) → fallthrough
```

Capture handler is terminal (no `next()`), must be last.

---

## 5. Top Pitfalls

From PITFALLS.md (HIGH confidence — verified against repo source files).

### CRIT-01 — Privacy mode ON → silent zero capture [Phase 0-Ops gate + Phase 4]

Bot privacy mode is ON by default. Capture handler fires for commands only; table stays empty. Everything looks green, 06:30 summary says "тихо" every day forever.

**Mitigation:** Phase 0-Ops: BotFather → privacy OFF → kick → re-invite → re-promote admin. Startup: log WARN if `getMe().can_read_all_group_messages === false`. Phase 4 verification: send non-command message, assert DB row within 5s.

### CRIT-03 + CRIT-04 — Docker volume perms + Alpine native build [Phase 4-01]

Bind mount `./data:/app/data` owned by host uid → container uid 1001 gets `EACCES`. No `python3 make g++` → `better-sqlite3` native compile fails or glibc prebuilt segfaults on musl. Both cause Phase 4 to fail entirely.

**Mitigation:** Dockerfile builder: `apk add --no-cache python3 make g++`; `mkdir -p /app/data && chown -R botuser:botuser /app/data` before `USER botuser`. Host: `sudo chown -R 1001:1001 ./data` once before first `docker compose up`. Phase 4-01 verification: `touch /app/data/.write_test` + `require('better-sqlite3')` inside container.

### CRIT-05 — Non-atomic state.json write corrupts idempotency [Phase 7-01/7-03]

`digest.service.ts:71-76` uses non-atomic `writeFileSync`. Two cron jobs (06:00 + 06:30) or simultaneous `/digest` + `/summary` commands → partial write → `JSON.parse` throws → `readState()` swallows error, returns defaults → idempotency lost → double publish.

**Mitigation:** Atomic write: `writeFileSync(tmp); renameSync(tmp, final)`. Stop swallowing parse errors: if `JSON.parse` fails → log ERROR + block publish (never return defaults silently).

### CRIT-06 — Cron registry must be refactored before Phase 7-02 [Phase 7-01]

`cron.ts:11` has `let task: ScheduledTask | null`. Adding second job overwrites digest reference → graceful shutdown stops only one task → container hangs on SIGTERM → SIGKILL cuts in-flight LLM call.

**Mitigation:** Phase 7-01 (before orchestrator): refactor to `Map<string, ScheduledTask>`. Shutdown verifies both task names logged as stopped.

### LLM-02 — Prompt injection from user messages [Phase 6-02 + Phase 7-03]

User posts adversarial text instructing the model to override the summary. v1.0 was safe (RSS text only). v2.0 is the first time user-controlled text reaches the LLM.

**Mitigation (all layers required):** System role for instructions / user role for transcript. Escape/replace `<transcript>` tags in user messages. Reaffirm instructions after transcript. Structured JSON output with schema validation. Normalise Unicode display names (RTL overrides, homoglyphs). Phase 7-03 formatter: scan output for crypto addresses / suspicious URLs → log WARN + redact or skip.

### PRIV-01 — /forget-me race with concurrent capture [Phase 8-02]

`/forget-me` runs `DELETE` while capture `INSERT`s → new row survives deletion. Sub-second window, won't reproduce in testing.

**Mitigation:** Two-phase GDPR delete inside single `db.transaction()`: (1) INSERT into `forgotten_users`; (2) DELETE from messages. Capture handler checks `forgotten_users` on every insert via prepared statement.

---

## 6. MVP Recommendation

### Must ship in v2.0 (all 5 phases = the MVP)

All phases are interdependent from a trust/GDPR perspective. Capture without Phase 8 privacy controls is a GDPR violation in production. Do not ship Phase 7 without Phase 8 complete.

| Phase | Non-negotiable deliverables |
|-------|-----------------------------|
| Phase 0-Ops | Privacy OFF, admin status, topic created, volume mounted, consent announcement |
| Phase 4 | DB infra, capture, edit handling, idempotency, placeholders, no-text-in-logs, preflight check |
| Phase 5 | `/track`, `/untrack`, `/tracked`, hot-reload Set, restart-resilient |
| Phase 6 | Single-shot `summarizeThread`, anonymisation, prompt-injection guard, structured output, both-provider validation |
| Phase 7 | Cron registry refactor, orchestrator, formatter, atomic state write, 06:30 MSK delivery coexisting with 06:00 |
| Phase 8 | `/forget-me` + `forgotten_users` audit, retention sweep, `/storage`, ingest-rate counter, pino no-text guarantee |

### Defer to v2.1 (validate after first month of production)

Map-reduce path (> 15k token threads), decisions/commitments callout, quote-of-the-thread, links-mentioned, rolling 7-day cost sum.

**Roadmapper instruction:** Plan Phase 6 as 6-01 (required) + 6-02 (conditional — skip condition: "if no thread exceeds 12k tokens in first week of production"). Include Phase 6-02 in the plan with the skip condition explicit.

---

## 7. Phase-Spike Flags

Open questions per phase requiring validation during planning (do not assume).

**Phase 4 — spike recommended:**
- Verify exact Bot API field names `forward_origin`, `is_topic_message`, `message_thread_id` against Grammy 1.42 + `@grammyjs/types`. `forward_origin` believed to have replaced legacy `forward_from_*` ~2023 — confirm.
- Confirm `bot.on(['message', 'edited_message'], handler)` filter array syntax in Grammy 1.42.
- Verify `ctx.chat.is_forum` availability in Grammy context object.

**Phase 5 — one smoke test:**
- Verify command messages sent inside forum topics carry `ctx.message.message_thread_id` (one smoke test with actual bot in dev group before building whitelist logic).

**Phase 6 — empirical:**
- Token counting: confirm `@anthropic-ai/sdk`'s `client.messages.countTokens` endpoint availability in the already-installed SDK version. If absent, use char heuristic `text.length / 3.5`.
- Validate both providers (Anthropic + OpenAI-compatible) return schema-conformant JSON (PITFALLS LLM-04).
- Define hard per-thread per-day token ceiling (suggested: 50k input tokens, configurable via ENV).

**Phase 7 — no spike needed:**
- Cron registry refactor fully specified in ARCHITECTURE.md. Atomic rename is 5 LOC. No unknowns.

**Phase 8 — one open question:**
- `/forget-me` DM reply: verify Grammy throws when `ctx.api.sendMessage(ctx.from.id, ...)` and user has not started bot in DM. Need try/catch + fallback to thread reply. Validate in Phase 8-02.

---

## 8. Cross-Document Tensions and Resolutions

### Tension 1: state.json vs SQLite for idempotency state

PITFALLS CRIT-05 recommends migrating `lastDigestDate` / `lastThreadSummaryDate` into SQLite `pipeline_state` table for atomic writes. ARCHITECTURE.md keeps `state.json` with atomic-rename fix.

**Resolution:** Keep `state.json` + atomic rename for v2.0 MVP. Migration to SQLite adds ~2h refactor with no functional difference given the 30-min cron gap. Roadmapper: flag SQLite migration as v2.1 cleanup item.

### Tension 2: map-reduce scope — table stakes vs defer

FEATURES.md §5 marks map-reduce as "table stakes." FEATURES.md §10 MVP says "defer if first month shows <15k tokens." ARCHITECTURE.md includes Phase 6-02 in the build order.

**Resolution:** Phase 6-01 (single-shot + token counter) is required. Phase 6-02 (map-reduce) is conditional. Roadmapper: plan 6-02 with explicit skip condition.

### Tension 3: capture log verbosity

FEATURES.md says "structured pino logs on every capture." PITFALLS PRIV-05 says "DO NOT log message text body." PITFALLS CODE-04 flags log volume at 1000 msg/day.

**Resolution:** Log at DEBUG level for individual captures (off in prod). Metadata only: `{chat_id, thread_id, author_id, message_length, has_media}` — never `text`. Hourly aggregate at INFO. Phase 4-03 success criterion must include "pino logs do NOT include message text body."

### Tension 4: Dockerfile two-`npm ci` vs copy node_modules

STACK.md notes the cleaner pattern is `COPY --from=builder /app/node_modules ./node_modules` to avoid double prebuild download, but recommends keeping the existing two-`npm ci` pattern to minimise diff.

**Resolution:** Keep two-`npm ci`. Add `apk add` only to builder stage. If production stage prebuild fails, fix in CI.

### Non-conflict to document

`@types/better-sqlite3@^7` (types) vs runtime `^12` — intentional, expected, the types track the v12 API surface. Document in Phase 4-01 PR to prevent a future developer from "fixing" it.

---

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack additions | HIGH | Verified against npm registry + GitHub manifest 2026-04-27. |
| Feature scope | MEDIUM-HIGH | Core capture + summary well-grounded. `forward_origin` field names flagged for Phase 4 spike. |
| Architecture | HIGH | Grounded in actual repo source. |
| Pitfalls | HIGH | CRIT-01..06 verified against live code. |
| GDPR controls | MEDIUM-HIGH | Standard Art. 13 + 17 for closed community. |
| Map-reduce sizing | MEDIUM | 8k-token chunk is a heuristic. |
| Token costs | HIGH | Math is clear; actual thread volume is the empirical unknown. |

**Overall: HIGH.**

---

## Suggested phases: 6 (Phase 0-Ops + Phases 4-8)

1. **Phase 0-Ops** — human checklist gating all code; privacy OFF, admin status, topic, volume, consent announcement
2. **Phase 4** — DB infrastructure + message capture; de-risks all critical build/ops blockers day one
3. **Phase 5** — admin whitelist commands; makes capture operational without hardcoded thread IDs
4. **Phase 6** — summariser pure function; isolated from I/O, testable with fixtures before delivery wiring
5. **Phase 7** — cron registry refactor + orchestrator + delivery; third E2E slice
6. **Phase 8** — privacy/operational commands; required before production enablement
