---
phase: quick-260501-cov
plan: 01
subsystem: deploy
tags: [deploy, docker, timeweb, gitignore, config]
requires: []
provides:
  - "Timeweb App Platform sanitizer-compatible docker-compose.yml (zero volumes declarations)"
  - "Local-dev docker-compose.override.yml ignored by git"
affects:
  - docker-compose.yml
  - .gitignore
tech-stack:
  added: []
  patterns:
    - "Timeweb App Platform: persistence via dashboard Disk UI (no compose volumes)"
    - "Local-dev override via gitignored docker-compose.override.yml (Compose auto-merge)"
key-files:
  created: []
  modified:
    - docker-compose.yml
    - .gitignore
decisions:
  - "Persistence configured entirely through Timeweb dashboard Disk UI mounted at /app/data; compose file declares zero volumes"
  - "Local-dev env_file + bind-mount move to gitignored docker-compose.override.yml (Compose merges automatically)"
metrics:
  duration: 51s
  completed: 2026-05-01
  tasks: 2
  files_changed: 2
---

# Quick Task 260501-cov: Remove volumes from docker-compose.yml Summary

Remove all `volumes:` declarations from `docker-compose.yml` (Timeweb App Platform sanitizer rejects them) and add `docker-compose.override.yml` to `.gitignore` so the local-dev compose override never gets committed.

## Context

Prior quick task `260501-ce4` introduced a named volume `botdata` to satisfy what was assumed to be Timeweb's persistence model. Deployment revealed Timeweb's compose sanitizer rejects ANY `volumes:` declarations with the error:

```
Sanitizer check error volumes is not allowed in docker-compose.yml
```

Persistence on Timeweb must instead be configured via the dashboard's Disk UI (create a Disk, mount it to `/app/data`). Local dev keeps its `./data:/app/data` bind-mount and `.env` loading via a gitignored `docker-compose.override.yml` that Compose merges automatically on `docker compose up`.

## Changes

### docker-compose.yml

- Removed service-level `volumes: - botdata:/app/data` block
- Removed top-level `volumes: botdata:` block (and preceding blank line)
- Rewrote SETUP-06 comment block to document:
  - Timeweb sanitizer rejection of `volumes:` declarations (with exact error message)
  - Persistence via Timeweb dashboard Disk UI mounted to `/app/data` (SQLite + state.json)
  - Env vars set via Timeweb dashboard UI (not `.env`)
  - Local-dev `docker-compose.override.yml` pattern (Compose auto-merge)
- Preserved unchanged: `build: .`, `restart: unless-stopped`, full `logging:` block (`driver: json-file`, `max-size: "10m"`, `max-file: "3"`)

### .gitignore

- Appended single new line `docker-compose.override.yml` after the existing 7 entries
- All prior entries (`node_modules/`, `dist/`, `.env`, `*.log`, `data/`, `.env.development`, `.env.production`) preserved verbatim and in order
- File ends with single trailing newline (line count: 7 → 8)

## Verification

| Check | Result |
| --- | --- |
| `grep -E '^volumes:\|botdata' docker-compose.yml` | exit 1 (no matches — PASS) |
| `grep -c 'build: \.' docker-compose.yml` | 1 (PASS) |
| `grep -c 'restart: unless-stopped' docker-compose.yml` | 1 (PASS) |
| `grep -c 'logging:' docker-compose.yml` | 1 (PASS) |
| `grep 'max-size: "10m"'` / `'max-file: "3"'` | both present (PASS) |
| `grep 'docker-compose.override.yml'` in compose comment | present (PASS) |
| `grep 'Disk UI'` in compose comment | present (PASS) |
| `docker compose config > /dev/null` | parses cleanly (PASS) |
| `tail -1 .gitignore` | `docker-compose.override.yml` (PASS) |
| `wc -l .gitignore` | 8 (was 7) (PASS) |
| All 7 prior `.gitignore` entries present (anchored grep per entry) | PASS |

## Commits

| Task | Hash | Message |
| ---- | ---- | ------- |
| 1 | `26fd410` | `fix(quick-260501-cov-01): strip volumes from docker-compose.yml for Timeweb sanitizer` |
| 2 | `26f6ac6` | `chore(quick-260501-cov-02): ignore docker-compose.override.yml` |

## Deviations from Plan

None — plan executed exactly as written.

## Authentication Gates

None.

## Operator Follow-up (out of scope, but required for production)

This quick task makes the compose file parse-clean for Timeweb. To complete deploy, the operator must (in the Timeweb dashboard):

1. Create a Persistent Disk and mount it to `/app/data` on the bot service
2. Set every required environment variable via the dashboard UI (no `.env` is loaded in production)
3. For local development, create `docker-compose.override.yml` next to `docker-compose.yml` adding `env_file: .env` and `volumes: - ./data:/app/data` to the `bot` service

These steps are infra-platform actions and cannot be performed from the repo.

## Self-Check: PASSED

- `docker-compose.yml`: FOUND
- `.gitignore`: FOUND
- Commit `26fd410`: FOUND
- Commit `26f6ac6`: FOUND
