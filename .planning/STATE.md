---
gsd_state_version: 1.0
milestone: v2.0
milestone_name: Thread Summaries
status: executing
stopped_at: Completed 04-01-PLAN.md
last_updated: "2026-04-28T06:00:06.631Z"
last_activity: 2026-04-28
progress:
  total_phases: 6
  completed_phases: 0
  total_plans: 3
  completed_plans: 1
  percent: 33
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-04-27)

**Core value:** Participants get a quality-filtered AI digest every morning — builds the habit and saves 30-60 minutes of daily scrolling. v2.0 extends this with morning thread summaries so participants reconnect to club discussions without scrolling.
**Current focus:** Phase 04 — message-capture-persistence

## Current Position

Phase: 04 (message-capture-persistence) — EXECUTING
Plan: 2 of 3
Status: Ready to execute
Last activity: 2026-04-28

Progress: [░░░░░░░░░░] 0%

Note: `total_phases: 5` counts the integer code phases (4-8). Phase 0-Ops is a manual gating checklist, not a code phase, and is excluded from phase counts and plan counts.

## Performance Metrics

**Velocity (v2.0):**

- Total plans completed: 0
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

**Recent Trend:**

- Last 5 plans: — (none in v2.0 yet)
- Trend: —

*v1.0 velocity archived in `milestones/v1.0-ROADMAP.md` (10 plans across Phases 1-3 + 03.1).*
| Phase 04 P01 | 4min | 3 tasks | 7 files |

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
- [Phase 04]: THREAD_SUMMARY_THREAD_ID is requireEnvInt (no default) — gates Phase 7, fail-fast at boot
- [Phase 04]: No FKs in v1 (4 candidates rejected with documented rationale per RESEARCH §3)

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
- `state.json` not in volume + non-atomic write → owned by Phase 4 (volume) + Phase 7 (atomic write)
- `cron.ts` single-task slot → owned by Phase 7-01

### Roadmap Evolution

- v1.0 (shipped 2026-04-27): Phases 1, 2, 3 + 03.1 (INSERTED) — 26/26 requirements
- v2.0 (in progress): Phase 0-Ops manual gate + Phases 4-8 — 57 requirements mapped 100%

## Session Continuity

Last session: 2026-04-28T05:59:52.269Z
Stopped at: Completed 04-01-PLAN.md
Resume file: None
