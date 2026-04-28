---
phase: 04-message-capture-persistence
reviewed: 2026-04-28T00:00:00Z
depth: standard
files_reviewed: 15
files_reviewed_list:
  - .env.example
  - Dockerfile
  - docker-compose.yml
  - package.json
  - src/bot.ts
  - src/config.ts
  - src/index.ts
  - src/modules/capture/capture.handler.ts
  - src/modules/capture/capture.mapper.ts
  - src/services/db.service.ts
  - src/services/tracking.service.ts
  - src/stores/message-store.ts
  - src/stores/tracked-threads-store.ts
  - src/types/index.ts
  - src/utils/preflight.ts
findings:
  critical: 1
  warning: 4
  info: 6
  total: 11
status: issues_found
---

# Phase 4: Code Review Report

**Reviewed:** 2026-04-28
**Depth:** standard
**Files Reviewed:** 15
**Status:** issues_found

## Summary

Фаза 4 (SQLite + capture pipeline + privacy controls) реализована аккуратно: миграции в транзакциях, защита от silent-fallback на WAL, подготовленные lazy-statements, два слоя try/catch на горячем пути, явная защита `forgotten_users` перед записью, корректная обработка анонимных админов через `sender_chat.id === ctx.chat.id`.

Главная находка — отсутствие фильтра по `chat_id` в capture-обработчике. Whitelist проверяет только `thread_id`, а не пару `(chat_id, thread_id)`. Если бот окажется в другой группе с пересекающимся `message_thread_id`, произойдёт незаявленный захват сообщений в ту же БД — нарушение PRIV-02 в обход явного контракта на «один целевой чат». Остальные замечания — проектные шероховатости (типизация `targetChatId` как `string` при семантике integer), мелкие edge-cases парсинга ENV, отсутствие fail-fast при коллизии `THREAD_SUMMARY_THREAD_ID === AI_RADAR_THREAD_ID`, и несколько info-пунктов по неймингу/чистоте.

Соответствие тону «штурман → пилот» и `strict: no any` — соблюдено.

## Critical Issues

### CR-01: Capture handler не валидирует `chat_id` — риск кросс-чат захвата (PRIV-02)

**File:** `src/modules/capture/capture.handler.ts:48-49`
**Issue:** Хот-путь проверяет только `isThreadTracked(threadId)`, опираясь на module-singleton `Set<number>` из `tracking.service.ts`. Если бот будет добавлен в любой другой форум-чат, где совпадёт численное значение `message_thread_id` (а Telegram не гарантирует уникальность thread_id между чатами), сообщение попадёт в `messages` с чужим `chat_id`. Это:
1. Нарушает контракт «один целевой чат» (D-02 seed использует `config.targetChatId`).
2. Открывает PRIV-02: данные из чужой группы окажутся в той же БД и попадут в будущие thread-summaries.
3. Делает уникальный индекс `idx_messages_chat_tg` на `(chat_id, tg_message_id)` единственной защитой — но он не помешает записи, только дедуплицирует столкновение.

В `tracked-threads-store.ts:listTracked()` `chat_id` уже хранится в строке, но игнорируется при загрузке whitelist (`tracking.service.ts:19-21`).

**Fix:** Сравнивать пару `(chat_id, thread_id)`. Минимальный патч — фильтр по `targetChatId` в обработчике плюс типизация под `number`:

```ts
// src/modules/capture/capture.handler.ts
import { config } from '../../config.js';
// ...
const targetChatId = Number(config.targetChatId); // вычисляется один раз на модуль
// ...
async function captureHandler(ctx: Context): Promise<void> {
  try {
    const msg = ctx.msg;
    if (!msg) return;
    if (msg.chat.id !== targetChatId) return;       // <-- новый guard, до всех остальных
    if (msg.is_topic_message !== true) return;
    // ... остальное без изменений
  }
}
```

Долгосрочный фикс (рекомендуемый): хранить в `trackedSet` ключ-строку `"${chatId}:${threadId}"` и менять `isThreadTracked(chatId, threadId)`. Это разлочит мульти-чат сценарий, который явно отложен в Phase 5+, без рефакторинга позже.

## Warnings

### WR-01: `BotConfig.targetChatId` / `aiRadarThreadId` типизированы как `string`, хотя содержат integer

**File:** `src/types/index.ts:3-5,12-13`
**Issue:** `requireEnvInt()` валидирует, что значение — целое, но возвращает `string` (`config.ts:14-20`). В результате типы в `BotConfig` — `string`, и каждый потребитель вынужден повторять `Number(config.targetChatId)` (`db.service.ts:147`, `preflight.ts:38`, `digest.sender.ts:21`). Это:
1. Дублирует runtime-парсинг и risk silent NaN при будущих рефакторах.
2. Идёт вразрез с CLAUDE.md «строгий TypeScript, никаких any» — типы лгут о реальном runtime-значении.
3. Особенно опасно в `preflight.ts:38-44`: `Number.isInteger(targetChatId)` реально проверяет повторно то, что уже гарантировал `requireEnvInt`, маскируя проблему.

**Fix:** Сделать `requireEnvInt` возвращающим `number` и обновить типы:

```ts
// src/config.ts
function requireEnvInt(name: string): number {
  const value = requireEnv(name);
  if (!/^-?\d+$/.test(value)) {
    throw new Error(`Environment variable ${name} must be an integer, got "${value}"`);
  }
  return Number(value);
}

// src/types/index.ts
export interface BotConfig {
  botToken: string;
  targetChatId: number;
  aiRadarThreadId: number;
  threadSummaryThreadId: number;
  // ...
}
```

Затем убрать все `Number(config.targetChatId)` в `preflight.ts`, `db.service.ts`, `digest.sender.ts`. Это снимет WR-04 ниже автоматически.

### WR-02: Нет fail-fast на коллизию `THREAD_SUMMARY_THREAD_ID === AI_RADAR_THREAD_ID`

**File:** `src/config.ts:54-71`
**Issue:** Конфиг загружает оба ID независимо. Опечатка оператора (один и тот же thread_id в двух ENV) приведёт к публикации thread-summary в AI-радар тред — публичный регресс для подписчиков клуба. Это типично для PRIV-02 / OPS-03 вектора (неаккуратная конфигурация в проде).

**Fix:** Добавить пост-валидацию после построения `config`:

```ts
// src/config.ts, после export const config = { ... };
if (config.threadSummaryThreadId === config.aiRadarThreadId) {
  throw new Error(
    'THREAD_SUMMARY_THREAD_ID must differ from AI_RADAR_THREAD_ID — ' +
    'thread-summary would publish into the digest thread.',
  );
}
```

Аналогично можно проверить, что `INITIAL_TRACKED_THREAD_IDS` не содержит `aiRadarThreadId` или `threadSummaryThreadId` — захват собственных публикаций бота в БД нежелателен.

### WR-03: `parseInitialTrackedThreadIds` принимает дробные строки и значения вне диапазона

**File:** `src/config.ts:39-52`
**Issue:** `Number("1.5")` → `1.5`, который не пройдёт `Number.isInteger` — корректно. Но `Number("0x10")` → `16`, `Number("1e5")` → `100000`, `Number(" ")` → `0` (после `trim` отфильтровано через `filter(Boolean)`). Главная проблема — **отрицательных** thread_id Telegram не выдаёт, и допущение `Number.isInteger(n)` пропустит `0` или отрицательное значение, которое в БД будет seed-нуто, но никогда не сматчится в реальном трафике. Тихий сбой — оператор будет искать причину молчащего пайплайна.

**Fix:** Добавить нижнюю границу и единый формат парсинга, симметричный `requireEnvInt`:

```ts
function parseInitialTrackedThreadIds(raw: string): number[] {
  if (raw.trim() === '') return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      if (!/^\d+$/.test(s)) {
        throw new Error(`INITIAL_TRACKED_THREAD_IDS contains non-positive-integer: "${s}"`);
      }
      const n = Number(s);
      if (n <= 0) {
        throw new Error(`INITIAL_TRACKED_THREAD_IDS must contain positive thread_id, got ${n}`);
      }
      return n;
    });
}
```

### WR-04: Кеш админов в `bot.ts` не инвалидируется при изменении прав

**File:** `src/bot.ts:24-46`
**Issue:** `ADMIN_CACHE_TTL_MS = 5 * 60_000`. Если админ деградирован/удалён из чата, он сохраняет доступ к `/digest`, `/dev-digest`, `/status` ещё до 5 минут. В контексте `/dev-digest` (публикует в AI-радар тред без `state.json`-идемпотентности) это окно для накрутки/спама дайджестом. Не критично для MVP, но — окно атаки шире, чем выглядит на первый взгляд.

Дополнительно: `adminCache` — module-level `Map`, без верхней границы. Если бот окажется в большом числе чатов, это медленный leak.

**Fix:** Вариант 1 — короче TTL для админ-команд с побочным эффектом (60 секунд для `/digest` / `/dev-digest`, 5 минут для read-only `/status`). Вариант 2 — `bot.on('chat_member')` инвалидировать кеш при смене статуса. Минимум — добавить TODO с явной ссылкой на риск:

```ts
// Note: 5min cache means a demoted admin keeps command access for up to 5min.
// For Phase 4 (single trusted ops chat) acceptable; revisit on Phase 5+ multi-chat.
const ADMIN_CACHE_TTL_MS = 5 * 60_000;
```

## Info

### IN-01: `requireEnvInt` имя обещает `number`, возвращает `string`

**File:** `src/config.ts:14-20`
**Issue:** Функция называется `requireEnvInt`, но сигнатура — `(name: string): string`. Это путает читателя и приводит к WR-01. Если WR-01 принят — этот пункт закрывается автоматически.

### IN-02: `formatDisplayName` не санитизирует пустые `first_name`

**File:** `src/modules/capture/capture.mapper.ts:103-114`
**Issue:** Per Telegram Bot API, `User.first_name` гарантированно не пустой, но Grammy типы — `string` без минимальной длины. Если когда-нибудь придёт пустая строка (тест-фикстура, бот, edge-case), `formatDisplayName` вернёт `""`, что окажется в БД как `author_name` и нарушит `NOT NULL` миграции? Нет — `NOT NULL` пропустит пустую строку (`""` ≠ `NULL` в SQLite). Но downstream форматирование summary получит безымянного автора.

**Fix:** Тривиальный fallback:

```ts
function formatDisplayName(user: UserLike): string {
  const fn = user.first_name?.trim() ?? '';
  const ln = user.last_name !== undefined ? ` ${user.last_name}` : '';
  const un = user.username !== undefined ? ` @${user.username}` : '';
  const result = `${fn}${ln}${un}`.trim();
  return result === '' ? `User #${'id' in user ? String(user.id) : 'unknown'}` : result;
}
```

### IN-03: Дубль guard'а на `senderChat.type === 'channel'` в handler и mapper

**File:** `src/modules/capture/capture.handler.ts:45` + `src/modules/capture/capture.mapper.ts:53-56`
**Issue:** Та же проверка дважды — в handler (early-return) и в mapper (return null). Комментарий в mapper честно называет это «belt-and-suspenders». Само по себе нормально, но если правило изменится (например, для linked-channel захват включат), нужно править оба места и легко забыть одно. Дублирование business-логики через слои.

**Fix:** Оставить один — в handler (он раньше). Mapper делает только pure mapping; защита от мусора — задача handler. Если хочется страховки в mapper, превратить её в `assert` (throw) — расхождение зашумит логи и заметится на CR-смоук-тесте, а не молча отфильтрует вторично.

### IN-04: Неиспользуемая строка `ed` в комментарии и магическое число `1000`

**File:** `src/modules/capture/capture.mapper.ts:70,81`
**Issue:** `msg.date * 1000` встречается дважды без константы. Не баг, но проект явно заявляет «Система > Навык» — лёгкий хелпер `unixSecondsToISO(s: number): string` в `src/utils/time.ts` уберёт магическое число и упростит будущий retention-сервис (он тоже будет конвертить).

**Fix:**

```ts
// src/utils/time.ts
export function unixSecondsToISO(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}
```

### IN-05: `loadTrackingWhitelist` логирует все `threadIds` в info-уровне

**File:** `src/services/tracking.service.ts:22-25`
**Issue:** При больших whitelist (Phase 5+) в info-логе окажется массив целиком. Сейчас при бутстрапе из ENV это нормально, но в проде на 100+ тредах лог станет шумным. PRIV-05 явно про текст сообщений, не про метаданные тредов, так что не критично — но дисциплина логирования хороша как привычка.

**Fix:** Перевести `threadIds` в `debug`:

```ts
logger.info({ count: trackedSet.size }, 'Tracking whitelist loaded');
logger.debug({ threadIds: [...trackedSet] }, 'Tracking whitelist contents');
```

### IN-06: `closeDb` не сбрасывает кешированные prepared statements

**File:** `src/services/db.service.ts:173-184` + `src/stores/message-store.ts:9-10` + `src/stores/tracked-threads-store.ts:10`
**Issue:** При вызове `closeDb()` модули `message-store` и `tracked-threads-store` оставляют ссылки `_upsertStmt`, `_forgottenStmt`, `_listStmt` на закрытую БД. Если кто-то когда-нибудь вызовет `initDb()` повторно (редкий тест-сценарий, hot-reload в dev), эти statements укажут на «висящий» handle и выбросят. Сейчас shutdown-only сценарий не страдает, но контракт «idempotent initDb()» из docstring `db.service.ts:78` нарушен.

**Fix:** Опубликовать `resetStatements()` в каждом store и вызывать из `closeDb()` (или ввести event-bus), либо документировать что `initDb` строго одноразовый и убрать «idempotent» из комментария.

```ts
// src/stores/message-store.ts
export function _resetForTests(): void {
  _upsertStmt = null;
  _forgottenStmt = null;
}
```

---

_Reviewed: 2026-04-28_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
