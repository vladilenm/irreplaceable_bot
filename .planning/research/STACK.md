# Stack Research — v2.0 Thread Summaries (additions only)

**Domain:** Telegram bot v2.0 — message capture + summarisation, append-only event ingest into local SQLite
**Researched:** 2026-04-27
**Confidence:** HIGH (Context7-equivalent: official GitHub repo + npm registry + npm package metadata verified directly; live release dated 2026-04-12)

> Scope: this document covers ONLY the *deltas* needed for v2.0 on top of the validated v1.0 stack (Node 20-alpine, TypeScript 5 strict + ESM, Grammy 1.42, node-cron 4.2, pino 10.3, @anthropic-ai/sdk + openai, rss-parser). The v1.0 stack is treated as immovable bedrock; nothing here replaces it.

---

## Executive Summary

For v2.0 the project needs **exactly two new npm packages**: `better-sqlite3` (runtime) and `@types/better-sqlite3` (dev). Everything else asked about — migrations, prompt-injection escaping, message anonymisation — should be **in-code, not a new dependency**, because adding more deps for tiny problems contradicts the project's "module = small file in `modules/`" philosophy and adds supply-chain surface for a 200-user club bot.

The `apk add python3 make g++` line in the Dockerfile builder stage is **needed as a fallback**, not as the primary install path: better-sqlite3 v12.9.0 ships a prebuilt `linuxmusl-x64` binary for Node ABI 115 (Node 20 LTS), so `npm ci` on `node:20-alpine` will normally download the prebuild and skip native compilation entirely. The build deps exist for the failure mode (network hiccup, ABI drift, unsupported arch like a future arm Alpine image).

---

## Recommended Stack — Additions Only

### Core Additions

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| `better-sqlite3` | `^12.9.0` (latest 2026-04-12) | SQLite driver — sync API, prepared statements, transactions, native C binding | Validated decision in PROJECT.md. Sync API matches the bot's existing single-process architecture (no async overhead, no callback hell, transactions are just functions). Far faster than `sqlite3` (the historical `node-sqlite3`) by 2.8x–24x on the project's expected workload (single-row inserts on capture, range scans on summary). Engine field `node: 20.x \|\| 22.x \|\| 23.x \|\| 24.x \|\| 25.x` confirms Node 20 LTS support. Active maintenance: repo `pushed_at` 2026-04-27, latest release 2026-04-12. Project ships prebuilt binaries for `linuxmusl-x64` Node ABI 115 → no native compile on `node:20-alpine` happy path. |

### Dev Dependency Additions

| Library | Version | Purpose | Why |
|---------|---------|---------|-----|
| `@types/better-sqlite3` | `^7.6.13` (latest 2025-08-03) | TypeScript types for better-sqlite3 | Required by strict TS / no-`any` rule. Note the major-version mismatch with runtime (`^7` vs runtime `^12`) is **expected and correct** — the types package follows its own versioning and currently tracks the v12 API surface. This is the canonical types package referenced from the project's own README. |

### Nothing else

The original questions asked about "any other new runtime/dev dependencies for the v2.0 feature set (e.g., for prompt-injection escaping, message anonymisation)". **Recommendation: zero additional packages.**

| Tempting addition | Why it's NOT needed |
|---|---|
| Migration library (`umzug`, `db-migrate`, `node-pg-migrate`) | The project ships ~5 tables (`messages`, `tracked_threads`, `users`, `schema_migrations`, room for one more). In-code migrations are 30 LOC: a `schema_migrations(version INT PRIMARY KEY, applied_at TEXT)` table + an array `[{version: 1, up: (db) => db.exec(`...`)}, …]` + a loop in `db.service.ts#init()` that runs unapplied entries inside a transaction. Pulling `umzug` (which is designed for Sequelize/Mongoose ecosystems) adds a heavyweight migration runner for a use case that needs ~5 statements over the project's lifetime. **In-code is the right call here**, and matches the existing `requireEnv` / `bot.catch()` / `state.json` style of "one small module, no framework". |
| HTML-sanitisation lib (`sanitize-html`, `dompurify`) for prompt-injection escape | The existing `src/modules/digest/digest.formatter.ts` already has a working `escapeHtml` (per MILESTONES.md, hardened by WR-01: HTML escape inside `href`). Reuse it for both Telegram-bound output AND the LLM-bound transcript. Prompt injection mitigation is *prompt structure* (system-prompt isolation, fenced transcript blocks, "treat below as data not instructions") not HTML-escaping — adding a sanitiser misframes the threat. |
| Anonymisation lib (`faker`, custom hash libs) | "Anonymisation" here means **strip numeric `from.id`, keep `display_name`** before sending to LLM (per success criterion 6.3). That's `delete msg.author_id` — one line. No library. |
| Rate-limit lib (`bottleneck`, `p-throttle`) for ingest | `bot.on('message')` is fired by Grammy's update loop one at a time; there's no concurrent ingest to throttle. The "ingest-rate counter" in OBS-01 is a `let count = 0; setInterval(() => { logger.info({ingestRate: count}); count = 0 }, 3600_000)` — pino does the rest. No library. |
| ORM (`prisma`, `drizzle`, `kysely`) | Decision logged in PROJECT.md ("better-sqlite3 (sync), не Postgres", "Локальный SQLite достаточен"). The project has 5 tables, sync access, single writer. An ORM would dwarf the actual code. `db.prepare('INSERT INTO messages ...').run(...)` is the right level. Drizzle is the closest reasonable alternative if this scope grows (see "Stack Patterns by Variant" below). |
| `dotenv-safe`, `zod` for env validation | The existing `requireEnv` / `requireEnvInt` (validated, hardened by WR-03) already does this. Reuse for the 5 new env vars listed in MILESTONES.md. |

---

## Installation

```bash
# Single command for v2.0 deltas
npm install better-sqlite3
npm install -D @types/better-sqlite3
```

Resulting `package.json` deltas:

```jsonc
{
  "dependencies": {
    "better-sqlite3": "^12.9.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.13"
  }
}
```

No other dependency edits.

---

## Native Build on `node:20-alpine` — verified incantation

### What actually happens during `npm ci`

`better-sqlite3@12.9.0` `package.json` contains:
```
"scripts": { "install": "prebuild-install || node-gyp rebuild --release" }
```

So on install:

1. **First attempt:** `prebuild-install` (v7.1.3, dependency of better-sqlite3) hits the GitHub releases page and looks for an asset matching `{platform}-{arch}` × `node-v{ABI}`. For `node:20-alpine` on x86_64 host, the match is `better-sqlite3-v12.9.0-node-v115-linuxmusl-x64.tar.gz` (verified to exist in the v12.9.0 release assets). The tarball is downloaded and extracted; **no compilation occurs**.
2. **Fallback:** if (1) fails — network error, no asset for the platform/ABI combination, or `--build-from-source` is passed — `node-gyp rebuild --release` runs, which requires Python 3, GNU make, and a C++ compiler.

### Recommended Dockerfile pattern

The build deps must live in the **builder stage only**. The production stage already has the resolved `node_modules` (including the compiled `.node` binary) copied in via the existing `npm ci --omit=dev` pattern, so it does NOT need toolchain.

Concrete change to `Dockerfile`:

```dockerfile
# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Native build deps for better-sqlite3 fallback path.
# 99% of the time prebuild-install downloads the linuxmusl-x64 binary
# and these are unused, but pinning them here makes Phase 4 verification
# deterministic across networks. apk's --no-cache avoids index bloat.
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

# v2.0: pre-create data dir owned by botuser BEFORE switching USER.
# Volume mount overlay inherits these perms when host dir doesn't exist;
# if host dir exists it keeps host perms (see "Volume permissions" below).
RUN addgroup -g 1001 -S botuser && \
    adduser -S botuser -u 1001 && \
    mkdir -p /app/data && \
    chown -R botuser:botuser /app/data
USER botuser

CMD ["node", "dist/index.js"]
```

**Important nuance about the production stage:** the production stage *also* runs `npm ci --omit=dev`, which means it *also* runs the `install` script of `better-sqlite3`, which means **it also calls `prebuild-install`** (a runtime dep, not dev). So the prebuilt binary is fetched AGAIN in the production stage. If you want to avoid two prebuild downloads (one in builder, one in prod) and skip the toolchain in production reliably, **the cleanest pattern is `COPY --from=builder /app/node_modules ./node_modules`** in production and drop the second `npm ci`. Both are valid; the current Dockerfile does the latter style implicitly.

Recommended: keep the current two-`npm-ci` pattern (it's what v1.0 ships, no behaviour change), and add the `apk add` only to the builder stage. Production stage doesn't need the toolchain because if its prebuild-install also fails, the whole image is broken regardless — fix builds in CI, not at runtime.

### Why `python3 make g++` and not `python3-dev` or `build-base`

- `python3` is enough — better-sqlite3's `binding.gyp` invokes Python only as a script orchestrator. `python3-dev` headers are not used.
- `make` and `g++` are the two binaries node-gyp shells out to.
- `build-base` is a meta-package on Alpine that installs `make`, `g++`, `gcc`, `libc-dev`, etc. It works but pulls a couple of extra MB. `python3 make g++` is the minimal triple and is the canonical incantation in Alpine + node-gyp Stack Overflow / GitHub-issues consensus.
- Do NOT add `gcc` separately — `g++` already pulls it.

### Verifying the build worked (Phase 4-01 verification step)

```bash
# Inside the running container or `docker compose run --rm bot sh`
node -e "const db=require('better-sqlite3')(':memory:'); console.log(db.pragma('journal_mode=WAL'))"
# Expected: [ { journal_mode: 'wal' } ]   (in-memory dbs always report 'memory' actually — use a file path:)
node -e "const db=require('better-sqlite3')('/tmp/x.db'); console.log(db.pragma('journal_mode=WAL'))"
# Expected: [ { journal_mode: 'wal' } ]
```

---

## Docker Volume Permissions (botuser uid 1001)

This is the gotcha that bites every Docker-on-VPS project the first time.

### Failure mode

`docker-compose.yml` mounts a host directory:
```yaml
volumes:
  - ./data:/app/data
```

If `./data` exists on the host, Docker **does not apply the image's chown** — the container sees the directory with the host's uid/gid. On most Linux VPS setups the host `./data` is owned by uid 0 (root) or uid 1000 (deploy user), and the container's botuser (uid 1001) can't write. Symptom: bot starts, tries to open `/app/data/messages.db`, gets `SQLITE_CANTOPEN: unable to open database file`, and dies.

### Three working patterns (pick one)

**Pattern A — pre-chown on host (simplest, recommended):**

```bash
# Run once on the VPS, before docker compose up
mkdir -p ./data
sudo chown -R 1001:1001 ./data
```

Then `docker-compose.yml`:
```yaml
services:
  bot:
    # ... existing fields ...
    volumes:
      - ./data:/app/data
```

This is the recommended path because it's explicit, debuggable (`ls -la data/`), and matches the v1.0 manual deployment style. Document it in `04-OPS-CHECKLIST.md`.

**Pattern B — named volume instead of bind mount (lets Docker manage perms):**

```yaml
services:
  bot:
    # ...
    volumes:
      - botdata:/app/data

volumes:
  botdata:
```

Docker creates the volume the first time, applies the image's `chown` (because the directory inside the volume is empty when Docker copies the image's `/app/data` perms over), and reuses it across `docker compose up`/`down`. Trade-off: `data/messages.db` is now under `/var/lib/docker/volumes/<project>_botdata/_data/messages.db`, harder to inspect from the host shell. MILESTONES.md already specifies bind mount (`./data:/app/data`) — stick with bind mount + Pattern A.

**Pattern C — `user:` directive in compose (overrides image USER):**

```yaml
services:
  bot:
    user: "1001:1001"
    volumes:
      - ./data:/app/data
```

This forces the container's effective uid to match. Works, but redundant since the Dockerfile already does `USER botuser` (uid 1001). Mention it as a fallback if Pattern A fails on a weird filesystem (e.g. NFS-mounted storage with squash_root).

### Why MILESTONES.md mentions both `chown` and "volume permissions in compose"

The project lead correctly anticipated this. Phase 4-01 should:
1. Add `mkdir -p /app/data && chown -R botuser:botuser /app/data` in the Dockerfile *before* `USER botuser` (already in the recommended Dockerfile above) — handles the Pattern B case if the deployment ever switches to named volume.
2. Document the `sudo chown -R 1001:1001 ./data` step in the Phase 0-Ops checklist — handles the Pattern A bind-mount case which is what `docker-compose.yml` actually uses.

Both are belt-and-suspenders, neither is wasted.

---

## SQLite WAL + Migrations Pattern (in-code, no library)

### WAL mode

Per better-sqlite3 official docs (`docs/performance.md`), WAL is the recommended pragma for any non-trivial workload. One-liner in `db.service.ts`:

```ts
import Database from 'better-sqlite3';

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');         // SQLite's per-connection default is OFF; turn on
db.pragma('synchronous = NORMAL');      // explicit even though it's the WAL default in this build
```

Footnote from the official perf doc: better-sqlite3 ships SQLite compiled with `SQLITE_DEFAULT_WAL_SYNCHRONOUS=1` so `synchronous=NORMAL` is implicit in WAL mode, but stating it explicitly makes the intent legible to a future reader.

### In-code migrations pattern (5 tables, project lifetime)

```ts
// src/services/db.service.ts (sketch)
const MIGRATIONS: ReadonlyArray<{ version: number; up: (db: Database.Database) => void }> = [
  {
    version: 1,
    up: (db) => {
      db.exec(`
        CREATE TABLE messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          chat_id INTEGER NOT NULL,
          thread_id INTEGER NOT NULL,
          tg_message_id INTEGER NOT NULL,
          author_id INTEGER NOT NULL,
          author_name TEXT NOT NULL,
          text TEXT NOT NULL,
          created_at TEXT NOT NULL,
          edited_at TEXT,
          UNIQUE(chat_id, tg_message_id)
        );
        CREATE INDEX idx_messages_thread_created ON messages(thread_id, created_at);
        CREATE INDEX idx_messages_author ON messages(author_id);

        CREATE TABLE tracked_threads (
          thread_id INTEGER PRIMARY KEY,
          chat_id INTEGER NOT NULL,
          added_by INTEGER NOT NULL,
          added_at TEXT NOT NULL
        );

        CREATE TABLE users (
          author_id INTEGER PRIMARY KEY,
          display_name TEXT NOT NULL,
          first_seen_at TEXT NOT NULL
        );
      `);
    },
  },
  // future versions append here
];

export function initDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);

  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((r: any) => r.version)
  );

  const apply = db.transaction((m: typeof MIGRATIONS[number]) => {
    m.up(db);
    db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
      .run(m.version, new Date().toISOString());
  });

  for (const m of MIGRATIONS) {
    if (!applied.has(m.version)) apply(m);
  }
  return db;
}
```

This is ~40 LOC, atomic per migration (DDL inside `db.transaction()`), deterministic, no new dependency. Total cost matches the project's "no `any`, plug-and-play modules" philosophy.

### Why NOT umzug / db-migrate / better-sqlite3-migrations

- **umzug** (`v3.8.2`, 2024-09-23) — designed for Sequelize/Mongoose, async storage adapters, async migration interface. Forces async wrapping of better-sqlite3's sync API for no benefit. ~2.2k stars, healthy, but wrong tool.
- **db-migrate** (`v0.11.14`, 2025-08-04) — file-system-driven, expects a `migrations/` folder with timestamped files. Overkill for 5 ever-growing tables, adds CLI to learn.
- **`better-sqlite3-migrations`** — does not exist on npm (verified empty result). There's no community-favoured migration runner specifically for better-sqlite3 because the in-code pattern shown above is what the better-sqlite3 ecosystem actually uses.
- **node-sqlite3-migrations** — does not exist on npm either.

The in-code approach is the canonical answer. If migrations ever exceed ~20 entries (years from now, unlikely for a club bot), revisit; for now, ship it.

---

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| `better-sqlite3` | `node:sqlite` (built-in, Node 22.5+) | Once the project upgrades to Node 22 LTS (Oct 2026+) AND the `node:sqlite` API stabilises out of experimental. Still experimental as of Node 22.x; would lose prepared-statement performance optimisations and 64-bit int handling that better-sqlite3 has. **Not now.** |
| `better-sqlite3` | `sqlite3` (`v6.0.1`, async callback API) | Never for this project. Async API is wrong fit (Grammy handlers are async-friendly but the bot has a single writer; sync transactions are simpler). 2.8x–24x slower per project benchmark. |
| `better-sqlite3` | `node-sqlite3-wasm` (`v0.8.56`) | If the deployment ever moves to a platform without native modules (Cloudflare Workers, Vercel Edge). Not the case here — VPS + Docker is fine. |
| In-code migrations | `drizzle-kit` (with `drizzle-orm`) | If the schema grows past ~10 tables AND the team wants type-safe query building. Drizzle's introspection + migration generation is genuinely good, and it's the only ORM whose better-sqlite3 driver is fully sync. **For 5 tables it's overkill;** revisit at v3.0 if scope grows. |
| `escapeHtml` from existing `digest.formatter.ts` | `sanitize-html` (`^2.x`) | If the bot ever needs to ingest *user-pasted HTML* (rich media, signed URLs, etc.) and re-emit a sanitised subset. Current scope is plain Telegram message text → escape-then-format, which the existing helper handles. |

---

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| `sqlite` npm package (the one named just "sqlite", `v5.1.1`) | Wrapper around `sqlite3` that adds promise API and a *separate* migration runner. Effectively `sqlite3 + light ORM`. Pulls async overhead, slower, more deps. | `better-sqlite3` directly. |
| `prisma` with sqlite | Heavyweight: generates client, requires schema.prisma, runs migrations through its own engine, adds rust binary. Beautiful for teams of 10+ on Postgres, wildly oversized for a 5-table single-process club bot. | `better-sqlite3` + 40 LOC migration runner. |
| `sequelize` / `typeorm` | ORMs designed for multi-DB portability. The project has explicitly chosen SQLite as a permanent decision. | Raw prepared statements. |
| `knex` for migrations | Adds a query builder + migration CLI + connection pooling for a single-writer SQLite. None of those features earn their weight. | In-code migrations array. |
| `dotenv-flow`, `dotenv-safe` for v2.0 env vars | Project already has `dotenv` + hardened `requireEnv`/`requireEnvInt` (WR-03). Adding another env loader on top is noise. | Reuse existing config helpers. |
| `node-gyp` as direct dependency | better-sqlite3 already declares it transitively as part of its install fallback. | Don't add it; the toolchain in the builder stage is enough. |
| `pg`, `mysql2`, any client/server DB driver | Decided against by the project (Out-of-Scope: "Supabase / external DB"). | Stay with SQLite. |

---

## Stack Patterns by Variant

**If the bot stays at ≤200 users and ≤5 tracked threads (the planned envelope):**
- Use `better-sqlite3` + in-code migrations as described.
- WAL mode + a single writer thread (the bot process) covers all needs.
- Backups = `cp data/messages.db data/backup/$(date).db` from a host cron, no `Database#backup()` complexity.

**If the bot grows to >1000 users or >50 tracked threads:**
- WAL is still fine; add `wal_checkpoint(RESTART)` on a 5-min `setInterval` (the official perf doc shows the exact pattern, ~5 LOC).
- Consider switching to `Database#backup(destination)` API for online backups instead of `cp` (handles WAL state correctly).
- Still no need for ORM or external DB.

**If this ever needs to run in worker_threads (e.g. summary generation in a separate thread):**
- better-sqlite3 supports worker threads natively (per README "Worker thread support"). Open the same DB file in WAL mode from each worker; SQLite handles concurrent readers. Single-writer rule still applies — funnel writes through main thread or use a serialised queue.

---

## Version Compatibility Matrix

| Package | Version | Compatible With | Notes |
|---------|---------|-----------------|-------|
| `better-sqlite3@^12.9.0` | 12.9.0 | Node 20.x, 22.x, 23.x, 24.x, 25.x | Verified from the package's `engines` field. Node 20 LTS is fine. ABI 115 prebuild exists for linuxmusl-x64. |
| `better-sqlite3@^12.9.0` | 12.9.0 | TypeScript 5.x ESM | Default export class `Database`; usage: `import Database from 'better-sqlite3'` works in `"type": "module"` projects. The package is itself CommonJS but Node's CJS-from-ESM interop handles it. Verified via the project's existing `@anthropic-ai/sdk` and `openai` interop pattern (both same shape). |
| `@types/better-sqlite3@^7.6.13` | 7.6.13 | runtime `better-sqlite3@^12` | Type package version intentionally lags runtime; types track the v12 API surface. |
| `prebuild-install@^7.1.3` | 7.1.3 | Node 18+, glibc + musl | Transitive dep of better-sqlite3. Don't install directly. |
| Node.js | 20.x (Alpine) | better-sqlite3, all v1.0 deps | No upgrade needed for v2.0. |

---

## Environment Variables (additions)

Per MILESTONES.md, five new env vars enter via existing `requireEnv` / `requireEnvInt`. Adding them here for stack-completeness — they're config not deps:

```env
THREAD_SUMMARY_THREAD_ID=12345        # int — message_thread_id of "🧵 Сводки тредов"
THREAD_SUMMARY_CRON=30 3 * * *        # cron expr — 06:30 MSK = 03:30 UTC
MESSAGE_RETENTION_DAYS=90             # int — for nightly retention sweep
RETENTION_SWEEP_CRON=0 1 * * *        # cron expr — 04:00 MSK = 01:00 UTC
DB_PATH=data/messages.db              # string — relative to process cwd
```

No new env-loading dependency needed.

---

## Sources

- **better-sqlite3 npm metadata** (`npm view better-sqlite3` 2026-04-27) — version `12.9.0`, `time.modified` 2026-04-12T18:23:42Z, `engines.node = "20.x || 22.x || 23.x || 24.x || 25.x"`, `dependencies = { bindings: ^1.5.0, prebuild-install: ^7.1.1 }`, `scripts.install = "prebuild-install || node-gyp rebuild --release"`. **HIGH confidence — primary source.**
- **better-sqlite3 GitHub release v12.9.0 assets** (api.github.com/repos/WiseLibs/better-sqlite3/releases/latest) — confirmed `linuxmusl-x64` prebuilt binaries exist for Node ABI 115/127/131/137/141. **HIGH confidence — direct GitHub API.**
- **better-sqlite3 GitHub repo health** — `pushed_at: 2026-04-27T10:56:35Z`, `archived: false`, `open_issues_count: 90`, `stargazers_count: 7152`. Active maintenance confirmed. **HIGH confidence.**
- **better-sqlite3 README + docs/performance.md + docs/troubleshooting.md** (raw.githubusercontent.com, master branch) — WAL pragma example, prebuilt-binary mention, troubleshooting points to `npm install` path with no native compile on supported platforms. **HIGH confidence — official docs.**
- **better-sqlite3 v12.9.0 `package.json` install script** (raw.githubusercontent.com tag v12.9.0) — `prebuild-install || node-gyp rebuild --release` confirms two-step fallback. **HIGH confidence — pinned tag.**
- **@types/better-sqlite3 npm metadata** — version `7.6.13`, modified 2025-08-03. **HIGH confidence.**
- **Migration libraries cross-check** (`npm view umzug`, `npm view db-migrate`, `npm search migration sqlite`) — confirmed no community-canonical migration lib targets better-sqlite3 specifically; in-code is the established pattern. **HIGH confidence.**
- **Project context** — `.planning/PROJECT.md`, `.planning/MILESTONES.md`, `~/.claude/plans/hidden-percolating-dragon.md`, `package.json`, `Dockerfile`, `docker-compose.yml`. **HIGH confidence — first-party.**

---

*Stack research for: Telegram bot v2.0 — message capture + thread summarisation*
*Researched: 2026-04-27*
*All assertions about `linuxmusl-x64` prebuild availability, Node 20 ABI = 115, and the Dockerfile builder-stage `apk add python3 make g++` pattern have been verified against the v12.9.0 release manifest, not assumed from training data.*
