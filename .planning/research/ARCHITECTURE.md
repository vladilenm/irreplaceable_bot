# Architecture — Thread Summaries v2.0 Integration

**Project:** Telegram-бот «Незаменимые» — v2.0 Thread Summaries
**Researched:** 2026-04-27
**Confidence:** HIGH (grounded in actual repo source)

---

## TL;DR — Integration Verdict

v2.0 is **mostly additive** to v1.0. Only two files require **invasive** edits:

1. `src/scheduler/cron.ts` — module-level `let task: ScheduledTask | null` must become a `Map<string, ScheduledTask>` registry. Trivial refactor, ~30 LOC.
2. `src/index.ts` — insert `initDb()` between `dotenv/config` and `startScheduler()`. Pure addition of one call.

Everything else (`bot.ts`, `config.ts`, `types/index.ts`) extends without rewrites. Existing `digest` module is untouched. This is the cheapest possible architectural shape because v1.0 was built on the right primitives.

---

## 1. DB Initialization in Startup Sequence

### Required v2.0 sequence

```
dotenv/config
  → import { bot } from './bot.js'
  → main():
      initDb()                              // (1) NEW — sync, throws on failure
      loadTrackingWhitelist()               // (2) NEW — DB → in-memory Set, sync
      startScheduler()                      // (3) cron tasks armed (digest + summary + retention)
      bot.start({...})                      // (4) long-polling — handlers see ready DB
```

### Why this exact order

| Step | Must run before | Reason |
|------|-----------------|--------|
| `initDb()` | everything | `better-sqlite3` is sync — schema migrations and WAL pragma must succeed before any repo touches the file. If it throws, exit fast. |
| `loadTrackingWhitelist()` | `bot.start()` | If long-polling starts first, capture handler runs against empty Set → first ms of messages silently dropped on startup race. |
| `startScheduler()` | `bot.start()` | Existing v1.0 order — keep. Cron isn't time-sensitive at boot. |
| `bot.start()` | last | Polling is the only async producer of writes; everything must be ready. |

### Risks of getting it wrong

| Risk | Symptom | Mitigation |
|------|---------|------------|
| DB init AFTER `bot.start()` | `SqliteError: no such table: messages` on every message in first ~50ms | Always sync-init before polling |
| Whitelist loaded AFTER polling | Tracked thread messages dropped silently for first N updates | Sync-load before polling |
| Migration runs lazily | First capture is slower; race with cron at startup | Run migrations in `initDb()` eagerly |
| DB file on volume not mounted | `SqliteError: unable to open database file` | Phase 0-Ops checklist + compose named volume |
| Init throws after scheduler armed | Cron fires while DB undefined → unhandled rejection | DB first, scheduler second |

### Concrete shape (target `src/index.ts`)

```typescript
import 'dotenv/config';
import { bot } from './bot.js';
import { logger } from './utils/logger.js';
import { startScheduler, stopScheduler } from './scheduler/cron.js';
import { initDb, closeDb } from './services/db.service.js';
import { loadTrackingWhitelist } from './services/tracking.service.js';

async function main(): Promise<void> {
  logger.info('Starting bot...');

  initDb();                       // sync; throws → process exits
  loadTrackingWhitelist();        // sync; populates in-memory Set from DB

  startScheduler();

  void bot.start({ onStart: () => logger.info('Bot is running (long-polling mode)') })
    .catch((err: unknown) => {
      logger.fatal({ err }, 'bot.start() failed');
      process.exit(1);
    });
}

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Shutdown signal received');
  stopScheduler();
  await bot.stop();
  closeDb();                      // NEW — checkpoint WAL after polling stops
  logger.info('Bot stopped. Goodbye.');
  process.exit(0);
}
```

`closeDb()` after `bot.stop()` because polling stop awaits in-flight handlers; closing first would corrupt mid-flight transactions.

---

## 2. Cron Registry Refactor

### Before (current `src/scheduler/cron.ts`, 51 LOC)

Single-task slot: `let task: ScheduledTask | null = null` — blocker for N tasks.

### After — minimal API change, registry of named tasks

```typescript
import cron from 'node-cron';
import type { ScheduledTask } from 'node-cron';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { runDigestPipeline } from '../modules/digest/digest.service.js';
import { sendDigest } from '../modules/digest/digest.sender.js';
import { runThreadSummaryPipeline } from '../modules/thread-summary/thread-summary.service.js';
import { runRetentionSweep } from '../services/retention.service.js';

const tasks = new Map<string, ScheduledTask>();

interface JobSpec {
  name: string;
  cronExpression: string;
  handler: () => Promise<void>;
}

function registerJob(spec: JobSpec): void {
  if (!cron.validate(spec.cronExpression)) {
    logger.error({ name: spec.name, cron: spec.cronExpression }, 'Invalid cron expression, job not registered');
    return;
  }
  if (tasks.has(spec.name)) {
    logger.warn({ name: spec.name }, 'Job already registered, skipping');
    return;
  }
  const task = cron.schedule(spec.cronExpression, async () => {
    logger.info({ name: spec.name }, 'Cron triggered');
    try { await spec.handler(); }
    catch (err: unknown) { logger.error({ err, name: spec.name }, 'Cron job failed'); }
  });
  tasks.set(spec.name, task);
  logger.info({ name: spec.name, cronExpression: spec.cronExpression }, 'Cron job registered');
}

export function startScheduler(): void {
  registerJob({
    name: 'digest',
    cronExpression: config.digestCron,
    handler: async () => {
      const result = await runDigestPipeline();
      if (result.alreadyPublished) { logger.warn('Cron: digest already published today, skipping send'); return; }
      await sendDigest(result);
    },
  });

  registerJob({
    name: 'thread-summary',
    cronExpression: config.threadSummaryCron,
    handler: runThreadSummaryPipeline,
  });

  registerJob({
    name: 'retention-sweep',
    cronExpression: config.retentionSweepCron,
    handler: runRetentionSweep,
  });
}

export function stopScheduler(): void {
  for (const [name, task] of tasks) { task.stop(); logger.info({ name }, 'Cron job stopped'); }
  tasks.clear();
}
```

### Why this shape

- External API unchanged. `startScheduler()` / `stopScheduler()` keep signatures. `index.ts` doesn't change.
- Per-job try/catch preserved — one bad job doesn't kill the loop.
- Map with named keys for ops introspection (future `/jobs` admin command + dedup guard).
- Validation per-job — failed job logs and skips, others register fine.
- Wrapper handler centralises try/catch + log so each `JobSpec.handler` can be a clean async function.
- No `any`: `JobSpec` fully typed, `tasks` parameterised.

---

## 3. Module Placement — `src/modules/thread-summary/` Mirroring `digest/`

### v2.0 layout

```
src/
├── modules/
│   ├── digest/                              [unchanged]
│   ├── thread-summary/                      [NEW]
│   │   ├── thread-summary.service.ts        ← orchestrator (iterate whitelist → summarise → format → publish)
│   │   ├── thread-summary.formatter.ts      ← HTML format + 4096 splitter
│   │   └── thread-summary.sender.ts         ← analogue of digest.sender.ts
│   └── capture/                             [NEW]
│       └── capture.handler.ts               ← bot.on('message'|'edited_message') wiring
├── services/                                [cross-cutting]
│   ├── ai.service.ts                        [unchanged]
│   ├── rss.service.ts                       [unchanged]
│   ├── db.service.ts                        ← NEW — better-sqlite3 singleton + WAL + migrations
│   ├── summarizer.service.ts                ← NEW — pure summarizeThread()
│   ├── tracking.service.ts                  ← NEW — Set<number> + DB CRUD + hot-reload
│   └── retention.service.ts                 ← NEW — runRetentionSweep()
├── stores/                                  [NEW — repository layer]
│   ├── message-store.ts                     ← typed repo over messages table
│   └── tracked-threads-store.ts             ← typed repo over tracked_threads table
└── ...
```

### Rationale

- `modules/` = product-feature-grouped (digest, thread-summary, capture)
- `services/` = primitives consumed by modules
- `stores/` = pure data access, separate from `services/` for clear boundary

Plug-and-play satisfied: future `modules/sprints/` drops in next to `digest/` and `thread-summary/` without touching existing modules.

---

## 4. Repository / Store Pattern

### Decision: single `db.service.ts` exporting connection getter, one repo per aggregate

```
db.service.ts                        ─┐
  ├── initDb(): void                  │  Connection lifecycle + migrations
  ├── getDb(): Database               │  No SQL here — only WAL, foreign_keys=ON, pragma
  └── closeDb(): void                 ─┘

stores/message-store.ts              ─┐
  ├── insertMessage(m)                │  All SQL for `messages` table
  ├── upsertEdited(m)                 │  Returns typed CapturedMessage / number
  ├── selectByThreadWindow(id, hrs)   │  No business logic — pure data access
  └── deleteByAuthor(authorId)        ─┘

stores/tracked-threads-store.ts      ─┐
  ├── listTracked()                   │
  ├── trackThread(t)                  │
  └── untrackThread(id)               ─┘
```

### Type contracts (additions to `src/types/index.ts`)

```typescript
export interface CapturedMessage {
  id: number;
  chatId: number;
  threadId: number;
  tgMessageId: number;             // (chatId, tgMessageId) unique
  authorId: number;                // numeric Telegram id — NEVER passed to LLM
  authorName: string;              // display name, anonymised at summariser boundary
  text: string;                    // [photo] / [voice 0:42] placeholders for non-text
  createdAt: string;               // ISO-8601 UTC
  editedAt: string | null;
}

export interface TrackedThread {
  chatId: number;
  threadId: number;
  trackedAt: string;
  trackedByUserId: number;
}

export interface ThreadSummary {
  threadId: number;
  threadName: string;
  headline: string;
  bullets: string[];               // 3-6 per SUM-01
  participants: string[];
  openQuestions: string[];
  messageCount: number;
  windowHours: number;
  skipped: boolean;
  skipReason?: 'low-volume' | 'no-tracked-threads' | 'llm-error';
}

// BotConfig extension — five new fields:
export interface BotConfig {
  // ... existing fields ...
  threadSummaryThreadId: string;
  threadSummaryCron: string;
  messageRetentionDays: number;
  retentionSweepCron: string;
  dbPath: string;
}
```

### `prepare()` strategy

Cache prepared statements as module-level constants inside each store, lazy-initialised on first `getDb()` call. Pattern:

```typescript
let _insertStmt: Database.Statement | null = null;
function insertStmt() {
  _insertStmt ??= getDb().prepare(`INSERT INTO messages (...) VALUES (@chatId, ...)`);
  return _insertStmt;
}
```

Avoids re-preparing per-message (hot path) and avoids module-load order coupling with `initDb()`.

---

## 5. Capture Handler Placement

### Decision: `src/modules/capture/capture.handler.ts` with explicit `registerCaptureHandlers(bot)`

NOT inline in `src/bot.ts`. `bot.ts` already 215 LOC; capture logic in module mirrors digest separation. Capture handler accepts `Bot` as argument → trivially testable.

### File contents sketch

```typescript
// src/modules/capture/capture.handler.ts
import type { Bot } from 'grammy';
import { logger } from '../../utils/logger.js';
import { isThreadTracked } from '../../services/tracking.service.js';
import { insertMessage, upsertEdited } from '../../stores/message-store.js';
import { mapTelegramMessageToCaptured } from './capture.mapper.js';

export function registerCaptureHandlers(bot: Bot): void {
  bot.on('message', async (ctx) => { /* tracked check → insert → log */ });
  bot.on('edited_message', async (ctx) => { /* tracked check → upsert → log */ });
}
```

### `bot.ts` change — single line addition

After `bot.catch()`, before command handlers:

```typescript
import { registerCaptureHandlers } from './modules/capture/capture.handler.js';
// ...
registerCaptureHandlers(bot);
```

Order matters: capture registers BEFORE command handlers. Grammy commands match via filter middleware; `bot.on('message')` matches everything but is short-circuited by `isThreadTracked()` → near-zero cost for non-tracked traffic.

### How capture gets the whitelist — import, not DI

```typescript
import { isThreadTracked } from '../../services/tracking.service.js';
// inside handler:
if (!ctx.message.message_thread_id) return;
if (!isThreadTracked(ctx.message.message_thread_id)) return;
```

`tracking.service.ts` exposes a closure over a module-private `Set<number>`. Singleton-by-import idiomatic Node.js; matches v1.0's `adminCache`.

---

## 6. Whitelist Hot-Reload

### Decision: shared mutable `Set<number>` inside `tracking.service.ts`

| Option | Latency | Complexity | Verdict |
|--------|---------|------------|---------|
| Pull-on-each-message via SQL | ~0.1ms but adds load + lock contention | Trivial | ❌ Violates least-DB-work principle |
| **Shared mutable Set, mutate on command** | ~10ns per check | Simple, single source | ✅ |
| Pub/sub (Node EventEmitter) | Same as Set + extra layer | Over-engineered | ❌ Single-process bot, events are function calls |

### Concrete shape

```typescript
// src/services/tracking.service.ts
const trackedSet = new Set<number>();

export function loadTrackingWhitelist(): void {
  trackedSet.clear();
  for (const t of listTracked()) trackedSet.add(t.threadId);
  logger.info({ count: trackedSet.size }, 'Tracking whitelist loaded');
}

export function isThreadTracked(threadId: number): boolean {
  return trackedSet.has(threadId);
}

export function track(chatId: number, threadId: number, byUserId: number): boolean {
  if (trackedSet.has(threadId)) return false;
  trackThread({ chatId, threadId, trackedAt: new Date().toISOString(), trackedByUserId: byUserId });
  trackedSet.add(threadId);                          // DB-first, then memory
  return true;
}

export function untrack(threadId: number): boolean {
  if (!trackedSet.has(threadId)) return false;
  untrackThread(threadId);
  trackedSet.delete(threadId);
  return true;
}
```

**Race-safety:** Node.js single-threaded; capture handler and command handler can never be mid-modification simultaneously. DB-first ordering ensures restart correctness.

**Subtle correctness:** `untrack` does NOT delete existing captured messages (Phase 5 success criteria: "существующие строки остаются"). Retention sweep eventually deletes them.

---

## 7. State.json vs DB — What Lives Where

### Decision: state.json keeps idempotency dates; DB owns everything else

| Data | v1.0 location | v2.0 location | Reason |
|------|---------------|---------------|--------|
| `lastDigestDate` | `state.json` | `state.json` (unchanged) | Already works, atomic write fits |
| `lastSkipped` | `state.json` | `state.json` | Drives 24h/48h fallback |
| `lastItemCount` | `state.json` | `state.json` | Cosmetic, used by `/status` |
| `lastThreadSummaryDate` (NEW) | — | `state.json` | Same model as digest idempotency |
| Messages | — | DB (`messages`) | Volume + queries demand SQL |
| Tracked threads | — | DB (`tracked_threads`) | Authoritative state |
| Users (denormalised) | — | DB (`users`) — populated lazily | Avoid join in summary path |
| Admin cache | In-memory Map | In-memory still | TTL 5 min; DB-backed adds latency |
| Schema migrations | — | DB (`schema_migrations`) | Standard pattern |

### State.json shape v2.0

```json
{
  "lastDigestDate": "2026-04-27T03:00:00.000Z",
  "lastSkipped": false,
  "lastItemCount": 5,
  "lastThreadSummaryDate": "2026-04-27T03:30:00.000Z"
}
```

Both pipelines call `readState()` / `writeState()` from a shared module → consider extracting to `src/services/state.service.ts` during Phase 7. Race risk noted: digest at 06:00 MSK and summary at 06:30 MSK never overlap; writes atomic via `writeFileSync`.

---

## 8. Build Order — Vertical Slice First

### Critical path

```
Phase 4-01 (DB infrastructure)
      ↓
Phase 4-02 (message-store + types)
      ↓
Phase 4-03 (capture handler + tracking service stub)
      ↓
   ╔═══════════ FIRST VERTICALLY TESTABLE SLICE ═══════════╗
   ║  Bot captures messages from a hardcoded thread ID;    ║
   ║  sqlite3 query shows real captured rows.              ║
   ║  No commands, no summary yet.                         ║
   ╚════════════════════════════════════════════════════════╝
      ↓
Phase 5 (track/untrack/tracked → hot-reload whitelist)
      ↓
   ╔═══════════ SECOND VERTICALLY TESTABLE SLICE ═══════════╗
   ║  Admins manage whitelist from chat. No restart needed. ║
   ╚════════════════════════════════════════════════════════╝
      ↓
Phase 6 (summarizer.service — pure function, no I/O)
      ↓                                              ↑
Phase 7-01 (cron registry refactor) ──── parallel ───┘
      ↓
Phase 7-02 (thread-summary.service orchestrator)
      ↓
Phase 7-03 (formatter + idempotency + state.json field)
      ↓
   ╔═══════════ THIRD VERTICALLY TESTABLE SLICE ═══════════╗
   ║  06:30 MSK cron publishes consolidated summary post.  ║
   ║  Coexists with 06:00 MSK digest.                      ║
   ╚════════════════════════════════════════════════════════╝
      ↓
Phase 8 (operational + privacy commands)
```

### Sequential dependencies

1. Phase 4-01 → 4-02 → 4-03
2. Phase 4 → Phase 5
3. Phase 4 + Phase 6 → Phase 7
4. Phase 7-01 → Phase 7-02
5. Phase 7 → Phase 8

### Parallelisable

- Phase 6 and Phase 7-01 are independent
- Phase 4-02 + Phase 4-03 can be co-developed once `db.service.ts` schema is locked
- Phase 8 commands can be drafted alongside Phase 7

### First-slice rationale

Phase 4 produces a demonstrable end-to-end loop. De-risks: privacy mode (operational), SQLite native build on Alpine (build-toolchain), Docker volume permissions for uid 1001 (perms). All three catastrophic later, cheap now.

---

## Integration Points — File-by-File Cheatsheet

### NEW files (16)

```
src/services/db.service.ts                              [Phase 4-01]
src/services/summarizer.service.ts                      [Phase 6]
src/services/tracking.service.ts                        [Phase 5]
src/services/retention.service.ts                       [Phase 8-03]
src/services/state.service.ts                           [Phase 7-03 — extracted]
src/stores/message-store.ts                             [Phase 4-02]
src/stores/tracked-threads-store.ts                     [Phase 5-01]
src/modules/capture/capture.handler.ts                  [Phase 4-03]
src/modules/capture/capture.mapper.ts                   [Phase 4-03]
src/modules/thread-summary/thread-summary.service.ts    [Phase 7-02]
src/modules/thread-summary/thread-summary.formatter.ts  [Phase 7-03]
src/modules/thread-summary/thread-summary.sender.ts     [Phase 7-02]
prompts/thread-summarizer.md                            [Phase 6-01]
data/messages.db (auto-created)                         [Phase 4-01, runtime]
.planning/phases/04-message-capture/04-OPS-CHECKLIST.md [Phase 0-Ops]
.env.example new fields                                 [Phase 4-01]
```

### MODIFIED files (10)

| File | Change |
|------|--------|
| `src/index.ts` | Add `initDb(); loadTrackingWhitelist();` before `startScheduler()`. Add `closeDb()` to `shutdown()`. |
| `src/bot.ts` | After `bot.catch`, before `/start`: add `registerCaptureHandlers(bot)` + 7 new command handlers |
| `src/scheduler/cron.ts` | Refactor `let task` → `Map<string, ScheduledTask>` registry |
| `src/config.ts` | Add 5 new fields: `threadSummaryThreadId`, `threadSummaryCron`, `messageRetentionDays`, `retentionSweepCron`, `dbPath` |
| `src/types/index.ts` | Add `CapturedMessage`, `TrackedThread`, `ThreadSummary`; extend `BotConfig` with 5 fields |
| `src/modules/digest/digest.service.ts` | Extend `PipelineState` with `lastThreadSummaryDate: string \| null`. Or extract `state.service.ts`. |
| `Dockerfile` | builder stage: `RUN apk add --no-cache python3 make g++` for native `better-sqlite3` |
| `docker-compose.yml` | Add `volumes: - ./data:/app/data` |
| `package.json` | `better-sqlite3` (runtime) + `@types/better-sqlite3` (dev) |
| `.env.example` | 5 new env vars with defaults |

### UNCHANGED (proves additive shape)

```
src/services/ai.service.ts        ← summarizer.service.ts uses its public function
src/services/rss.service.ts       ← unrelated
src/utils/telegram.ts             ← already supports thread_id
src/utils/logger.ts               ← pino reused
src/modules/digest/digest.formatter.ts    ← thread-summary.formatter is sibling, not fork
src/modules/digest/digest.sender.ts       ← thread-summary.sender is sibling
prompts/curator.md                ← thread-summarizer.md is sibling
config/feeds.json                 ← unrelated
```

---

## Data Flow — v1.0 vs v2.0

### v1.0 (current — outbound only)

```
[cron 06:00] → runDigestPipeline()
  → fetchFeeds(rss-parser, 9 sources)
  → filterArticles(ai.service)
  → writeState(state.json)
  → sendDigest()
    → formatDigestHtml()
    → sendMessageWithRetry({chatId, threadId=AI_RADAR, text, parseMode='HTML'})
```

### v2.0 (additive — inbound + outbound)

```
INBOUND PATH (continuous)
  Telegram update → bot.on('message') → capture.handler
    → isThreadTracked(threadId)? // O(1) Set check
        ↓ yes
    → mapTelegramMessageToCaptured(ctx)
    → message-store.insertMessage()
        → SQLite WAL flush, idempotent on (chatId, tgMessageId)

ADMIN COMMAND PATHS
  /track     → isAdmin → tracking.service.track()    → store + Set update
  /untrack   → isAdmin → tracking.service.untrack()  → store + Set update
  /tracked   → isAdmin → tracking.service.list()     → reply
  /forget-me → ANY user → message-store.deleteByAuthor(ctx.from.id) → reply count
  /storage   → isAdmin → store.countByThread + db file size → reply
  /summary   → isAdmin → runThreadSummaryPipeline({skipIdempotency:false})
  /dev-summary → isAdmin → runThreadSummaryPipeline({skipIdempotency:true, persistState:false})

OUTBOUND PATHS (cron registry)
  [cron 06:00 MSK]  digest job        → runDigestPipeline → sendDigest → AI_RADAR_THREAD_ID
  [cron 06:30 MSK]  thread-summary    → for each tracked threadId:
                                          → message-store.selectByThreadWindow(id, 24h)
                                          → summarizer.service.summarizeThread(messages)
                                          → ThreadSummary
                                       → thread-summary.formatter (consolidate + escape + split)
                                       → sendMessageWithRetry → THREAD_SUMMARY_THREAD_ID
                                       → writeState({lastThreadSummaryDate})
  [cron 04:00 MSK]  retention sweep   → message-store.deleteOlderThan(90 days)
                                       → log ingest-rate counter
```

### Three changes vs v1.0 worth flagging

1. Bot now writes more than reads from DB. Capture is hot path. Pre-prepared statements + WAL non-negotiable.
2. Two cron jobs same morning. Digest (06:00) + summary (06:30) share `state.json` — separate fields, separate writes (non-overlapping windows).
3. First incoming-message handler. Capture errors must NOT crash loop — wrap handler body in try/catch + log.

---

## Suggested Build Order (Phase-Keyed)

| Order | Phase | Plan | Deliverable | E2E? |
|-------|-------|------|-------------|------|
| 1 | Phase 0-Ops | manual | privacy off, volume mounted, summary topic, anonsы | ops only |
| 2 | Phase 4-01 | infra | Dockerfile build deps, compose volume, db.service.ts, schema migrations | infra |
| 3 | Phase 4-02 | data | message-store.ts, types, idempotency on `(chat_id, tg_message_id)` | unit test |
| 4 | Phase 4-03 | capture | capture.handler.ts, hardcoded whitelist, register in bot.ts | **FIRST E2E** |
| 5 | Phase 5-01 | service | tracking.service.ts (Set + DB CRUD + hot-reload), tracked-threads-store.ts | unit test |
| 6 | Phase 5-02 | commands | /track, /untrack, /tracked; capture reads from tracking.service | **SECOND E2E** |
| 7 | Phase 6-01 | summariser | prompts/thread-summarizer.md + summarizer.service.ts (single-shot) | fixture test |
| 8 | Phase 6-02 | summariser | map-reduce chunking, anonymisation, prompt-injection guard | fixture test |
| 9 | Phase 7-01 | scheduler | cron registry refactor | unit + digest still fires |
| 10 | Phase 7-02 | orchestrator | thread-summary.service.ts, new config fields | via /dev-summary |
| 11 | Phase 7-03 | delivery | thread-summary.formatter (HTML + 4096 split), state.json field | **THIRD E2E** |
| 12 | Phase 8-01 | commands | /summary, /dev-summary | yes |
| 13 | Phase 8-02 | privacy | /storage, /forget-me | yes |
| 14 | Phase 8-03 | retention | retention.service.ts + cron + ingest-rate pino counter | manual aged-row insert |

### Risk-tied ordering

- **Phase 4-01 first** — native `better-sqlite3` build on `node:20-alpine` fails without `python3 make g++`; volume permissions for uid 1001. Discover day one.
- **Phase 7-01 before 7-02** — orchestrator registers itself; without registry, write code to register that you immediately throw away.
- **Phase 6 in parallel with 7-01** — only true parallelism opportunity.
- **Phase 4-03 hardcoded whitelist is stepping stone** — once Phase 5 lands, capture imports `isThreadTracked` from tracking.service.

---

## Quality-Gate Verification

- [x] Integration points identified concretely with file references.
- [x] NEW vs MODIFIED explicit. 16 new + 10 modified files.
- [x] Build order considers dependencies. Sequential vs parallel work, locking DB → store → handler → tracking → summariser → cron → delivery.
- [x] Cron registry refactor sketched.

---

## Confidence

| Area | Confidence | Source |
|------|------------|--------|
| Startup sequence | HIGH | Direct read of `src/index.ts` |
| Cron registry | HIGH | Direct read of `src/scheduler/cron.ts` (51 LOC) |
| Module placement | HIGH | Mirrors v1.0 `src/modules/digest/` convention |
| Repository pattern | MEDIUM-HIGH | Standard idiom; partly new |
| Capture placement | HIGH | Matches plug-and-play constraint |
| Whitelist hot-reload | HIGH | Single-process Node + low volume |
| state.json vs DB | HIGH | Aligns with milestone plan + v1.0 stability |
| Build order | HIGH | Verified against MILESTONES.md + file dependencies |

No external sources needed — research grounded in repo source-of-truth.
