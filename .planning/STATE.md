---
gsd_state_version: 1.0
milestone: v2.0
milestone_name: Thread Summaries
status: in_progress
started_at: "2026-04-27"
last_updated: "2026-04-27"
last_activity: 2026-04-27
progress:
  total_phases: 0
  completed_phases: 0
  total_plans: 0
  completed_plans: 0
  percent: 0
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-04-27)

**Core value:** Participants get a quality-filtered AI digest every morning — builds the habit and saves 30-60 minutes of daily scrolling. v2.0 extends this with morning thread summaries so participants reconnect to club discussions without scrolling.
**Current focus:** v2.0 Thread Summaries — defining requirements

## Current Position

Phase: Not started (defining requirements)
Plan: —
Status: Defining requirements
Last activity: 2026-04-27 — Milestone v2.0 started

## Accumulated Context

### Decisions (carried forward from v1.0)

Full decision log lives in PROJECT.md Key Decisions table. v1.0 decisions still load-bearing for v2.0:
- Long-polling (no webhook infra needed)
- Dual-provider LLM abstraction (`AI_BASE_URL` switch)
- File-based state pattern (extending to SQLite for messages, `state.json` retained for cron idempotency)
- MSK calendar day for cron idempotency
- Admin-list cache 5-min TTL (reuse for `/track`, `/untrack`, `/storage`)
- Options-object service signature pattern (clone for `summarizeThread()`)
- Strict TypeScript no `any`
- `requireEnv()` / `requireEnvInt()` fail-fast env validation
- `bot.catch()` registered BEFORE command handlers

### v2.0-specific decisions (locked)

- Single consolidated summary post, not per-thread
- Storage = `better-sqlite3` (sync, file in Docker volume)
- No backfill — start «from the moment of activation»
- Whitelist via `/track` admin command, persisted in DB
- Schedule 06:30 MSK (after AI-radar at 06:00 MSK)
- Tone «штурман → пилот» (matches v1.0)

### Pending Todos

None — milestone just started.

### Blockers/Concerns

Pre-flight (Phase 0-Ops, manual checklist — must precede Phase 4 verification):
- BotFather privacy mode currently ON (default) → must be turned OFF
- Bot must be removed and re-added as admin (privacy flag applies on rejoin only)
- New forum topic «🧵 Сводки тредов» must be created; `THREAD_SUMMARY_THREAD_ID` captured
- Docker volume `./data:/app/data` not currently configured — `state.json` lost on `docker compose down`; Phase 4-01 fixes both SQLite + state.json
- Dockerfile (`node:20-alpine`) lacks `python3 make g++` — required for native `better-sqlite3` build
- In-chat announcement to club + GDPR `/forget-me` capability (Phase 8) before turning capture on for real users
- `src/scheduler/cron.ts` currently `let task: ScheduledTask | null` — refactor to `Map<string, ScheduledTask>` registry needed before Phase 7

### Roadmap Evolution

- v1.0 (shipped): Phases 1, 2, 3 + Phase 03.1 (INSERTED)
- v2.0 (in progress): Phase numbering continues from 4

## Session Continuity

Last session: 2026-04-27 — milestone v2.0 kickoff
Stopped at: requirements gathering
Resume file: this file + `.planning/PROJECT.md` + `~/.claude/plans/hidden-percolating-dragon.md` (reference plan)
