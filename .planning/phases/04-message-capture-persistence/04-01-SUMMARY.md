---
phase: 04-message-capture-persistence
plan: 01
subsystem: infra
tags: [sqlite, better-sqlite3, docker, wal, migrations, env-config, typescript]

requires:
  - phase: 01-foundation
    provides: requireEnv/requireEnvInt pattern, BotConfig interface, pino logger
  - phase: 03-delivery
    provides: Docker multi-stage build, botuser uid 1001, docker-compose env_file pattern

provides:
  - SQLite + better-sqlite3 v12 infrastructure (WAL, sync API, file-backed)
  - Native build toolchain in Dockerfile builder stage (apk add python3 make g++)
  - Host bind-mount data volume (./data:/app/data) surviving docker compose down
  - 6 v2.0 BotConfig fields (thread summary thread/cron, retention days/cron, db path, initial tracked thread CSV)
  - 3 capture-domain types (CapturedMessage, TrackedThread, ForgottenUser) used by stores (Plan 04-02) and capture handler (Plan 04-03)
  - db.service.ts singleton (initDb/getDb/closeDb) with WAL pragma + verify, in-code MIGRATIONS array, ENV-seed runner
  - Migration v1: 4 product tables (messages, users, tracked_threads, forgotten_users) + schema_migrations meta-table + 4 indexes (UNIQUE chat_tg, thread_created, partial author, created_at)

affects: [04-02-stores, 04-03-capture-handler, 05-thread-tracking-commands, 06-thread-summarizer, 07-daily-summary-delivery, 08-operational-privacy-commands]

tech-stack:
  added:
    - better-sqlite3@^12.9.0 (sync SQLite driver, prebuilt linuxmusl-x64 ABI 115)
    - "@types/better-sqlite3@^7.6.13"
    - python3/make/g++ in Dockerfile builder stage (native fallback toolchain)
  patterns:
    - Pragma-application-order discipline (journal_mode=WAL FIRST + verify, then foreign_keys/synchronous/busy_timeout)
    - In-code MIGRATIONS array with per-migration db.transaction() (forward-only, no rollback)
    - WAL silent-fallback defence (throw on pragma read-back mismatch; PITFALLS DB-01)
    - ENV-seed bootstrap with dual gate (table empty AND ENV non-empty) to keep stub data exit cleanly after Phase 5 ships /track
    - Module singleton pattern (private _db, public init/get/close) — mirrors v1.0 adminCache idiom
    - readEnvIntWithDefault helper with optional MIN bound (closes PRIV-02 typo regression)

key-files:
  created:
    - src/services/db.service.ts (184 LOC — initDb/getDb/closeDb, MIGRATIONS array v1, ENV-seed runner)
  modified:
    - Dockerfile (builder native toolchain + production /app/data chown before USER)
    - docker-compose.yml (./data:/app/data bind-mount + log rotation preserved)
    - .env.example (5 v2.0 ENV vars + INITIAL_TRACKED_THREAD_IDS template appended; 9 v1.0 lines preserved)
    - package.json + package-lock.json (better-sqlite3 + types pinned)
    - src/types/index.ts (CapturedMessage / TrackedThread / ForgottenUser added; BotConfig extended with 6 fields)
    - src/config.ts (readEnvIntWithDefault + parseInitialTrackedThreadIds helpers + 6 new config entries)

key-decisions:
  - "WAL pragma applied FIRST, then verified via pragma read-back — silent fallback to journal=delete is now a startup throw, not a degraded mode"
  - "Each migration wrapped in db.transaction() — partial-failure isolated to one version; retry resumes from same version"
  - "schema_migrations bootstrap uses CREATE TABLE IF NOT EXISTS (idempotent on already-migrated DB)"
  - "Migration v1 ships ALL 4 product tables (D-06): Phase 8 only writes to forgotten_users, no schema change required downstream"
  - "ENV-seed double-gated (trackedCount === 0 AND ENV non-empty) so post-/track DB is the source of truth and ENV becomes a no-op after Phase 5"
  - "MESSAGE_RETENTION_DAYS readEnvIntWithDefault enforces MIN=7 — defeats PRIV-02 typo regression at startup"
  - "THREAD_SUMMARY_THREAD_ID uses requireEnvInt (not optional) — gates Phase 7 publish, fail-fast at boot"
  - "No FKs in v1 (rejected 4 candidates per RESEARCH §3): users is lazy lookup, /untrack must NOT cascade-delete messages, reply_to may reference untracked threads"

patterns-established:
  - "Pattern: pragma application order (WAL → verify → foreign_keys/synchronous/busy_timeout) — must be reused for any future DB connection"
  - "Pattern: in-code MIGRATIONS const array with version+description+sql tuple — Phase 8/v2.1 append new entries, never edit shipped versions"
  - "Pattern: ENV-bootstrap with dual-gate idempotency — stub data path that self-deactivates once authoritative source ships"
  - "Pattern: dbRef captured before db.transaction() callback to satisfy strict null-check"
  - "Pattern: closeDb runs wal_checkpoint(TRUNCATE) before close — gates clean shutdown for REL-05"

requirements-completed:
  - SETUP-05
  - SETUP-06
  - SETUP-07
  - SETUP-08
  - STORE-01
  - STORE-02
  - STORE-03

duration: 4min
completed: 2026-04-28
---

# Phase 04 Plan 01: SQLite + Docker Infrastructure Foundation Summary

**SQLite (WAL) infrastructure ready: native-build toolchain in Dockerfile builder, host bind-mount data volume, db.service.ts singleton with in-code migration v1 creating all 4 product tables + indexes, ENV-seed bootstrapping tracked_threads on first boot only.**

## Performance

- **Duration:** ~4 minutes
- **Started:** 2026-04-28T05:53:09Z
- **Completed:** 2026-04-28T05:57:40Z
- **Tasks:** 3 (all atomic, no checkpoints, no deviations)
- **Files modified:** 7 (1 created, 6 modified)

## Accomplishments

- Dockerfile builder stage installs python3/make/g++ for better-sqlite3 native fallback build (CRIT-04 mitigation); production stage chowns `/app/data` to botuser BEFORE `USER` directive (T-04-01 mitigation).
- docker-compose.yml mounts `./data:/app/data` so SQLite + state.json survive `docker compose down`; existing log-rotation block preserved.
- `.env.example` ships 5 new ENV vars (`THREAD_SUMMARY_THREAD_ID`, `THREAD_SUMMARY_CRON=30 3 * * *`, `MESSAGE_RETENTION_DAYS=90`, `RETENTION_SWEEP_CRON=0 1 * * *`, `DB_PATH=data/messages.db`) plus `INITIAL_TRACKED_THREAD_IDS` CSV template; all 9 v1.0 lines retained verbatim.
- `BotConfig` extended with 6 fields; 3 new capture-domain types exported (`CapturedMessage`, `TrackedThread`, `ForgottenUser`) — feed Plan 04-02 stores.
- `src/config.ts` adds `readEnvIntWithDefault(name, default, min?)` (enforces MIN=7 for retention; closes PRIV-02 typo regression) and `parseInitialTrackedThreadIds(raw)` (rejects non-int, tolerates whitespace, empty → []).
- `src/services/db.service.ts` (184 LOC) opens DB, applies WAL first + verifies, then `foreign_keys/synchronous/busy_timeout`, runs MIGRATIONS array inside per-migration `db.transaction()`, ENV-seeds tracked_threads on dual-gate empty-table+non-empty-ENV.
- Runtime smoke (host): `journalMode=wal`, all 4 product tables created, migration v1 row inserted, 3 tracked_threads seeded with `added_by=NULL`; second boot reports `appliedMigrations: 0` (idempotent); `MESSAGE_RETENTION_DAYS=5` throws with explicit error.

## Task Commits

1. **Task 1: Dockerfile + docker-compose + .env.example + package.json** — `5ad7131` (feat)
2. **Task 2: Extend BotConfig types and config loader** — `142b139` (feat)
3. **Task 3: db.service.ts (initDb/getDb/closeDb + WAL + MIGRATIONS v1 + ENV-seed)** — `80d6f6e` (feat)

## Files Created/Modified

- **Created:** `src/services/db.service.ts` — singleton database service (184 LOC).
- **Modified:** `Dockerfile` — builder toolchain + production data chown.
- **Modified:** `docker-compose.yml` — bind-mount `./data:/app/data`.
- **Modified:** `.env.example` — 6 new ENV var lines appended.
- **Modified:** `package.json` + `package-lock.json` — better-sqlite3 + types pinned.
- **Modified:** `src/types/index.ts` — 3 new exports + BotConfig extension.
- **Modified:** `src/config.ts` — 2 new helpers + 6 new config entries.

## Final Dockerfile (target shape — applied verbatim)

```dockerfile
# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# v2.0 SETUP-05: native build deps for better-sqlite3 fallback path.
# 99% of installs use the linuxmusl-x64 prebuild for ABI 115; toolchain
# exists for the failure mode (network hiccup, ABI drift).
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

# Production stage
FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

# v2.0 SETUP-07: pre-create /app/data with botuser ownership BEFORE USER directive.
RUN addgroup -g 1001 -S botuser && \
    adduser -S botuser -u 1001 && \
    mkdir -p /app/data && \
    chown -R botuser:botuser /app/data
USER botuser

CMD ["node", "dist/index.js"]
```

## Final docker-compose.yml (target shape — applied verbatim)

```yaml
services:
  bot:
    build: .
    env_file:
      - .env
    restart: unless-stopped
    volumes:
      - ./data:/app/data
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
```

## Final BotConfig (extended fields + validation rules)

| Field | Source | Default | Validation |
|---|---|---|---|
| `threadSummaryThreadId` | `requireEnvInt('THREAD_SUMMARY_THREAD_ID')` | (required, no default) | integer regex `^-?\d+$`; throw on missing/non-int |
| `threadSummaryCron` | `process.env['THREAD_SUMMARY_CRON']` | `'30 3 * * *'` | none (cron-string) |
| `messageRetentionDays` | `readEnvIntWithDefault('MESSAGE_RETENTION_DAYS', 90, 7)` | `90` | `Number.isInteger`; MIN=7 throws |
| `retentionSweepCron` | `process.env['RETENTION_SWEEP_CRON']` | `'0 1 * * *'` | none |
| `dbPath` | `process.env['DB_PATH']` | `'data/messages.db'` | none |
| `initialTrackedThreadIds` | `parseInitialTrackedThreadIds(process.env['INITIAL_TRACKED_THREAD_IDS'] ?? '')` | `[]` | empty → `[]`; non-int entry → throw |

V1.0 fields untouched: `botToken`, `targetChatId`, `aiRadarThreadId`, `digestCron`, `aiApiKey`, `aiModel`, `aiBaseUrl?`, `logLevel`, `nodeEnv`.

## Migration v1 SQL DDL (full text — copied verbatim from RESEARCH §3)

```sql
CREATE TABLE IF NOT EXISTS messages (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id             INTEGER NOT NULL,
  thread_id           INTEGER NOT NULL,
  tg_message_id       INTEGER NOT NULL,
  author_id           INTEGER,
  author_name         TEXT    NOT NULL,
  is_anonymous        INTEGER NOT NULL DEFAULT 0,
  text                TEXT    NOT NULL,
  reply_to_message_id INTEGER,
  created_at          TEXT    NOT NULL,
  edited_at           TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_chat_tg
  ON messages (chat_id, tg_message_id);

CREATE INDEX IF NOT EXISTS idx_messages_thread_created
  ON messages (thread_id, created_at);

CREATE INDEX IF NOT EXISTS idx_messages_author
  ON messages (author_id) WHERE author_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_messages_created
  ON messages (created_at);

CREATE TABLE IF NOT EXISTS users (
  author_id     INTEGER PRIMARY KEY,
  display_name  TEXT    NOT NULL,
  first_seen_at TEXT    NOT NULL,
  last_seen_at  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS tracked_threads (
  thread_id   INTEGER PRIMARY KEY,
  chat_id     INTEGER NOT NULL,
  added_by    INTEGER,
  added_at    TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS forgotten_users (
  author_id      INTEGER PRIMARY KEY,
  forgotten_at   TEXT    NOT NULL,
  deleted_count  INTEGER NOT NULL DEFAULT 0,
  requested_via  TEXT    NOT NULL
);
```

`schema_migrations(version PK, applied_at TEXT)` is bootstrapped separately via `CREATE TABLE IF NOT EXISTS` BEFORE the migration loop.

## WAL Pragma Application Order (numbered, RESEARCH §1.5)

1. `pragma('journal_mode = WAL')` — FIRST, OUTSIDE any transaction (sqlite.org: "journal_mode cannot be changed while a transaction is active").
2. `pragma('journal_mode', { simple: true })` read-back — throw if not `'wal'` (PITFALLS DB-01 silent-fallback defence).
3. `pragma('foreign_keys = ON')` — per-connection default OFF; explicit enable.
4. `pragma('synchronous = NORMAL')` — explicit even though it's WAL default (legibility).
5. `pragma('busy_timeout = 5000')` — bounded wait on lock contention (PITFALLS DB-02).

After pragmas: `schema_migrations` bootstrap → SELECT applied versions → for each unapplied migration run inside its own `db.transaction()` → ENV-seed tracked_threads (dual-gate).

## Verification Commands Run (host smoke; full Docker verification deferred to Phase 0-Ops gate)

| # | Command | Result |
|---|---|---|
| 1 | `npx tsc --noEmit` after Tasks 2, 3 | exit 0 (no output) |
| 2 | `npm run build` | exit 0 (no output) |
| 3 | `docker compose config` | parsed cleanly (services/bot/volumes confirmed) |
| 4 | First-boot init (host smoke, ENV `INITIAL_TRACKED_THREAD_IDS=100,200,300`) | `mode: wal`, tables = `[forgotten_users, messages, schema_migrations, sqlite_sequence, tracked_threads, users]`, migrations = `[{"version":1}]`, tracked = 3 rows, all `added_by=null` |
| 5 | Second-boot init on same DB | `appliedMigrations: 0` (idempotent), `tracked count = 3` (no double-seed) |
| 6 | `MESSAGE_RETENTION_DAYS=5` boot | throws `Environment variable MESSAGE_RETENTION_DAYS must be >= 7, got 5` |
| 7 | `parseInitialTrackedThreadIds('1, 2,3')` | `[1, 2, 3]` |
| 8 | `parseInitialTrackedThreadIds('1,abc')` | throws `INITIAL_TRACKED_THREAD_IDS contains non-integer: "abc"` |

Dockerized verification (`docker compose build --no-cache`, `docker compose run --rm bot sh -c "id && touch /app/data/.write_test"`, `sqlite3 /app/data/messages.db ".tables"`) is gated by the Phase 0-Ops manual checklist (host-side `chown -R 1001:1001 ./data`, real `THREAD_SUMMARY_THREAD_ID` capture). The host smoke covers every code-side invariant.

## Decisions Made

- None beyond the locked CONTEXT.md decisions (D-02..D-07). Plan executed exactly as written.

## Deviations from Plan

None — plan executed exactly as written. RESEARCH §3 SQL DDL, §5 migration runner, §6 Dockerfile/compose copied verbatim with zero changes.

The two minor handling notes worth recording:

- npm cache permission collision on the developer host (`/Users/vladilen/.npm/_cacache` had root-owned files from a prior install). Worked around with `--cache /tmp/npm-cache` for the two `npm install` calls. Not a code change; not a deviation; documented for the developer's awareness so the eventual `sudo chown -R 501:20 "/Users/vladilen/.npm"` is on the radar.
- Plan note about adding `THREAD_SUMMARY_THREAD_ID=0` to local `.env` for smoke runs is a developer-side action; the host smoke run used inline ENV (`THREAD_SUMMARY_THREAD_ID=2 ...`) with no edit to `.env.example` (which still ships blank, as the plan requires).

## Issues Encountered

- `tsc --strict + noUncheckedIndexedAccess` flagged `_db!.exec(...)` inside the migration transaction callback (non-null assertion on a possibly-reassigned `let`). Resolved by capturing `const dbRef = _db;` immediately above the `db.transaction(...)` definition and using `dbRef` inside the callback. Compiles clean with no `any`, no `!`.

## Operational Note (Phase 0-Ops gate, NOT this plan's responsibility)

The Phase 0-Ops manual checklist (privacy mode OFF, admin re-promote, summary topic id capture, host-side `chown -R 1001:1001 ./data`, GDPR consent announcement) lives at `.planning/phases/04-message-capture-persistence/04-OPS-CHECKLIST.md` (yet-to-be-created or curator-owned). Code-side Phase 4 plans cannot satisfy these.

## Next Phase Readiness

- **Plan 04-02 (stores) unblocked:** can `import { getDb } from '../services/db.service.js'` and lazy-cache prepared statements against `messages` / `tracked_threads` / `forgotten_users` tables. Schema is final per D-06 — no migration v2 in this milestone.
- **Plan 04-03 (capture handler) unblocked:** types `CapturedMessage` / `ForgottenUser` available; capture mapper can use `BotConfig.initialTrackedThreadIds` indirectly (via tracking.service / DB).
- **No code blockers for Phase 5–8:** schema and pragma discipline shipped here cover the entire v2.0 feature surface.

## Self-Check: PASSED

All claimed files and commits verified present:

- `Dockerfile` — modified, contains `apk add --no-cache python3 make g++` and `chown -R botuser:botuser /app/data` before `USER botuser` (lines 38 < 39). FOUND.
- `docker-compose.yml` — modified, contains `- ./data:/app/data`. FOUND.
- `.env.example` — modified, contains 6 new ENV lines + 9 v1.0 lines preserved. FOUND.
- `package.json` — `better-sqlite3@^12.9.0` + `@types/better-sqlite3@^7.6.13`. FOUND.
- `src/types/index.ts` — exports `CapturedMessage`, `TrackedThread`, `ForgottenUser`; BotConfig extended. FOUND.
- `src/config.ts` — defines `readEnvIntWithDefault`, `parseInitialTrackedThreadIds`; uses `requireEnvInt('THREAD_SUMMARY_THREAD_ID')`. FOUND.
- `src/services/db.service.ts` — created (184 LOC), exports `initDb`/`getDb`/`closeDb`. FOUND.
- Commit `5ad7131` (Task 1). FOUND.
- Commit `142b139` (Task 2). FOUND.
- Commit `80d6f6e` (Task 3). FOUND.

`npx tsc --noEmit` exits 0. Host runtime smoke confirms WAL active, 4 tables, migration v1 row, ENV-seed working with idempotent second-boot, MIN=7 guard throws on `MESSAGE_RETENTION_DAYS=5`.

---
*Phase: 04-message-capture-persistence*
*Plan: 01*
*Completed: 2026-04-28*
