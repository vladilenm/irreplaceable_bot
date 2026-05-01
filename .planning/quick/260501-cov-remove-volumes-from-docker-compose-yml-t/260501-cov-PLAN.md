---
phase: quick-260501-cov
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - docker-compose.yml
  - .gitignore
autonomous: true
requirements:
  - QUICK-260501-cov
must_haves:
  truths:
    - "docker-compose.yml contains zero `volumes:` declarations (neither service-level nor top-level)"
    - "docker-compose.yml retains `build: .`, `restart: unless-stopped`, and the full `logging:` block unchanged"
    - "SETUP-06 comment in docker-compose.yml documents Timeweb sanitizer rejection of `volumes:`, Disk-UI persistence path, dashboard env vars, and the local-dev override pattern"
    - ".gitignore ends with a `docker-compose.override.yml` entry so future local-dev override files are never committed"
    - "`docker compose config` parses docker-compose.yml without error (Timeweb App Platform sanitizer compatibility proxy)"
  artifacts:
    - path: "docker-compose.yml"
      provides: "Timeweb-App-Platform-compliant compose definition (no volumes declarations)"
      contains: "build: ."
    - path: ".gitignore"
      provides: "ignore rule for local-dev compose override"
      contains: "docker-compose.override.yml"
  key_links:
    - from: "docker-compose.yml SETUP-06 comment"
      to: "Timeweb dashboard Disk UI + env-var UI + local docker-compose.override.yml"
      via: "documentation in comment block"
      pattern: "docker-compose\\.override\\.yml"
---

<objective>
Make `docker-compose.yml` pass Timeweb App Platform's sanitizer (which rejects ANY `volumes:` declarations) and prevent the future local-dev override file from being committed to git.

Purpose: The prior quick task 260501-ce4 introduced a named volume `botdata` to satisfy what was assumed to be Timeweb's persistence model. Deployment revealed the sanitizer rejects this with `Sanitizer check error volumes is not allowed in docker-compose.yml`. Persistence must instead be configured entirely through the Timeweb dashboard's Disk UI, with the compose file containing zero volume declarations. Local dev keeps its `./data` bind-mount via a gitignored `docker-compose.override.yml` that Compose merges automatically.

Output:
- `docker-compose.yml` with no `volumes:` lines and a rewritten SETUP-06 comment block
- `.gitignore` with `docker-compose.override.yml` appended
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
</execution_context>

<context>
@.planning/STATE.md
@./CLAUDE.md
@docker-compose.yml
@.gitignore

<interfaces>
<!-- Current docker-compose.yml shape (before edit) -->
<!-- Lines 1-4: services.bot with build: . and restart: unless-stopped -->
<!-- Lines 5-21: SETUP-06 comment block (will be REWRITTEN) -->
<!-- Lines 22-23: service-level volumes block (will be REMOVED) -->
<!-- Lines 24-28: logging block (will be PRESERVED unchanged) -->
<!-- Lines 30-31: top-level volumes block (will be REMOVED) -->

<!-- Current .gitignore (8 lines) -->
<!-- Line 1: node_modules/ -->
<!-- Line 2: dist/ -->
<!-- Line 3: .env -->
<!-- Line 4: *.log -->
<!-- Line 5: data/ -->
<!-- Line 6: .env.development -->
<!-- Line 7: .env.production -->
<!-- Line 8: (blank) -->
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Strip all volumes declarations from docker-compose.yml and rewrite SETUP-06 comment</name>
  <files>docker-compose.yml</files>
  <action>
Rewrite docker-compose.yml so the final content reads exactly as below. The `bot` service must keep `build: .`, `restart: unless-stopped`, and the entire `logging:` block UNCHANGED. Remove the service-level `volumes: - botdata:/app/data` block entirely. Remove the top-level `volumes: botdata:` block entirely (and the blank line preceding it). Replace the existing SETUP-06 comment block with a new one covering: (1) Timeweb App Platform's sanitizer rejects ANY `volumes:` declarations; (2) persistence is configured via the Timeweb dashboard Disk UI (create Disk, mount to `/app/data` where SQLite + state.json live); (3) env vars are set via the Timeweb dashboard, not loaded from `.env`; (4) for local dev, create a gitignored `docker-compose.override.yml` adding `env_file: .env` and `volumes: - ./data:/app/data` to the `bot` service — Compose merges `docker-compose.override.yml` automatically on `docker compose up`.

Final exact file content:

```yaml
services:
  bot:
    build: .
    restart: unless-stopped
    # v2.0 SETUP-06 (Timeweb App Platform compatible):
    # Timeweb App Platform's compose sanitizer REJECTS any `volumes:`
    # declarations (both service-level and top-level). Attempting to declare
    # them yields: `Sanitizer check error volumes is not allowed in
    # docker-compose.yml`. Therefore this file MUST contain zero `volumes:`
    # entries.
    #
    # Persistence (production): configured entirely via the Timeweb dashboard
    # Disk UI. Create a Disk in the dashboard and mount it to `/app/data` —
    # this is where SQLite (better-sqlite3) and state.json live. The platform
    # injects the disk into the container without any compose-level
    # declaration.
    #
    # Env vars (production): NOT loaded from a `.env` file. Set every required
    # variable via the Timeweb dashboard UI; the platform injects them into
    # the container at runtime.
    #
    # Local dev: create a gitignored `docker-compose.override.yml` next to
    # this file with the bot service overrides you need locally — typically
    # `env_file: .env` and `volumes: - ./data:/app/data`. Docker Compose
    # automatically merges `docker-compose.override.yml` on `docker compose
    # up`, so production builds stay clean while local dev keeps its bind
    # mount and .env loading. The override file is in .gitignore.
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
```

Do not introduce any other changes. Do not touch the Dockerfile, source code, or `.env*` files. The file ends after the closing `"3"` line on the `max-file:` option (no trailing top-level blocks).
  </action>
  <verify>
    <automated>grep -E '^volumes:|botdata' docker-compose.yml; test $? -eq 1 && grep -q 'build: \.' docker-compose.yml && grep -q 'restart: unless-stopped' docker-compose.yml && grep -q 'logging:' docker-compose.yml && grep -q 'max-size: "10m"' docker-compose.yml && grep -q 'max-file: "3"' docker-compose.yml && grep -q 'docker-compose.override.yml' docker-compose.yml && grep -q 'Disk UI' docker-compose.yml && echo OK</automated>
  </verify>
  <done>
- `grep -E '^volumes:|botdata' docker-compose.yml` returns nothing (exit 1)
- `build: .`, `restart: unless-stopped`, the full `logging:` block (driver, options, max-size 10m, max-file 3) all still present
- SETUP-06 comment mentions Timeweb sanitizer, Disk UI, /app/data mountpoint, dashboard env vars, and `docker-compose.override.yml` local-dev pattern
- File contains zero `volumes:` declarations (service-level and top-level both gone)
  </done>
</task>

<task type="auto">
  <name>Task 2: Append docker-compose.override.yml to .gitignore</name>
  <files>.gitignore</files>
  <action>
Append `docker-compose.override.yml` as a new line at the end of `.gitignore`. Do NOT reorder, modify, or remove any of the existing 7 entries (`node_modules/`, `dist/`, `.env`, `*.log`, `data/`, `.env.development`, `.env.production`). The current file ends with a trailing blank line — preserve standard POSIX file ending (single newline after the new entry).

Final exact file content:

```
node_modules/
dist/
.env
*.log
data/
.env.development
.env.production
docker-compose.override.yml
```

(Note: file should end with a single trailing newline after `docker-compose.override.yml`.)
  </action>
  <verify>
    <automated>grep -q '^docker-compose\.override\.yml$' .gitignore && grep -q '^node_modules/$' .gitignore && grep -q '^dist/$' .gitignore && grep -q '^\.env$' .gitignore && grep -q '^\*\.log$' .gitignore && grep -q '^data/$' .gitignore && grep -q '^\.env\.development$' .gitignore && grep -q '^\.env\.production$' .gitignore && echo OK</automated>
  </verify>
  <done>
- `.gitignore` contains a line `docker-compose.override.yml` (exact match, no leading/trailing whitespace)
- All 7 prior entries preserved verbatim and in the same order
- File ends with a single trailing newline
  </done>
</task>

</tasks>

<verification>
After both tasks complete, run these checks from the repo root:

1. No volumes residue:
   ```bash
   grep -E '^volumes:|botdata' docker-compose.yml || echo "PASS: no volumes lines"
   ```

2. Critical structural elements preserved:
   ```bash
   grep -c 'build: \.' docker-compose.yml      # expect 1
   grep -c 'restart: unless-stopped' docker-compose.yml  # expect 1
   grep -c 'logging:' docker-compose.yml       # expect 1
   ```

3. Compose still parses (with env vars supplied so any `${VAR}` interpolation does not error — the current file uses none, but this guards future edits):
   ```bash
   docker compose config > /dev/null && echo "PASS: parses"
   ```

4. .gitignore entry present and existing entries intact:
   ```bash
   tail -1 .gitignore        # expect: docker-compose.override.yml
   wc -l .gitignore          # expect: 8 (was 7)
   ```
</verification>

<success_criteria>
- `docker-compose.yml` parses via `docker compose config` without errors
- Zero `volumes:` declarations remain in `docker-compose.yml` (verified by grep)
- `build: .`, `restart: unless-stopped`, and the full `logging:` block (with `max-size: "10m"` and `max-file: "3"`) remain unchanged
- SETUP-06 comment block in `docker-compose.yml` documents: Timeweb sanitizer rejection of `volumes:`, Disk-UI-based persistence at `/app/data`, dashboard-based env vars, and the local-dev `docker-compose.override.yml` pattern
- `.gitignore` ends with `docker-compose.override.yml` appended after all 7 prior entries (preserved verbatim)
- No edits to Dockerfile, source code, or `.env*` files
</success_criteria>

<output>
After completion, create `.planning/quick/260501-cov-remove-volumes-from-docker-compose-yml-t/260501-cov-SUMMARY.md` per quick-task SOP.
</output>
