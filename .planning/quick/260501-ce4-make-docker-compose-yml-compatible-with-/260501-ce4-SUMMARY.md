---
phase: quick-260501-ce4
plan: 01
subsystem: deploy/docker
tags: [docker-compose, timeweb, paas, named-volume, persistence, deploy]
requirements_completed:
  - QUICK-260501-ce4
dependency_graph:
  requires: []
  provides:
    - "Timeweb App Platform-compatible Compose definition"
    - "Docker named volume `botdata` for SQLite + state.json persistence"
  affects:
    - "Local dev workflow (no longer uses ./data bind mount)"
    - "Operator deploy procedure (Persistent Disk attachment via Timeweb UI)"
tech_stack:
  added: []
  patterns:
    - "Docker named volume for cross-platform persistence (Engine + PaaS)"
    - "Env-var injection via platform UI (no host .env file in container build context)"
key_files:
  created: []
  modified:
    - docker-compose.yml
decisions:
  - "Drop `env_file: - .env` — Timeweb App Platform injects env vars at runtime via dashboard UI; .env file is not present in platform's build context"
  - "Swap bind-mount `./data:/app/data` → named volume `botdata:/app/data` — bind mounts to relative host paths get wiped on PaaS redeploy; named volume is the portable primitive both Docker Engine (local) and Timeweb (PaaS, via Persistent Disk overlay) understand"
  - "No driver overrides on top-level `volumes.botdata:` — default `local` driver is correct for Docker Engine; Timeweb maps its Persistent Disk over the mountpoint regardless of driver"
metrics:
  duration: "~1min"
  tasks: 1
  files: 1
  completed: "2026-05-01"
---

# Quick Task 260501-ce4: Make docker-compose.yml Compatible with Timeweb App Platform

Made `docker-compose.yml` deployable on Timeweb App Platform (PaaS) by removing the host-dependent `env_file:` directive and replacing the `./data` bind-mount with a Docker named volume `botdata`, while preserving local-dev semantics and the existing `restart` + `logging` config.

## What Changed

**File:** `docker-compose.yml` (21 insertions, 6 deletions)

| Change | Before | After |
|--------|--------|-------|
| Env file | `env_file: - .env` | (removed — Timeweb UI injects env vars; local dev uses `--env-file .env` flag or shell exports) |
| Volume mount | `- ./data:/app/data` (bind) | `- botdata:/app/data` (named) |
| Top-level volumes | (none) | `volumes:\n  botdata:` |
| SETUP-06 comment | Documented bind-mount + `down -v` semantics | Documents named-volume persistence, Timeweb Persistent Disk attachment, local-dev `down`/`down -v` semantics, env-var injection model |
| Preserved | `build: .`, `restart: unless-stopped`, full `logging:` block (json-file, max-size 10m, max-file 3) | unchanged |

## Verification

**Plan-defined verify chain (single command):**

```sh
docker compose -f docker-compose.yml config >/dev/null \
  && grep -q "^  botdata:$" docker-compose.yml \
  && grep -q "botdata:/app/data" docker-compose.yml \
  && ! grep -q "env_file" docker-compose.yml \
  && ! grep -q "\./data:/app/data" docker-compose.yml \
  && grep -q "restart: unless-stopped" docker-compose.yml \
  && grep -q "max-size: \"10m\"" docker-compose.yml \
  && echo OK
```

**Result:** `OK` (exit 0). All assertions passed:
- `docker compose config` parsed file successfully (valid YAML + Compose schema, named volume resolves)
- `botdata:` declared at top level
- `botdata:/app/data` mounted on the bot service
- `env_file` directive absent
- `./data:/app/data` bind-mount absent
- `restart: unless-stopped` preserved
- `max-size: "10m"` (logging) preserved

## Operator Notes

### Timeweb App Platform deploy

After the first deploy on Timeweb App Platform:

1. In the Timeweb dashboard, attach a **Persistent Disk** to the mountpoint `/app/data` for the bot service. Without this, SQLite (`better-sqlite3` file) and `state.json` will not survive redeploys — Timeweb's runtime overlays the Persistent Disk on top of the named-volume mountpoint declared in Compose.
2. In the Timeweb dashboard, populate environment variables via the platform UI (BOT_TOKEN, AI_BASE_URL, AI_API_KEY, AI_MODEL, GROUP_CHAT_ID, DIGEST_THREAD_ID, THREAD_SUMMARY_THREAD_ID, MESSAGE_RETENTION_DAYS, etc.). The `.env` file from the repo is **not** read by the platform.
3. Verify on first boot: container should start, SQLite should initialize at `/app/data/club-bot.sqlite`, and the bot should respond on long-polling.

### Local dev migration

The host directory `./data` is no longer referenced by Compose. After this change:

- Run `docker compose --env-file .env up` (or export env vars in your shell) — the implicit `.env` auto-load is gone.
- On first `docker compose up`, Docker Engine creates the named volume `club-bot_botdata` automatically and mounts it at `/app/data`. SQLite + state.json now live there.
- Existing data in host `./data` is **not** auto-migrated. If you need to preserve it, copy manually into the named volume (e.g., via a one-shot helper container that mounts both source and target). This migration is **out of scope** for this task.
- `docker compose down` keeps the volume; `docker compose down -v` or `docker volume rm club-bot_botdata` destroys it (PITFALLS DB-03 still applies, just with a new destruction trigger).

## Deviations from Plan

None — plan executed exactly as written. Single-task, single-file edit; verify chain produced `OK` on first run.

## Commits

| Task | Description | Commit |
|------|-------------|--------|
| 1 | chore(quick-260501-ce4-01): make docker-compose.yml Timeweb App Platform compatible | `25f7b39` |

## Self-Check: PASSED

- File `docker-compose.yml` exists and contains the target shape: FOUND
- Commit `25f7b39` exists in `git log`: FOUND
- SUMMARY.md path matches plan output spec: FOUND (`.planning/quick/260501-ce4-make-docker-compose-yml-compatible-with-/260501-ce4-SUMMARY.md`)
- All `<done>` criteria from PLAN.md Task 1 satisfied: confirmed by grep chain + `docker compose config`
