---
phase: 07-v2-closure
plan: 03
type: execute
wave: 1
depends_on: []
files_modified:
  - src/services/state.service.ts
  - src/services/state.service.test.ts
  - src/stores/tracked-threads-store.ts
  - src/stores/tracked-threads-store.test.ts
  - src/services/tracking.service.ts
  - src/types/index.ts
  - src/modules/thread-summary/thread-summary.service.ts
  - .env.example
autonomous: true
requirements: []
tags: [cleanup, dead-code, env, comments, jsdoc]
must_haves:
  truths:
    - "src/services/state.service.ts exports `isThreadSummaryPublishedTodayWithState` only — the bare `isThreadSummaryPublishedToday` is gone. No callsite in src/ or tests references the removed name."
    - "src/stores/tracked-threads-store.ts exports `listTracked` and `_resetTrackedThreadsStoreForTests` only — `upsertThreadTitle` (and its prepared statement / cache) are gone."
    - "src/services/tracking.service.ts comments no longer mention 'Phase 5' or 'Phase 7' or 'Phase 8' as future work — replaced with current-state language."
    - "src/types/index.ts JSDoc for `RunThreadSummaryOptions.skipIdempotency` no longer references the deleted function name."
    - "src/modules/thread-summary/thread-summary.service.ts `refreshThreadTitle` JSDoc updated: drops reference to `/track` (Phase 5) and explicitly mentions Phase 7 cleanup of `upsertThreadTitle`. Resulting JSDoc contains the literal string `Phase 7` (acceptance: grep returns ≥1)."
    - "`.env.example` `MESSAGE_RETENTION_DAYS=2` line is replaced with `MESSAGE_RETENTION_DAYS=90` (matches code-enforced default + min=7 invariant)."
    - "`npm run typecheck` and `npx vitest run` both pass."
  artifacts:
    - path: "src/services/state.service.ts"
      provides: "Single canonical idempotency check (isThreadSummaryPublishedTodayWithState)"
    - path: "src/stores/tracked-threads-store.ts"
      provides: "listTracked-only store (no upsertThreadTitle)"
    - path: ".env.example"
      provides: "Sane MESSAGE_RETENTION_DAYS=90 example"
      contains: "MESSAGE_RETENTION_DAYS=90"
  key_links:
    - from: "src/modules/thread-summary/thread-summary.service.ts"
      to: "src/services/state.service.ts"
      via: "import { readState, writeState, isThreadSummaryPublishedTodayWithState }"
      pattern: "isThreadSummaryPublishedTodayWithState"
---

<objective>
Закрыть Success Criterion 3: зачистить пять мёртвых артефактов после де-скопа Phase 5 + Phase 7 (CMD/PRIV write paths).

Покрытие:
1. `isThreadSummaryPublishedToday` — экспорт-сирота в state.service (вытеснен `*WithState` версией по WR-03).
2. `upsertThreadTitle` — экспорт-сирота в tracked-threads-store (Phase 5 cancelled, не вызывается из production).
3. `ForumTopicCapableApi` double-cast — фактически уже удалён по WR-01 (audit-снимок устарел: текущий thread-summary.service.ts использует cached-only refreshThreadTitle); остаётся только подчистить JSDoc-формулировки.
4. Stale Phase 5/7/8 комментарии в `tracking.service.ts` (строки 6, 37-38, 44-46).
5. `.env.example MESSAGE_RETENTION_DAYS=2` → `=90` (значение ниже code-enforced min=7 — упало бы на старте, если пользователь скопировал вербатим).

Все пять подзадач безопасно изолированы в отдельных файлах — ни одна не зависит от других, ни одна не модифицирует production-семантику. Это чисто косметический + dead-code cleanup.

Output:
- 4 source-файла с удалёнными декларациями + комментариями.
- 2 test-файла с удалёнными test-блоками для удалённых exports.
- 1 `.env.example` с обновлённым retention-значением.
- 1 types-файл с обновлённым JSDoc.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@.planning/ROADMAP.md
@.planning/v2.0-MILESTONE-AUDIT.md
@.planning/v2.0-INTEGRATION-CHECK.md
@src/services/state.service.ts
@src/services/state.service.test.ts
@src/stores/tracked-threads-store.ts
@src/stores/tracked-threads-store.test.ts
@src/services/tracking.service.ts
@src/types/index.ts
@src/modules/thread-summary/thread-summary.service.ts
@.env.example

<interfaces>
<!-- Текущие экспорты модулей; план описывает целевое (после-чистки) состояние -->

state.service.ts (целевое состояние ПОСЛЕ плана):
```typescript
export function readState(): PipelineStateV2;
export function writeState(state: PipelineStateV2): void;
export function isDigestPublishedToday(): boolean;
// REMOVED: isThreadSummaryPublishedToday — superseded by *WithState (WR-03 fix)
export function isThreadSummaryPublishedTodayWithState(state: PipelineStateV2): boolean;
```

tracked-threads-store.ts (целевое состояние ПОСЛЕ плана):
```typescript
export function listTracked(): TrackedThread[];
export function _resetTrackedThreadsStoreForTests(): void;
// REMOVED: upsertThreadTitle, _upsertTitleStmt, upsertTitleStmt
```

Реальный verified факт (грэп от 2026-04-30): `ForumTopicCapableApi` НЕ присутствует в src/ — был удалён фиксом WR-01 (см. .planning/phases/06-thread-summary-pipeline/06-REVIEW-FIX.md строка 32). Значит подзадача №3 сводится к подчистке JSDoc-комментариев, не к удалению кода. Audit-снимок 2026-04-30 описывает desired-state не текущий-state.
</interfaces>

**Pre-cleanup grep verification (executor должен прогнать ДО любых изменений, чтобы убедиться в текущем состоянии):**
```bash
grep -rn "isThreadSummaryPublishedToday\b" src/                 # ожидаем: 4 совпадения (декл, тест-импорт, 1 ассерт, 1 JSDoc-cite в types)
grep -rn "upsertThreadTitle" src/                                # ожидаем: 6+ совпадений (декл, statement, JSDoc, 4 в test, 1 cite в JSDoc)
grep -rn "ForumTopicCapableApi" src/                             # ожидаем: 0 (уже снесено WR-01)
grep -nE "Phase 5|Phase 7|Phase 8" src/services/tracking.service.ts  # ожидаем: 4 совпадения
grep "MESSAGE_RETENTION_DAYS" .env.example                       # ожидаем: MESSAGE_RETENTION_DAYS=2
```
</context>

<tasks>

<task type="auto">
  <name>Task 1: Remove isThreadSummaryPublishedToday + drop S7 test + clean RunThreadSummaryOptions JSDoc</name>
  <files>src/services/state.service.ts, src/services/state.service.test.ts, src/types/index.ts</files>
  <read_first>
    - src/services/state.service.ts (строки 98-106 — функция, которую сносим)
    - src/services/state.service.test.ts (строка 21 импорт + строки 99-108 тест S7)
    - src/types/index.ts (строки 119-126 — JSDoc на RunThreadSummaryOptions.skipIdempotency)
    - src/modules/thread-summary/thread-summary.service.ts (строки 85-89 — комментарий ссылается на удаляемое имя для documentation purposes)
  </read_first>
  <action>
**Файл 1: `src/services/state.service.ts`**

Удалить функцию полностью (строки 98-106 включая JSDoc):
```typescript
/**
 * Phase 6 D-31: idempotency check for thread-summary job. Same MSK-day pattern,
 * separate state field per DLV-10.
 */
export function isThreadSummaryPublishedToday(): boolean {
  const state = readState();
  if (state.lastThreadSummaryDate === null) return false;
  return todayMsk() === toMskDate(state.lastThreadSummaryDate);
}
```

Оставить только `isThreadSummaryPublishedTodayWithState` (строки 108-116) — это единственный канонический путь после WR-03 fix.

**Файл 2: `src/services/state.service.test.ts`**

Удалить из импорта (строка 21) `isThreadSummaryPublishedToday,` — оставить остальные импорты intact.

Удалить тест S7 целиком (строки 99-108 — `it('S7: ...')` блок включая фигурные скобки):
```typescript
it('S7: isThreadSummaryPublishedToday — separate from digest, same MSK-day pattern', () => {
  writeState({
    lastDigestDate: null,
    lastSkipped: false,
    lastItemCount: 0,
    lastThreadSummaryDate: new Date().toISOString(),
  });
  expect(isThreadSummaryPublishedToday()).toBe(true);
  expect(isDigestPublishedToday()).toBe(false);
});
```

Если эквивалентный тест нужен на `isThreadSummaryPublishedTodayWithState` — добавить НОВЫЙ блок S7-WithState (опционально, не обязательно — функция уже покрыта в `thread-summary.service.test.ts` через интеграционный путь):
```typescript
it('S7: isThreadSummaryPublishedTodayWithState — separate from digest, same MSK-day pattern', () => {
  const state: PipelineStateV2 = {
    lastDigestDate: null,
    lastSkipped: false,
    lastItemCount: 0,
    lastThreadSummaryDate: new Date().toISOString(),
  };
  expect(isThreadSummaryPublishedTodayWithState(state)).toBe(true);
});
```

**Файл 3: `src/types/index.ts` (строка 120)**

Изменить JSDoc:
```typescript
/** If true, bypass isThreadSummaryPublishedToday() short-circuit. Default: false. */
```
→ на:
```typescript
/** If true, bypass isThreadSummaryPublishedTodayWithState() short-circuit. Default: false. */
```

**Файл 4: `src/modules/thread-summary/thread-summary.service.ts` (строка 85-87)** — JSDoc:

Найти строку:
```
// (once here, once inside isThreadSummaryPublishedToday) with no consistency
```
Заменить на:
```
// (once here, once inside the deprecated isThreadSummaryPublishedToday — removed
// in Phase 7) with no consistency
```
ALTERNATIVE (предпочтительно для чистоты): полностью удалить комментарий `// WR-03 fix:...` блок (строки 85-89), оставив только саму проверку — фикс уже стабильно применён, исторический контекст переехал в SUMMARY/REVIEW-FIX. Если выберете этот вариант, оставьте однострочный комментарий: `// WR-03: idempotency check uses already-loaded prevState (single readState per cycle).`
  </action>
  <verify>
    <automated>npx vitest run src/services/state.service.test.ts && npm run typecheck</automated>
  </verify>
  <acceptance_criteria>
    - `grep -cE "^export function isThreadSummaryPublishedToday\\b" src/services/state.service.ts` returns 0
    - `grep -c "isThreadSummaryPublishedToday\\b" src/services/state.service.ts` returns 0 (вообще никаких упоминаний bare-имени)
    - `grep -c "isThreadSummaryPublishedTodayWithState" src/services/state.service.ts` returns ≥1 (canonical стоит)
    - `grep -c "isThreadSummaryPublishedToday\\b" src/services/state.service.test.ts` returns 0
    - `grep -c "isThreadSummaryPublishedToday\\b" src/types/index.ts` returns 0 (JSDoc обновлён)
    - `grep -c "isThreadSummaryPublishedToday\\b" src/modules/thread-summary/thread-summary.service.ts` returns 0 (или ≤1 если оставлен «исторический» single-line комментарий со словом deprecated)
    - `grep -rn "isThreadSummaryPublishedToday\\b" src/` returns 0 lines
    - `npx vitest run src/services/state.service.test.ts` exits 0
    - `npm run typecheck` exits 0
  </acceptance_criteria>
  <done>Bare-функция и все её упоминания удалены; *WithState — единственный путь.</done>
</task>

<task type="auto">
  <name>Task 2: Remove upsertThreadTitle + statement + drop U1 test + clean refreshThreadTitle JSDoc</name>
  <files>src/stores/tracked-threads-store.ts, src/stores/tracked-threads-store.test.ts, src/modules/thread-summary/thread-summary.service.ts</files>
  <read_first>
    - src/stores/tracked-threads-store.ts (полностью — `_upsertTitleStmt` строка 12, `upsertTitleStmt()` строки 29-36, `upsertThreadTitle` строки 55-62, `_resetTrackedThreadsStoreForTests` строки 67-70)
    - src/stores/tracked-threads-store.test.ts (полностью — describe('upsertThreadTitle (U1, U2)') строки 36-60)
    - src/modules/thread-summary/thread-summary.service.ts (строки 34-46 — JSDoc на refreshThreadTitle ссылается на «`/track` (Phase 5) или migration v2 bootstrap»; строки 47-50 — тело функции, не трогать)
    - .planning/v2.0-INTEGRATION-CHECK.md строка 52 (orphan-export evidence)
  </read_first>
  <action>
**Файл 1: `src/stores/tracked-threads-store.ts`**

1. Удалить declaration строки 12:
```typescript
let _upsertTitleStmt: Statement<[string, number]> | null = null;
```

2. Удалить функцию `upsertTitleStmt()` (строки 29-36 включая JSDoc):
```typescript
function upsertTitleStmt(): Statement<[string, number]> {
  // No INSERT path — Phase 6 D-07: orchestrator only updates titles for
  // already-tracked threads. Phase 5 owns INSERT via /track command.
  _upsertTitleStmt ??= getDb().prepare<[string, number]>(
    'UPDATE tracked_threads SET title = ? WHERE thread_id = ?',
  );
  return _upsertTitleStmt;
}
```

3. Удалить экспорт `upsertThreadTitle` (строки 55-62 — JSDoc + функция):
```typescript
/**
 * Phase 6 D-06: orchestrator calls this once per day per thread to refresh
 * the cached forum-topic title from getForumTopic API. No-op for non-existent
 * thread_id (UPDATE matches 0 rows; safe).
 */
export function upsertThreadTitle(threadId: number, title: string): void {
  upsertTitleStmt().run(title, threadId);
}
```

4. В `_resetTrackedThreadsStoreForTests` (строки 67-70) удалить строку `_upsertTitleStmt = null;`:
```typescript
export function _resetTrackedThreadsStoreForTests(): void {
  _listStmt = null;
  _upsertTitleStmt = null;   // ← удалить
}
```

5. Обновить JSDoc-блок наверху файла (строки 6-9), удалив устаревшую формулировку:
```typescript
// Lazy-cached prepared statements (STORE-04). Phase 5 will add
// insertTrackedThread / deleteTrackedThread here; Phase 4 ships read-side only
// (D-01 contract: no refactor required when Phase 5 adds the writers).
// Phase 6 D-05/D-06: extends listTracked to return title; adds upsertThreadTitle
// (UPDATE-only — Phase 5 owns INSERT via /track command).
```
Заменить на:
```typescript
// Lazy-cached prepared statements (STORE-04). Phase 4 ships read-side only;
// Phase 5 (track/untrack commands) was cancelled 2026-04-29, so the writer
// path stays out of v2.0. tracked_threads.title remains nullable; thread-summary
// orchestrator falls back to `Тред #N` when title is NULL (see refreshThreadTitle).
```

**Файл 2: `src/stores/tracked-threads-store.test.ts`**

1. Удалить из импорта (строка 5) `upsertThreadTitle,`.

2. Удалить целиком блок `describe('upsertThreadTitle (U1, U2)', () => { ... })` строки 36-60.

3. Если после удаления тест `U2: listTracked returns title=null...` нужно сохранить (он проверяет колонку из migration v2 — полезный) — переместить его в существующий describe выше или в новый `describe('listTracked title column', ...)`. Текст теста (без `upsertThreadTitle` вызова) сохраняет смысл:
```typescript
describe('listTracked — title column from migration v2', () => {
  it('returns title=null for thread that was never refreshed', () => {
    getDb()
      .prepare(
        'INSERT INTO tracked_threads (thread_id, chat_id, added_by, added_at) VALUES (?, ?, NULL, ?)',
      )
      .run(101, -1001, '2026-04-29T10:00:00.000Z');
    expect(listTracked().find((t) => t.threadId === 101)?.title).toBeNull();
  });
});
```

**Файл 3: `src/modules/thread-summary/thread-summary.service.ts`** (строки 34-46, JSDoc на `refreshThreadTitle` — функция объявляется на строке 47, тело строки 47-50; редактируется ТОЛЬКО JSDoc-блок 34-46)

Текущая формулировка ссылается на «`/track` (Phase 5) or migration v2 bootstrap» — Phase 5 cancelled, формулировка устаревшая.

Заменить JSDoc:
```typescript
/**
 * Resolve a thread title for display.
 *
 * Phase 6 originally attempted to call `bot.api.getForumTopic(chatId, threadId)`
 * before each cycle to refresh `tracked_threads.title`. That method does NOT
 * exist on Telegram Bot API 7.x (only `getForumTopicIconStickers` is exposed
 * by grammy 1.42.0), so the runtime guard `typeof api.getForumTopic === 'function'`
 * was always false — the refresh was permanently dead code (WR-01).
 *
 * Until Telegram exposes a real source-of-truth, this resolver is cached-only:
 * it reads the title written by `/track` (Phase 5) or migration v2 bootstrap.
 * If no cached title exists, fall back to a generic `Тред #N` label.
 */
```
→ на:
```typescript
/**
 * Resolve a thread title for display.
 *
 * Phase 6 originally attempted to call `bot.api.getForumTopic(chatId, threadId)`
 * before each cycle to refresh `tracked_threads.title`. That method does NOT
 * exist on Telegram Bot API 7.x (only `getForumTopicIconStickers` is exposed
 * by grammy 1.42.0), so the runtime guard `typeof api.getForumTopic === 'function'`
 * was always false — the refresh was permanently dead code (WR-01 fix removed it).
 *
 * Phase 5 (`/track` command which would have INSERTed titles) was cancelled
 * 2026-04-29; the `upsertThreadTitle` writer was removed in Phase 7. As a result,
 * `tracked_threads.title` is NULL for every thread today — this resolver always
 * returns the `Тред #{threadId}` fallback. If a future phase (`/track` or
 * Telegram API surfaces `getForumTopic`) reintroduces a title-writer, this
 * function continues to work without modification — it reads whatever DB
 * currently has.
 */
```
  </action>
  <verify>
    <automated>npx vitest run src/stores/tracked-threads-store.test.ts && npm run typecheck</automated>
  </verify>
  <acceptance_criteria>
    - `grep -c "upsertThreadTitle" src/stores/tracked-threads-store.ts` returns 0
    - `grep -c "_upsertTitleStmt" src/stores/tracked-threads-store.ts` returns 0
    - `grep -c "upsertTitleStmt" src/stores/tracked-threads-store.ts` returns 0
    - `grep -rn "upsertThreadTitle" src/` returns 0 lines (export, callsites, tests — all gone)
    - `grep -c "Phase 5 owns INSERT" src/stores/tracked-threads-store.ts` returns 0 (устаревший комментарий снят)
    - `grep -c "Phase 5 .*cancelled" src/stores/tracked-threads-store.ts` returns ≥1 (новая формулировка указывает на cancellation)
    - `grep -c "Phase 7" src/modules/thread-summary/thread-summary.service.ts` returns ≥1 (упоминание Phase 7 cleanup в JSDoc)
    - `npx vitest run src/stores/tracked-threads-store.test.ts` exits 0
    - `npm run typecheck` exits 0
  </acceptance_criteria>
  <done>upsertThreadTitle и все его следы удалены; refreshThreadTitle JSDoc отражает реальное состояние.</done>
</task>

<task type="auto">
  <name>Task 3: Refresh stale Phase 5/7/8 comments in tracking.service.ts</name>
  <files>src/services/tracking.service.ts</files>
  <read_first>
    - src/services/tracking.service.ts полностью (46 строк)
  </read_first>
  <action>
В `src/services/tracking.service.ts` заменить четыре блока комментариев:

**Block 1 (строки 4-7):**
```typescript
// Private module-singleton Set — source of truth for the capture hot path.
// O(1) lookup vs ~0.1ms SELECT per message (RESEARCH §"Don't Hand-Roll" table).
// Phase 5 will add track()/untrack() that mutate this Set + write to DB
// (D-01 contract: Phase 4 ships read-side only).
```
→ на:
```typescript
// Private module-singleton Set — source of truth for the capture hot path.
// O(1) lookup vs ~0.1ms SELECT per message (RESEARCH §"Don't Hand-Roll" table).
// Phase 5 (track/untrack in-chat commands) was cancelled 2026-04-29 — whitelist
// is managed via env-seed (INITIAL_TRACKED_THREAD_IDS) and direct DB writes only.
```

**Block 2 (строки 36-38) — JSDoc на `listTrackedThreadIds`:**
```typescript
/**
 * Snapshot of currently-tracked thread IDs. Used by future Phase 5 /tracked
 * command and Phase 7 thread-summary orchestrator.
 */
```
→ на:
```typescript
/**
 * Snapshot of currently-tracked thread IDs. Consumed by the thread-summary
 * orchestrator (src/modules/thread-summary/thread-summary.service.ts) on every
 * 06:30 MSK cron tick.
 */
```

**Block 3 (строки 44-46) — trailing footer комментарий:**
```typescript
// Phase 5 will add track(threadId, addedBy: number) and untrack(threadId)
// functions here that mutate trackedSet AND write through to the store.
// Phase 4 ships read-side only — no placeholders, no throwing stubs (D-01).
```
→ полностью УДАЛИТЬ блок (3 строки). Файл заканчивается на функции `listTrackedThreadIds`.

После этих изменений в `tracking.service.ts` не должно остаться ни одного `Phase 5`, `Phase 7`, `Phase 8` упоминания, кроме (опционально) единственной формулировки про cancellation в Block 1.
  </action>
  <verify>
    <automated>npm run typecheck && grep -cE "Phase [578]" src/services/tracking.service.ts</automated>
  </verify>
  <acceptance_criteria>
    - `grep -cE "Phase 5 will add" src/services/tracking.service.ts` returns 0
    - `grep -cE "Phase 5 /tracked" src/services/tracking.service.ts` returns 0
    - `grep -cE "Phase 7 thread-summary" src/services/tracking.service.ts` returns 0
    - `grep -cE "Phase 8" src/services/tracking.service.ts` returns 0
    - `grep -c "Phase 5 .*cancelled 2026-04-29" src/services/tracking.service.ts` returns ≥1
    - `grep -c "thread-summary orchestrator" src/services/tracking.service.ts` returns ≥1
    - `npm run typecheck` exits 0
  </acceptance_criteria>
  <done>Все «Phase 5/7/8 will/future» формулировки заменены на нынешнее или cancelled-state описание.</done>
</task>

<task type="auto">
  <name>Task 4: Fix .env.example MESSAGE_RETENTION_DAYS=2 → 90</name>
  <files>.env.example</files>
  <read_first>
    - .env.example (строка 21 — целевое изменение)
    - src/config.ts (строка 67 — `readEnvIntWithDefault('MESSAGE_RETENTION_DAYS', 90, 7)` — default=90, min=7)
  </read_first>
  <action>
В `.env.example` на строке 21 заменить:
```
MESSAGE_RETENTION_DAYS=2
```
на:
```
MESSAGE_RETENTION_DAYS=90
```

Контекст изменения: `config.ts` использует `readEnvIntWithDefault('MESSAGE_RETENTION_DAYS', 90, 7)` — default 90, минимум 7. Текущее значение `=2` ниже минимума и упало бы на старте при копировании вербатим (PRIV-02 typo regression защита от Phase 4). Plan 01 (retention sweep) теперь активно использует это значение для DELETE — некорректный пример вводит оператора в заблуждение.

Никакие другие строки `.env.example` не трогаем. Cron-комментарии, ключи API, и прочие — без изменений.
  </action>
  <verify>
    <automated>grep -E "^MESSAGE_RETENTION_DAYS=" .env.example</automated>
  </verify>
  <acceptance_criteria>
    - `grep -c "^MESSAGE_RETENTION_DAYS=90$" .env.example` returns 1
    - `grep -c "^MESSAGE_RETENTION_DAYS=2$" .env.example` returns 0
    - `grep -c "MESSAGE_RETENTION_DAYS" .env.example` returns 1 (никаких дубликатов)
    - все остальные строки .env.example не изменены (`git diff .env.example | grep -E '^[+-]' | wc -l` returns 2 — одна `-`, одна `+`)
  </acceptance_criteria>
  <done>.env.example отражает code-enforced default (90 дней, ≥ min=7).</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| Public exports | Удалённые export'ы — внутренний API проекта; нет внешних потребителей. |
| Operator copying .env.example | Конфиг-граница: некорректный пример → fail-fast на старте. |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-07-03-01 | Tampering | Removed function later resurrected with stale callsite | mitigate | grep-acceptance criterion (0 matches in src/) после плана; PR-review должен ловить попытку re-introduce. |
| T-07-03-02 | Information Disclosure | Comments leak future-roadmap detail | accept | Удалённые комментарии описывали Phase 5/7/8, которые публично де-скоупированы в ROADMAP.md. Никакой sensitive info. |
| T-07-03-03 | Denial of Service | `.env.example` value <7 days breaks startup | mitigate | Замена `=2` → `=90` восстанавливает соответствие code-enforced min=7 (config.ts line 67). Оператор копирующий верьатим больше не получит startup-throw. |
| T-07-03-04 | Repudiation | JSDoc lost historical context (WR-01, WR-03 fixes) | accept | Исторический контекст сохраняется в `.planning/phases/06-thread-summary-pipeline/06-REVIEW-FIX.md` и SUMMARY-файлах. Inline JSDoc оставляет ссылку на WR-01/WR-03 номера для traceability. |

Block-on: high. Никаких high-severity угроз — это чисто косметическая чистка. T-07-03-01 (re-introduction prevention) митигируется acceptance grep-criterion.
</threat_model>

<verification>
- `npm run typecheck` exits 0 — никаких orphan import'ов или undefined references.
- `npx vitest run` — полный сьют зелёный (изменено: state.service.test, tracked-threads-store.test).
- Сводный grep-чек:
  - `grep -rn "isThreadSummaryPublishedToday\b" src/` → 0 строк
  - `grep -rn "upsertThreadTitle" src/` → 0 строк
  - `grep -rn "ForumTopicCapableApi" src/` → 0 строк (был уже снесён WR-01, подтверждаем)
  - `grep -nE "Phase 5 will|Phase 5 /tracked|Phase 7 thread-summary|Phase 8" src/services/tracking.service.ts` → 0 строк
- `grep "^MESSAGE_RETENTION_DAYS=90$" .env.example` → exit 0.
</verification>

<success_criteria>
1. Все четыре подзадачи выполнены — нет ни одного из five-targeted-dead-artifacts:
   - `isThreadSummaryPublishedToday` функция → удалена.
   - `upsertThreadTitle` функция + statement → удалены.
   - `ForumTopicCapableApi` → подтверждено отсутствие; JSDoc updated.
   - `Phase 5/7/8 will/future` комментарии → заменены.
   - `MESSAGE_RETENTION_DAYS=2` → 90.
2. `npm run typecheck` зелёный.
3. `npx vitest run` зелёный.
4. Никаких изменений в публичной семантике API — только удаление dead/orphan артефактов.
</success_criteria>

<output>
After completion, create `.planning/phases/07-v2-closure/07-03-SUMMARY.md` со списком очищенных артефактов и delta-grep evidence (before/after). Frontmatter `requirements_completed: []` (cleanup-план без новых REQ-IDs).
</output>
