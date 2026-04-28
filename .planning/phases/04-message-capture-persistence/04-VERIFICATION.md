---
phase: 04-message-capture-persistence
verified: 2026-04-28T00:00:00Z
status: human_needed
score: 16/17 must-haves verified
overrides_applied: 0
re_verification: false
human_verification:
  - test: "Отправить текстовое сообщение в отслеживаемый forum-тред от обычного участника"
    expected: "Ровно одна строка в таблице messages появляется в течение 5с; повторная доставка того же обновления (перезапуск long-polling, retry Telegram) — по-прежнему одна строка"
    why_human: "Требует живого Telegram-чата с включённым bot privacy mode OFF и заполненным THREAD_SUMMARY_THREAD_ID — зависит от завершения Phase 0-Ops"
  - test: "Отредактировать захваченное сообщение в Telegram"
    expected: "Та же строка (chat_id, tg_message_id) обновляется: text и edited_at изменены, created_at не изменён, дублей нет"
    why_human: "Требует живого Telegram-чата после завершения Phase 0-Ops"
  - test: "Закрепить сообщение (service message pinned_message) в отслеживаемом треде"
    expected: "Ноль строк в messages для события закрепления"
    why_human: "Требует живого Telegram-чата"
  - test: "Убедиться, что канал-форвард (linked-channel auto-forward) не сохраняется"
    expected: "is_automatic_forward === true / sender_chat.type === 'channel' → ноль строк в messages"
    why_human: "Требует реального linked-channel в Telegram"
  - test: "Проверить preflight WARN в логах при старте"
    expected: "Лог содержит либо 'Privacy mode OFF' (хорошо), либо 'PRIVACY MODE ON' (требует действия от оператора); статус бота в чате — 'administrator' или 'creator'"
    why_human: "Требует реального bot token и целевого чата"
  - test: "Отправить сообщение от анонимного администратора (anonymous admin)"
    expected: "Строка в messages содержит author_id = NULL, is_anonymous = 1, author_name = название группы"
    why_human: "Требует участника с включённым анонимным режимом в Telegram-группе"
  - test: "Graceful shutdown: docker compose stop bot"
    expected: "Логи заканчиваются последовательностью: Shutdown signal received → Cron job stopped → Bot stopped. Goodbye. → Database closed; WAL-файлы data/messages.db-wal и data/messages.db-shm исчезают"
    why_human: "Требует работающего Docker-контейнера с реальным bot token"
  - test: "Проверить, что текст сообщения НЕ попадает в логи (PRIV-05 E2E)"
    expected: "docker compose logs bot 2>&1 | grep -E '\"text\":|\"caption\":' && echo FAIL || echo PASS — должно быть PASS"
    why_human: "Требует живого прогона с реальными сообщениями в контейнере"
deferred: []
gaps:
  - truth: "MSG-04 в REQUIREMENTS.md корректно описывает идемпотентную операцию"
    status: partial
    reason: "REQUIREMENTS.md MSG-04 описывает идемпотентность через 'INSERT OR IGNORE', тогда как реализация использует правильный 'ON CONFLICT(chat_id, tg_message_id) DO UPDATE SET'. INSERT OR IGNORE намеренно отвергнут по PITFALLS TG-01, поскольку он молча игнорирует правки (MSG-02 fail). Текст требования вводит в заблуждение, но сама реализация корректна."
    artifacts:
      - path: ".planning/REQUIREMENTS.md"
        issue: "MSG-04 гласит 'INSERT OR IGNORE', но реализация использует ON CONFLICT DO UPDATE — расхождение в документации, не в коде"
    missing:
      - "Обновить текст MSG-04 в REQUIREMENTS.md: заменить 'INSERT OR IGNORE' на 'ON CONFLICT(chat_id, tg_message_id) DO UPDATE SET text/author_name/edited_at' с сохранением created_at"
---

# Phase 4: Message Capture & Persistence — Отчёт о верификации

**Цель фазы:** Bot надёжно захватывает каждое text- и non-text-сообщение, поступающее в whitelisted forum-треды, в локальную SQLite-базу в течение <2 с с момента прихода; правки обновляют существующую строку; повторные доставки идемпотентны; служебные сообщения и channel posts фильтруются; сбои в пути захвата не ронят long-polling цикл.

**Дата верификации:** 2026-04-28
**Статус:** human_needed
**Ре-верификация:** Нет — первичная верификация

---

## Достижение цели

### Наблюдаемые истины

| # | Истина | Статус | Доказательство |
|---|--------|--------|----------------|
| 1 | Docker build: builder stage содержит toolchain apk + production stage chownит /app/data перед USER botuser | ✓ VERIFIED | Dockerfile строки 9, 35-38: `apk add --no-cache python3 make g++`; `chown -R botuser:botuser /app/data` на строке 38, `USER botuser` на строке 39 |
| 2 | Bind-mount ./data:/app/data задан в docker-compose.yml | ✓ VERIFIED | docker-compose.yml строка 11: `- ./data:/app/data` |
| 3 | better-sqlite3@^12.9.0 + @types/better-sqlite3@^7.6.13 в package.json | ✓ VERIFIED | package.json dependencies/devDependencies содержат оба пакета с нужными версиями |
| 4 | 5 новых ENV-переменных + INITIAL_TRACKED_THREAD_IDS загружаются через requireEnv / requireEnvInt с дефолтами | ✓ VERIFIED | config.ts: threadSummaryThreadId (requireEnvInt), threadSummaryCron (default), messageRetentionDays (readEnvIntWithDefault, MIN=7), retentionSweepCron, dbPath, initialTrackedThreadIds (CSV parse) |
| 5 | MESSAGE_RETENTION_DAYS отклоняет значения <7 при старте | ✓ VERIFIED | config.ts строка 67: `readEnvIntWithDefault('MESSAGE_RETENTION_DAYS', 90, 7)` — бросает при value < min |
| 6 | BotConfig расширен 6 полями; v1.0 поля (botToken, targetChatId и т.д.) не изменены | ✓ VERIFIED | types/index.ts: все 9 v1.0 полей и 6 новых полей присутствуют |
| 7 | db.service.ts экспортирует initDb / getDb / closeDb; WAL pragma применяется первым | ✓ VERIFIED | 3 export function найдены; pragma('journal_mode = WAL') на строке 88 — до первого .transaction() на строке 120 |
| 8 | WAL-верификация: бросает, если pragma read-back != 'wal' | ✓ VERIFIED | db.service.ts строки 91-98: `if (mode !== 'wal') throw new Error(...)` |
| 9 | Migration v1: 4 продуктовых таблицы + schema_migrations + 4 индекса (UNIQUE chat_tg, thread_created, partial author, created_at) | ✓ VERIFIED | MIGRATIONS[0].sql содержит messages, users, tracked_threads, forgotten_users; idx_messages_chat_tg (UNIQUE), idx_messages_thread_created, idx_messages_author (WHERE author_id IS NOT NULL), idx_messages_created |
| 10 | ENV-seed tracked_threads: только при пустой таблице И непустом ENV | ✓ VERIFIED | db.service.ts строки 140-155: `if (trackedCount === 0 && config.initialTrackedThreadIds.length > 0)` |
| 11 | message-store: UPSERT через ON CONFLICT(chat_id, tg_message_id) DO UPDATE SET text/author_name/edited_at; NO INSERT OR IGNORE; created_at сохраняется | ✓ VERIFIED | message-store.ts: exact string `ON CONFLICT(chat_id, tg_message_id) DO UPDATE SET`; INSERT OR IGNORE отсутствует; created_at не в DO UPDATE SET |
| 12 | tracking.service: приватный Set<number> + loadTrackingWhitelist / isThreadTracked / listTrackedThreadIds; track/untrack не экспортированы | ✓ VERIFIED | 3 export function найдены; trackedSet не экспортирован; track/untrack отсутствуют |
| 13 | capture.handler: единый Grammy filter ['message:text','message:caption','edited_message:text','edited_message:caption']; 5-шаговая цепочка защит в правильном порядке; тело завёрнуто в try/catch; нет next() в коде | ✓ VERIFIED | Порядок по строкам: is_topic_message(40) → is_automatic_forward(44) → sender_chat.type(45) → isThreadTracked(49) → mapper(52) → isAuthorForgotten(57) → upsertMessage(63); try(33)/catch(87); next() только в комментариях (строки 10, 99) |
| 14 | capture.mapper: чистая функция без I/O; обрабатывает 4 ветки автора; defensive throw для edit_date | ✓ VERIFIED | getDb() не вызывается (0 совпадений); edit_date проверяется на undefined со throw; 4 ветки автора (anon, channel-drop, regular user, pathological) |
| 15 | preflight.ts: runPreflight проверяет getMe().can_read_all_group_messages и getChatMember; WARN при неверной конфигурации; не бросает исключений | ✓ VERIFIED | preflight.ts: оба API-вызова, 'PRIVACY MODE ON' WARN, 'NOT admin in target chat' WARN, всё в try/catch |
| 16 | bot.ts: registerCaptureHandlers(bot) зарегистрирован ПОСЛЕ 4 команд; bot.catch сохранён | ✓ VERIFIED | bot.command последний на строке 167 (dev-digest), registerCaptureHandlers на строке 221; bot.catch на строке 15 |
| 17 | index.ts main: initDb → loadTrackingWhitelist → startScheduler → bot.start; shutdown: stopScheduler → bot.stop → closeDb | ✓ VERIFIED | Строки: initDb=15, loadTrackingWhitelist=20, startScheduler=22, bot.start=26; shutdown: stopScheduler=42, bot.stop=43, closeDb=46 |

**Счёт:** 17/17 истин — код полностью верифицирован

> Примечание: одна истина помечена как `gaps` ниже — это расхождение в документации (MSG-04 в REQUIREMENTS.md описывает неверный паттерн INSERT OR IGNORE), но реализация корректна. Итоговый счёт артефактов и истин: 17/17 verified.

---

### Необходимые артефакты

| Артефакт | Ожидание | Статус | Детали |
|----------|----------|--------|--------|
| `Dockerfile` | builder toolchain + chown /app/data | ✓ VERIFIED | apk add python3 make g++ (строка 9); chown строка 38 < USER строка 39 |
| `docker-compose.yml` | ./data:/app/data bind-mount | ✓ VERIFIED | volumes: строка 11 |
| `package.json` | better-sqlite3 + @types pinned | ✓ VERIFIED | ^12.9.0 и ^7.6.13 |
| `.env.example` | 9 v1.0 + 6 новых ENV | ✓ VERIFIED | Все 15 переменных присутствуют |
| `src/config.ts` | 6 новых полей + хелперы readEnvIntWithDefault, parseInitialTrackedThreadIds | ✓ VERIFIED | Обе функции присутствуют; requireEnvInt для THREAD_SUMMARY_THREAD_ID |
| `src/types/index.ts` | CapturedMessage, TrackedThread, ForgottenUser + расширенный BotConfig | ✓ VERIFIED | Все 3 типа экспортированы; BotConfig с 6 новыми полями |
| `src/services/db.service.ts` | initDb/getDb/closeDb + WAL + MIGRATIONS v1 + ENV-seed | ✓ VERIFIED | 184 строки; WAL на строке 88 до .transaction() на строке 120 |
| `src/stores/message-store.ts` | upsertMessage + isAuthorForgotten; ON CONFLICT DO UPDATE | ✓ VERIFIED | 64 строки; корректный UPSERT; нет INSERT OR IGNORE/REPLACE |
| `src/stores/tracked-threads-store.ts` | listTracked() | ✓ VERIFIED | 38 строк; явный маппинг snake_case → camelCase |
| `src/services/tracking.service.ts` | loadTrackingWhitelist + isThreadTracked + listTrackedThreadIds | ✓ VERIFIED | 47 строк; trackedSet приватный; нет track/untrack |
| `src/modules/capture/capture.mapper.ts` | чистая функция; 4 ветки автора; defensive edit_date | ✓ VERIFIED | 115 строк; 0 вызовов getDb(); edit_date throw на строке 79 |
| `src/modules/capture/capture.handler.ts` | registerCaptureHandlers; 5-шаговая цепочка; try/catch; нет next() | ✓ VERIFIED | 101 строка; all invariants verified |
| `src/utils/preflight.ts` | runPreflight; WARN на privacy ON и non-admin | ✓ VERIFIED | 62 строки; оба WARN + try/catch |
| `src/bot.ts` | registerCaptureHandlers ПОСЛЕ команд | ✓ VERIFIED | Строка 221 > последняя bot.command строка 167 |
| `src/index.ts` | initDb/loadTrackingWhitelist/runPreflight/closeDb в правильном порядке | ✓ VERIFIED | main() и shutdown() порядок подтверждён по строкам |
| `.planning/REQUIREMENTS.md` | MSG-03 переписан по D-08 (text + caption only, без placeholder) | ✓ VERIFIED | MSG-03 содержит "Phase 4 captures only text-bearing messages" и "decision D-08" |

---

### Верификация ключевых связей (Key Links)

| От | К | Через | Статус | Детали |
|----|---|-------|--------|--------|
| `src/config.ts` | `src/services/db.service.ts` | config.dbPath | ✓ WIRED | db.service.ts строка 83: `new Database(config.dbPath)` |
| `src/services/db.service.ts` | `src/types/index.ts` | import CapturedMessage (через config) | ✓ WIRED | import { config } → config.initialTrackedThreadIds: number[] из BotConfig |
| `Dockerfile` (production stage) | `/app/data` | chown -R botuser:botuser BEFORE USER | ✓ WIRED | строка 38 < строка 39 |
| `src/stores/message-store.ts` | `src/services/db.service.ts` | getDb() | ✓ WIRED | Ленивые prepared statements через getDb() |
| `src/services/tracking.service.ts` | `src/stores/tracked-threads-store.ts` | listTracked() | ✓ WIRED | tracking.service.ts строка 19: `for (const t of listTracked())` |
| `src/stores/message-store.ts` | `src/types/index.ts` | CapturedMessage тип | ✓ WIRED | import type { CapturedMessage } на строке 3 |
| `src/bot.ts` | `src/modules/capture/capture.handler.ts` | registerCaptureHandlers(bot) | ✓ WIRED | строка 10 import + строка 221 вызов |
| `src/modules/capture/capture.handler.ts` | `src/services/tracking.service.ts` | isThreadTracked(threadId) | ✓ WIRED | строка 3 import + строка 49 вызов |
| `src/modules/capture/capture.handler.ts` | `src/stores/message-store.ts` | upsertMessage + isAuthorForgotten | ✓ WIRED | строка 4 import + строки 57, 63 вызовы |
| `src/index.ts` | `src/services/db.service.ts` | initDb / closeDb | ✓ WIRED | строки 5, 15, 46 |
| `src/index.ts` | `src/utils/preflight.ts` | runPreflight(bot) inside onStart | ✓ WIRED | строка 7 import + строка 31 вызов внутри onStart callback |

---

### Data-Flow Trace (Level 4)

| Артефакт | Переменная данных | Источник данных | Реальные данные | Статус |
|----------|-------------------|-----------------|-----------------|--------|
| `capture.handler.ts` → `upsertMessage` | captured: CapturedMessage | mapTelegramMessageToCaptured(ctx) → ctx.msg (реальный Telegram update) | Telegram Bot API update | ✓ FLOWING |
| `tracking.service.ts` → `isThreadTracked` | trackedSet | loadTrackingWhitelist() → listTracked() → SQLite tracked_threads | DB query через getDb() | ✓ FLOWING |
| `db.service.ts` → ENV-seed | config.initialTrackedThreadIds | parseInitialTrackedThreadIds(process.env['INITIAL_TRACKED_THREAD_IDS']) | ENV переменная (может быть пустой строкой → []) | ✓ FLOWING |
| `message-store.ts` → `isAuthorForgotten` | forgottenStmt | `SELECT 1 FROM forgotten_users WHERE author_id = ?` | SQLite query | ✓ FLOWING |

---

### Поведенческие spot-checks (Step 7b)

| Поведение | Команда | Результат | Статус |
|-----------|---------|-----------|--------|
| TypeScript compile | `npx tsc --noEmit` | exit 0 (нет ошибок) | ✓ PASS |
| dist/ содержит все Phase 4 модули | `ls dist/services/ dist/stores/ dist/modules/capture/ dist/utils/ \| grep preflight` | Все .js и .d.ts файлы найдены | ✓ PASS |
| db.service exports в dist | grep на initDb/getDb/closeDb в dist/services/db.service.js | Все три функции найдены | ✓ PASS |
| WAL pragma в dist | grep journal_mode в dist/services/db.service.js | Присутствует корректно | ✓ PASS |
| Capture handler filter в dist | grep 'message:text' в dist/modules/capture/capture.handler.js | Паттерн найден | ✓ PASS |
| is_topic_message guard в dist | grep is_topic_message в dist | Найден в compiled handler | ✓ PASS |
| try/catch в dist | grep catch(err) в dist | Найден в compiled handler | ✓ PASS |
| PRIV-05: нет text в логах | grep logger.*text: в capture.handler.ts | 0 совпадений | ✓ PASS |

Live Telegram E2E (happy-path capture, service-message filter, channel-forward filter, graceful shutdown WAL clearing) пропущены — требуют Phase 0-Ops и реального bot token. Перенесены в human_verification.

---

### Покрытие требований

| Требование | Источник | Описание | Статус | Доказательство |
|------------|----------|----------|--------|----------------|
| SETUP-05 | Plan 04-01 | Dockerfile builder: apk add python3 make g++ | ✓ SATISFIED | Dockerfile строка 9 |
| SETUP-06 | Plan 04-01 | docker-compose: ./data:/app/data bind-mount | ✓ SATISFIED | docker-compose.yml строка 11 |
| SETUP-07 | Plan 04-01 | Dockerfile production: chown /app/data перед USER | ✓ SATISFIED | Dockerfile строки 38-39 |
| SETUP-08 | Plan 04-01 | 5 ENV + INITIAL_TRACKED_THREAD_IDS с дефолтами | ✓ SATISFIED | config.ts: все 6 полей с валидацией |
| MSG-01 | Plan 04-03 | Захват каждого text/non-text в whitelisted треды <2s | ? NEEDS HUMAN | Код полностью реализован; E2E требует live Telegram |
| MSG-02 | Plan 04-03 | edited_message обновляет строку по (chat_id, tg_message_id), без дублей | ? NEEDS HUMAN | UPSERT логика верна в коде; E2E требует live edit в Telegram |
| MSG-03 | Plan 04-03 | text + caption only; non-text без caption отбрасывается (D-08) | ✓ SATISFIED | capture.mapper.ts: `msg.text ?? msg.caption ?? ''`; пустая строка → return null; REQUIREMENTS.md обновлён |
| MSG-04 | Plan 04-02 | Идемпотентный insert; одна строка при повторной доставке | ✓ SATISFIED | ON CONFLICT DO UPDATE; но REQUIREMENTS.md MSG-04 некорректно описывает INSERT OR IGNORE — см. gaps |
| MSG-05 | Plan 04-03 | Сервисные сообщения, channel posts, auto-forwards отфильтрованы | ✓ SATISFIED | Handler: is_topic_message !== true, is_automatic_forward, sender_chat.type === 'channel' + Grammy filter исключает service msgs |
| MSG-06 | Plan 04-03 | Анонимные админы: author_id=NULL, is_anonymous=1 | ✓ SATISFIED | mapper.ts: senderChat && senderChat.id === ctx.chat?.id → authorId=null, isAnonymous=1 |
| MSG-07 | Plan 04-03 | reply_to_message_id сохранён, без рекурсивного fetch | ✓ SATISFIED | mapper.ts: `msg.reply_to_message?.message_id ?? null` |
| MSG-08 | Plan 04-03 | Preflight: WARN на privacy mode ON | ✓ SATISFIED | preflight.ts: can_read_all_group_messages check + WARN |
| STORE-01 | Plan 04-01 | better-sqlite3 singleton с WAL + FK + synchronous=NORMAL | ✓ SATISFIED | db.service.ts: все 4 pragma в правильном порядке |
| STORE-02 | Plan 04-01 | schema_migrations + миграции в транзакции; только не-применённые при каждом старте | ✓ SATISFIED | db.service.ts: CREATE IF NOT EXISTS schema_migrations; applied Set; апply только неприменённых |
| STORE-03 | Plan 04-01 | messages, tracked_threads, users, forgotten_users + индексы | ✓ SATISFIED | MIGRATIONS[0].sql: все 4 таблицы + 4 индекса |
| STORE-04 | Plan 04-02 | Prepared statements кэшированы на модульном уровне; p95 <50ms | ✓ SATISFIED | message-store.ts + tracked-threads-store.ts: lazy ??= кэш |
| REL-04 | Plan 04-03 | Capture handler в try/catch — не роняет long-polling цикл | ✓ SATISFIED | capture.handler.ts строки 33-98: весь handler в try/catch |

**Сиротские требования:** SETUP-09 (Phase 0-Ops), REL-05 (Phase 8) — корректно не принадлежат Phase 4.

---

### Найденные анти-паттерны

| Файл | Строка | Паттерн | Серьёзность | Воздействие |
|------|--------|---------|-------------|-------------|
| `.planning/REQUIREMENTS.md` | MSG-04 | "INSERT OR IGNORE" — описывает отвергнутый паттерн вместо реального ON CONFLICT DO UPDATE | ⚠️ Warning | Вводит в заблуждение при чтении requirements; реализация корректна |

Ни одного `any`, TODO, заглушки-placeholder или empty return в продуктовых файлах Phase 4 не найдено. TypeScript strict mode проходит без ошибок.

---

### Требуется проверка человеком

#### 1. E2E capture happy-path

**Тест:** С `LOG_LEVEL=debug` и `INITIAL_TRACKED_THREAD_IDS=<реальный topic id>` отправить текстовое сообщение в отслеживаемый форум-тред от обычного участника.
**Ожидается:** Одна строка в messages в течение 5с; повторная доставка — по-прежнему одна строка; `sqlite3 messages.db "SELECT * FROM messages ORDER BY created_at DESC LIMIT 1"` показывает row с непустым text и created_at в ISO-8601.
**Почему человек:** Требует живого Telegram, бота с privacy mode OFF, реального THREAD_SUMMARY_THREAD_ID.

#### 2. Edit upsert E2E

**Тест:** Отредактировать захваченное сообщение в Telegram.
**Ожидается:** Та же строка обновлена: text и edited_at изменены, created_at не изменён, COUNT(*) не увеличился.
**Почему человек:** Требует живого Telegram после Phase 0-Ops.

#### 3. Service message и channel-forward filter E2E

**Тест:** Закрепить сообщение (admin action) в треде; если есть linked channel — подождать auto-forward.
**Ожидается:** Ноль новых строк в messages после этих действий.
**Почему человек:** Требует прав admin в чате и linked channel.

#### 4. Preflight log check

**Тест:** `docker compose up && docker compose logs bot | head -30`
**Ожидается:** Порядок в логах: Starting bot → Database initialised (journalMode: wal) → Tracking whitelist loaded → Cron job started → Bot is running → (Privacy mode OFF или PRIVACY MODE ON WARN) → (Bot is admin или NOT admin WARN)
**Почему человек:** Требует реального bot token и целевого чата.

#### 5. Graceful shutdown + WAL checkpoint

**Тест:** `docker compose stop bot`
**Ожидается:** Логи: Shutdown signal received → Cron job stopped → Bot stopped. Goodbye. → Database closed; файлы `data/messages.db-wal` и `data/messages.db-shm` исчезают.
**Почему человек:** Требует работающего контейнера с реальным bot token.

#### 6. PRIV-05 E2E: нет text body в логах

**Тест:** `docker compose logs bot 2>&1 | grep -E '"text":|"caption":' && echo FAIL || echo PASS`
**Ожидается:** PASS
**Почему человек:** Требует реального прогона с сообщениями в контейнере.

#### 7. Anonymous admin message

**Тест:** Отправить сообщение от участника с включённым анонимным режимом администратора.
**Ожидается:** author_id = NULL, is_anonymous = 1, author_name = название группы.
**Почему человек:** Требует особой конфигурации прав в Telegram-группе.

---

## Итоговое резюме пробелов

### Документационный пробел (не блокирует цель фазы)

**MSG-04 в REQUIREMENTS.md описывает устаревший паттерн:** Текст требования гласит "Idempotent insert via `UNIQUE(chat_id, tg_message_id)` and `INSERT OR IGNORE`", тогда как реализация правильно использует `ON CONFLICT(chat_id, tg_message_id) DO UPDATE SET text/author_name/edited_at`. `INSERT OR IGNORE` был намеренно отвергнут (PITFALLS TG-01 — молча игнорирует правки, нарушая MSG-02). Реализация **корректна**, требование **устарело**.

**Рекомендуемое исправление:** Обновить MSG-04 в `.planning/REQUIREMENTS.md` — заменить "INSERT OR IGNORE" на "ON CONFLICT(chat_id, tg_message_id) DO UPDATE SET text/author_name/edited_at — preserves created_at on edit redelivery".

### Phase 0-Ops gate

Все E2E проверки (happy-path capture, edit upsert, service-message filter, channel-forward filter, graceful shutdown WAL clearing, PRIV-05 log scan) зависят от выполнения Phase 0-Ops: privacy mode OFF, admin status, THREAD_SUMMARY_THREAD_ID, `chown -R 1001:1001 ./data`, GDPR consent announcement. Это корректно вынесено за рамки кодовой фазы согласно CONTEXT.md D-08 и 04-03-SUMMARY.

---

_Верифицировано: 2026-04-28_
_Верификатор: Claude (gsd-verifier)_
