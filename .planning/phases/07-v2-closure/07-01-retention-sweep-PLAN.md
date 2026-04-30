---
phase: 07-v2-closure
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - src/scheduler/cron.ts
  - src/services/retention.service.ts
  - src/services/retention.service.test.ts
  - src/scheduler/cron.test.ts
autonomous: true
requirements:
  - PRIV-03
tags: [retention, cron, sqlite, batch-delete, observability]
must_haves:
  truths:
    - "Cron job 'retention-sweep' fires at 04:00 MSK (config.retentionSweepCron, default '0 1 * * *' UTC) and deletes messages where created_at is older than now() − MESSAGE_RETENTION_DAYS."
    - "Each sweep iteration deletes at most 1000 rows (LIMIT 1000) and loops until DELETE returns 0 rows changed."
    - "Each completed sweep emits a single pino INFO line with structure { event: 'retention-sweep', rows_deleted: N, duration_ms: D } where N is the total deleted across all iterations and D is the wall-clock duration of the sweep call."
    - "MESSAGE_RETENTION_DAYS is consumed from config (parameter-bound) and never interpolated into SQL string."
    - "A failure inside the sweep handler is caught by the registerJob per-job try/catch and does not affect the digest or thread-summary jobs (SCHED-04 invariant preserved)."
  artifacts:
    - path: "src/services/retention.service.ts"
      provides: "Pure retention-sweep function with batched DELETE + structured log"
      exports: ["runRetentionSweep"]
    - path: "src/services/retention.service.test.ts"
      provides: "Unit tests asserting batching, cutoff, structured log shape"
    - path: "src/scheduler/cron.ts"
      provides: "Real retentionSweepHandler body wired to runRetentionSweep"
      contains: "runRetentionSweep"
  key_links:
    - from: "src/scheduler/cron.ts retentionSweepHandler"
      to: "src/services/retention.service.ts runRetentionSweep"
      via: "direct import + await"
      pattern: "await runRetentionSweep"
    - from: "src/services/retention.service.ts"
      to: "src/services/db.service.ts getDb"
      via: "prepared statement + sqlite parameter binding"
      pattern: "DELETE FROM messages.*LIMIT 1000"
---

<objective>
Реализовать PRIV-03: 90-дневный retention sweep для таблицы `messages`. Заменить пустой stub `retentionSweepHandler` (cron.ts:108-110, который только пишет INFO) на реальный батчевый DELETE с обсервабилити.

Purpose: Без этого данные в `messages` накапливаются бесконечно — нарушение GDPR-намерения minimal-retention и милстоунный блокер v2.0.

Output:
- Новый файл `src/services/retention.service.ts` с чистой функцией `runRetentionSweep()` (батч DELETE LIMIT 1000 в цикле, structured pino-лог).
- Тесты `retention.service.test.ts` (in-memory SQLite, фикстуры с messages разной давности).
- `cron.ts.retentionSweepHandler` body-replace: вызывает `runRetentionSweep`.
- Обновлённый тест `cron.test.ts` подтверждает, что хендлер не падает при пустой таблице и что ошибка одного job не валит остальные (SCHED-04 invariant).
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@.planning/ROADMAP.md
@.planning/REQUIREMENTS.md
@.planning/v2.0-MILESTONE-AUDIT.md
@src/services/db.service.ts
@src/scheduler/cron.ts
@src/scheduler/cron.test.ts
@src/config.ts
@src/stores/message-store.ts

<interfaces>
<!-- Контракты, к которым обращается план. Извлечено из существующего кода — executor не должен лазить по проекту в поисках этих сигнатур. -->

From src/services/db.service.ts:
```typescript
export function initDb(): void;
export function getDb(): Database.Database; // throws if initDb() not called
export function closeDb(): void;
export function _resetForTests(): void; // test-only
```

From src/config.ts:
```typescript
// readEnvIntWithDefault('MESSAGE_RETENTION_DAYS', 90, 7)
config.messageRetentionDays: number; // default 90, min=7 enforced at boot
config.retentionSweepCron: string;   // default '0 1 * * *' UTC = 04:00 MSK
config.dbPath: string;               // ':memory:' допустим в тестах
```

From src/utils/logger.ts:
```typescript
export const logger: pino.Logger; // структурный логгер; используется как logger.info({...}, 'msg')
```

From src/scheduler/cron.ts (текущий стаб, который заменяем):
```typescript
async function retentionSweepHandler(): Promise<void> {
  logger.info('retention sweep stub — Phase 7 implements');
}
// registerJob('retention-sweep', config.retentionSweepCron, retentionSweepHandler);
// registerJob уже оборачивает handler в try/catch (SCHED-04) — наш код может бросать.
```

Schema (`messages` таблица из migration v1):
```sql
CREATE TABLE messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id       INTEGER NOT NULL,
  thread_id     INTEGER NOT NULL,
  tg_message_id INTEGER NOT NULL,
  ...
  created_at    TEXT NOT NULL,  -- ISO-8601 string
  edited_at     TEXT
);
CREATE INDEX idx_messages_created ON messages (created_at);
```
Колонка `created_at` хранится как ISO-8601 строка — ISO-строки сравниваются лексикографически и эквивалентно хронологически, поэтому `created_at < ?` с ISO-cutoff корректен и попадает в `idx_messages_created`.
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Pure runRetentionSweep service + tests</name>
  <files>src/services/retention.service.ts, src/services/retention.service.test.ts</files>
  <read_first>
    - src/services/db.service.ts (паттерн `getDb()` + how migrations seed schema; lines 87-198)
    - src/stores/message-store.ts (lazy `??=` prepared-statement pattern, lines 9-49 — повторяем подход)
    - src/services/state.service.test.ts (паттерн vitest + `_resetForTests` + initDb в `beforeEach`)
    - src/utils/logger.ts (логгер импорт)
    - src/config.ts (config.messageRetentionDays — НЕ хардкодим число)
    - .planning/v2.0-MILESTONE-AUDIT.md строки 42 и 174 (ссылка на текущий стаб)
  </read_first>
  <behavior>
    - T1: пустая таблица → `runRetentionSweep()` возвращает `{ rowsDeleted: 0, durationMs: number }`; пино-лог `{event: 'retention-sweep', rows_deleted: 0, duration_ms: D}` сработал ровно один раз.
    - T2: 5 строк `created_at` старее cutoff + 3 строки внутри окна → `rowsDeleted === 5`; после вызова `SELECT COUNT(*) FROM messages` возвращает 3.
    - T3: 2500 строк все старее cutoff → `rowsDeleted === 2500`; внутри произошло ≥3 итераций (батч ≤1000 на итерацию). Можно проверить через мок-spy на prepared-statement или на logger.debug счётчик итераций.
    - T4: cutoff вычисляется как `new Date(Date.now() - config.messageRetentionDays * 86400 * 1000).toISOString()` — параметр функции (или внутренний `Date.now()` mockable через vi.useFakeTimers).
    - T5: SQL — параметризован: `DELETE FROM messages WHERE created_at < ? AND id IN (SELECT id FROM messages WHERE created_at < ? ORDER BY created_at ASC LIMIT 1000)` (нельзя `DELETE ... LIMIT N` напрямую в sqlite без compile flag — используем подзапрос; cutoff передаём дважды).
    - T6: при ошибке внутри транзакции (например, getDb() кинет) — функция бросает `Error`; вызывающая сторона (registerJob wrap) логирует.
  </behavior>
  <action>
Создать `src/services/retention.service.ts` со следующим контрактом:

```typescript
import type { Statement } from 'better-sqlite3';
import { getDb } from './db.service.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

export interface RetentionSweepResult {
  rowsDeleted: number;
  durationMs: number;
}

const BATCH_SIZE = 1000;

let _deleteBatchStmt: Statement<[string, string]> | null = null;

function deleteBatchStmt(): Statement<[string, string]> {
  // Lazy-cached prepared statement (mirrors src/stores/message-store.ts pattern STORE-04).
  // Two parameters: outer cutoff (defensive), inner cutoff (selector).
  // sqlite3 не поддерживает `DELETE ... LIMIT N` без SQLITE_ENABLE_UPDATE_DELETE_LIMIT;
  // используем subquery с ORDER BY created_at ASC LIMIT 1000 — предсказуемое FIFO удаление.
  _deleteBatchStmt ??= getDb().prepare<[string, string]>(`
    DELETE FROM messages
    WHERE created_at < ?
      AND id IN (
        SELECT id FROM messages
        WHERE created_at < ?
        ORDER BY created_at ASC
        LIMIT ${BATCH_SIZE}
      )
  `);
  return _deleteBatchStmt;
}

/**
 * PRIV-03: Удаление сообщений старше config.messageRetentionDays.
 * Батч ≤1000 строк за итерацию, цикл до тех пор пока DELETE возвращает 0.
 * Параметризованный cutoff (никаких string-interpolation в SQL).
 *
 * Эмитит ровно один структурный pino-лог в конце:
 *   { event: 'retention-sweep', rows_deleted: N, duration_ms: D }
 *
 * Вызывается из src/scheduler/cron.ts retentionSweepHandler.
 * registerJob оборачивает в try/catch (SCHED-04) — функция может бросать.
 */
export async function runRetentionSweep(): Promise<RetentionSweepResult> {
  const startedAt = Date.now();
  const cutoffMs = startedAt - config.messageRetentionDays * 86400 * 1000;
  const cutoffIso = new Date(cutoffMs).toISOString();

  const stmt = deleteBatchStmt();
  let rowsDeleted = 0;
  let iterations = 0;
  // безопасный потолок (в очень большой БД на стартовом «зачищаем-всё»):
  // 10_000 итераций × 1000 = 10M строк, далее лучше упасть и проинвестигировать.
  const MAX_ITER = 10000;

  // synchronous better-sqlite3 — `await` не нужен, но возвращаемая Promise держит контракт async-handler.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (iterations >= MAX_ITER) {
      throw new Error(`runRetentionSweep exceeded ${MAX_ITER} iterations — abort`);
    }
    const info = stmt.run(cutoffIso, cutoffIso);
    iterations++;
    if (info.changes === 0) break;
    rowsDeleted += info.changes;
  }

  const durationMs = Date.now() - startedAt;
  logger.info(
    { event: 'retention-sweep', rows_deleted: rowsDeleted, duration_ms: durationMs },
    'Retention sweep complete',
  );
  return { rowsDeleted, durationMs };
}

// Test-only: invalidate cached prepared statement (mirrors message-store).
export function _resetRetentionServiceForTests(): void {
  _deleteBatchStmt = null;
}
```

Создать `src/services/retention.service.test.ts`:
- Импорт `vitest` (`describe`, `it`, `expect`, `beforeEach`, `vi`).
- Импорт `_resetForTests` из `db.service`, `_resetMessageStoreForTests` из `message-store`, `_resetRetentionServiceForTests` + `runRetentionSweep` из `retention.service`.
- В `beforeEach` reset + `initDb()` (config.dbPath = ':memory:' через `tests/setup.ts` env scaffolding).
- T1 (пустая таблица): `const r = await runRetentionSweep(); expect(r.rowsDeleted).toBe(0); expect(typeof r.durationMs).toBe('number')`.
- T2 (mixed): вставить через `getDb().prepare(INSERT INTO messages...)` 5 строк с `created_at = '2020-01-01T00:00:00.000Z'` и 3 с `new Date().toISOString()`; после `runRetentionSweep()` → `rowsDeleted === 5`, `SELECT COUNT(*) === 3`.
- T3 (multi-batch): вставить 2500 старых строк (один txn), запустить sweep → `rowsDeleted === 2500`, `SELECT COUNT(*) === 0`.
- T4 (structured log): использовать `vi.spyOn(logger, 'info')` (или импортировать `logger` напрямую и spy), убедиться, что вызван ровно один раз с объектом, содержащим ключ `event: 'retention-sweep'`, `rows_deleted: number`, `duration_ms: number`.
- T5 (SQL parameterised — defence in depth): убедиться, что в коде НЕТ конкатенации (этот тест статический — `expect(retentionSourceText.includes('${'))` через `readFileSync(retention.service.ts)` — допустимо, но проще: проверить, что переданный config.messageRetentionDays = 7 (минимум) удаляет только то, что старше 7 суток, а не больше).
  </action>
  <verify>
    <automated>npx vitest run src/services/retention.service.test.ts</automated>
  </verify>
  <acceptance_criteria>
    - `test -f src/services/retention.service.ts` exits 0
    - `test -f src/services/retention.service.test.ts` exits 0
    - `grep -c "export async function runRetentionSweep" src/services/retention.service.ts` returns 1
    - `grep -c "event.*retention-sweep" src/services/retention.service.ts` returns ≥1 (structured log emitted)
    - `grep -c "rows_deleted" src/services/retention.service.ts` returns ≥1
    - `grep -c "duration_ms" src/services/retention.service.ts` returns ≥1
    - `grep -c "LIMIT 1000\|LIMIT \${BATCH_SIZE}" src/services/retention.service.ts` returns ≥1
    - `grep -E '\\$\\{config\\.messageRetentionDays\\}|\\$\\{cutoff' src/services/retention.service.ts` returns 0 (никакой interpolation в SQL)
    - `grep -c "config.messageRetentionDays" src/services/retention.service.ts` returns ≥1 (значение читается из config, не хардкод)
    - `npx vitest run src/services/retention.service.test.ts` exits 0 with all tests passing
  </acceptance_criteria>
  <done>retention.service.ts реализует батчевый DELETE с пино-логом, тесты на 4+ кейса проходят.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Wire runRetentionSweep into cron retentionSweepHandler + cron.test.ts assertion</name>
  <files>src/scheduler/cron.ts, src/scheduler/cron.test.ts</files>
  <read_first>
    - src/scheduler/cron.ts строки 104-110 (текущий стаб, который заменяем)
    - src/scheduler/cron.ts строки 32-53 (registerJob — wraps in try/catch, SCHED-04 invariant)
    - src/scheduler/cron.test.ts (паттерн тестирования cron — vitest + node-cron mock)
    - src/services/retention.service.ts (Task 1 артефакт — импорт `runRetentionSweep`)
  </read_first>
  <action>
В `src/scheduler/cron.ts`:

1. Добавить импорт после уже существующего ряда импортов (строка ~20):
```typescript
import { runRetentionSweep } from '../services/retention.service.js';
```

2. Заменить тело функции `retentionSweepHandler` (строки 104-110, целиком включая JSDoc-блок `/** Phase 6 D-26 stub. Phase 7 replaces this body... */`):
```typescript
/**
 * Phase 7 PRIV-03: реальный retention sweep.
 * Делегирует в runRetentionSweep — батчевый DELETE LIMIT 1000 + structured pino-лог.
 * registerJob оборачивает вызов в try/catch (SCHED-04), так что брошенная отсюда
 * ошибка изолирована от digest и thread-summary jobs.
 */
async function retentionSweepHandler(): Promise<void> {
  await runRetentionSweep();
}
```

3. Удалить JSDoc-комментарий «Phase 6 D-26 stub. Phase 7 replaces this body...» — он больше не актуален.

В `src/scheduler/cron.test.ts` — добавить НОВЫЙ test case (не модифицируя существующие):

```typescript
it('R1 (Phase 7): retention-sweep registered as third job after digest+thread-summary', () => {
  startScheduler();
  const names = _getRegisteredJobNames();
  expect(names).toContain('retention-sweep');
  expect(names).toHaveLength(3);
});
```

Если в файле уже есть подобный тест на 3 job'а — оставить, не дублировать; вместо этого добавить **единственный** R2-тест (статический grep по исходнику cron.ts — проще и стабильнее, чем vi.mock):

```typescript
import { readFile } from 'node:fs/promises';

it('R2 (Phase 7): cron.ts no longer contains the stub log line and imports runRetentionSweep', async () => {
  const src = await readFile(new URL('./cron.ts', import.meta.url), 'utf-8');
  expect(src).not.toContain('retention sweep stub — Phase 7 implements');
  expect(src).toContain('runRetentionSweep');
});
```

**Не реализовывать vi.mock-альтернативу** — статический grep-тест полностью покрывает swap-acceptance и не страдает от brittleness mock-setup'а. Дополнительные acceptance criteria ниже (grep по исходнику) дают тот же результат на уровне CI.

**JSDoc removal scope:** удалить ТОЛЬКО JSDoc-комментарий на функции `retentionSweepHandler` (строки 104-110 в текущем `src/scheduler/cron.ts`). Top-of-file overview comment в строках 1-12 (где описан общий список cron-задач, включая запись `retention-sweep (04:00 MSK ...)`) **не трогать** — это отдельная документация структуры файла, не JSDoc на handler.
  </action>
  <verify>
    <automated>npx vitest run src/scheduler/cron.test.ts</automated>
  </verify>
  <acceptance_criteria>
    - `grep -c "retention sweep stub — Phase 7 implements" src/scheduler/cron.ts` returns 0 (стаб-строка снесена)
    - `grep -c "runRetentionSweep" src/scheduler/cron.ts` returns ≥2 (импорт + вызов)
    - `grep -c "import.*runRetentionSweep.*from.*retention.service" src/scheduler/cron.ts` returns 1
    - `grep -c "await runRetentionSweep" src/scheduler/cron.ts` returns 1
    - `grep -c "Phase 6 D-26 stub" src/scheduler/cron.ts` returns 0 (устаревший JSDoc на handler'е удалён)
    - `grep -c "retention-sweep (04:00 MSK" src/scheduler/cron.ts` returns ≥1 (top-of-file overview comment должен остаться — bounded JSDoc removal: вычищаем только handler-JSDoc, не вершину файла)
    - `npx vitest run src/scheduler/cron.test.ts` exits 0 (все тесты, включая R1/R2, проходят)
    - `npm run typecheck` exits 0
  </acceptance_criteria>
  <done>retentionSweepHandler делегирует в runRetentionSweep; стаб-комментарий удалён; cron-тест подтверждает swap.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| ENV → config.ts | `MESSAGE_RETENTION_DAYS` приходит из .env (контролируемая операторская граница; не пользовательский ввод, но числовая корректность критична). |
| cron tick → retention.service | Внутренняя граница: scheduler триггерит handler, handler вызывает service. |
| retention.service → SQLite | Параметризованные prepared statements; SQL не строится строкой. |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-07-01-01 | Tampering | `MESSAGE_RETENTION_DAYS` env interpolation | mitigate | `readEnvIntWithDefault('MESSAGE_RETENTION_DAYS', 90, 7)` уже валидирует целое число и min=7 в config.ts — нечисловое значение бросает на старте; в SQL значение приходит как параметр через `stmt.run(cutoffIso, cutoffIso)` (две связки), никакой `${}` интерполяции в строке запроса. |
| T-07-01-02 | Denial of Service | Excessive batch DELETE locking WAL | mitigate | `LIMIT 1000` на итерацию + цикл до 0 changes; better-sqlite3 sync write ~1ms на батч; WAL чекпойнт регулярно вытесняется фоновыми коммитами. Защитный потолок MAX_ITER=10_000 предотвращает infinite loop при поломанном index. |
| T-07-01-03 | Denial of Service | Cron double-fire wiping in-flight data | accept | Идемпотентность не нужна: повторный sweep на тех же данных удалит 0 строк (DELETE WHERE created_at < cutoff — мониторонная функция времени). Двойной fire безопасен. Документировано в JSDoc `runRetentionSweep`. |
| T-07-01-04 | Repudiation | No audit trail of deletion | accept | pino-лог `{event: 'retention-sweep', rows_deleted: N, duration_ms: D}` покрывает observability-нужду; полная audit-таблица не оправдана для small club (≤200 users) — задача retention в обратной логике. |
| T-07-01-05 | Information Disclosure | DELETE log raises rows_deleted exfil | accept | Лог содержит только агрегатное число строк, никакого text/author_id; PRIV-05 invariant соблюдён. |
| T-07-01-06 | Elevation of Privilege | Sweep across protected rows | mitigate | DELETE параметризован по `created_at < cutoff`; нет user-controlled WHERE клаузы. Нет path injection — fully data-driven cutoff. |

Block-on: high. Все high-severity угрозы (T-07-01-01, T-07-01-02, T-07-01-06) митигируются техническими средствами в коде. Accept-оценки на medium/low не требуют дополнительной работы.
</threat_model>

<verification>
- `npm run typecheck` exits 0 (никаких `any`, контракт `RetentionSweepResult` экспортирован).
- `npx vitest run src/services/retention.service.test.ts src/scheduler/cron.test.ts` — все тесты зелёные.
- Грэп-команды из `acceptance_criteria` каждой задачи возвращают ожидаемые значения.
- Smoke: `node --experimental-vm-modules -e "import('./dist/services/retention.service.js').then(m => m.runRetentionSweep())"` (после `npm run build`) — на пустой :memory: бд возвращает `{rowsDeleted: 0, durationMs: <small>}` и логирует одну INFO-строку.
</verification>

<success_criteria>
1. retention-sweep cron больше не stub: `grep -c "retention sweep stub" src/scheduler/cron.ts` == 0.
2. `runRetentionSweep()` существует, экспортирован, тесты проходят.
3. Структурный лог `{event: 'retention-sweep', rows_deleted, duration_ms}` подтверждён тестом.
4. Батч ≤1000 на итерацию подтверждён тестом T3 (2500 строк удаляются за ≥3 батча).
5. Параметризованный SQL — нет `${}` интерполяции.
6. SCHED-04 invariant сохраняется (registerJob per-job try/catch); другие cron jobs продолжают работать.
</success_criteria>

<output>
After completion, create `.planning/phases/07-v2-closure/07-01-SUMMARY.md` со списком созданных/изменённых файлов, числом тестов, метриками выполнения. Frontmatter `requirements_completed: [PRIV-03]`.
</output>
