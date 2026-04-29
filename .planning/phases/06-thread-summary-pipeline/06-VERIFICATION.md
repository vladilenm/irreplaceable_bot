---
phase: 06-thread-summary-pipeline
verified: 2026-04-29T18:25:00Z
status: human_needed
score: 20/20 must-haves verified
overrides_applied: 0
re_verification: false
human_verification:
  - test: "Запустить бота на реальном боте и дождаться срабатывания cron 06:30 MSK"
    expected: "Один HTML-пост появляется в теме «🧵 Сводки тредов» (THREAD_SUMMARY_THREAD_ID); повторный запуск в тот же MSK-день — ноль новых постов (idempotency)"
    why_human: "Требует живого Telegram-бота с настроенным THREAD_SUMMARY_THREAD_ID, реальными данными в tracked_threads и DB-сообщениями за последние 24ч"
  - test: "Отправить 5+ сообщений в tracked-тред и вручную вызвать pipeline через /dev-summary (Phase 7) или напрямую через runThreadSummaryPipeline"
    expected: "Пост содержит корректный HTML: заголовок <b>🧵 Сводки тредов · DD.MM.YYYY</b>, секции тредов (headline + bullets + participants), footer «тихо: N тредов» если есть low-volume"
    why_human: "Требует Phase 0-Ops: бот с admin-правами, privacy mode OFF, GDPR-consent, реальные сообщения в базе"
  - test: "Проверить, что digest cron 06:00 MSK по-прежнему работает нормально (нет регрессии)"
    expected: "AI-радар публикуется в ai_radar_thread_id в 06:00 MSK; через 30 мин thread-summary публикуется в thread_summary_thread_id; конкурентных конфликтов нет"
    why_human: "Требует обоих cron-циклов на живом боте; гарантировать отсутствие state.json-конфликта между двумя записями невозможно без реального прогона"
---

# Phase 6: Thread Summary Pipeline — Отчёт о верификации

**Цель фазы:** End-to-end daily thread-summary feature — в 06:30 MSK каждый день единый консолидированный HTML-пост с охватом всех tracked-тредов с ≥5 сообщениями за последние 24h публикуется в тему «🧵 Сводки тредов»; мирно сосуществует с 06:00 MSK AI-радаром. Чистая `summarizeThread()` (low-volume skip, anonymisation, prompt-injection defences, Unicode display-name normalisation, dual-provider parity), рефакторинг cron-реестра, idempotency через `lastThreadSummaryDate`, разбивка overflow-постов на границах секций.

**Дата верификации:** 2026-04-29T18:25:00Z
**Статус:** human_needed
**Ре-верификация:** Нет — первичная верификация

---

## Достижение цели

### Наблюдаемые истины

| # | Истина | Статус | Доказательство |
|---|--------|--------|----------------|
| 1 | `summarizeThread()` с <5 сообщений возвращает `{skipped:true, reason:'low-volume'}` без вызова LLM | ✓ VERIFIED | `LOW_VOLUME_THRESHOLD = 5` на строке 54; проверка `messageCount < LOW_VOLUME_THRESHOLD` на строке 180; тест L1 (vi.mock spy утверждает `not.toHaveBeenCalled()`) |
| 2 | Numeric `author_id` отсутствует в outbound prompt — `buildTranscript` выводит только `[HH:MM] DisplayName: text` | ✓ VERIFIED | `summarizer.service.ts:85-90`: `const displayName = normalizeDisplayName(m.authorName)` + `time = m.createdAt.slice(11,16)` — `authorId` нигде в выводе; тест A1 (`not.toContain('12345')`) |
| 3 | Adversarial-инъекция, пробившая prompt-слои, отвергается Zod last-gate (`schema-invalid` skip) | ✓ VERIFIED | `ThreadSummarySchema.safeParse()` на строке 218; `reason: 'schema-invalid'` возвращается при fail; тест ADV-1 |
| 4 | Переключение `AI_MODEL` между Claude и OpenAI-compatible даёт одинаковый `ThreadSummary` discriminated-union shape | ✓ VERIFIED | `isClaude(config.aiModel)` на строке 204; оба пути через `ThreadSummarySchema.safeParse()`; тест ADV-1 покрывает обе ветки; `THREAD_SUMMARIZER_JSON_SCHEMA` используется в обоих dispatch-ах |
| 5 | `filterArticles` в `ai.service.ts` — byte-identical к v1.0; diff = 0 строк | ✓ VERIFIED | `git diff src/services/ai.service.ts` — 0 строк изменений |
| 6 | `normalizeDisplayName('Ма​ша‮')` возвращает `'Маша'` (NFC + strip zero-width + strip RTL override) | ✓ VERIFIED | `display-name.ts:11-14`: `normalize('NFC').replace(STRIP_RE, '')` + `STRIP_RE` покрывает U+200B-U+200F, U+202A-U+202E, \p{C}; тесты T1-T7 (7 из 7 проходят) |
| 7 | Token gate: transcript >15k токенов → `{skipped:true, reason:'transcript-too-large'}` без вызова LLM | ✓ VERIFIED | `TOKEN_LIMIT = 15000` на строке 55; `estimatedTokens > TOKEN_LIMIT` на строке 192; тест T1 |
| 8 | Migration v2: `tracked_threads.title TEXT` добавлена после boot | ✓ VERIFIED | `db.service.ts:68-72`: `version: 2`, `ALTER TABLE tracked_threads ADD COLUMN title TEXT` |
| 9 | `writeState` пишет атомарно через `writeFileSync(tmp) + renameSync(tmp, final)` | ✓ VERIFIED | `state.service.ts:75-76`: `writeFileSync(tmpPath, ...)` + `renameSync(tmpPath, finalPath)` |
| 10 | `readState` на corrupt JSON бросает исключение (не swallows) | ✓ VERIFIED | `state.service.ts:44-48`: `throw new Error('State file corrupted at ...')` в catch |
| 11 | `isThreadSummaryPublishedToday()` сравнивает MSK calendar day через `toLocaleDateString('en-CA', {timeZone: 'Europe/Moscow'})` | ✓ VERIFIED | `state.service.ts:81,85`: оба `todayMsk()` и `toMskDate()` используют именно этот паттерн |
| 12 | `selectMessagesInWindow` и `selectTopParticipants` присутствуют в `message-store.ts` | ✓ VERIFIED | `message-store.ts:132,162`: обе функции экспортированы с lazy-cached prepared statements |
| 13 | `cron.ts` использует `Map<string, ScheduledTask>`, регистрирует 3 job'а (digest, thread-summary, retention-sweep) | ✓ VERIFIED | `cron.ts:22`: `const tasks = new Map<string, ScheduledTask>()`; `cron.ts:114-116`: все 3 registerJob; тест C7: jobCount === 3 |
| 14 | `stopScheduler()` логирует `'Cron job stopped'` с именем для каждого job | ✓ VERIFIED | `cron.ts:129`: `logger.info({ name }, 'Cron job stopped')` в цикле по Map |
| 15 | Failed cron job не убивает остальные — per-job try/catch wrapper | ✓ VERIFIED | `cron.ts:42-47`: try/catch в `registerJob` вокруг `await handler()` |
| 16 | `threadSummaryHandler` — реальный, не stub; вызывает `runThreadSummaryPipeline` + `sendThreadSummary` | ✓ VERIFIED | `cron.ts:75-101`: реальный handler; `runThreadSummaryPipeline()` импортирован из `thread-summary.service.ts` |
| 17 | HTML-escape на всех динамических полях: title, headline, bullets, participant names, open questions | ✓ VERIFIED | `formatter.ts:35-36`: `escapeHtml()`; используется на строках 59, 62, 66, 72, 80; тесты F4 + F5 |
| 18 | Greedy section-boundary splitter для 4096-char chunk limit | ✓ VERIFIED | `formatter.ts:153-191`: greedy алгоритм разбивки на границах секций; тест F11 |
| 19 | Idempotency: `lastThreadSummaryDate` в `state.json`; повторный вызов в тот же MSK-день → `{alreadyPublished: true}` | ✓ VERIFIED | `service.ts:103-109`: `isThreadSummaryPublishedToday()`; merge-write на строке 168; тест O1 |
| 20 | `src/utils/telegram.ts` не изменён; `sendMessageWithRetry` переиспользуется для отправки chunk'ов | ✓ VERIFIED | `git diff src/utils/telegram.ts` = 0; `sender.ts:4,20-25`: `sendMessageWithRetry` импортируется и используется |

**Счёт:** 20/20 истин — весь автоматически проверяемый код полностью верифицирован

---

### Необходимые артефакты

| Артефакт | Ожидание | Статус | Детали |
|----------|----------|--------|--------|
| `src/services/summarizer.service.ts` | summarizeThread, ThreadSummarySchema, buildTranscript, ≥200 строк | ✓ VERIFIED | ~270 LOC; все 7 экспортов: summarizeThread, buildTranscript, ThreadSummarySchema, THREAD_SUMMARIZER_JSON_SCHEMA, LOW_VOLUME_THRESHOLD, TOKEN_LIMIT, CHARS_PER_TOKEN |
| `src/utils/display-name.ts` | normalizeDisplayName с NFC + strip RTL/zero-width | ✓ VERIFIED | 15 LOC; `normalize('NFC').replace(STRIP_RE, '').trim()`; STRIP_RE покрывает U+200B-U+202E + \p{C} |
| `prompts/thread-summarizer.md` | System prompt с sandwich-инструкциями | ✓ VERIFIED | Файл существует; `<<<TRANSCRIPT_START>>>` и `submit_summary` присутствуют в промпте |
| `src/types/index.ts` | ThreadSummary, LLMSummaryOutput, RunThreadSummaryOptions, ThreadSummaryResult, PipelineStateV2 | ✓ VERIFIED | Все 5 типов добавлены (строки 94-146); `lastThreadSummaryDate: string | null`; `TrackedThread.title: string | null` |
| `tests/fixtures/adversarial-transcript.txt` | Adversarial fixture с injection attempt, ≥5 сообщений | ✓ VERIFIED | 6 строк; содержит `IGNORE PREVIOUS INSTRUCTIONS` и `<<<TRANSCRIPT_END>>>` injection |
| `tests/fixtures/normal-transcript.txt` | Normal fixture ≥5 сообщений | ✓ VERIFIED | 6 строк; нормальный русский диалог |
| `src/services/state.service.ts` | readState/writeState/isDigestPublishedToday/isThreadSummaryPublishedToday, ≥80 строк | ✓ VERIFIED | 107 LOC; все 4 функции экспортированы |
| `src/scheduler/cron.ts` | Map<string, ScheduledTask>, 3 named jobs, per-job try/catch | ✓ VERIFIED | `Map<string, ScheduledTask>()` на строке 22; 3 registerJob; per-job try/catch в registerJob |
| `src/services/db.service.ts` | MIGRATIONS version 2 с ALTER TABLE | ✓ VERIFIED | `version: 2` на строке 68; SQL на строках 70-72 |
| `src/stores/tracked-threads-store.ts` | upsertThreadTitle + listTracked с title | ✓ VERIFIED | `upsertThreadTitle` строка 60; `listTracked` строка 44 с title в маппинге |
| `src/stores/message-store.ts` | selectMessagesInWindow + selectTopParticipants | ✓ VERIFIED | Оба экспортированы (строки 132, 162); COALESCE anon-grouping + correlated subquery |
| `src/modules/thread-summary/thread-summary.formatter.ts` | formatThreadSummaryPost, ≥100 строк | ✓ VERIFIED | ~193 LOC; sort by messageCount DESC, HTML escape, greedy splitter, footer |
| `src/modules/thread-summary/thread-summary.sender.ts` | sendThreadSummary; telegram.ts не изменён | ✓ VERIFIED | ~32 LOC; sendMessageWithRetry reused; telegram.ts diff = 0 |
| `src/modules/thread-summary/thread-summary.service.ts` | runThreadSummaryPipeline, ≥150 строк | ✓ VERIFIED | ~196 LOC; 7 шагов D-33; per-thread try/catch; merge-write state |

---

### Верификация ключевых связей (Key Links)

| От | К | Через | Статус | Детали |
|----|---|-------|--------|--------|
| `summarizer.service.ts` | `@anthropic-ai/sdk` + `openai` SDK | `isClaude(config.aiModel)` switch | ✓ WIRED | строка 204: `if (isClaude(config.aiModel)) { callAnthropic }; else { callOpenAICompatible }` |
| `summarizer.service.ts` | Zod schema | `ThreadSummarySchema.safeParse()` в try/catch | ✓ WIRED | строка 218: `ThreadSummarySchema.safeParse(llmOutput)` |
| `prompts/thread-summarizer.md` | `summarizer.service.ts` | `readFileSync(new URL('../../prompts/thread-summarizer.md', import.meta.url))` | ✓ WIRED | строка 17 сервиса |
| `cron.ts` | `digest.service.ts` | `registerJob('digest', ...)` с digestHandler | ✓ WIRED | строка 114: `registerJob('digest', config.digestCron, digestHandler)` |
| `cron.ts` | `thread-summary.service.ts` | `registerJob('thread-summary', ...)` → `runThreadSummaryPipeline` | ✓ WIRED | строка 115; handler (строка 77) вызывает реальную функцию |
| `cron.ts` | retention-sweep stub | `registerJob('retention-sweep', ...)` | ✓ WIRED | строка 116; stub handler логирует INFO — Phase 7 заменяет тело |
| `digest.service.ts` | `state.service.ts` | re-export readState/writeState/isDigestPublishedToday | ✓ WIRED | строка 28: `export { readState, writeState, isDigestPublishedToday } from '../../services/state.service.js'` |

---

### Data-Flow Trace (Level 4)

| Артефакт | Переменная данных | Источник | Реальные данные | Статус |
|----------|-------------------|----------|-----------------|--------|
| `thread-summary.service.ts` → `formatThreadSummaryPost` | `summaries: ThreadSummary[]` | `selectMessagesInWindow` (SQLite) → `summarizeThread` (LLM) | DB-запрос по `thread_id + created_at >= sinceIso` | ✓ FLOWING |
| `thread-summary.service.ts` → `titles Map` | `titles: Map<number, string>` | `refreshThreadTitle` → `getForumTopic` API + `upsertThreadTitle` DB-cache | Telegram API / DB cache / `Тред #N` fallback | ✓ FLOWING |
| `thread-summary.sender.ts` | `chunks: string[]` | `runThreadSummaryPipeline` → `formatThreadSummaryPost` | HTML из реальных summariseThread результатов | ✓ FLOWING |
| `state.service.ts` → `isThreadSummaryPublishedToday` | `state.lastThreadSummaryDate` | `readState()` → `data/state.json` (файловая система) | JSON-файл; atomic write через `renameSync` | ✓ FLOWING |

---

### Поведенческие spot-checks (Step 7b)

| Поведение | Команда | Результат | Статус |
|-----------|---------|-----------|--------|
| TypeScript compile | `npm run typecheck` | exit 0, 0 ошибок | ✓ PASS |
| Все тесты (73) | `npm test` | 73 passed (11 test files) | ✓ PASS |
| `ai.service.ts` не изменён (AI-07) | `git diff src/services/ai.service.ts \| wc -l` | 0 | ✓ PASS |
| `telegram.ts` не изменён | `git diff src/utils/telegram.ts \| wc -l` | 0 | ✓ PASS |
| Migration v2 присутствует | `grep -n "version: 2" src/services/db.service.ts` | строка 68 | ✓ PASS |
| Три job'а в cron | `grep "registerJob" src/scheduler/cron.ts` | digest, thread-summary, retention-sweep | ✓ PASS |
| Cron thread-summary — реальный handler | `grep "runThreadSummaryPipeline" src/scheduler/cron.ts` | строка 77 | ✓ PASS |
| Atomic write | `grep "renameSync" src/services/state.service.ts` | строка 76 | ✓ PASS |

---

### Покрытие требований

| Требование | Источник | Описание | Статус | Доказательство |
|------------|----------|----------|--------|----------------|
| SUM-01 | Plan 06-01 | ThreadSummary с headline/bullets/participants/openQuestions/skipped | ✓ SATISFIED | `types/index.ts:100-118`; полный discriminated union |
| SUM-02 | Plan 06-01 | <5 сообщений → low-volume skip без LLM | ✓ SATISFIED | `summarizer.service.ts:180-185`; тест L1 |
| SUM-03 | Plan 06-01 | author_id НИКОГДА в LLM-промпте | ✓ SATISFIED | `buildTranscript` строки 85-90; тест A1 |
| SUM-04 | Plan 06-01 | ≤15k токенов single-shot (char heuristic); больше — transcript-too-large skip | ✓ SATISFIED | `TOKEN_LIMIT = 15000`; строки 191-197; тест T1 |
| SUM-05 | Plan 06-01 | Layered prompt-injection: HTML-escape + sandwich + system-role isolation + Zod last-gate + reaffirm | ✓ SATISFIED | `escapeForTranscript()` строки 67-74; sandwich строки 58-59,93; `ThreadSummarySchema.safeParse` строка 218; тест ADV-1 + ADV-2 |
| SUM-06 | Plan 06-01 | Dual-provider parity: Claude и OpenAI-compatible дают одинаковый shape | ✓ SATISFIED | `isClaude()` dispatch строка 204; `THREAD_SUMMARIZER_JSON_SCHEMA` для обоих; Zod валидирует оба пути |
| SUM-07 | Plan 06-01 | Unicode normalisation: NFC + strip RTL/zero-width/control; применяется перед transcript и перед HTML-render | ✓ SATISFIED | `normalizeDisplayName` в `buildTranscript:85` и `formatter.ts:72`; тесты T1-T7 |
| AI-07 | Plan 06-01 | `filterArticles` в `ai.service.ts` не изменён | ✓ SATISFIED | `git diff src/services/ai.service.ts` = 0 строк |
| DLV-06 | Plan 06-03 | Cron 06:30 MSK запускает thread-summary pipeline; сосуществует с 06:00 MSK digest | ✓ SATISFIED | `cron.ts:115`: `registerJob('thread-summary', config.threadSummaryCron, ...)`; `config.ts:66`: default `'30 3 * * *'` |
| DLV-07 | Plan 06-03 | Единый консолидированный HTML-пост для всех tracked-тредов с ≥5 сообщениями | ✓ SATISFIED | `formatThreadSummaryPost()` объединяет все summaries; low-volume идут только в footer |
| DLV-08 | Plan 06-03 | Low-volume треды в footer «тихо: N тредов»; пустых body-секций нет | ✓ SATISFIED | `formatter.ts:87-101`: `formatFooter()`; только `skipped === false` секции уходят в body |
| DLV-09 | Plan 06-03 | >4096 chars — разбивка на границах секций; каждый chunk через `sendMessageWithRetry` | ✓ SATISFIED | `formatter.ts:153-191`: greedy splitter; `sender.ts:20-25`: `sendMessageWithRetry` |
| DLV-10 | Plan 06-03 | Idempotency: `lastThreadSummaryDate` отдельное поле; повторный вызов в тот же MSK-день → ONE post | ✓ SATISFIED | `state.service.ts:102-106`; `service.ts:103-109`; тест O1 |
| STATE-01 | Plan 06-02 | `writeState()` атомарна через `writeFileSync(tmp) + renameSync(tmp, final)` | ✓ SATISFIED | `state.service.ts:75-76` |
| STATE-02 | Plan 06-02 | `readState()` бросает на corrupt JSON; не swallows | ✓ SATISFIED | `state.service.ts:44-48`: два `throw new Error(...)` |
| SCHED-01 | Plan 06-02 | `cron.ts` рефакторен: `let task` → `Map<string, ScheduledTask>`; public API не изменён | ✓ SATISFIED | `cron.ts:22`: `const tasks = new Map<string, ScheduledTask>()`; `startScheduler/stopScheduler` сигнатуры без изменений |
| SCHED-02 | Plan 06-02 | `startScheduler()` регистрирует digest (06:00), thread-summary (06:30), retention-sweep (04:00) | ✓ SATISFIED | `cron.ts:114-116`: все три `registerJob` |
| SCHED-03 | Plan 06-02 | `stopScheduler()` логирует `'Cron job stopped'` с именем для каждого job | ✓ SATISFIED | `cron.ts:129`: `logger.info({ name }, 'Cron job stopped')` |
| SCHED-04 | Plan 06-02 | Упавший cron job не убивает остальные | ✓ SATISFIED | `cron.ts:42-47`: per-job try/catch в `registerJob`; тест C2/C3 |

**Все 19 требований Phase 6 удовлетворены.**

**Сиротских требований:** нет. CMD-04/05/06/07/08, PRIV-01..03/05, OBS-01..04, REL-05 принадлежат Phase 7 согласно REQUIREMENTS.md трассировке.

---

### Найденные анти-паттерны

| Файл | Строка | Паттерн | Серьёзность | Воздействие |
|------|--------|---------|-------------|-------------|
| `src/scheduler/cron.ts` | 107-109 | `retentionSweepHandler` — stub: `logger.info('retention sweep stub — Phase 7 implements')` | ℹ️ Info | Intentional placeholder per SCHED-02; Phase 7 заменяет тело. Не блокирует Phase 6 цель |
| `src/modules/thread-summary/thread-summary.service.ts` | 53 | `bot.api as unknown as ForumTopicCapableApi` — double cast | ℹ️ Info | Зафиксированное архитектурное решение: Bot API 7.x не документирует `getForumTopic`; runtime check на строке 55 (`typeof api.getForumTopic === 'function'`) безопасен; O7 тест покрывает fallback |

Ни одного блокирующего анти-паттерна. Заглушки intentional и задокументированы.

---

### Требуется проверка человеком

#### 1. E2E: cron 06:30 MSK fires → один пост в теме

**Тест:** Дождаться срабатывания cron в 06:30 MSK (или вызвать через `/dev-summary` в Phase 7); проверить тему «🧵 Сводки тредов».
**Ожидается:** Один HTML-пост с заголовком `<b>🧵 Сводки тредов · DD.MM.YYYY</b>`, секциями активных тредов, footer «тихо: N тредов» если есть low-volume треды.
**Почему человек:** Требует Phase 0-Ops: bot admin, privacy mode OFF, THREAD_SUMMARY_THREAD_ID, реальные сообщения в отслеживаемых тредах.

#### 2. E2E: idempotency — двойной запуск в тот же MSK-день

**Тест:** После первой публикации вручную повторно запустить pipeline.
**Ожидается:** Второй запуск возвращает `{alreadyPublished: true}`; новый пост не появляется; логи содержат WARN «already published today».
**Почему человек:** Требует живого `state.json` на production-хосте.

#### 3. E2E: coexistence digest 06:00 + thread-summary 06:30

**Тест:** Дождаться обоих cron-срабатываний в одни сутки.
**Ожидается:** AI-радар публикуется в `AI_RADAR_THREAD_ID` в 06:00; thread-summary публикуется в `THREAD_SUMMARY_THREAD_ID` в 06:30; `state.json` содержит оба поля — `lastDigestDate` и `lastThreadSummaryDate` — с корректными датами.
**Почему человек:** Требует production-деплоя; race condition между записями state.json проверяется только в реальных условиях.

---

## Итоговое резюме

Phase 6 полностью реализована. Все 19 требований (SUM-01..07, AI-07, DLV-06..10, STATE-01..02, SCHED-01..04) подтверждены файл-за-файлом.

**Automated state:**
- `npm run typecheck` → exit 0 (строгий TypeScript без ошибок)
- `npm test` → **73/73 тестов**, 11 test files, 100% passing
- `git diff src/services/ai.service.ts` → 0 строк (AI-07)
- `git diff src/utils/telegram.ts` → 0 строк (DLV-09)

**Три E2E сценария** требуют живого бота и настроенной production-среды (Phase 0-Ops). Все они касаются поведения на уровне Telegram API и state.json в production — не могут быть проверены автоматически без реального bot token и чата. Код, реализующий эти сценарии, полностью верифицирован на уровне кода и unit-тестов.

Retention-sweep stub в `cron.ts` и double-cast `ForumTopicCapableApi` — intentional, задокументированы, не блокируют Phase 6 цель.

---

_Верифицировано: 2026-04-29_
_Верификатор: Claude (gsd-verifier)_
