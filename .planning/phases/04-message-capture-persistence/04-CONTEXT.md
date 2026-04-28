# Phase 4: Message Capture & Persistence — Context

**Gathered:** 2026-04-28
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 4 ставит фундамент v2.0: бот переходит из publish-only в listen+publish режим. Захватывает каждое **text-bearing** сообщение (text + caption) из whitelisted forum-тредов клубной супергруппы в локальную SQLite-БД (`./data/messages.db`, WAL) внутри <2s от прихода. Идемпотентно по `(chat_id, tg_message_id)`, обрабатывает edits через upsert, фильтрует service messages / channel posts / automatic forwards / non-text без caption, не падает loop при ошибках. Закрывает 17 требований: SETUP-05/06/07/08, MSG-01..08, STORE-01..04, REL-04 — и проактивно создаёт `forgotten_users` инфраструктуру для PRIV-02.

**Что НЕ в этой фазе:** `/track`/`/untrack`/`/tracked` команды (Phase 5), summarizer (Phase 6), cron-orchestrator + delivery (Phase 7), `/summary`/`/forget-me`/retention sweep + OBS-01 hourly aggregate (Phase 8).

</domain>

<decisions>
## Implementation Decisions

### Whitelist Bridge (Phase 4 ↔ Phase 5)

- **D-01:** Phase 4 создаёт полный (хоть и stub-уровня) `services/tracking.service.ts` и `stores/tracked-threads-store.ts`. Сервис экспортирует `loadTrackingWhitelist()`, `isThreadTracked(threadId)`, `listTrackedThreadIds()`. Phase 5 лишь *добавит* `/track`/`/untrack`/`/tracked` команды + расширит store на write-side; никаких рефакторингов файлов из Phase 4.
- **D-02:** ENV-bootstrap: новый ENV-var `INITIAL_TRACKED_THREAD_IDS` (CSV из `message_thread_id`). При первом boot `loadTrackingWhitelist()` проверяет `tracked_threads` — если таблица пуста и ENV задан, INSERT-ит ID в DB единоразово, логирует INFO. На последующих boot DB не пуста → ENV игнорируется. После Phase 5 ENV можно убрать; `/untrack` будет работать корректно (DB = source of truth).

### Schema (`messages`, `users`, `tracked_threads`, `forgotten_users`, `schema_migrations`)

- **D-03:** Время хранится как `TEXT NOT NULL` в ISO-8601 UTC (`2026-04-28T11:23:45.000Z`). Источник: `new Date(ctx.message.date * 1000).toISOString()`. Лексикографическая сортировка совпадает с хронологической. Согласовано с v1.0 `state.json.lastDigestDate`.
- **D-04:** `messages.author_id INTEGER NULL`, `is_anonymous INTEGER NOT NULL DEFAULT 0` (явный флаг), `author_name TEXT NOT NULL` (денормализован в момент insert). Историческое имя сохраняется при последующем rename. Анонимные admin'ы (PITFALLS TG-04): `author_id = NULL`, `is_anonymous = 1`, `author_name = sender_chat.title`.
- **D-05:** Reply-context — только `reply_to_message_id INTEGER NULL`. Никакого parent fetch, никакого `reply_excerpt` (защищает /forget-me от утечки родительской PII через дубль).
- **D-06:** Phase 4 migration v1 ставит ВСЕ 4 продуктовые таблицы (+ `schema_migrations`) сразу: `messages`, `users` (lazy-populated lookup), `tracked_threads`, `forgotten_users`. Phase 8 не меняет schema, только пишет в `forgotten_users` через `/forget-me`.
- **D-07:** Migration механизм: in-code array `const MIGRATIONS: Array<{version: number, sql: string}> = [...]` в `db.service.ts`. На boot: `SELECT MAX(version) FROM schema_migrations`, выполнить все более новые в одной транзакции, INSERT version row. Forward-only — никаких rollback. Versions = integer (`1, 2, 3...`).

### Capture Scope — text + caption only (deviation from MSG-03)

- **D-08:** ⚠ **Deviation от MSG-03**: Phase 4 НЕ пишет placeholder rows для non-text. Захватываются только сообщения с `ctx.message.text` ИЛИ `ctx.message.caption`. Чистые photo/voice/video/document/sticker/poll/animation/video_note/audio/dice/location/contact БЕЗ caption — drop, ноль строк в DB. **REQUIREMENTS.md MSG-03 обновляется в составе Phase 4** (планер заведёт в чек-лист).
- **D-09:** `messages.text TEXT NOT NULL` хранит ИЛИ `ctx.message.text`, ИЛИ `ctx.message.caption` — без префиксов `[photo]`/`[video]`. Mapper выбирает: `text ?? caption`. Если оба пустые → row не пишется.
- **D-10:** Filter at handler entry: первая проверка после tracked/service/channel-post/auto-forward — наличие текста. Реализуется через Grammy filter `bot.on(['message:text', 'message:caption', 'edited_message:text', 'edited_message:caption'], handler)` (или через `if (!ctx.message.text && !ctx.message.caption) return` — researcher выберет точную форму).

### Plan Partitioning, Logging, GDPR-стартовый guard

- **D-11:** Phase 4 ships **одним планом** (`4-01`), покрывающим все 17 требований. Это отступление от ROADMAP-estimate в 3 плана — обосновано: solo-dev темп («штурман → пилот»), полный vertical slice до первого E2E-теста, минимальный handoff overhead. Если gsd-planner оценит риск/сложность как требующие split — может субдивайдить, но bias к одному плану.
- **D-12:** Capture handler делает pre-INSERT guard: prepared statement `SELECT 1 FROM forgotten_users WHERE author_id = ?`, если hit — short-circuit, никакого insert. PRIV-02 («close post-deletion replay window») закрывается ещё в Phase 4. Phase 8 `/forget-me` лишь пишет в forgotten_users + DELETE FROM messages в одной `db.transaction()`.
- **D-13:** Per-message capture log: `logger.debug({chat_id, thread_id, author_id, message_length, is_edit, has_media})`. В prod `LOG_LEVEL=info` — debug-логи выключены. ERROR на исключения capture-handler. PRIV-05 соблюдён (никакого `text` body в логи). Для verification — временно `LOG_LEVEL=debug`.
- **D-14:** OBS-01 hourly capture-rate aggregate **не в этой фазе**. Phase 8 owns observability layer. Verification Phase 4 — через sqlite3 CLI (`SELECT COUNT(*), MAX(created_at) FROM messages`) и временный debug-лог.

### Plan structure (single plan 4-01)

Single plan покрывает в естественном порядке:
1. **Infra**: Dockerfile builder stage `RUN apk add --no-cache python3 make g++` + production stage `RUN mkdir -p /app/data && chown -R botuser:botuser /app/data` ДО `USER botuser`. `docker-compose.yml` добавляет `volumes: - ./data:/app/data`. `.env.example` + `config.ts`: 5 ENV (`THREAD_SUMMARY_THREAD_ID`, `THREAD_SUMMARY_CRON`=`30 3 * * *`, `MESSAGE_RETENTION_DAYS`=90 (min=7), `RETENTION_SWEEP_CRON`=`0 1 * * *`, `DB_PATH`=`data/messages.db`) + `INITIAL_TRACKED_THREAD_IDS` (CSV).
2. **DB layer**: `services/db.service.ts` (initDb/getDb/closeDb + WAL/foreign_keys/synchronous=NORMAL/busy_timeout=5000 pragma + assert WAL active per PITFALLS DB-01 + in-code MIGRATIONS array v1 со всеми 4 таблицами + ENV-seed runner). `types/index.ts` расширяется: `CapturedMessage`, `TrackedThread`, `ForgottenUser`, `BotConfig` +5 fields.
3. **Stores**: `stores/message-store.ts` (`insertMessage`, `upsertEdited` через `INSERT ... ON CONFLICT DO UPDATE`, `selectByThreadWindow`, `deleteByAuthor`, `isAuthorForgotten`; prepared statements lazy module-level). `stores/tracked-threads-store.ts` (`listTracked`, `insertTrackedThread`).
4. **Service stub**: `services/tracking.service.ts` (private `Set<number>` + `loadTrackingWhitelist()` + ENV-seed логика + `isThreadTracked()`).
5. **Capture**: `modules/capture/capture.handler.ts` (`registerCaptureHandlers(bot)` → `bot.on(['message','edited_message'])` filter chain: tracked check → text/caption check → service/channel-post/auto-forward filter → forgotten guard → mapper → store; try/catch обернут весь body — REL-04). `modules/capture/capture.mapper.ts` (pure `mapTelegramMessageToCaptured(ctx) → CapturedMessage`, никаких side effects).
6. **Wiring**: `bot.ts` — `registerCaptureHandlers(bot)` ПОСЛЕ `bot.catch()` и команд (CODE-01). `index.ts` — `initDb(); loadTrackingWhitelist();` до `startScheduler()`; `closeDb()` в shutdown ПОСЛЕ `bot.stop()`.
7. **Preflight** (`utils/preflight.ts`): после `bot.start` onStart — `getMe()` → log WARN если `can_read_all_group_messages !== true` (MSG-08). `getChatMember(targetChatId, botId)` → log WARN если status !== `administrator`.
8. **REQUIREMENTS update**: MSG-03 переписать с «placeholder» на «text + caption only».

### Claude's Discretion

- Точная Grammy-filter форма (single `bot.on(['message','edited_message'])` + ifs vs два отдельных `bot.on('message:text', ...)` + `bot.on('message:caption', ...)` + `bot.on('edited_message:text/caption', ...)`) — researcher выберет на основе Grammy v1.42 idiom + читаемости.
- Точный SQL DDL для каждой из 4 таблиц (типы, индексы, FK) — формирует researcher с учётом D-03..D-07; обязательны UNIQUE INDEX `(chat_id, tg_message_id)` для idempotency и индексы по `thread_id, created_at` (для summarizer-window query Phase 6).
- Pino-redact rules vs ручное метаданные-only логирование — стилевой выбор; обе формы соблюдают PRIV-05.
- ENV-default для `INITIAL_TRACKED_THREAD_IDS` — пустая строка vs `undefined` (config.ts вернёт `[]` в обоих случаях).

### Folded Todos

Нет — `/gsd-tools todo match-phase 4` вернул 0 matches.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents (researcher, planner, executor) MUST read these before acting.**

### Project & Milestone
- `.planning/PROJECT.md` — Key Decisions table (long-polling, dual-LLM, MSK-day idempotency, options-object service signature, admin-cache 5-min TTL)
- `.planning/REQUIREMENTS.md` §SETUP-05..08, §MSG-01..08, §STORE-01..04, §REL-04, §PRIV-02 — целевые 17 требований Phase 4 + проактивный PRIV-02 guard
- `.planning/ROADMAP.md` §Phase 4 — Goal + Success Criteria + Depends-on Phase 0-Ops
- `.planning/STATE.md` — текущее положение, Phase 0-Ops blockers

### Research (`.planning/research/`)
- `SUMMARY.md` — build order, parallelism, top pitfalls digest
- `ARCHITECTURE.md` §1 (startup sequence), §3 (module placement), §4 (repository pattern + types), §5 (capture handler placement), §6 (whitelist hot-reload), §7 (state.json vs DB), §8 (build order), §10 (file-by-file cheatsheet) — точная форма integration
- `PITFALLS.md` CRIT-01..04 (privacy mode, admin status, volume perms, Alpine native build), TG-01..07 (Telegram listening gotchas), DB-01..04 (WAL perms, locking, volume semantics, migrations), CODE-01..03 (Grammy order, sync API, ESM path), PRIV-05, OPS-03/05 — конкретные failure modes + код-уровневые митигации
- `STACK.md`, `FEATURES.md` — secondary context

### Source-of-truth code (read for patterns to mirror, NOT to modify in this phase)
- `src/index.ts` — целевая правка: insert `initDb(); loadTrackingWhitelist();` перед `startScheduler()`, `closeDb()` после `bot.stop()`
- `src/bot.ts` — целевая правка: `registerCaptureHandlers(bot)` после `bot.catch()` и команд; reuse `isAdmin()` cache pattern для будущих Phase 5/8 команд
- `src/config.ts` — паттерн `requireEnv` / `requireEnvInt` (extend для 5 новых ENV + `INITIAL_TRACKED_THREAD_IDS`)
- `src/types/index.ts` — место для `CapturedMessage`, `TrackedThread`, `ForgottenUser`, `BotConfig` extension
- `src/modules/digest/digest.service.ts:51-76` — пример state.json read/write (НЕ копировать silent JSON-parse fallback — fixed в Phase 7); options-object pipeline pattern для будущего `runThreadSummaryPipeline`
- `src/scheduler/cron.ts` — НЕ трогать в Phase 4 (Phase 7-01 рефакторит в Map registry)

### External docs (researcher resolve через Context7 если нужны actual snippets)
- Grammy v1.42 — `bot.on(['message','edited_message'])` filter array, `bot.on('message:text')` / `'message:caption'` filter queries, middleware order, context properties
- better-sqlite3 v12+ — Database, prepare/run/get/all, transaction, pragma, WAL semantics
- Telegram Bot API 7+ — Message object (text/caption, photo, voice, document, ...), `is_topic_message`, `message_thread_id`, `is_automatic_forward`, `sender_chat`, `forum_topic_created`, `getMe.can_read_all_group_messages`, `getChatMember`
- node-cron v4 — НЕ трогаем в Phase 4 (контекст для Phase 7)

### Operational gate (Phase 0-Ops, blocks Phase 4 verification, NOT code)
- `.planning/phases/04-message-capture-persistence/04-OPS-CHECKLIST.md` (yet-to-be-created): privacy off, admin re-promote, summary topic id, volume chown 1001, GDPR consent announcement URL — без него production-side verification Phase 4 невозможна

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets (v1.0 → reuse in Phase 4)

- `src/utils/logger.ts` — pino, structured logs, level из ENV — capture-handler reuses, добавляет debug-level metadata
- `src/config.ts` — `requireEnv` / `requireEnvInt` fail-fast pattern с min/max валидацией — extend для 5 новых ENV (особенно `MESSAGE_RETENTION_DAYS` min=7) + `INITIAL_TRACKED_THREAD_IDS` (custom CSV parser, опциональный)
- `src/utils/telegram.ts` (`sendMessageWithRetry`) — НЕ нужен в Phase 4 (capture не отправляет), но архитектурный шаблон для будущего Phase 7
- `src/types/index.ts` — централизованные типы: добавляем CapturedMessage, TrackedThread, ForgottenUser, расширяем BotConfig
- `src/bot.ts:14-16` (bot.catch) — defensive isolation pattern для capture-handler errors (REL-04)
- `src/modules/digest/digest.service.ts:29` — ESM path resolution через `fileURLToPath(new URL(...))` — использовать только если `DB_PATH` относительный; absolute path proще

### Established Patterns (must follow)

- ESM (`type: module`) + `.js` extensions в импортах; ESM-CJS interop для better-sqlite3 — стандартный паттерн (`import Database from 'better-sqlite3'`)
- Strict TypeScript, `noUncheckedIndexedAccess`, никаких `any` — типизировать prepared statements через generic типы better-sqlite3
- Bot uid 1001 (`botuser`) в Dockerfile — НЕ менять; добавлять `chown -R botuser:botuser /app/data` ДО `USER botuser`
- options-object для service entry points (`runDigestPipeline(opts)`) — паттерн для будущего `runThreadSummaryPipeline` (Phase 7); Phase 4 пока не нуждается
- Module-singleton-by-import (как `adminCache` в bot.ts) — паттерн для `tracking.service` private Set

### Integration Points

- `src/index.ts` main()` — две новые строки `initDb(); loadTrackingWhitelist();` перед `startScheduler()`. Shutdown — `closeDb()` после `bot.stop()`
- `src/bot.ts` — `registerCaptureHandlers(bot)` ПОСЛЕ `bot.catch()` и всех команд (CODE-01: Grammy middleware order; capture не вызывает `next()`, чтобы не дёргать downstream)
- `src/config.ts` — 6 новых полей в config (5 prod + опциональный `initialTrackedThreadIds: number[]`)
- `Dockerfile` — builder stage инжект `apk add python3 make g++`; production stage инжект `mkdir + chown` ДО `USER`
- `docker-compose.yml` — добавить `volumes: - ./data:/app/data` к bot service
- `package.json` — `better-sqlite3@^12.x` (pin major; PITFALLS CRIT-04: native ABI breaks across minor) + `@types/better-sqlite3` (dev)

</code_context>

<specifics>
## Specific Ideas

- ENV-bootstrap (D-02) — изящное решение проблемы «нечем тестировать без Phase 5»: ENV-seed единоразовый, после Phase 5 деактивируется естественно. Никакой dual-source-of-truth.
- Caption-as-text без префикса (D-09) — keeps summarizer prompt чистым; никакого `[photo]` шума в transcript. Если в клубе важна сигналка «было N медиа» — добавим в Phase 6 через отдельный `media_count` параметр window-query (НЕ через placeholder rows).
- Migration-v1 со всеми 4 таблицами (D-06) — единая «schema лежит» точка; Phase 8 капитанит данные, не структуру.
- Один план вместо трёх (D-11) — solo-dev темп; в случае проблем гранулярно subdivide во время planning.

</specifics>

<deferred>
## Deferred Ideas

- **Placeholder rows для non-text сообщений** (исходный MSG-03 design) — отложено навсегда (или до v3). Если summarizer покажет нехватку сигнала «была активность без текста», вернёмся через `media_count` агрегат, не через дубль rows.
- **Voice/video duration в placeholder** — следствие D-08, deferred (никогда не нужны если non-text rows вообще не пишутся).
- **Расширенный non-text catalog (animation, video_note, dice, location, contact, forwards)** — следствие D-08.
- **Reply context: reply_to_author_id, reply_excerpt** — отвергнуто (D-05); GDPR-чище хранить только id.
- **Per-call `costEstimateUsd` в pino + rolling 7-day** — REQUIREMENTS Future v2.1.
- **Migration `lastDigestDate` / `lastThreadSummaryDate` из state.json в SQLite `pipeline_state` table** — REQUIREMENTS Future v2.1; Phase 7 сохраняет state.json + atomic-rename.
- **OBS-01 hourly capture-rate aggregate** — Phase 8 (зафиксировано D-14, не Phase 4).

### Reviewed Todos (not folded)

Нет — match-phase вернул 0.

</deferred>

---

*Phase: 04-message-capture-persistence*
*Context gathered: 2026-04-28*
