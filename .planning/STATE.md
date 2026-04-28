---
gsd_state_version: 1.0
milestone: v2.0
milestone_name: Thread Summaries
status: planning
stopped_at: Phase 4 context gathered
last_updated: "2026-04-28T05:08:43.144Z"
last_activity: 2026-04-27 — ROADMAP.md generated for v2.0; 57/57 v2.0 requirements mapped
progress:
  total_phases: 6
  completed_phases: 0
  total_plans: 0
  completed_plans: 0
  percent: 0
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-04-27)

**Core value:** Participants get a quality-filtered AI digest every morning — builds the habit and saves 30-60 minutes of daily scrolling. v2.0 extends this with morning thread summaries so participants reconnect to club discussions without scrolling.
**Current focus:** v2.0 Thread Summaries — roadmap done, Phase 4 next (after Phase 0-Ops manual checklist)

## Current Position

Phase: Not started (Phase 4 next, after Phase 0-Ops manual gate)
Plan: —
Status: Roadmap created, ready to plan Phase 4
Last activity: 2026-04-27 — ROADMAP.md generated for v2.0; 57/57 v2.0 requirements mapped

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

Last session: 2026-04-28T05:08:43.141Z
Stopped at: Phase 4 context gathered
Resume file: .planning/phases/04-message-capture-persistence/04-CONTEXT.md
