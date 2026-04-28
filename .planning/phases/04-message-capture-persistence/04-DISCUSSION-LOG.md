# Phase 4: Message Capture & Persistence — Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in `04-CONTEXT.md` — this log preserves the alternatives considered.

**Date:** 2026-04-28
**Phase:** 04-message-capture-persistence
**Areas discussed:** Whitelist-bridge (4↔5), Schema + migrations, Non-text placeholders, Plan-разбивка + логирование

---

## Whitelist-bridge (Phase 4 ↔ Phase 5)

### Q1: Как Phase 4 capture-handler узнаёт какие thread_id ловить ДО Phase 5?

| Option | Description | Selected |
|--------|-------------|----------|
| Stub tracking.service с пустым Set + ENV-seed | Phase 4 уже создаёт services/tracking.service.ts и stores/tracked-threads-store.ts. loadTrackingWhitelist() читает DB; если DB пуста и есть ENV `INITIAL_TRACKED_THREAD_IDS` — сидит в DB один раз. ENV можно убрать после Phase 5. | ✓ |
| Hardcoded ENV CAPTURE_THREAD_IDS без stub-сервиса | Phase 4 читает ENV прямо в capture.handler. Phase 5 потом выносит в tracking.service. | |
| Capture-all + filter на read-стороне | Никакого whitelist в Phase 4 — ловим всё. GDPR-рискованно. | |

**User's choice:** «Такс, звучит так словно нам нужно просто забить в env и все. А что за база данных?» — confirmed via Q2 как stub в Phase 4. Combined: stub-service + ENV-seed.
**Notes:** User'у уточнили выбор БД (SQLite/better-sqlite3) — было неясно из контекста сессии.

### Q2: Где живёт tracking.service.ts и store при stub-варианте — Phase 4 или Phase 5?

| Option | Description | Selected |
|--------|-------------|----------|
| Phase 4 выносит stub | Phase 4 создаёт services/tracking.service.ts (Set + load + isThreadTracked) и stores/tracked-threads-store.ts. Phase 5 добавляет команды /track/untrack/tracked. Чистая handoff. | ✓ |
| Phase 4 оставляет inline-Set в capture.handler, Phase 5 выносит | Меньше кода в Phase 4, но Phase 5 будет править hot-path. | |

**User's choice:** Phase 4 выносит stub.

### Q3: ENV-seed логика — бежит один раз или при каждом boot?

| Option | Description | Selected |
|--------|-------------|----------|
| Только если DB пуста | Seed единоразово; tracked_threads = source of truth; /untrack работает корректно. | ✓ |
| Каждый boot reconcile (ENV → DB merge) | INSERT OR IGNORE при каждом запуске. Риск: untrack thread, забыли убрать ENV — restart возвращает. Нарушает GDPR-consent. | |

**User's choice:** Только если DB пуста.

### Q4: Куда положить MSG-08 preflight (`getMe().can_read_all_group_messages`)?

| Option | Description | Selected |
|--------|-------------|----------|
| Plan 4-03 (capture handler) | Preflight в src/utils/preflight.ts, вызывается ПОСЛЕ bot.start onStart. Логически рядом с capture-кодом. | ✓ |
| Plan 4-01 (infra/db) | Preflight = инфра-левель. | |

**User's choice:** Plan 4-03 (capture handler). [Note: позже консолидировано в один план — D-11 — preflight живёт в utils/preflight.ts всё равно.]

---

## Schema messages + migrations

### Q1: Хранение времени в messages (created_at, edited_at)?

| Option | Description | Selected |
|--------|-------------|----------|
| TEXT ISO-8601 UTC | `created_at TEXT` = `2026-04-28T11:23:45.000Z`. Лексикографическая сортировка = chronological. Совпадает с v1.0 state.json. Debuggable в sqlite3 CLI. | ✓ |
| INTEGER unix-epoch секунды | Дешевле хранение. Telegram `ctx.message.date` уже в этом формате. Плохая читаемость в CLI. | |

**User's choice:** TEXT ISO-8601 UTC.

### Q2: is_anonymous + author_name — отдельные колонки или сводим из NULL/JOIN с users?

| Option | Description | Selected |
|--------|-------------|----------|
| is_anonymous BOOL + author_name TEXT денормализованы | author_id NULL, is_anonymous explicit, author_name денорм. Summarizer без JOIN, имя-в-момент сохраняется при rename. | ✓ |
| Только author_id (NULL = anon), name через JOIN с users | messages строже. Минус: имя в-момент теряется; флаг anon неявный; жёсткая зависимость от users. | |

**User's choice:** is_anonymous BOOL + author_name TEXT денормализованы.

### Q3: Migrations — механизм и версионирование?

| Option | Description | Selected |
|--------|-------------|----------|
| In-code array, integer version, forward-only | Массив `{version, sql}` в db.service.ts. На boot SELECT MAX(version), выполнить новые в одной транзакции. Forward-only. | ✓ |
| SQL-файлы в migrations/ (001-init.sql, 002-add-X.sql) | Git diff чище для ревью. Перебор для Phase 4 с одной миграцией. | |

**User's choice:** In-code array, integer version, forward-only.

### Q4: Reply-context: что хранить о родительском сообщении?

| Option | Description | Selected |
|--------|-------------|----------|
| Только reply_to_message_id | По MSG-07: reply_to_message_id INTEGER NULL. Никакого parent fetch. | ✓ |
| + reply_to_author_id и reply_excerpt | Summarizer видит контекст без self-JOIN. Минусы: дубль PII, /forget-me не cleanup excerpt. | |

**User's choice:** Только reply_to_message_id.

---

## Non-text placeholders

### Q1: Какой объём типов покрываем в Phase 4?

| Option | Description | Selected |
|--------|-------------|----------|
| MSG-03 базовые 6 + animation + video_note + forward-marker | photo/voice/video/document/sticker/poll + GIF + кружочки + [forward] префикс. Остальное — каточ-олл. | |
| Только MSG-03 буквально (6 типов) | Строго photo/voice/video/document/sticker/poll. Остальное — fallback `[вложение]`. | |
| Полный каталог (10+ типов) | Всё из Bot API. Перебор для Phase 4. | |

**User's choice:** «только messages. важно текст сумаризировать, не другие типы сообщений» — *deviation от MSG-03 entirely*. Триггерило follow-up Q5 для уточнения.

### Q2: Caption (текст к photo/video/etc) — куда пишется?

| Option | Description | Selected |
|--------|-------------|----------|
| Конкатенация в text: `[photo] caption-text` | Одна колонка. Просто. | ✓ (но потом пересмотрено через Q5) |
| Отдельная колонка caption TEXT NULL | Разделение signal/payload. Требует COALESCE в summarizer. | |

**User's choice:** Конкатенация в text. *Уточнено в Q5: префикс [photo] убран — caption хранится как чистый текст.*

### Q3: Voice/video duration в placeholder?

| Option | Description | Selected |
|--------|-------------|----------|
| Да: `[voice 0:42]`, `[video 1:23]` | MSG-03 явно просит. | |
| Без duration: просто `[voice]`, `[video]` | Меньше кода, теряем сигнал. | |

**User's choice:** «игнорируем» — следствие сужения scope в Q1, voice/video не пишутся вовсе.

### Q4: Где форматируется placeholder — в capture.mapper или в message-store?

| Option | Description | Selected |
|--------|-------------|----------|
| capture.mapper.ts | Pure function, тестируема без DB и grammy. | ✓ |
| Внутри message-store.insertMessage(ctx) | Меньше файлов, но store связывается с grammy-типами. | |

**User's choice:** capture.mapper.ts.

### Q5 (clarification): Уточним сужение scope. Что попадает в messages?

| Option | Description | Selected |
|--------|-------------|----------|
| Только text + caption | text-сообщения и media с caption. text-колонка хранит text ИЛИ caption без префиксов. Чистые photo/voice/etc БЕЗ caption — drop. **Deviation от MSG-03 — REQUIREMENTS.md обновляется в Phase 4.** | ✓ |
| Только text (caption тоже мимо) | Полный строгий text-only. | |
| Вернуться к MSG-03 (плейсхолдеры) | Как в исходном требовании. | |

**User's choice:** Только text + caption.
**Notes:** Это сознательное сужение MSG-03. REQUIREMENTS.md обновляется как часть Phase 4 deliverable.

---

## Plan-разбивка + логирование

### Q1: Plan-разбивка Phase 4?

| Option | Description | Selected |
|--------|-------------|----------|
| 3 плана: 4-01 infra / 4-02 stores / 4-03 service+handler | Естественная декомпозиция (как в ROADMAP estimate). | |
| 4 плана: + отдельный 4-04 wiring/preflight | Гранулярнее, больше commit-шума. | |

**User's choice:** «Можно все в 1 шаг?» → один план. Отступление от ROADMAP-estimate (3 плана). Captured как D-11.
**Notes:** gsd-planner может субдивайдить если оценит риск, но bias к одному плану.

### Q2: forgotten_users таблица + capture-guard — в Phase 4 или отложить в Phase 8?

| Option | Description | Selected |
|--------|-------------|----------|
| Phase 4 создаёт таблицу + guard | Migration v1 включает forgotten_users. capture.handler делает SELECT 1 FROM forgotten_users перед INSERT. Phase 8 только добавляет /forget-me-команду. | ✓ |
| Phase 8 добавит retroactively | Phase 4 без таблицы. Phase 8 добавляет migration v2 + правку capture.handler. Риск регресса. | |

**User's choice:** Phase 4 создаёт таблицу + guard.

### Q3: Пер-message capture log — уровень в prod?

| Option | Description | Selected |
|--------|-------------|----------|
| DEBUG (off в prod) | Каждый capture: logger.debug({chat_id, thread_id, author_id, message_length, is_edit}). В prod LOG_LEVEL=info → выключено. | ✓ |
| INFO пер-message | Лог-ротация разменяется за недели (CODE-04 pitfall). | |

**User's choice:** DEBUG (off в prod).

### Q4: Hourly capture-rate aggregate (OBS-01) — seed уже в Phase 4?

| Option | Description | Selected |
|--------|-------------|----------|
| Оставить в Phase 8 | Phase 4 фокусируется на capture+persist; OBS-01 = observability layer. Verification через sqlite3 CLI. | ✓ |
| Seed в Phase 4-03 | Видно с первых суток. Минус: размывает phase boundary. | |

**User's choice:** Оставить в Phase 8.

---

## Claude's Discretion

- Точная Grammy-filter форма (single `bot.on(['message','edited_message'])` + ifs vs два отдельных filter-handler) — researcher выбирает на основе Grammy idiom + читаемости.
- Точный SQL DDL для каждой из 4 таблиц (типы, индексы, FK) — researcher формирует с учётом D-03..D-07.
- Pino-redact rules vs ручное метаданные-only логирование.
- ENV-default для INITIAL_TRACKED_THREAD_IDS (пустая строка vs undefined — config.ts оба конвертирует в []).

## Deferred Ideas

- Placeholder rows для non-text (исходный MSG-03 design)
- Voice/video duration
- Расширенный non-text catalog
- Reply context: reply_to_author_id + reply_excerpt
- Per-call costEstimateUsd в pino
- Migration state.json в SQLite pipeline_state
- OBS-01 hourly capture-rate aggregate (Phase 8)
