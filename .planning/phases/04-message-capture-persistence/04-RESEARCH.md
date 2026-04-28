# Phase 4: Message Capture & Persistence — Research

**Researched:** 2026-04-28
**Domain:** Telegram bot listening (Grammy v1.42) + local SQLite persistence (better-sqlite3 v12) на Node 20-alpine + Docker
**Confidence:** HIGH (versions verified против npm registry 2026-04-28; Telegram Bot API + SQLite pragma поведение verified против sqlite.org / core.telegram.org / grammy.dev; archirecturные решения grounded в существующем коде v1.0)

## Summary

Phase 4 переводит бот из publish-only в listen+publish: ловим text-bearing сообщения (text + caption по D-08) из whitelisted forum-тредов в SQLite (`./data/messages.db`, WAL) идемпотентно. CONTEXT.md (D-01..D-14) уже locked все ключевые архитектурные решения; задача исследования — выбрать **точные формы** для 17 discretionary points, верифицировать version pins, привести concrete SQL DDL, шаблон capture-handler, миграционный runner и Dockerfile diff.

Все версии актуальны на 2026-04-28: `better-sqlite3@12.9.0` (опубликован 2026-04-12), `@types/better-sqlite3@7.6.13` (2025-08-03), `grammy@1.42.0` (текущая используемая). Ровно две новые npm-зависимости. Все остальное — in-code (миграции, маппер, prepared statements).

**Primary recommendation:** Использовать **single combined Grammy filter** `bot.on(['message:text', 'message:caption', 'edited_message:text', 'edited_message:caption'], handler)` — это сразу выкидывает service messages и non-text без кастомных guard'ов; затем внутри handler — guard chain в порядке: `is_topic_message` → tracked → `sender_chat?.type === 'channel'` / `is_automatic_forward` → forgotten guard → mapper → upsert. Migration runner: WAL первым, ВНЕ транзакции, верификация активности, потом FK / synchronous / busy_timeout, потом миграции в `db.transaction()`. Capture body — единый try/catch (REL-04). Dockerfile builder получает `apk add --no-cache python3 make g++`; production stage — `mkdir -p /app/data && chown -R botuser:botuser /app/data` ДО `USER botuser`.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Whitelist Bridge (Phase 4 ↔ Phase 5)**

- **D-01:** Phase 4 создаёт полный (хоть и stub-уровня) `services/tracking.service.ts` и `stores/tracked-threads-store.ts`. Сервис экспортирует `loadTrackingWhitelist()`, `isThreadTracked(threadId)`, `listTrackedThreadIds()`. Phase 5 лишь *добавит* `/track`/`/untrack`/`/tracked` команды + расширит store на write-side; никаких рефакторингов файлов из Phase 4.
- **D-02:** ENV-bootstrap: новый ENV-var `INITIAL_TRACKED_THREAD_IDS` (CSV из `message_thread_id`). При первом boot `loadTrackingWhitelist()` проверяет `tracked_threads` — если таблица пуста и ENV задан, INSERT-ит ID в DB единоразово, логирует INFO. На последующих boot DB не пуста → ENV игнорируется. После Phase 5 ENV можно убрать; `/untrack` будет работать корректно (DB = source of truth).

**Schema (`messages`, `users`, `tracked_threads`, `forgotten_users`, `schema_migrations`)**

- **D-03:** Время хранится как `TEXT NOT NULL` в ISO-8601 UTC (`2026-04-28T11:23:45.000Z`). Источник: `new Date(ctx.message.date * 1000).toISOString()`. Лексикографическая сортировка совпадает с хронологической. Согласовано с v1.0 `state.json.lastDigestDate`.
- **D-04:** `messages.author_id INTEGER NULL`, `is_anonymous INTEGER NOT NULL DEFAULT 0` (явный флаг), `author_name TEXT NOT NULL` (денормализован в момент insert). Историческое имя сохраняется при последующем rename. Анонимные admin'ы (PITFALLS TG-04): `author_id = NULL`, `is_anonymous = 1`, `author_name = sender_chat.title`.
- **D-05:** Reply-context — только `reply_to_message_id INTEGER NULL`. Никакого parent fetch, никакого `reply_excerpt` (защищает /forget-me от утечки родительской PII через дубль).
- **D-06:** Phase 4 migration v1 ставит ВСЕ 4 продуктовые таблицы (+ `schema_migrations`) сразу: `messages`, `users` (lazy-populated lookup), `tracked_threads`, `forgotten_users`. Phase 8 не меняет schema, только пишет в `forgotten_users` через `/forget-me`.
- **D-07:** Migration механизм: in-code array `const MIGRATIONS: Array<{version: number, sql: string}> = [...]` в `db.service.ts`. На boot: `SELECT MAX(version) FROM schema_migrations`, выполнить все более новые в одной транзакции, INSERT version row. Forward-only — никаких rollback. Versions = integer (`1, 2, 3...`).

**Capture Scope — text + caption only (deviation from MSG-03)**

- **D-08:** ⚠ **Deviation от MSG-03**: Phase 4 НЕ пишет placeholder rows для non-text. Захватываются только сообщения с `ctx.message.text` ИЛИ `ctx.message.caption`. Чистые photo/voice/video/document/sticker/poll/animation/video_note/audio/dice/location/contact БЕЗ caption — drop, ноль строк в DB. **REQUIREMENTS.md MSG-03 обновляется в составе Phase 4** (планер заведёт в чек-лист).
- **D-09:** `messages.text TEXT NOT NULL` хранит ИЛИ `ctx.message.text`, ИЛИ `ctx.message.caption` — без префиксов `[photo]`/`[video]`. Mapper выбирает: `text ?? caption`. Если оба пустые → row не пишется.
- **D-10:** Filter at handler entry: первая проверка после tracked/service/channel-post/auto-forward — наличие текста. Реализуется через Grammy filter `bot.on(['message:text', 'message:caption', 'edited_message:text', 'edited_message:caption'], handler)` (или через `if (!ctx.message.text && !ctx.message.caption) return` — researcher выберет точную форму).

**Plan Partitioning, Logging, GDPR-стартовый guard**

- **D-11:** Phase 4 ships **одним планом** (`4-01`), покрывающим все 17 требований. Это отступление от ROADMAP-estimate в 3 плана — обосновано: solo-dev темп («штурман → пилот»), полный vertical slice до первого E2E-теста, минимальный handoff overhead. Если gsd-planner оценит риск/сложность как требующие split — может субдивайдить, но bias к одному плану.
- **D-12:** Capture handler делает pre-INSERT guard: prepared statement `SELECT 1 FROM forgotten_users WHERE author_id = ?`, если hit — short-circuit, никакого insert. PRIV-02 («close post-deletion replay window») закрывается ещё в Phase 4. Phase 8 `/forget-me` лишь пишет в forgotten_users + DELETE FROM messages в одной `db.transaction()`.
- **D-13:** Per-message capture log: `logger.debug({chat_id, thread_id, author_id, message_length, is_edit, has_media})`. В prod `LOG_LEVEL=info` — debug-логи выключены. ERROR на исключения capture-handler. PRIV-05 соблюдён (никакого `text` body в логи). Для verification — временно `LOG_LEVEL=debug`.
- **D-14:** OBS-01 hourly capture-rate aggregate **не в этой фазе**. Phase 8 owns observability layer. Verification Phase 4 — через sqlite3 CLI (`SELECT COUNT(*), MAX(created_at) FROM messages`) и временный debug-лог.

### Claude's Discretion

1. Точная Grammy-filter форма для capture handler (single `bot.on(['message','edited_message'])` + ifs vs split text/caption queries) — researcher выберет на основе Grammy v1.42 idiom + читаемости.
2. Точный SQL DDL для всех 4 таблиц (типы колонок, NULL/NOT NULL, индексы, FK chains, UNIQUE INDEX (chat_id, tg_message_id) для idempotency, индексы по thread_id+created_at для summarizer-window queries Phase 6).
3. Pino-redact rules vs ручное метаданные-only логирование — стилевой выбор; обе формы соблюдают PRIV-05.
4. ENV default для `INITIAL_TRACKED_THREAD_IDS` — пустая строка vs `undefined`.
5. better-sqlite3 v12+ idioms: prepare/run/get/all, transaction, pragma application order, busy_timeout=5000, foreign_keys=ON, synchronous=NORMAL.
6. Idempotent upsert SQL: `INSERT ... ON CONFLICT(chat_id, tg_message_id) DO UPDATE SET text=excluded.text, edited_at=excluded.edited_at`.
7. Out-of-order edit handling: edited_message arrives но original row нет — INSERT с edited_at populated.
8. Anonymous-admin detection: `ctx.message.from is bot itself with sender_chat populated` → use sender_chat.id+title, set is_anonymous=1.
9. Service message detection: explicit list (forum_topic_created, pinned_message, new_chat_members, left_chat_member, etc.) — full Telegram Bot API 7+ enumeration.
10. Channel posts and automatic forwards: `ctx.message.is_automatic_forward`, `ctx.update.channel_post`, `sender_chat.type === 'channel'`.
11. Migration runner: ordering of (1) open DB → (2) PRAGMA journal_mode=WAL → (3) verify WAL active → (4) run pending migrations in transaction → (5) apply other pragmas.
12. better-sqlite3 native build на node:20-alpine: builder stage `apk add --no-cache python3 make g++` + production stage rebuild OR copy.
13. Volume permissions: `mkdir -p /app/data && chown -R botuser:botuser /app/data` ДО `USER botuser`.
14. preflight.ts: `getMe().can_read_all_group_messages` WARN if false (MSG-08), `getChatMember(targetChatId, botId).status` WARN if !== 'administrator'.
15. Использовать ли Grammy `:not(...)` filter chains для service-message exclusion vs imperative early-return guards.
16. Validation Architecture (Nyquist) — `nyquist_validation_enabled=false` в этом проекте, OPTIONAL section.
17. Test harness recommendation для Phase 4 (vitest? node:test? in-memory better-sqlite3 + ctx mocks?) — вероятно brief — main verification через sqlite3 CLI per D-14.

### Deferred Ideas (OUT OF SCOPE)

- **Placeholder rows для non-text сообщений** (исходный MSG-03 design) — отложено навсегда (или до v3).
- **Voice/video duration в placeholder** — следствие D-08, deferred.
- **Расширенный non-text catalog (animation, video_note, dice, location, contact, forwards)** — следствие D-08.
- **Reply context: reply_to_author_id, reply_excerpt** — отвергнуто (D-05); GDPR-чище.
- **Per-call `costEstimateUsd` в pino + rolling 7-day** — REQUIREMENTS Future v2.1.
- **Migration `lastDigestDate` / `lastThreadSummaryDate` из state.json в SQLite `pipeline_state` table** — REQUIREMENTS Future v2.1; Phase 7 сохраняет state.json + atomic-rename.
- **OBS-01 hourly capture-rate aggregate** — Phase 8 (зафиксировано D-14, не Phase 4).
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| SETUP-05 | Dockerfile builder stage installs `apk add --no-cache python3 make g++` (fallback for native build) | §Dockerfile Diff — builder stage section. better-sqlite3@12.9.0 ships prebuild для linuxmusl-x64 ABI 115; toolchain — fallback. |
| SETUP-06 | docker-compose.yml mounts `./data:/app/data` named volume | §Dockerfile Diff — compose section |
| SETUP-07 | Dockerfile creates `/app/data` with `botuser:botuser` ownership before `USER botuser` | §Dockerfile Diff — production stage section. Critical для bind-mount perms (PITFALLS CRIT-03). |
| SETUP-08 | 5 new ENV vars loaded via existing requireEnv/requireEnvInt | §11 ENV vars + config.ts extension. `MESSAGE_RETENTION_DAYS` min=7 enforced. |
| MSG-01 | bot.on('message') captures every text/non-text within <2s of arrival from tracked threads | §4 Capture Handler Skeleton. Sync better-sqlite3 INSERT — микросекунды; latency dominated by Grammy event loop, not DB. **D-08 deviation**: только text+caption. |
| MSG-02 | bot.on('edited_message') updates same row by (chat_id, tg_message_id) and sets edited_at | §3 SQL DDL — UNIQUE (chat_id, tg_message_id) + ON CONFLICT DO UPDATE. §1.6/1.7 — out-of-order safe. |
| MSG-03 | Non-text stored as placeholder | **NOT in Phase 4 per D-08.** Phase 4 captures text + caption ONLY; placeholder feature deferred / removed. **REQUIREMENTS.md MSG-03 to be rewritten in this phase** (planner adds explicit task). |
| MSG-04 | Idempotent insert via UNIQUE(chat_id, tg_message_id) and ON CONFLICT | §3 SQL DDL + §1.6 upsert SQL |
| MSG-05 | Service messages, channel posts, automatic forwards filtered out | §1.9 + §1.10 — combined filter via Grammy `message:text`/`message:caption` queries (drops service messages with no text) + explicit `sender_chat?.type === 'channel'` and `is_automatic_forward` guard |
| MSG-06 | Anonymous admins handled — author_id=NULL, is_anonymous=1 | §1.8 — `ctx.message.sender_chat` detection in mapper |
| MSG-07 | Reply context — reply_to_message_id stored as nullable, no recursive fetch | §3 SQL DDL — `reply_to_message_id INTEGER NULL`; no FK (parent may be in untracked thread or pre-capture history) |
| MSG-08 | Startup preflight — getMe().can_read_all_group_messages logged WARN if false | §1.14 preflight.ts shape |
| STORE-01 | better-sqlite3 connection singleton с journal_mode=WAL, foreign_keys=ON, synchronous=NORMAL; opened during initDb() before scheduler/polling | §5 Migration Runner — pragma order verified против sqlite.org PRAGMA docs |
| STORE-02 | schema_migrations(version, applied_at) table from day one; migrations array applied inside single transaction; only un-applied versions run on each boot | §5 Migration Runner |
| STORE-03 | Schema includes messages, tracked_threads, users, forgotten_users tables с FK + indexes | §3 SQL DDL — все 4 + schema_migrations |
| STORE-04 | Prepared statements cached per store as module-level constants (lazy-init); capture insert latency p95 <50ms in WAL mode | §4 Capture Handler Skeleton — module-level lazy-init pattern. better-sqlite3 single INSERT в WAL — десятки микросекунд, p95 <50ms тривиально удовлетворяется. |
| REL-04 | Capture handler body wrapped in try/catch — DB errors logged, do NOT crash long-polling loop | §4 — единый try/catch вокруг whole handler body + `bot.catch()` уже existed как safety net |
</phase_requirements>

## Project Constraints (from CLAUDE.md)

- **Стек**: Node.js 20+, Grammy, TypeScript, node-cron, pino — зафиксировано. Phase 4 добавляет ровно `better-sqlite3@^12.9.0` + `@types/better-sqlite3@^7.6.13` (dev).
- **Деплой**: VPS + Docker, long-polling (не webhooks). Capture handler = терминальный middleware в long-polling chain.
- **LLM**: абстракция `ai.service.ts` — НЕ затрагивается в Phase 4.
- **Типизация**: строгий TypeScript (`strict: true`, `noUncheckedIndexedAccess: true`), никаких `any`. Prepared statements типизировать через generic `db.prepare<Params, Result>()`.
- **Модульность**: каждая функция = модуль. `src/modules/capture/`, `src/services/db.service.ts`, `src/services/tracking.service.ts`, `src/stores/message-store.ts`, `src/stores/tracked-threads-store.ts`.
- **Тон бота**: «штурман → пилот» — сообщения от бота прямые, без восторгов. (В Phase 4 бот ничего не отправляет; tone не релевантен.)
- **GSD Workflow Enforcement**: file-changing работа должна идти через GSD команду — Phase 4 запускается через `/gsd-execute-phase`.

## Standard Stack

### Core (verified npm registry 2026-04-28)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `better-sqlite3` | `^12.9.0` (опубликован 2026-04-12) [VERIFIED: npm view] | Sync SQLite driver — prepared statements, transactions, native C binding | Sync API matches single-process bot; 2.8x-24x faster than `sqlite3`; ships prebuilt `linuxmusl-x64` for Node ABI 115 → no native compile on `node:20-alpine` happy path; active maintenance. Engines field `node: 20.x \|\| 22.x \|\| 23.x \|\| 24.x \|\| 25.x` confirms Node 20 LTS support. [CITED: STACK.md] |
| `@types/better-sqlite3` | `^7.6.13` (2025-08-03) [VERIFIED: npm view] | TypeScript types (dev) | Required by `strict` + no-`any`. Major-version mismatch (`^7` types / `^12` runtime) **intentional** — types track v12 API surface. Document this in plan PR. |

### Already in stack (no version change)

| Library | Version | Purpose |
|---------|---------|---------|
| `grammy` | `^1.42.0` [VERIFIED: package.json + npm view] | Telegram bot framework. `bot.on(['message','edited_message'])` array filter + `bot:text`/`bot:caption` filter queries — supported. [CITED: grammy.dev/guide/filter-queries] |
| `pino` | `^10.3.1` | Structured logging. Capture-handler reuses; добавляет debug-level metadata. |
| `dotenv` | `^17.4.2` | ENV loader. 5 new ENV vars + INITIAL_TRACKED_THREAD_IDS reuse existing `requireEnv`/`requireEnvInt`. |
| `node-cron` | `^4.2.1` | Scheduler. Phase 4 НЕ затрагивает (только подготавливает hooks для Phase 7). |

### Alternatives Considered (and rejected)

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `better-sqlite3` | `node:sqlite` (Node 22.5+ built-in) | Still experimental; loses prepared-statement perf optimisations. Revisit Node 22 LTS (Oct 2026+). [CITED: STACK.md alternatives] |
| `better-sqlite3` | `sqlite3` (async callback API) | Wrong fit для single-writer; 2.8x-24x slower. Never. |
| In-code migrations | `umzug` / `db-migrate` / `kysely` | Designed for Sequelize/Mongoose ecosystems; force async wrapping; overkill для 5 tables в lifetime. In-code = 30 LOC = the canonical better-sqlite3 pattern. [CITED: STACK.md] |
| Pure prepared statements | `drizzle-orm` | Closest reasonable ORM if scope grows past ~10 tables. For 5 tables — overkill. |
| Manual env validation | `zod` | Existing `requireEnv` / `requireEnvInt` (hardened by WR-03) sufficient. Don't add another loader. |
| Manual log redaction | `pino` redact paths | Optional (см. §10). Recommendation: manual metadata-only logging — единственный канал, видимый человеку, более прозрачен. |

**Installation:**

```bash
npm install better-sqlite3@^12.9.0
npm install -D @types/better-sqlite3@^7.6.13
```

**Version verification command (run during Phase 4-01):**

```bash
npm view better-sqlite3 version           # expect: 12.9.0 or higher
npm view @types/better-sqlite3 version    # expect: 7.6.13 or higher
node -e "const db=require('better-sqlite3')(':memory:'); console.log('OK')"
```

## Architecture Patterns

### Recommended Project Structure (Phase 4 deltas)

```
src/
├── modules/
│   ├── digest/                              [UNCHANGED]
│   └── capture/                             [NEW — Phase 4]
│       ├── capture.handler.ts               # registerCaptureHandlers(bot)
│       └── capture.mapper.ts                # pure mapTelegramMessageToCaptured(ctx)
├── services/
│   ├── ai.service.ts                        [UNCHANGED]
│   ├── rss.service.ts                       [UNCHANGED]
│   ├── db.service.ts                        [NEW] — initDb / getDb / closeDb + WAL + MIGRATIONS
│   └── tracking.service.ts                  [NEW — stub-level per D-01]
├── stores/                                  [NEW directory]
│   ├── message-store.ts                     # insertMessage / upsertEdited / isAuthorForgotten / selectByThreadWindow
│   └── tracked-threads-store.ts             # listTracked / insertTrackedThread (Phase 5 расширит)
├── utils/
│   ├── logger.ts                            [UNCHANGED]
│   ├── telegram.ts                          [UNCHANGED]
│   └── preflight.ts                         [NEW — getMe + getChatMember WARN log]
├── types/index.ts                           [EXTEND] — CapturedMessage, TrackedThread, ForgottenUser, BotConfig +5 fields
├── bot.ts                                   [EXTEND] — registerCaptureHandlers(bot) после bot.catch и команд
├── index.ts                                 [EXTEND] — initDb / loadTrackingWhitelist / closeDb
└── config.ts                                [EXTEND] — 5 ENV + INITIAL_TRACKED_THREAD_IDS

data/                                        [bind-mounted Docker volume]
└── messages.db                              [auto-created at first initDb()]
```

### Pattern 1: Module singleton via `getDb()`

**What:** `db.service.ts` exposes `getDb()` returning the same `Database` instance, initialised by `initDb()`. Stores import `getDb()` (not the instance directly) so module-load order doesn't matter.

**When to use:** All persistent module-singleton state in this project (compare existing `adminCache` Map в `bot.ts:24`).

```typescript
// src/services/db.service.ts (sketch)
import Database from 'better-sqlite3';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

let _db: Database.Database | null = null;

export function initDb(): void {
  if (_db) return;                              // idempotent
  _db = new Database(config.dbPath);
  _db.pragma('journal_mode = WAL');             // FIRST, OUTSIDE transaction
  const mode = _db.pragma('journal_mode', { simple: true });
  if (mode !== 'wal') {
    throw new Error(`WAL mode not active (got ${String(mode)}); check directory permissions`);
  }
  _db.pragma('foreign_keys = ON');
  _db.pragma('synchronous = NORMAL');
  _db.pragma('busy_timeout = 5000');
  runMigrations(_db);
  logger.info({ dbPath: config.dbPath, journalMode: mode }, 'Database initialised');
}

export function getDb(): Database.Database {
  if (!_db) throw new Error('initDb() must be called before getDb()');
  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.pragma('wal_checkpoint(TRUNCATE)');     // checkpoint before close
    _db.close();
    _db = null;
    logger.info('Database closed');
  }
}
```

### Pattern 2: Lazy-cached prepared statements per store

**What:** Module-level `let _stmt: Statement | null = null` lazily initialised on first call. Avoids re-preparing per message (hot path) и avoids module-load order coupling с `initDb()`.

```typescript
// src/stores/message-store.ts (sketch)
import type { Statement } from 'better-sqlite3';
import { getDb } from '../services/db.service.js';
import type { CapturedMessage } from '../types/index.js';

let _upsertStmt: Statement<CapturedMessage> | null = null;

function upsertStmt(): Statement<CapturedMessage> {
  _upsertStmt ??= getDb().prepare<CapturedMessage>(`
    INSERT INTO messages (
      chat_id, thread_id, tg_message_id,
      author_id, author_name, is_anonymous,
      text, reply_to_message_id, created_at, edited_at
    ) VALUES (
      @chatId, @threadId, @tgMessageId,
      @authorId, @authorName, @isAnonymous,
      @text, @replyToMessageId, @createdAt, @editedAt
    )
    ON CONFLICT(chat_id, tg_message_id) DO UPDATE SET
      text       = excluded.text,
      author_name = excluded.author_name,  -- (1) keep latest known display name
      edited_at  = excluded.edited_at
  `);
  return _upsertStmt;
}

export function upsertMessage(m: CapturedMessage): void {
  upsertStmt().run(m);
}
```

(1) Note: `author_name = excluded.author_name` preserves the value passed by caller. Capture-handler always sets `editedAt` only on edit branch, so a re-delivered original (long-poll dup) writes `editedAt = NULL` again — same value as before, no churn.

### Pattern 3: Single combined Grammy filter (Discretion #1, #15)

**Decision:** Use **single combined filter** with array of all four queries:

```typescript
bot.on(
  ['message:text', 'message:caption', 'edited_message:text', 'edited_message:caption'],
  captureHandler,
);
```

**Rationale (vs. alternative `bot.on(['message','edited_message'], handler)` + manual ifs):**

1. **Service messages auto-filtered.** Grammy filter query `:text` / `:caption` matches ONLY when that field is truthy. `forum_topic_created`, `pinned_message`, `new_chat_members` etc. have neither → handler never fires for them. Saves an early-return guard в каждом handler invocation. [CITED: grammy.dev/guide/filter-queries]
2. **No `:not(...)` chains needed** (Discretion #15) — Grammy doesn't document `:not()` (verified via WebFetch на grammy.dev/guide/filter-queries 2026-04-28). The combined positive filter is the idiom.
3. **Edit detection trivially.** Inside handler use `ctx.editedMessage !== undefined` — Grammy doc explicitly: «`ctx.editedMessage` — Returns only edited message objects». [CITED: grammy.dev/guide/context]
4. **Readability.** One handler, one filter array. No `if (ctx.update.edited_message)` branching needed at the top.

**Tradeoff vs split:** With split (4 separate `bot.on` calls), edit-vs-new is statically encoded in the filter — slightly more declarative. But: 4× duplicated handler bodies OR shared helper that re-introduces the branch. Net: combined wins.

**`ctx.msg` shortcut:** Grammy provides `ctx.msg` returning «whichever message type is present». [CITED: grammy.dev/guide/context]. Use this in handler — avoids `ctx.message ?? ctx.editedMessage`.

### Anti-Patterns to Avoid

- **Don't:** Wrap better-sqlite3 calls in `setImmediate` / `Promise.resolve` — sync API is by design (PITFALLS CODE-02). Hot-path single-row INSERT — micro-seconds; loop blocking is non-issue at club scale.
- **Don't:** Run migrations OUTSIDE transaction — partial schema state on failure (PITFALLS DB-04).
- **Don't:** Set `journal_mode = WAL` INSIDE a transaction — SQLite explicitly forbids (verified: «journal_mode cannot be changed while a transaction is active», sqlite.org/pragma.html#pragma_journal_mode).
- **Don't:** Use FK references к `users(author_id)` from `messages.author_id` — `users` is lazy-populated lookup (D-04 denormalises author_name); FK would force population order. Document author_id as «logical reference, not enforced».
- **Don't:** `INSERT OR IGNORE` for the upsert path — that drops edits silently (TG-01). Use explicit `ON CONFLICT(...) DO UPDATE`.
- **Don't:** Register capture handler BEFORE commands в `bot.ts` (CODE-01) — capture is terminal (no `next()`); командные filter middleware must match first. Order: `bot.catch` → commands → `registerCaptureHandlers(bot)` → fallthrough.
- **Don't:** Throw inside capture handler без top-level try/catch — single uncaught throw в Grammy middleware bubbles to `bot.catch()` (logged) but the spec demands defensive catch in handler body (REL-04).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Service-message filtering | Long if-chain `if (ctx.message.forum_topic_created \|\| ctx.message.pinned_message \|\| ...)` | Grammy filter query `message:text` / `message:caption` | Telegram has 30+ service-message field names (forum_topic_created, forum_topic_edited, forum_topic_closed, forum_topic_reopened, general_forum_topic_hidden/_unhidden, pinned_message, new_chat_members, left_chat_member, new_chat_title, new_chat_photo, delete_chat_photo, group_chat_created, supergroup_chat_created, channel_chat_created, message_auto_delete_timer_changed, migrate_to_chat_id, migrate_from_chat_id, video_chat_scheduled, video_chat_started, video_chat_ended, video_chat_participants_invited, web_app_data, write_access_allowed, users_shared, chat_shared, boost_added, chat_background_set, giveaway/_created/_winners/_completed, ...) [CITED: core.telegram.org/bots/api#message]. Maintaining list = certain rot. Filter query = single source of truth from Grammy. |
| Idempotent insert + upsert in one statement | App-level `SELECT then INSERT or UPDATE` (race-prone) | SQL `INSERT ... ON CONFLICT(...) DO UPDATE SET ...` (single statement, atomic at SQLite level) | SQLite UPSERT ON CONFLICT — atomic, single roundtrip; race-free. App-level select-then-write opens TG-02 hole (out-of-order edit). |
| Migration runner | Pull `umzug` (heavyweight, Sequelize-shaped, async) | In-code `MIGRATIONS` array + `db.transaction()` per version | 5 tables в lifetime; in-code = 30 LOC; canonical pattern для better-sqlite3 (no community-favoured wrapper exists; `better-sqlite3-migrations` npm package — verified empty result в STACK.md). |
| Atomic deletion + audit | Two separate operations | Single `db.transaction(() => { insertForgotten(); deleteByAuthor(); })()` | Phase 4 only ships forgotten_users **table** + capture-side guard; Phase 8 owns `/forget-me` itself. But schema must support it. |
| Anonymous-admin handling | Custom probe of `ctx.from.is_bot` etc | `if (ctx.message.sender_chat) author_id = null` | Telegram sets `sender_chat` ↔ message-as-chat (anon admin or channel auto-forward). Single canonical signal [CITED: core.telegram.org/bots/api#message]. |
| Whitelist hot lookup | DB SELECT every message | In-memory `Set<number>` mutated by `/track`/`/untrack` | Phase 5 owns mutation; Phase 4 stub creates Set + load from DB. O(1) lookup vs ~0.1ms SELECT (× 1000 messages/day = 100ms wasted per day, more importantly adds DB lock contention per message). |

**Key insight:** Almost every "tempting custom solution" в этой phase has a canonical answer that's already idiomatic in Grammy / SQLite / better-sqlite3. The plan-of-action: research the idiom, не «изобретать».

## Runtime State Inventory

> Phase 4 — это **greenfield для DB infrastructure** (нет существующего messages.db, нет existing tracked threads, нет existing forgotten_users). Эта секция применима только в той части, что Phase 4 МОДИФИЦИРУЕТ existing runtime state.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | `data/state.json` (existing v1.0) — НЕ затрагивается. Новый `data/messages.db` — auto-created at first `initDb()`. | None — `state.json` остаётся owned Phase 7. Phase 4 создаёт `messages.db` рядом. |
| Live service config | None — capture не затрагивает Telegram BotFather settings (privacy mode toggle = Phase 0-Ops manual gate). | None — Phase 0-Ops checklist обрабатывает. |
| OS-registered state | systemd / pm2 / Docker compose service `bot` — не меняется state-of-registration; меняется только image content. | Re-deploy через `docker compose up -d --build` — стандартный flow. |
| Secrets/env vars | 5 NEW + 1 OPTIONAL ENV (`THREAD_SUMMARY_THREAD_ID`, `THREAD_SUMMARY_CRON`, `MESSAGE_RETENTION_DAYS`, `RETENTION_SWEEP_CRON`, `DB_PATH`, `INITIAL_TRACKED_THREAD_IDS`). Existing `.env` файл prod не в git — operator должен добавить вручную. | Update `.env.example` AND prod `.env` файл. Document в Phase 0-Ops checklist. |
| Build artifacts | Existing `dist/` rebuilt by Dockerfile builder; no stale package state. `node_modules` rebuilt by `npm ci` — better-sqlite3 prebuild downloaded fresh. | None — standard rebuild. |

**Nothing found in category «Live service config»**: verified. Phase 0-Ops manual gate (privacy mode, admin re-promote, summary topic id) is documented as code-blocking-but-not-runtime, OWNED by Phase 0-Ops checklist artifact.

## 1. Implementation Approaches for Each Discretion Point

### 1.1 Grammy Filter Form (Discretion #1)

**Decision:** Single combined filter array.

```typescript
bot.on(
  ['message:text', 'message:caption', 'edited_message:text', 'edited_message:caption'],
  captureHandler,
);
```

**Rationale:** See Pattern 3 above. Service messages auto-filtered. Single handler. Use `ctx.msg` для actual message; `ctx.editedMessage !== undefined` для edit detection.

### 1.2 SQL DDL (Discretion #2) — see §3 below.

### 1.3 Pino-redact vs Manual Metadata-Only Logging (Discretion #3)

**Decision:** **Manual metadata-only logging** (no pino-redact).

**Rationale:**
- Capture-handler logs explicit object: `{chat_id, thread_id, author_id, message_length, is_edit, has_media}` — text body NEVER passed in. No redact path needed because PII is never logged.
- Pino-redact adds runtime overhead per log call (path-based scan + replacement) и opens reviewer trap: someone adds `text` field to log object thinking redact will catch it.
- «Если ты не хочешь, чтобы поле утекло — не клади его в log object» — простая инвариант, гарантируется code review.

```typescript
logger.debug({
  chat_id: m.chatId,
  thread_id: m.threadId,
  author_id: m.authorId,                  // null для anon (D-04)
  message_length: m.text.length,
  is_edit: m.editedAt !== null,
  has_media: ctx.message.photo || ctx.message.video || ctx.message.document || ctx.message.voice ? true : false,
}, 'Message captured');
```

PRIV-05 satisfied. ⚠ Plan checklist: explicit «log statement contains no `text` field» grep-check.

### 1.4 ENV Default for `INITIAL_TRACKED_THREAD_IDS` (Discretion #4)

**Decision:** Empty string default (`''`), parser returns `[]`.

```typescript
function parseInitialTrackedThreadIds(raw: string): number[] {
  if (raw.trim() === '') return [];
  return raw.split(',').map(s => s.trim()).filter(Boolean).map(s => {
    const n = Number(s);
    if (!Number.isInteger(n)) {
      throw new Error(`INITIAL_TRACKED_THREAD_IDS contains non-integer: "${s}"`);
    }
    return n;
  });
}

// in config.ts:
initialTrackedThreadIds: parseInitialTrackedThreadIds(process.env['INITIAL_TRACKED_THREAD_IDS'] ?? ''),
```

**Rationale:** Empty string default is friendlier для dev — `.env.example` ships `INITIAL_TRACKED_THREAD_IDS=` (empty) commented as «set CSV here for first boot». Undefined default would mean `.env.example` омитит ENV, который operator может не заметить. Both approaches yield `[]`; empty-string variant is more discoverable.

### 1.5 better-sqlite3 v12 Pragma & Statement Idioms (Discretion #5)

**Decision (verified против sqlite.org PRAGMA docs + better-sqlite3 docs/api.md 2026-04-28):**

Pragma application order:
1. `journal_mode = WAL` — FIRST, ВНЕ транзакции. (SQLite docs: «journal_mode cannot be changed while a transaction is active.»)
2. **Verify WAL active**: `db.pragma('journal_mode', { simple: true }) === 'wal'` — throw on mismatch (PITFALLS DB-01: silent fallback to `delete` mode if WAL files можно создать).
3. `foreign_keys = ON` (per-connection default OFF; must enable explicitly).
4. `synchronous = NORMAL` (explicit even though it's WAL default — legibility for next reader).
5. `busy_timeout = 5000` (5s wait для PITFALLS DB-02 macOS-vs-Linux divergence; surfaces lock contention as bounded wait, not random fail).

Pragma syntax: `db.pragma('journal_mode = WAL')` (canonical form, verified против sqlite.org and better-sqlite3 README; both `' = '` and `'='` accepted, choose `' = '` для readability).

Prepared statement typing:

```typescript
import type { Statement } from 'better-sqlite3';

interface InsertParams {
  chatId: number;
  threadId: number;
  // ... etc
}

const stmt: Statement<InsertParams> = db.prepare<InsertParams>(`
  INSERT INTO messages (chat_id, thread_id, ...) VALUES (@chatId, @threadId, ...)
`);
```

`@types/better-sqlite3@7.6.13` exposes `Statement<TParams = unknown[], TResult = unknown>` generic. Use named-parameter form (`@paramName`) для idiomatic param binding.

Transactions:

```typescript
const apply = db.transaction((m: Migration) => {
  db.exec(m.sql);
  db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
    .run(m.version, new Date().toISOString());
});
apply(migration);    // invocation runs the transaction
```

`db.transaction(fn)` returns a function; *calling* the returned function wraps fn in `BEGIN` ... `COMMIT` (or `ROLLBACK` on throw). Verified [CITED: github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md].

### 1.6 Idempotent Upsert SQL (Discretion #6)

**Decision:**

```sql
INSERT INTO messages (
  chat_id, thread_id, tg_message_id,
  author_id, author_name, is_anonymous,
  text, reply_to_message_id, created_at, edited_at
) VALUES (
  @chatId, @threadId, @tgMessageId,
  @authorId, @authorName, @isAnonymous,
  @text, @replyToMessageId, @createdAt, @editedAt
)
ON CONFLICT(chat_id, tg_message_id) DO UPDATE SET
  text          = excluded.text,
  author_name   = excluded.author_name,
  edited_at     = excluded.edited_at;
```

**Rationale:**
- `chat_id`, `thread_id`, `tg_message_id` — never change for a row → not in update set.
- `text` may change (edit) → updated.
- `author_name` may change (user renamed) → updated; preserves «name at last seen» (denormalised; acceptable for summary attribution).
- `is_anonymous` — invariant per row identity (same tg_message_id == same sender_chat semantics) → not in update set.
- `reply_to_message_id` — invariant per row identity → not in update set.
- `created_at` — preserved on edit (only `edited_at` reflects edit time).
- `edited_at` — sourced from `ctx.editedMessage?.edit_date` (Telegram-supplied) or `null` for first-time inserts.
- `author_id` — NEVER updated; if was anon (NULL), stays NULL; if was user (number), stays number. Edit flow doesn't change attribution.

### 1.7 Out-of-Order Edit Handling (Discretion #7)

**Scenario:** Bot misses original message (network blip, restart mid-update), then receives `edited_message` для tg_message_id что не в DB.

**Decision:** ON CONFLICT path makes this trivial. INSERT (а не UPDATE) — first-time write. Mapper для edit-from-blank:

- `created_at` = `new Date(ctx.editedMessage.date * 1000).toISOString()` (best available — Telegram's `date` field on edit is original send time, не edit time).
- `edited_at` = `new Date(ctx.editedMessage.edit_date * 1000).toISOString()` (Telegram-supplied edit timestamp).
- All other fields normal.

Result: row populated with `created_at < edited_at`, indistinguishable from «came in normal order». For analytics purposes if needed in v2.1: add `originated_as_edit BOOLEAN` column в migration v2 — НЕ Phase 4 scope.

### 1.8 Anonymous-Admin Detection (Discretion #8)

**Decision:**

```typescript
// Inside capture.mapper.ts mapTelegramMessageToCaptured:
const senderChat = msg.sender_chat;
const fromUser = msg.from;

let authorId: number | null;
let authorName: string;
let isAnonymous: 0 | 1;

if (senderChat && senderChat.id === ctx.chat?.id) {
  // Anonymous admin: sender_chat = the group itself
  authorId = null;
  authorName = senderChat.title;
  isAnonymous = 1;
} else if (senderChat && senderChat.type === 'channel') {
  // Linked-channel auto-forward — already filtered earlier (§1.10), never reaches here.
  // But defensive guard:
  return null;  // skip
} else if (fromUser) {
  authorId = fromUser.id;
  authorName = formatDisplayName(fromUser);  // first_name + last_name + @username fallback
  isAnonymous = 0;
} else {
  // Pathological: no from, no usable sender_chat → drop and log WARN
  logger.warn({ tg_message_id: msg.message_id }, 'Message with no from and no recognised sender_chat — dropping');
  return null;
}
```

**Verified [CITED: core.telegram.org/bots/api#message]:** `sender_chat` is set when message is «sent on behalf of a chat»: «the supergroup itself for messages sent by its anonymous administrators or a linked channel for messages automatically forwarded». Two cases distinguishable by `sender_chat.id === ctx.chat.id` (anon admin in same group) vs `sender_chat.type === 'channel'` (linked channel forward).

### 1.9 Service Message Detection (Discretion #9)

**Decision:** **Don't enumerate service-message fields explicitly.** Grammy filter query `message:text`/`message:caption` already excludes them — service messages have neither `text` nor `caption` populated. Discretion #15 cleanup: no `:not(...)` chains needed.

Defensive secondary check (cheap, single comparison) inside handler:

```typescript
if (msg.is_topic_message !== true) {
  // Either: (a) General topic — message_thread_id absent → skip, or
  //         (b) reply-as-thread в non-forum group — irrelevant, skip
  return;
}
```

PITFALLS TG-03: `message_thread_id` populated в TWO contexts (forum topic, reply-chain). `is_topic_message: true` = forum-topic mode → safe. For General topic specifically: `is_topic_message` absent → caught by this guard.

### 1.10 Channel Posts and Automatic Forwards (Discretion #10)

**Decision:** Two-pronged guard в handler entry, after `is_topic_message` check:

```typescript
// 1. Linked-channel auto-forward (verified TG-05): channel post auto-mirrored
//    в supergroup carries is_automatic_forward: true and sender_chat.type === 'channel'.
if (msg.is_automatic_forward === true) {
  return;  // out of scope per CONTEXT.md D-08 + REQUIREMENTS MSG-05
}
if (msg.sender_chat?.type === 'channel') {
  return;  // belt-and-suspenders: same condition по PITFALLS TG-05
}

// 2. channel_post / edited_channel_post — Grammy filter `message:text` / `edited_message:text`
//    don't include channel-post update types. So bot.on filter alone NEVER fires for
//    channel_post — no explicit guard needed. Document this in plan PR.
```

[CITED: core.telegram.org/bots/api#message] confirms: `is_automatic_forward = "True, if the message is a channel post that was automatically forwarded to the connected discussion group"`; `sender_chat = "the supergroup itself for ... or a linked channel for messages automatically forwarded"`.

### 1.11 Migration Runner Boot Sequence (Discretion #11) — see §5 below.

### 1.12 Native Build on `node:20-alpine` (Discretion #12)

**Decision:**

- Builder stage: `RUN apk add --no-cache python3 make g++` BEFORE `npm ci` — fallback for prebuild miss.
- Production stage: also runs `npm ci --omit=dev` which re-invokes better-sqlite3's install script and fetches prebuild AGAIN. **Don't** add toolchain to production stage — if prebuild-install fails в production, the image is broken regardless; fix CI, не runtime.
- Alternative: `COPY --from=builder /app/node_modules ./node_modules` to avoid double prebuild download. STACK.md recommends sticking with two-`npm ci` (existing v1.0 pattern, no behaviour change). **Recommendation: keep two-`npm ci`** for minimum diff.

Verification (Phase 4 success criterion):

```bash
docker compose exec bot node -e "const db=require('better-sqlite3')('/tmp/x.db'); console.log(db.pragma('journal_mode=WAL'))"
# Expected: [ { journal_mode: 'wal' } ]
```

### 1.13 Volume Permissions (Discretion #13)

**Decision (Dockerfile production stage):**

```dockerfile
RUN addgroup -g 1001 -S botuser && \
    adduser -S botuser -u 1001 && \
    mkdir -p /app/data && \
    chown -R botuser:botuser /app/data
USER botuser
```

**Plus host-side step** (Phase 0-Ops checklist):

```bash
sudo mkdir -p ./data && sudo chown -R 1001:1001 ./data
```

**Rationale:** When bind-mount `./data:/app/data` exists on host, Docker does NOT apply image's chown — perms come from host. Image-side chown is belt; host-side chown is suspenders; both ship.

PITFALLS DB-01 nuance: WAL needs DIRECTORY write perm (creates `messages.db-wal` and `-shm` siblings dynamically). Not just file perm. Hence chown of dir, not file.

### 1.14 Preflight Checks (Discretion #14)

**Decision:** New file `src/utils/preflight.ts` — runs once at bot start, logs WARN на mismatch (не throws — continues running but flags operator).

```typescript
// src/utils/preflight.ts
import type { Bot } from 'grammy';
import { config } from '../config.js';
import { logger } from './logger.js';

export async function runPreflight(bot: Bot): Promise<void> {
  try {
    const me = await bot.api.getMe();
    if (me.can_read_all_group_messages !== true) {
      logger.warn(
        { botId: me.id, username: me.username, can_read_all_group_messages: me.can_read_all_group_messages },
        'PRIVACY MODE ON — bot will not see normal user messages. Disable in BotFather and re-promote.',
      );
    } else {
      logger.info({ botId: me.id, username: me.username }, 'Privacy mode OFF, bot will receive group messages');
    }

    const targetChatId = Number(config.targetChatId);
    if (!Number.isInteger(targetChatId)) {
      logger.warn({ targetChatId: config.targetChatId }, 'TARGET_CHAT_ID is not numeric — skipping admin status check');
      return;
    }
    const member = await bot.api.getChatMember(targetChatId, me.id);
    if (member.status !== 'administrator' && member.status !== 'creator') {
      logger.warn(
        { chatId: targetChatId, status: member.status },
        'Bot is NOT admin in target chat — capture may behave unexpectedly. Promote in chat settings.',
      );
    } else {
      logger.info({ chatId: targetChatId, status: member.status }, 'Bot is admin in target chat');
    }
  } catch (err: unknown) {
    logger.error({ err }, 'Preflight check failed (non-fatal)');
  }
}
```

Wired in `index.ts` via `bot.start({ onStart: () => { void runPreflight(bot); ... } })`. **Non-blocking** — runs after `bot.start()` returns to onStart callback.

### 1.15 Grammy `:not(...)` (Discretion #15)

**Decision:** Don't use. Verified via WebFetch на grammy.dev/guide/filter-queries 2026-04-28: `:not(...)` syntax not documented. Combined positive filter (§1.1) обходит надобность.

### 1.16 Validation Architecture / Nyquist (Discretion #16)

**SKIPPED.** `.planning/config.json` ставит `workflow.nyquist_validation: false`. Optional section, omitted.

### 1.17 Test Harness (Discretion #17)

**Decision:** **Brief — manual smoke tests + sqlite3 CLI inspection are primary.** No new test framework adopted in Phase 4.

**Rationale:**
- D-14 explicitly: «Verification Phase 4 — через sqlite3 CLI и временный debug-лог».
- Project ships zero existing tests (verified: `package.json` has no `test` script, no `vitest`/`jest` dependency, no `tests/` dir).
- Adopting a framework (vitest, node:test) is a separate concern; doing it inside Phase 4 inflates scope.
- Capture handler is straightforward; integration tests с реальным Telegram update fixture были бы valuable but require either (a) real bot token + group для E2E, OR (b) Grammy test API + ctx mocks — non-trivial.

**Optional future spike (NOT in Phase 4 scope):** Add `node:test` (built-in Node 20+) + smoke test для `mapTelegramMessageToCaptured()` pure function (no DB, no Grammy). Cost: ~30 LOC. Defer to Phase 5+ — Phase 5 adds whitelist mutation logic that benefits more from a test harness.

**Phase 4 verification commands** (placed в plan as explicit gate):

```bash
# 1. Native build OK
docker compose exec bot node -e "require('better-sqlite3')"

# 2. WAL active
docker compose exec bot sqlite3 /app/data/messages.db "PRAGMA journal_mode;"
# Expected: wal

# 3. All 4 tables + schema_migrations exist
docker compose exec bot sqlite3 /app/data/messages.db ".tables"
# Expected: messages tracked_threads users forgotten_users schema_migrations

# 4. Migration v1 applied
docker compose exec bot sqlite3 /app/data/messages.db "SELECT * FROM schema_migrations;"
# Expected: 1|2026-04-...

# 5. Idempotency on real send (E2E with privacy off)
# - Send text message в tracked thread from non-admin account
# - Verify exactly one row appears within 5s:
docker compose exec bot sqlite3 /app/data/messages.db "SELECT chat_id, thread_id, tg_message_id, LENGTH(text), created_at, edited_at FROM messages ORDER BY created_at DESC LIMIT 5;"
# - Edit the message; re-run query — same row, edited_at populated.

# 6. Forgotten guard
docker compose exec bot sqlite3 /app/data/messages.db "INSERT INTO forgotten_users(author_id, forgotten_at, deleted_count, requested_via) VALUES (123, '2026-04-28T12:00:00.000Z', 0, 'test');"
# - Now send message from user_id=123 — verify NO new row in messages.

# 7. Logs do NOT contain text body
docker compose logs bot | grep -E '"text"' || echo "No text field in logs — PRIV-05 OK"
```

## 2. Library Version Pins (verified 2026-04-28)

| Package | Recommended Pin | Latest on npm | Verified |
|---------|-----------------|---------------|----------|
| `better-sqlite3` | `^12.9.0` | 12.9.0 (2026-04-12) | ✓ `npm view better-sqlite3 version` |
| `@types/better-sqlite3` | `^7.6.13` | 7.6.13 (2025-08-03) | ✓ `npm view @types/better-sqlite3 version` |
| `grammy` (existing) | `^1.42.0` | 1.42.0 | ✓ `npm view grammy version` |

**STACK.md note carried forward:** `^12` runtime / `^7` types intentional mismatch — types track v12 API surface. Document в Phase 4 plan PR description to prevent a future "fix".

## 3. Concrete SQL DDL (Discretion #2)

Single `CREATE TABLE IF NOT EXISTS` block applied as migration v1 inside `db.transaction()`. Schema lives в `MIGRATIONS[0].sql` constant, NOT in а `.sql` file (D-07 in-code).

```sql
-- ──────────────────────────────────────────────────────────────────
-- migration v1 — Phase 4: messages capture infrastructure
-- ──────────────────────────────────────────────────────────────────

-- All 4 product tables + schema_migrations meta-table.
-- D-03: timestamps as TEXT NOT NULL ISO-8601 UTC (lex sort = chrono sort)
-- D-04: author_id NULLABLE for anon admins; is_anonymous explicit flag; author_name denormalised
-- D-05: only reply_to_message_id, no parent fetch
-- D-06: 4 product tables shipped together (Phase 8 only writes to forgotten_users, no schema change)

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT    NOT NULL                   -- ISO-8601 UTC
);

CREATE TABLE IF NOT EXISTS messages (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id             INTEGER NOT NULL,
  thread_id           INTEGER NOT NULL,         -- forum topic message_thread_id
  tg_message_id       INTEGER NOT NULL,
  author_id           INTEGER,                  -- NULL для anonymous admins (D-04)
  author_name         TEXT    NOT NULL,         -- denormalised display_name OR sender_chat.title
  is_anonymous        INTEGER NOT NULL DEFAULT 0,  -- 0/1; flag for anon admin (D-04)
  text                TEXT    NOT NULL,         -- D-09: text ?? caption, no [photo] prefix
  reply_to_message_id INTEGER,                  -- D-05: nullable, no FK enforced
  created_at          TEXT    NOT NULL,         -- D-03: ISO-8601 UTC; from ctx.message.date
  edited_at           TEXT                      -- NULL до первого edit; from ctx.editedMessage.edit_date
);

-- Idempotency key (MSG-04): same Telegram message → same row.
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_chat_tg ON messages (chat_id, tg_message_id);

-- Summarizer-window query (Phase 6): all messages in thread X over last 24h.
-- Composite supports: WHERE thread_id = ? AND created_at >= ? ORDER BY created_at.
CREATE INDEX IF NOT EXISTS idx_messages_thread_created ON messages (thread_id, created_at);

-- /forget-me (Phase 8) and forgotten-guard (Phase 4 D-12) want fast lookup by author.
CREATE INDEX IF NOT EXISTS idx_messages_author ON messages (author_id) WHERE author_id IS NOT NULL;

-- Retention sweep (Phase 8) wants cheap age-based DELETE.
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages (created_at);


CREATE TABLE IF NOT EXISTS users (
  -- Lazy-populated lookup; capture-handler may upsert on first sight.
  -- Phase 4 does NOT enforce population — messages.author_name is denormalised so
  -- summarizer doesn't need this table. Phase 5/6 may decide to populate; Phase 4
  -- ships the table only.
  author_id     INTEGER PRIMARY KEY,
  display_name  TEXT    NOT NULL,
  first_seen_at TEXT    NOT NULL,                -- ISO-8601 UTC
  last_seen_at  TEXT    NOT NULL                 -- ISO-8601 UTC
);


CREATE TABLE IF NOT EXISTS tracked_threads (
  -- Phase 5 owns mutation; Phase 4 stub-loads from ENV bootstrap (D-02).
  thread_id   INTEGER PRIMARY KEY,
  chat_id     INTEGER NOT NULL,
  added_by    INTEGER,                            -- NULL когда seeded из ENV bootstrap
  added_at    TEXT    NOT NULL                    -- ISO-8601 UTC
);


CREATE TABLE IF NOT EXISTS forgotten_users (
  -- Phase 4 ships table + capture-side guard (D-12 closes PRIV-02 here).
  -- Phase 8 owns /forget-me, which writes here ATOMICALLY w/ DELETE FROM messages.
  author_id      INTEGER PRIMARY KEY,
  forgotten_at   TEXT    NOT NULL,                -- ISO-8601 UTC
  deleted_count  INTEGER NOT NULL DEFAULT 0,      -- Phase 8 fills; Phase 4 default 0
  requested_via  TEXT    NOT NULL                 -- 'self' | 'admin' | 'bootstrap-test' (Phase 8 enum)
);
```

**Foreign-key rationale (NOT used):**

| Candidate FK | Why omitted |
|--------------|-------------|
| `messages.author_id REFERENCES users(author_id)` | `users` is lazy-populated lookup (D-04 denormalises author_name). FK would force capture order: must INSERT users row before messages row. Adds complexity, zero gain — schema documents that author_id is logical reference, not enforced. |
| `messages.thread_id REFERENCES tracked_threads(thread_id)` | Phase 8 retention sweep deletes old messages; Phase 5 `/untrack` should NOT cascade-delete messages (TRK-02 explicit: "existing captured rows are NOT deleted"). FK with ON DELETE CASCADE wrong; without cascade the ref doesn't help. Skip. |
| `messages.reply_to_message_id REFERENCES messages(tg_message_id)` | Parent may be in untracked thread or pre-capture history (TG-02 out-of-order edits). FK violates 50% of inserts. Skip. |
| `forgotten_users.author_id REFERENCES users(author_id)` | Same as messages — `users` is lazy lookup; FK forces ordering issue для test bootstrap. Skip. |

`PRAGMA foreign_keys = ON` is still set — it disciplines any FK we DO add later (e.g., a v2 migration introducing a strict reference). For now, no FKs in v1.

## 4. Capture Handler Skeleton (Discretion #4)

```typescript
// src/modules/capture/capture.handler.ts
import type { Bot, Context } from 'grammy';
import { logger } from '../../utils/logger.js';
import { isThreadTracked } from '../../services/tracking.service.js';
import { upsertMessage, isAuthorForgotten } from '../../stores/message-store.js';
import { mapTelegramMessageToCaptured } from './capture.mapper.js';

export function registerCaptureHandlers(bot: Bot): void {
  // Single combined filter (§1.1):
  // - Excludes service messages (no text/caption)
  // - Excludes channel_post / edited_channel_post (different update type)
  // - Catches both new and edit, both text-only and caption-bearing
  bot.on(
    ['message:text', 'message:caption', 'edited_message:text', 'edited_message:caption'],
    captureHandler,
  );
}

async function captureHandler(ctx: Context): Promise<void> {
  // REL-04: full body wrapped in try/catch — DB errors, mapper errors,
  // schema mismatch — logged, never crash long-polling loop.
  try {
    const msg = ctx.msg;  // Grammy shortcut: returns ctx.message ?? ctx.editedMessage
    if (!msg) return;     // defensive (filter should guarantee, belt-and-suspenders)

    // Forum-topic guard (§1.9, PITFALLS TG-03)
    if (msg.is_topic_message !== true) return;

    // Channel-forward guard (§1.10, PITFALLS TG-05)
    if (msg.is_automatic_forward === true) return;
    if (msg.sender_chat?.type === 'channel') return;

    // Thread whitelist guard (D-01)
    const threadId = msg.message_thread_id;
    if (threadId === undefined || !isThreadTracked(threadId)) return;

    // Map Telegram update → CapturedMessage (§1.8 anon detection inside)
    const captured = mapTelegramMessageToCaptured(ctx);
    if (captured === null) return;  // mapper returned null = drop (no text and no caption)

    // Forgotten-user guard (D-12, closes PRIV-02 in Phase 4)
    if (captured.authorId !== null && isAuthorForgotten(captured.authorId)) {
      logger.debug({ author_id: captured.authorId }, 'Skipping message from forgotten user');
      return;
    }

    // Idempotent upsert (MSG-02, MSG-04)
    upsertMessage(captured);

    // Per-message debug log (D-13, PRIV-05 — metadata only, no text body)
    logger.debug({
      chat_id: captured.chatId,
      thread_id: captured.threadId,
      author_id: captured.authorId,
      message_length: captured.text.length,
      is_edit: captured.editedAt !== null,
      has_media: !!(msg.photo || msg.video || msg.document || msg.voice || msg.audio || msg.animation || msg.video_note || msg.sticker),
    }, 'Message captured');
  } catch (err: unknown) {
    // REL-04: error path. Log, don't rethrow — Grammy bot.catch() is safety net,
    // but explicit catch here means we control the log shape.
    logger.error({
      err,
      update_id: ctx.update.update_id,
      chat_id: ctx.chat?.id,
      tg_message_id: ctx.msg?.message_id,
    }, 'Capture handler failed');
  }
  // Note: handler is TERMINAL — no `next()` call. Capture is end of middleware chain
  // (CODE-01: registered AFTER commands в bot.ts).
}
```

```typescript
// src/modules/capture/capture.mapper.ts
import type { Context } from 'grammy';
import { logger } from '../../utils/logger.js';
import type { CapturedMessage } from '../../types/index.js';

export function mapTelegramMessageToCaptured(ctx: Context): CapturedMessage | null {
  const msg = ctx.msg;
  if (!msg) return null;

  // D-09: text or caption, no prefix. Filter already guaranteed one is present
  // but defensively re-check (mapper could be called from tests):
  const text = msg.text ?? msg.caption ?? '';
  if (text === '') return null;

  // D-04 + §1.8: author detection
  const senderChat = msg.sender_chat;
  const fromUser = msg.from;

  let authorId: number | null;
  let authorName: string;
  let isAnonymous: 0 | 1;

  if (senderChat && senderChat.id === ctx.chat?.id) {
    authorId = null;
    authorName = senderChat.title;
    isAnonymous = 1;
  } else if (senderChat && senderChat.type === 'channel') {
    return null;  // belt-and-suspenders; handler should already filter
  } else if (fromUser) {
    authorId = fromUser.id;
    authorName = formatDisplayName(fromUser);
    isAnonymous = 0;
  } else {
    logger.warn({ tg_message_id: msg.message_id }, 'Message with no recognised author — dropping');
    return null;
  }

  // D-03: ISO-8601 UTC. ctx.message.date — Unix seconds.
  const createdAt = new Date(msg.date * 1000).toISOString();
  const editedAt = ctx.editedMessage
    ? new Date(ctx.editedMessage.edit_date! * 1000).toISOString()
    : null;

  return {
    chatId: msg.chat.id,
    threadId: msg.message_thread_id!,        // guaranteed by handler guard
    tgMessageId: msg.message_id,
    authorId,
    authorName,
    isAnonymous,
    text,
    replyToMessageId: msg.reply_to_message?.message_id ?? null,
    createdAt,
    editedAt,
  };
}

function formatDisplayName(user: { first_name: string; last_name?: string; username?: string }): string {
  const fn = user.first_name;
  const ln = user.last_name ? ` ${user.last_name}` : '';
  const un = user.username ? ` @${user.username}` : '';
  return `${fn}${ln}${un}`.trim();
}
```

```typescript
// src/types/index.ts (additions)
export interface CapturedMessage {
  chatId: number;
  threadId: number;
  tgMessageId: number;
  authorId: number | null;          // NULL for anon admins (D-04)
  authorName: string;
  isAnonymous: 0 | 1;
  text: string;
  replyToMessageId: number | null;
  createdAt: string;                 // ISO-8601 UTC (D-03)
  editedAt: string | null;
}

export interface TrackedThread {
  threadId: number;
  chatId: number;
  addedBy: number | null;            // NULL when seeded from ENV bootstrap
  addedAt: string;
}

export interface ForgottenUser {
  authorId: number;
  forgottenAt: string;
  deletedCount: number;
  requestedVia: 'self' | 'admin' | 'bootstrap-test';
}

// BotConfig — extend existing interface:
export interface BotConfig {
  // ... existing fields ...
  threadSummaryThreadId: string;     // requireEnvInt
  threadSummaryCron: string;         // default '30 3 * * *'
  messageRetentionDays: number;      // default 90, min 7 enforced
  retentionSweepCron: string;        // default '0 1 * * *'
  dbPath: string;                    // default 'data/messages.db'
  initialTrackedThreadIds: number[]; // CSV-parsed, default []
}
```

## 5. Migration Runner (Discretion #11)

```typescript
// src/services/db.service.ts
import Database from 'better-sqlite3';
import type { Statement } from 'better-sqlite3';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

interface Migration {
  version: number;
  description: string;
  sql: string;
}

const MIGRATIONS: ReadonlyArray<Migration> = [
  {
    version: 1,
    description: 'Phase 4: messages capture infrastructure (4 tables + indexes)',
    sql: `
      -- ... full DDL from §3 ...
    `,
  },
  // future versions append here
];

let _db: Database.Database | null = null;

export function initDb(): void {
  if (_db) return;

  _db = new Database(config.dbPath);

  // ─── Pragma application order (§1.5, §5 boot sequence) ───
  // 1. journal_mode = WAL — FIRST, OUTSIDE transaction
  //    (sqlite.org: "journal_mode cannot be changed while a transaction is active")
  _db.pragma('journal_mode = WAL');

  // 2. Verify WAL active (PITFALLS DB-01: silent fallback to 'delete' if perms denied)
  const mode = _db.pragma('journal_mode', { simple: true });
  if (mode !== 'wal') {
    throw new Error(
      `WAL mode not active — got '${String(mode)}'. ` +
      `Check directory permissions on ${config.dbPath} parent ` +
      `(needs RWX for uid 1001 in Docker).`,
    );
  }

  // 3. Other pragmas (no ordering constraint between these per sqlite.org PRAGMA docs)
  _db.pragma('foreign_keys = ON');
  _db.pragma('synchronous = NORMAL');
  _db.pragma('busy_timeout = 5000');

  // 4. Migrations — bootstrap schema_migrations table first (uses CREATE TABLE IF NOT EXISTS,
  //    so safe on already-migrated DB).
  _db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      applied_at TEXT    NOT NULL
    );
  `);

  const appliedRows = _db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: number }>;
  const applied = new Set(appliedRows.map(r => r.version));

  // Each migration runs in its own transaction — partial-failure isolated to one version.
  const applyMigration = _db.transaction((m: Migration) => {
    _db!.exec(m.sql);
    _db!.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
      .run(m.version, new Date().toISOString());
  });

  let appliedCount = 0;
  for (const m of MIGRATIONS) {
    if (!applied.has(m.version)) {
      logger.info({ version: m.version, description: m.description }, 'Applying migration');
      applyMigration(m);
      appliedCount++;
    }
  }

  // 5. Seed `tracked_threads` from INITIAL_TRACKED_THREAD_IDS if table empty (D-02)
  const trackedCount = (_db.prepare('SELECT COUNT(*) AS c FROM tracked_threads').get() as { c: number }).c;
  if (trackedCount === 0 && config.initialTrackedThreadIds.length > 0) {
    const insertStmt = _db.prepare(`
      INSERT INTO tracked_threads (thread_id, chat_id, added_by, added_at)
      VALUES (?, ?, NULL, ?)
    `);
    const seedTxn = _db.transaction((ids: number[]) => {
      const now = new Date().toISOString();
      const chatId = Number(config.targetChatId);
      for (const id of ids) insertStmt.run(id, chatId, now);
    });
    seedTxn(config.initialTrackedThreadIds);
    logger.info(
      { count: config.initialTrackedThreadIds.length, ids: config.initialTrackedThreadIds },
      'Bootstrapped tracked_threads from INITIAL_TRACKED_THREAD_IDS',
    );
  }

  logger.info(
    { dbPath: config.dbPath, journalMode: mode, appliedMigrations: appliedCount },
    'Database initialised',
  );
}

export function getDb(): Database.Database {
  if (!_db) throw new Error('initDb() must be called before getDb()');
  return _db;
}

export function closeDb(): void {
  if (_db) {
    try {
      _db.pragma('wal_checkpoint(TRUNCATE)');  // checkpoint before close для clean shutdown
    } catch (err: unknown) {
      logger.warn({ err }, 'WAL checkpoint failed on close (non-fatal)');
    }
    _db.close();
    _db = null;
    logger.info('Database closed');
  }
}
```

**Boot sequence (verified):**

1. `new Database(path)` — opens file, creates if absent.
2. `pragma('journal_mode = WAL')` — outside any transaction (no transaction has been started yet).
3. Verify `pragma('journal_mode', {simple: true}) === 'wal'` — throw on mismatch (catches PITFALLS DB-01 silent fallback).
4. `pragma('foreign_keys = ON')`, `pragma('synchronous = NORMAL')`, `pragma('busy_timeout = 5000')` — no ordering constraint between them.
5. Bootstrap `schema_migrations` (CREATE TABLE IF NOT EXISTS — idempotent).
6. SELECT applied versions; for each MIGRATIONS entry not in applied set, run inside its own `db.transaction()`.
7. Bootstrap `tracked_threads` from ENV (D-02) if both table empty AND ENV non-empty.

## 6. Dockerfile + docker-compose Diff (Discretion #12, #13)

### Dockerfile (target shape)

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
# When bind-mount overlay arrives empty, container inherits these perms;
# when bind-mount has host perms, host-side `chown -R 1001:1001 ./data` covers it
# (documented in Phase 0-Ops checklist).
RUN addgroup -g 1001 -S botuser && \
    adduser -S botuser -u 1001 && \
    mkdir -p /app/data && \
    chown -R botuser:botuser /app/data
USER botuser

CMD ["node", "dist/index.js"]
```

### docker-compose.yml (target shape)

```yaml
services:
  bot:
    build: .
    env_file:
      - .env
    restart: unless-stopped
    # v2.0 SETUP-06: bind-mount ./data:/app/data so SQLite + state.json
    # survive `docker compose down`. Note: `down -v` does NOT affect bind mounts;
    # only `rm -rf ./data` deletes (PITFALLS DB-03).
    volumes:
      - ./data:/app/data
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
```

### .env.example (additions)

```env
# v2.0 thread summaries
THREAD_SUMMARY_THREAD_ID=
THREAD_SUMMARY_CRON=30 3 * * *
MESSAGE_RETENTION_DAYS=90
RETENTION_SWEEP_CRON=0 1 * * *
DB_PATH=data/messages.db
# CSV of message_thread_id values to seed tracked_threads on first boot only.
# After Phase 5 ships /track/untrack, this can be left blank.
INITIAL_TRACKED_THREAD_IDS=
```

### Host-side step (Phase 0-Ops checklist — documented in 04-OPS-CHECKLIST.md)

```bash
sudo mkdir -p ./data && sudo chown -R 1001:1001 ./data
```

## 7. Capture Handler Wiring

### `src/bot.ts` (changes — minimal)

```typescript
// existing imports ...
import { registerCaptureHandlers } from './modules/capture/capture.handler.js';

// existing: bot.catch() ... commands ...

// NEW: register capture LAST, after all commands.
// CODE-01 / PITFALLS Grammy middleware order: command filter middleware
// must match before bot.on('message:...') terminal handler.
registerCaptureHandlers(bot);
```

### `src/index.ts` (changes — three lines)

```typescript
// existing imports ...
import { initDb, closeDb } from './services/db.service.js';
import { loadTrackingWhitelist } from './services/tracking.service.js';
import { runPreflight } from './utils/preflight.js';

async function main(): Promise<void> {
  logger.info('Starting bot...');

  initDb();                           // NEW: sync, throws on WAL/perm failure
  loadTrackingWhitelist();            // NEW: sync, populates Set from DB

  startScheduler();

  void bot.start({
    onStart: () => {
      logger.info('Bot is running (long-polling mode)');
      void runPreflight(bot);          // NEW: non-blocking; logs WARN if privacy ON / not admin
    },
  }).catch(/* unchanged */);
}

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Shutdown signal received, stopping gracefully...');
  stopScheduler();
  await bot.stop();
  closeDb();                           // NEW: AFTER bot.stop() to allow in-flight handlers
  logger.info('Bot stopped. Goodbye.');
  process.exit(0);
}
```

### `src/services/tracking.service.ts` (Phase 4 stub)

```typescript
import { logger } from '../utils/logger.js';
import { listTracked } from '../stores/tracked-threads-store.js';

const trackedSet = new Set<number>();

export function loadTrackingWhitelist(): void {
  trackedSet.clear();
  for (const t of listTracked()) trackedSet.add(t.threadId);
  logger.info({ count: trackedSet.size, threadIds: [...trackedSet] }, 'Tracking whitelist loaded');
}

export function isThreadTracked(threadId: number): boolean {
  return trackedSet.has(threadId);
}

export function listTrackedThreadIds(): number[] {
  return [...trackedSet];
}

// Phase 5 will add track(), untrack() functions here. Phase 4 leaves this as read-only.
```

## 8. PITFALLS Cross-Check vs CONTEXT.md Decisions

Cross-checking D-01..D-14 against PITFALLS.md to surface any inconsistencies:

| Decision | Relevant Pitfalls | Conflict / Reinforcement |
|----------|-------------------|--------------------------|
| D-01/D-02 ENV-bootstrap whitelist | OPS-01 whitelist hot-reload race | NO conflict. ENV-seed runs *before* `bot.start()`; capture handler reads stable Set. Phase 5 owns hot-reload race. |
| D-03 ISO-8601 TEXT timestamps | None | Reinforces lex-sort = chrono-sort. Compatible with state.json `lastDigestDate` (already ISO). |
| D-04 author_id NULL + is_anonymous | TG-04 anonymous admins | REINFORCES. Mapper §1.8 implements exactly this pattern. |
| D-05 only reply_to_message_id | TG-04 anon (no PII leak via parent) | REINFORCES. Phase 8 `/forget-me` cleaner — no parent excerpt to scrub. |
| D-06 all 4 tables in v1 | DB-04 migration discipline | REINFORCES. «NEVER edit a migration after shipped; add new one» — D-06 lays groundwork. |
| D-07 in-code MIGRATIONS array | DB-04 | REINFORCES. STACK.md verified `better-sqlite3-migrations` package doesn't exist; in-code is canonical. |
| D-08 text+caption only (deviation MSG-03) | TG-07 service messages drop without text | REINFORCES. `message:text`/`message:caption` filter naturally drops service messages. **NEW NOTE:** REQUIREMENTS.md MSG-03 needs rewrite — planner adds explicit task. |
| D-09 text ?? caption no prefix | None directly | Architecturally clean; FEATURES.md note about media activity signal deferred. |
| D-10 filter at handler entry | TG-07 service messages | REINFORCES. Combined Grammy filter (§1.1) IS the handler-entry filter. |
| D-11 single plan 4-01 | None — process decision | ROADMAP estimated 3 plans; D-11 collapses. Acceptable trade-off solo-dev. Planner may subdivide if complexity warrants. |
| D-12 forgotten guard at capture | PRIV-01 forget-me race | REINFORCES. Phase 4 closes Phase 8's race ahead of time — defensive depth. |
| D-13 metadata-only debug log | PRIV-05, CODE-04 log volume | REINFORCES. Default `LOG_LEVEL=info` keeps debug-spam down. **§1.3 explicit decision: manual metadata logging, no pino-redact.** |
| D-14 OBS-01 в Phase 8 | OBS-01 mentioned PITFALLS — informational only | NO conflict. Phase 4 verification = manual sqlite3 CLI per D-14. |

**No conflicts found.** All 14 decisions either reinforce or are orthogonal to PITFALLS items.

**Two NEW pitfalls surfaced by this research (not in original PITFALLS.md):**

1. **PITFALL-NEW-01: better-sqlite3 prebuild fetched TWICE in Dockerfile two-`npm ci` pattern** — both builder and production stages run `npm ci` and re-invoke prebuild-install. Doubles network cost on cold builds. *Mitigation:* accept it (STACK.md tradeoff discussion); fix is `COPY --from=builder /app/node_modules ./node_modules` in production but adds Alpine ABI compat dependency. Document in plan PR.

2. **PITFALL-NEW-02: Telegram `ctx.editedMessage.edit_date` may be undefined?** Per Bot API, `edit_date` is required field on edited messages but Grammy types may mark optional. *Mitigation:* assert on mapper: `if (!ctx.editedMessage.edit_date) throw new Error('Edit message missing edit_date')` — if TG ever sends edit without edit_date, that's their bug; we want loud failure не silent wrong timestamps. Defensive check в mapper.

## 9. Open Questions / Unknowns (for Planner)

1. **Should Phase 4 populate `users` table?** D-04 explicit: «`users` (lazy-populated lookup)». Phase 4 ships the table. Question: does capture-handler upsert into `users` on first sight, OR is population deferred to Phase 5/6/7 actually-needs-it moment?
   - **Recommendation:** Phase 4 ships the table empty. Don't populate from capture path — adds extra SQL per message for zero current consumer. Phase 6 (summarizer) decides whether it wants `users.display_name` (override of denormalised `messages.author_name`) or trusts denorm value. Plan checklist: «`users` table empty after Phase 4 verification — populate-on-first-sight is Phase 5/6 decision».

2. **Where exactly to place the forgotten-user guard?** D-12 says «pre-INSERT prepared statement SELECT 1 FROM forgotten_users WHERE author_id = ?». Question: this is a *separate* statement before the upsert (2 SQL roundtrips per message), OR fold into the upsert WHERE clause as `INSERT ... WHERE NOT EXISTS (SELECT 1 FROM forgotten_users...)`?
   - **Recommendation:** Separate statement. Reasons: (a) for anon admins (`author_id = NULL`) the SELECT is skipped anyway (NULL never matches anything); (b) folding into INSERT makes ON CONFLICT path more complex (need to check forgotten in DO UPDATE branch too); (c) two prepared statements at p95 <50ms is well under MSG-01's <2s requirement.

3. **`users.last_seen_at` update strategy?** Schema includes it (D-04 implies it's «lazy-populated lookup»). If not populated by capture path (per Q1), this column is unused в Phase 4. Question: drop column from migration v1?
   - **Recommendation:** Keep. Schema lockdown D-06 ships «all 4 product tables sui-schema»; column exists for Phase 5/6 to populate without v2 migration. No semantic cost.

4. **REQUIREMENTS.md MSG-03 update wording.** D-08 explicitly: «REQUIREMENTS.md MSG-03 must be rewritten in this phase». Question: rewrite as «text + caption only — placeholder rows deferred to v3» (full deletion of placeholder concept) OR mark as «D-08 deviation; placeholder rows deferred» (more diff-friendly)?
   - **Recommendation:** Rewrite to «text + caption only — non-text without caption dropped». Cleaner historical record. Planner adds explicit «edit REQUIREMENTS.md MSG-03» as task.

5. **Planner subdivision risk (D-11).** D-11 says single plan 4-01 covering 17 reqs is the bias; planner may subdivide. Sub-question: which subdivisions are safe?
   - **Recommendation:** If planner subdivides, suggested split:
     - 4-01a: Infra (Dockerfile, compose, ENV, db.service.ts + migrations, package.json)
     - 4-01b: Stores + types (message-store, tracked-threads-store, types/index.ts extension)
     - 4-01c: Capture handler + tracking.service stub + bot.ts wiring + preflight + REQUIREMENTS.md MSG-03 update
   - But strong recommendation to keep single plan per D-11 — the cohesion bonus (one E2E-test gate) outweighs.

## Common Pitfalls (Phase 4-specific)

### Pitfall 1: WAL silent fallback to `delete` mode

**What goes wrong:** `pragma('journal_mode = WAL')` runs but SQLite can't create `messages.db-wal` / `messages.db-shm` siblings (directory perms, FS limits) → silent fallback to `delete` journal. WAL benefits lost; no error.
**Why it happens:** Permissions on directory (not just file). Bind-mount on host with wrong uid.
**How to avoid:** Verify after pragma: `pragma('journal_mode', {simple: true}) === 'wal'` → throw if not. Implemented in §5.
**Warning signs:** Multi-reader perf regressions; lock contention при concurrent /storage SELECT (Phase 8).

### Pitfall 2: Forgetting `is_topic_message` guard

**What goes wrong:** Reply-chain message in non-forum supergroup carries `message_thread_id` (= replied-to message's id). If that id collides с tracked thread id (unlikely but possible across chats), capture writes false positive.
**Why it happens:** Telegram dual-overload of `message_thread_id` — forum-topic and reply-chain semantics share the field.
**How to avoid:** First guard after filter: `if (msg.is_topic_message !== true) return`.
**Warning signs:** Rows in `messages` with `thread_id` not in `tracked_threads` — should be impossible if guard works.

### Pitfall 3: Migration partial-apply

**What goes wrong:** Migration SQL contains 5 statements; statement 3 fails (FK violation, syntax error). Without transaction wrapper, statements 1-2 stay applied, no `schema_migrations` row, retry hits «table exists». Bot loop.
**Why it happens:** Forgetting to wrap migration in `db.transaction()` (or running outside). FOREIGN_KEYS=ON exacerbates: a migration that ALTERs while FK has stale ref will fail mid-statement.
**How to avoid:** §5 wraps each migration in its own `db.transaction()` — partial failure rolls back; retry restarts from same version.
**Warning signs:** «table X already exists» on second boot after a failed first boot. CTAS uses `CREATE TABLE IF NOT EXISTS`, but ALTERs don't have such safety; transaction is the only generic fix.

### Pitfall 4: `bot.on(['message','edited_message'])` filter swallows commands

**What goes wrong:** Capture handler registered BEFORE commands в `bot.ts`. `/start` arrives, capture matches it (it's a `message:text`), terminates without `next()`. `/start` reply never fires.
**Why it happens:** Grammy middleware order. Discussed PITFALLS CODE-01.
**How to avoid:** Register capture handler LAST в `bot.ts` (after all commands). Verified in §7 wiring shape.
**Warning signs:** Commands silently stop working after Phase 4 deploy.

### Pitfall 5: Anonymous-admin row collisions across chats

**What goes wrong:** Bot in two groups; both have anonymous admins; both write `author_id = NULL, author_name = 'Group A title'` and `'Group B title'`. Summarizer (Phase 6) lumps them as «one anon user». Acceptable for v2.0 (single-group deploy) but worth flagging.
**Why it happens:** D-04 collapses anon to single NULL.
**How to avoid:** v2.0 deploys to single group; non-issue. If multi-group ever ships, add `is_anonymous` differentiation in summarizer transcript builder.
**Warning signs:** N/A in v2.0.

### Pitfall 6: better-sqlite3 prebuild ABI mismatch on `npm ci`

**What goes wrong:** Image cached from before Node version bump; prebuild downloaded for ABI 115 (Node 20) doesn't match runtime ABI 127 (Node 22). Segfault on first SQL.
**Why it happens:** prebuild-install matches by ABI; if image build & runtime drift, mismatch.
**How to avoid:** Pin `node:20-alpine` exactly (already done). Pin `better-sqlite3@^12.9.0` major-only (allows patch updates without ABI break per WiseLibs/better-sqlite3 release pattern).
**Warning signs:** `node` exits with code 139 (SIGSEGV) on first message; «out of memory» errors при `require('better-sqlite3')`.

### Pitfall 7: Edit `edit_date` undefined in Grammy types (NEW pitfall surfaced)

**What goes wrong:** Mapper does `new Date(ctx.editedMessage.edit_date * 1000).toISOString()` but Grammy/typescript types mark `edit_date` optional → either TS error or runtime `NaN.toISOString()` throw.
**Why it happens:** Bot API spec says `edit_date` is required on edited messages but Grammy types are conservative.
**How to avoid:** Mapper assertion: `if (!ctx.editedMessage.edit_date) throw new Error('edit_date missing on edited_message')` — defensive throw caught by handler-level try/catch (REL-04).
**Warning signs:** Capture handler logs «edit_date missing» — investigate Grammy version OR Telegram API change.

## Code Examples

### Idempotent upsert (Discretion #6)

```typescript
// Source: §4 message-store.ts
const stmt = db.prepare<CapturedMessage>(`
  INSERT INTO messages (chat_id, thread_id, tg_message_id, author_id, author_name, is_anonymous, text, reply_to_message_id, created_at, edited_at)
  VALUES (@chatId, @threadId, @tgMessageId, @authorId, @authorName, @isAnonymous, @text, @replyToMessageId, @createdAt, @editedAt)
  ON CONFLICT(chat_id, tg_message_id) DO UPDATE SET
    text        = excluded.text,
    author_name = excluded.author_name,
    edited_at   = excluded.edited_at
`);
stmt.run(captured);
```

### Pragma application order (Discretion #5)

```typescript
// Source: §5 db.service.ts initDb()
// Order: WAL first OUTSIDE txn → verify → other pragmas (any order) → migrations
db.pragma('journal_mode = WAL');
const mode = db.pragma('journal_mode', { simple: true });
if (mode !== 'wal') throw new Error(`WAL not active: ${String(mode)}`);
db.pragma('foreign_keys = ON');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 5000');
```

### Migration transaction (Discretion #11)

```typescript
// Source: §5 db.service.ts initDb()
const applyMigration = db.transaction((m: Migration) => {
  db.exec(m.sql);
  db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
    .run(m.version, new Date().toISOString());
});
for (const m of MIGRATIONS) {
  if (!applied.has(m.version)) applyMigration(m);
}
```

### Forgotten-user guard (Discretion #1, D-12)

```typescript
// Source: §4 capture.handler.ts captureHandler
let _forgottenStmt: Statement<[number]> | null = null;
function isAuthorForgotten(authorId: number): boolean {
  _forgottenStmt ??= getDb().prepare('SELECT 1 FROM forgotten_users WHERE author_id = ?');
  return _forgottenStmt.get(authorId) !== undefined;
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `bot.on('message', handler)` + manual edit branch | `bot.on(['message', 'edited_message'], handler)` array filter | Grammy 1.x stable | Single handler covers both update types; cleaner. |
| `bot.on('message', handler)` + service-message if-chain | `bot.on('message:text')` filter query | Grammy 1.x stable | Service messages auto-filtered by query; no maintenance debt for new TG service-message types. |
| `INSERT OR IGNORE` для idempotency | `INSERT ... ON CONFLICT(...) DO UPDATE SET ...` | SQLite 3.24.0 (2018) | UPSERT preserves edit semantics — IGNORE drops edits. Modern idiom. |
| Async `sqlite3` lib | Sync `better-sqlite3` v12 | better-sqlite3 1.0+ (2017+); v12 active maintenance 2026-04-12 | 2.8x-24x faster, simpler transactions, native prepared statements. Single-process bot — sync is correct fit. |
| Migration libraries (umzug, db-migrate) | In-code MIGRATIONS array + `db.transaction()` | better-sqlite3 community pattern | No framework needed; 30 LOC; canonical for the lib. |

**Deprecated/outdated:**

- `bot.on('message')` with manual `if (ctx.message.forum_topic_created || ...)` service-message guards — still works, but Grammy filter queries supersede. Don't write new code in this style.
- `INSERT OR REPLACE INTO messages` — drops `created_at` on edit (REPLACE = DELETE + INSERT). Use UPSERT ON CONFLICT instead.
- `pragma('journal_mode = WAL')` AFTER opening a transaction — silently fails per sqlite.org. Always before any txn.

## Assumptions Log

> Below — claims tagged `[ASSUMED]` in this research. The planner и discuss-phase use this section to flag what needs user confirmation before execution.

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | better-sqlite3 v12.9.0 prebuild для linuxmusl-x64 ABI 115 will be available при `npm ci` time on production VPS network | §1.12, §6 Dockerfile | Build falls back to `node-gyp rebuild` — toolchain present in builder, succeeds; production stage might fail if its `npm ci --omit=dev` can't fetch prebuild. Mitigation: `apk add` only in builder; if prod fails, switch to `COPY --from=builder /app/node_modules` — STACK.md verified pattern. **Tested — STACK.md confirms ABI 115 prebuild exists 2026-04-27.** [VERIFIED via STACK.md / GitHub release manifest] |
| A2 | Grammy v1.42 `bot.on(['message:text', 'message:caption', 'edited_message:text', 'edited_message:caption'], handler)` accepts 4-element array of filter queries | §1.1, §4 | Если Grammy не принимает array OF queries (только array of update-type names), нужно split на 4 separate `bot.on` calls. **Verified [CITED: grammy.dev/guide/filter-queries] доку «pass both of them to `bot.on()` in an array» — applies to filter queries also (queries are strings of same shape as update-type names).** Risk LOW. |
| A3 | `ctx.editedMessage.edit_date` reliably populated on edits | §4 mapper, Pitfall 7 | Bot API spec says required. Если undefined, defensive throw в mapper catches it — REL-04 try/catch isolates. Risk LOW (defensive code present). |
| A4 | `senderChat.id === ctx.chat.id` reliably distinguishes anon admin from linked-channel forward | §1.8 | Verified [CITED: core.telegram.org/bots/api#message]: «sender_chat — the supergroup itself for messages sent by its anonymous administrators or a linked channel for messages automatically forwarded». For anon admin in same group, sender_chat IS the chat; for channel forward, sender_chat is the source channel (different id). Distinguishable. Risk LOW. |
| A5 | Capture handler latency p95 <50ms in WAL mode (STORE-04 success criterion) | §1.5, Pitfall 6 | better-sqlite3 sync INSERT в WAL — typically 0.1-1ms on SSD; p95 <50ms with massive headroom. **Verified [CITED: github.com/WiseLibs/better-sqlite3/blob/master/docs/performance.md] WAL gives high throughput.** Risk LOW. |
| A6 | Phase 0-Ops manual gate (privacy off, admin re-promote) is completed before Phase 4 verification — but NOT before Phase 4 code lands | All §| If Phase 0-Ops not done at deploy time, Phase 4 code will run but `getMe().can_read_all_group_messages` will log WARN. Capture handler will fire only for commands. Verification step cannot pass. Plan should explicitly state «code can land before Phase 0-Ops; verification gates after». Risk LOW (procedural, not technical). [CITED: STATE.md, ROADMAP.md] |
| A7 | `INITIAL_TRACKED_THREAD_IDS` will be cleanable by Phase 5 ENV cleanup | D-02 | Phase 5 ships `/track`/`/untrack`. Once DB has any rows, ENV becomes no-op (D-02 explicit). ENV can be deleted после first successful Phase 5 deploy. Documented в .env.example comment. Risk LOW. |

**Bottom line:** Verifiable facts (versions, API behaviour, Telegram fields) all VERIFIED via Context7-equivalent webfetch против sqlite.org / core.telegram.org / grammy.dev / npm registry на 2026-04-28. The few ASSUMED items above are low-risk procedural or have defensive code.

## Sources

### Primary (HIGH confidence)

- npm registry — `npm view better-sqlite3 version` (12.9.0, 2026-04-12), `npm view @types/better-sqlite3 version` (7.6.13), `npm view grammy version` (1.42.0). Verified 2026-04-28.
- sqlite.org/pragma.html#pragma_journal_mode — verified WAL pragma ordering, transaction constraints («journal_mode cannot be changed while a transaction is active»), foreign_keys constraint («no-op within a transaction»).
- grammy.dev/guide/filter-queries — verified `bot.on(['message','edited_message'], handler)` array support, `message:text`/`message:caption` filter query forms, `:not()` not documented (excluded).
- grammy.dev/guide/context — verified `ctx.msg`, `ctx.message`, `ctx.editedMessage` semantics; «`ctx.editedMessage` — Returns only edited message objects».
- core.telegram.org/bots/api#message — verified service-message field enumeration (30+ fields), `is_automatic_forward`, `sender_chat` semantics.
- github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md — verified `Database#transaction()` returns function, `db.pragma('journal_mode', {simple: true})` returns first column of first row.
- github.com/WiseLibs/better-sqlite3/blob/master/docs/performance.md — verified WAL recommendation, `synchronous=NORMAL` is WAL default, `wal_checkpoint(RESTART)` for big-WAL handling.
- `.planning/research/STACK.md` (2026-04-27) — verified `better-sqlite3@12.9.0` linuxmusl-x64 ABI 115 prebuild availability, two-`npm ci` Dockerfile rationale, in-code migrations canonical pattern.
- `.planning/research/PITFALLS.md` (2026-04-27) — CRIT-01..06, TG-01..07, DB-01..04, CODE-01..03, PRIV-05, OPS-03/05 verified против actual codebase source files.
- `.planning/research/ARCHITECTURE.md` (2026-04-27) — startup sequence, module placement, repository pattern, capture handler placement, build order — все grounded in repo source.

### Secondary (MEDIUM confidence)

- WebFetch на grammy.dev/ref/types/message — limited information, fallback to grammy.dev/guide/context plus core.telegram.org для concrete field semantics.
- `.planning/research/SUMMARY.md`, `FEATURES.md` — secondary context для feature scope.

### Tertiary (LOW confidence — flagged для validation)

- None в этой research. All discretionary points have HIGH or MEDIUM source backing.

## Metadata

**Confidence breakdown:**

- Standard stack: **HIGH** — versions verified npm registry 2026-04-28; both packages confirmed actively maintained.
- SQL DDL: **HIGH** — D-03..D-07 from CONTEXT.md are explicit; SQL syntax verified against SQLite docs; index choices justified per query patterns (Phase 6 summarizer-window, Phase 8 retention/forget).
- Capture handler: **HIGH** — Grammy filter syntax verified [CITED: grammy.dev]; `ctx.msg`/`ctx.editedMessage` verified; service message + auto-forward semantics verified [CITED: core.telegram.org].
- Migration runner: **HIGH** — pragma order verified against sqlite.org PRAGMA docs; `db.transaction()` semantics verified against better-sqlite3 docs.
- Dockerfile diff: **HIGH** — STACK.md exhaustively verified ABI 115 prebuild availability; PITFALLS CRIT-03/04 confirmed actual codebase has no toolchain/no chown.
- Pitfalls: **HIGH** — all D-01..D-14 cross-checked against PITFALLS.md, no conflicts found; 2 NEW pitfalls (PITFALL-NEW-01/02) surfaced.
- Open questions: **HIGH** — questions are real planner-side decision points (e.g., users-table population strategy), not unknown-unknowns.

**Research date:** 2026-04-28
**Valid until:** 2026-05-28 (30 days — stable APIs, version pins recent, low-churn libraries)

## RESEARCH COMPLETE

**Phase:** 4 — Message Capture & Persistence
**Confidence:** HIGH

### Key Findings

1. **Grammy filter discretion (#1) resolved:** Single combined `bot.on(['message:text', 'message:caption', 'edited_message:text', 'edited_message:caption'], handler)` is the right idiom — auto-filters service messages, single handler, edit detection via `ctx.editedMessage !== undefined`. `:not(...)` syntax not documented в Grammy v1.42; combined positive filter is canonical.
2. **SQL DDL fully specified:** All 4 product tables + schema_migrations + 4 indexes (UNIQUE chat+tg_message_id для idempotency, composite thread+created_at для summarizer-window, partial author_id index для forget-me, plain created_at для retention sweep). NO foreign keys в v1 — justified per FK candidate-by-candidate; `PRAGMA foreign_keys = ON` still set для future migrations.
3. **Pragma order verified против sqlite.org:** `journal_mode = WAL` MUST come first AND outside transaction (sqlite.org explicit). Other pragmas (foreign_keys, synchronous, busy_timeout) — no ordering constraint between them. WAL must be VERIFIED active immediately after set (PITFALLS DB-01 silent fallback). Migrations run AFTER all pragmas, each in its own `db.transaction()`.
4. **2 NEW pitfalls surfaced** (not in original PITFALLS.md): (a) prebuild fetched twice in two-`npm ci` Dockerfile pattern (accept tradeoff per STACK.md); (b) `ctx.editedMessage.edit_date` may be marked optional in Grammy types — defensive throw in mapper.
5. **Library versions confirmed current:** `better-sqlite3@12.9.0` (2026-04-12), `@types/better-sqlite3@7.6.13` (2025-08-03), `grammy@1.42.0` — all verified against npm registry 2026-04-28.

### File Created

`/Users/vladilen/Documents/тнз/club-bot/.planning/phases/04-message-capture-persistence/04-RESEARCH.md`

### Confidence Assessment

| Area | Level | Reason |
|------|-------|--------|
| Standard Stack | HIGH | Versions verified npm registry 2026-04-28 |
| Architecture | HIGH | All decisions grounded in repo source + ARCHITECTURE.md |
| SQL DDL | HIGH | Schema choices justified per CONTEXT.md decisions D-03..D-07 + future query patterns |
| Capture Handler | HIGH | Grammy filter syntax verified [CITED: grammy.dev]; combined query pattern is idiomatic |
| Migration Runner | HIGH | Pragma order verified against sqlite.org; transaction wrapper canonical for better-sqlite3 |
| Dockerfile Diff | HIGH | builder + production layout verified against STACK.md (which itself verified ABI 115 prebuild against GitHub release manifest) |
| Pitfalls | HIGH | D-01..D-14 cross-checked, no conflicts; 2 new pitfalls surfaced and mitigated |

### Open Questions (5)

1. `users` table population strategy — Phase 4 ships empty? (Recommendation: yes, defer to consumer phase.)
2. Forgotten-user guard placement — separate SELECT or fold into INSERT WHERE NOT EXISTS? (Recommendation: separate SELECT.)
3. `users.last_seen_at` column unused в Phase 4 — keep or drop? (Recommendation: keep; schema lockdown D-06.)
4. REQUIREMENTS.md MSG-03 rewrite wording — full rewrite vs deviation note? (Recommendation: full rewrite.)
5. Plan subdivision (D-11 bias = single plan) — if planner subdivides, what's the safe split? (Recommendation: keep single; if forced split, suggested 4-01a infra / 4-01b stores+types / 4-01c handler+wiring.)

### Ready for Planning

Research complete. Planner has:
- ✅ User constraints from CONTEXT.md (locked in `<user_constraints>` block)
- ✅ Phase requirement IDs (17) mapped с research support (in `<phase_requirements>` block)
- ✅ Concrete SQL DDL (§3) — copy verbatim into MIGRATIONS[0].sql
- ✅ Capture handler skeleton (§4) — translate to plan tasks
- ✅ Migration runner shape (§5) — translate to plan tasks
- ✅ Dockerfile + compose diff (§6) — direct translation
- ✅ Wiring deltas (§7) — `bot.ts` + `index.ts` + `tracking.service.ts` stub
- ✅ PITFALLS confirmation (§8) — no conflicts with D-01..D-14
- ✅ Open questions surfaced (§9) — planner decisions before execution

Planner can now create `04-01-PLAN.md` (or subdivided variant) covering all 17 requirements + 1 REQUIREMENTS.md MSG-03 update task.
