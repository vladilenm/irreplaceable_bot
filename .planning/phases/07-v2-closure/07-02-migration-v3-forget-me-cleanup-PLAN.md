---
phase: 07-v2-closure
plan: 02
type: execute
wave: 1
depends_on: []
files_modified:
  - src/services/db.service.ts
  - src/services/db.service.test.ts
  - src/modules/capture/capture.handler.ts
  - src/stores/message-store.ts
  - src/stores/message-store.test.ts
autonomous: true
requirements: []
tags: [migration, schema, forgotten-users, capture, cleanup, gdpr]
must_haves:
  truths:
    - "Migration v3 ran on next boot drops the `forgotten_users` table; subsequent boot is a no-op (idempotent migration loop, schema_migrations row at version=3)."
    - "Capture handler at src/modules/capture/capture.handler.ts has no reference to `isAuthorForgotten` or `forgotten_users` — the guard is removed cleanly."
    - "src/stores/message-store.ts no longer exports `isAuthorForgotten` and no longer prepares any statement against `forgotten_users`."
    - "TypeScript build still passes (no orphan import); all existing capture tests still pass."
    - "tracked-threads-store.test.ts M2 assertion (`toContain(1)` + `toContain(2)`) passes as-is because `toContain` accepts any superset including `[1, 2, 3]` — this plan does NOT modify that test file (it is owned by Plan 07-03 in same wave, and no edit is required for v3 to land cleanly)."
    - "Manual /forget-me runbook is captured by Plan 05 (operator workflow doc), not by this plan — this plan is code/schema only."
  artifacts:
    - path: "src/services/db.service.ts"
      provides: "MIGRATIONS array extended with version 3"
      contains: "version: 3"
    - path: "src/modules/capture/capture.handler.ts"
      provides: "Capture handler without forgotten_users guard"
    - path: "src/stores/message-store.ts"
      provides: "Message store without isAuthorForgotten export and forgottenStmt"
  key_links:
    - from: "src/services/db.service.ts MIGRATIONS"
      to: "schema_migrations"
      via: "applyMigration transaction at line 134-139"
      pattern: "version: 3"
    - from: "src/modules/capture/capture.handler.ts"
      to: "src/stores/message-store.ts"
      via: "import { upsertMessage } only"
      pattern: "import \\{ upsertMessage \\}"
---

<objective>
Закрыть Success Criterion 2: миграция v3 сносит таблицу `forgotten_users`, capture handler теряет guard на эту таблицу, message-store теряет `isAuthorForgotten` + prepared statement. Манульный `/forget-me` runbook документируется в Plan 05 (этот план — только код и схема).

Purpose: PRIV-01/CMD-07 (in-chat `/forget-me` команда) был удалён вместе с Phase 7 (de-scoped 2026-04-29). Таблица `forgotten_users` остаётся read-only — никто никогда не пишет в неё, capture-guard всегда возвращает false. Это мёртвая инфраструктура: read overhead на каждое сообщение, орфан-схема, путаница для будущего читателя кода. Снести.

**B5 fix — race elimination:** `src/stores/tracked-threads-store.test.ts` принадлежит Plan 07-03 `files_modified`, не 07-02. Existing M2 test использует `expect(versions).toContain(1); expect(versions).toContain(2);` — это permissive assertions, которые passes для любого superset (включая `[1, 2, 3]`). Migration v3 land'ает без модификации этого test'а. Поэтому ни Task этого плана, ни acceptance criterion НЕ ссылаются на `tracked-threads-store.test.ts` — file ownership 100% Plan 07-03, никаких race-conditions в wave 1.

Output:
- В `MIGRATIONS` массиве (db.service.ts) добавлена запись `{ version: 3, description: 'Phase 7: drop forgotten_users (CMD-07 de-scoped)', sql: 'DROP TABLE IF EXISTS forgotten_users;' }`.
- Capture handler чище: guard-блок (lines 55-60) удалён, импорт `isAuthorForgotten` снят.
- message-store потерял `forgottenStmt`, `isAuthorForgotten`, обнулён `_forgottenStmt` в `_resetMessageStoreForTests`. Снят `forgotten_users` SELECT.
- Тесты `message-store.test.ts` (если ссылаются на `isAuthorForgotten`) почищены; `capture.handler` не имеет тестов на эту ветку (проверено: `grep -r isAuthorForgotten src/**/*.test.ts` не находит ничего).
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@.planning/ROADMAP.md
@.planning/v2.0-MILESTONE-AUDIT.md
@src/services/db.service.ts
@src/modules/capture/capture.handler.ts
@src/stores/message-store.ts
@src/stores/message-store.test.ts

<interfaces>
<!-- Текущие сигнатуры — executor должен их соблюсти -->

From src/stores/message-store.ts (целевое состояние ПОСЛЕ плана):
```typescript
export function upsertMessage(m: CapturedMessage): void;             // ОСТАЁТСЯ
export function selectMessagesInWindow(...): CapturedMessage[];       // ОСТАЁТСЯ
export function selectTopParticipants(...): ParticipantStat[];        // ОСТАЁТСЯ
export function _resetMessageStoreForTests(): void;                   // ОСТАЁТСЯ (обновляется — убираем _forgottenStmt = null)
// REMOVED: isAuthorForgotten, _forgottenStmt, forgottenStmt()
```

From src/services/db.service.ts MIGRATIONS массив:
```typescript
const MIGRATIONS: ReadonlyArray<Migration> = [
  { version: 1, description: 'Phase 4: messages capture infrastructure (4 tables + indexes)', sql: '...' },
  { version: 2, description: 'Phase 6 D-05: tracked_threads.title (forum-topic display name cache)', sql: 'ALTER TABLE tracked_threads ADD COLUMN title TEXT;' },
  // ДОБАВЛЯЕМ:
  { version: 3, description: 'Phase 7: drop forgotten_users (CMD-07 de-scoped 2026-04-29)', sql: 'DROP TABLE IF EXISTS forgotten_users;' },
];
```
applyMigration уже оборачивает каждую миграцию в её собственную транзакцию (db.service.ts:134-139), форматный паттерн соблюдён.

Capture handler — текущий guard блок (capture.handler.ts:55-60), который УБИРАЕМ:
```typescript
// Forgotten-user guard (D-12, closes PRIV-02 ahead of Phase 8 /forget-me).
// Anon admins (authorId === null) skip this check — NULL never matches.
if (captured.authorId !== null && isAuthorForgotten(captured.authorId)) {
  logger.debug({ author_id: captured.authorId }, 'Skipping message from forgotten user');
  return;
}
```

**Cross-plan file ownership note (B5):** `src/stores/tracked-threads-store.test.ts` принадлежит Plan 07-03 (он удаляет `upsertThreadTitle` describe-block). Migration v3 НЕ требует обновления этого теста — M2 ассерты `toContain(1)` + `toContain(2)` passes для superset `[1, 2, 3]`. Никаких edits этого файла из 07-02.
</interfaces>

**Pitfall:** sqlite `DROP TABLE IF EXISTS` is safe and idempotent. Migration v3 is an irreversible (forward-only) drop — но table сейчас содержит 0 rows в production (D-12: `forgotten_users` никогда не получала writer-кода в v2.0; CMD-07 de-scoped). Risk = принят (см. threat_model).
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Add migration v3 + assert with new test in db.service.test.ts</name>
  <files>src/services/db.service.ts, src/services/db.service.test.ts</files>
  <read_first>
    - src/services/db.service.ts полностью (MIGRATIONS-паттерн + applyMigration)
    - src/services/db.service.test.ts (если существует — добавляем новый describe; если нет — создаём)
  </read_first>
  <behavior>
    - Mig-T1: после `initDb()` в `:memory:` БД, `SELECT version FROM schema_migrations ORDER BY version` возвращает массив, который `toContain(1)`, `toContain(2)`, `toContain(3)` — все три версии applied.
    - Mig-T2: после `initDb()` таблица `forgotten_users` НЕ существует — `SELECT name FROM sqlite_master WHERE type='table' AND name='forgotten_users'` возвращает 0 строк.
    - Mig-T3: повторный `_resetForTests(); initDb()` — schema_migrations всё ещё содержит версию 3 (миграции идемпотентны через cache `applied`).
    - Mig-T4: миграция v3 имеет описание `'Phase 7: drop forgotten_users (CMD-07 de-scoped 2026-04-29)'` — простой grep на массиве.
  </behavior>
  <action>
В `src/services/db.service.ts` строка 73-74 (после migration v2 объекта, перед `// future versions append here`):

Добавить миграцию:
```typescript
  {
    version: 3,
    description: 'Phase 7: drop forgotten_users (CMD-07 de-scoped 2026-04-29)',
    sql: `
      DROP TABLE IF EXISTS forgotten_users;
    `,
  },
```

Создать (или дополнить, если уже есть) тестовый файл `src/services/db.service.test.ts` с тестами Mig-T1..T4. Используем `vitest`, `_resetForTests`, `initDb`, `getDb`. Если файл уже существует — добавить новый describe('migration v3 — drop forgotten_users (Phase 7)', ...) с указанными тестами; не трогать другие existing блоки.

**B5 note:** НЕ ТРОГАТЬ `src/stores/tracked-threads-store.test.ts` из этого плана — он owned by Plan 07-03 (тот удаляет describe блок upsertThreadTitle). Existing M2 (`toContain(1)` + `toContain(2)`) passes как-есть для миграции v3, потому что versions массив становится `[1, 2, 3]` и `toContain` работает на superset.

Пример теста Mig-T2 (пишется в `db.service.test.ts`, не в `tracked-threads-store.test.ts`):
```typescript
it('Mig-T2: forgotten_users table does not exist after initDb', () => {
  const rows = getDb()
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'forgotten_users'")
    .all();
  expect(rows).toHaveLength(0);
});
```

Пример Mig-T1:
```typescript
it('Mig-T1: schema_migrations contains version 3', () => {
  const versions = (
    getDb()
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all() as Array<{ version: number }>
  ).map((r) => r.version);
  expect(versions).toContain(1);
  expect(versions).toContain(2);
  expect(versions).toContain(3);
});
```
  </action>
  <verify>
    <automated>npx vitest run src/services/db.service.test.ts</automated>
  </verify>
  <acceptance_criteria>
    - `grep -c "version: 3" src/services/db.service.ts` returns ≥1
    - `grep -c "DROP TABLE IF EXISTS forgotten_users" src/services/db.service.ts` returns 1
    - `grep -c "Phase 7: drop forgotten_users (CMD-07 de-scoped 2026-04-29)" src/services/db.service.ts` returns 1
    - `npx vitest run src/services/db.service.test.ts` exits 0 with new Mig-T1..Mig-T4 passing
    - `npx vitest run src/stores/tracked-threads-store.test.ts` exits 0 БЕЗ модификации этого файла из этого плана (B5: M2 passes as-is, file owned by 07-03)
    - `npm run typecheck` exits 0
  </acceptance_criteria>
  <done>Миграция v3 в массиве, тесты подтверждают отсутствие таблицы forgotten_users после boot. tracked-threads-store.test.ts не модифицирован из этого плана.</done>
</task>

<task type="auto">
  <name>Task 2: Strip forgotten_users from capture handler + message-store + tests</name>
  <files>src/modules/capture/capture.handler.ts, src/stores/message-store.ts, src/stores/message-store.test.ts</files>
  <read_first>
    - src/modules/capture/capture.handler.ts (полностью — guard блок строки 55-60; импорт строка 4)
    - src/stores/message-store.ts (полностью — `_forgottenStmt`, `forgottenStmt`, `isAuthorForgotten`, `_resetMessageStoreForTests`)
    - src/stores/message-store.test.ts (проверить наличие тестов на `isAuthorForgotten` — `grep -nE "isAuthorForgotten|forgotten" src/stores/message-store.test.ts`; если найдено — снести соответствующий блок `describe`/`it`)
  </read_first>
  <action>
**Файл 1: `src/modules/capture/capture.handler.ts`**

1. Изменить import на строке 4:
   ```typescript
   import { upsertMessage, isAuthorForgotten } from '../../stores/message-store.js';
   ```
   → стало:
   ```typescript
   import { upsertMessage } from '../../stores/message-store.js';
   ```

2. Удалить guard блок (строки 55-60 включительно — JSDoc комментарий + if):
   ```typescript
       // Forgotten-user guard (D-12, closes PRIV-02 ahead of Phase 8 /forget-me).
       // Anon admins (authorId === null) skip this check — NULL never matches.
       if (captured.authorId !== null && isAuthorForgotten(captured.authorId)) {
         logger.debug({ author_id: captured.authorId }, 'Skipping message from forgotten user');
         return;
       }
   ```
   После удаления гард-блока, последовательность в captureHandler становится: `mapTelegramMessageToCaptured(ctx)` → null check → `upsertMessage(captured)` → debug-лог.

**Файл 2: `src/stores/message-store.ts`**

1. Удалить declaration строку 10:
   ```typescript
   let _forgottenStmt: Statement<[number]> | null = null;
   ```

2. Удалить функцию `forgottenStmt()` (строки 51-56 целиком включая JSDoc если есть):
   ```typescript
   function forgottenStmt(): Statement<[number]> {
     _forgottenStmt ??= getDb().prepare<[number]>(
       'SELECT 1 FROM forgotten_users WHERE author_id = ?',
     );
     return _forgottenStmt;
   }
   ```

3. Удалить экспорт `isAuthorForgotten` (строки 116-126 — JSDoc + функция):
   ```typescript
   /**
    * Pre-INSERT forgotten-user guard (D-12, closes PRIV-02 in Phase 4 ahead of
    * Phase 8 /forget-me). Returns true if author_id has a row in forgotten_users.
    *
    * Caller (capture handler) MUST short-circuit when this returns true — never
    * write a captured row for a forgotten user. Anon admins (author_id === null)
    * never call this function (NULL never matches anything).
    */
   export function isAuthorForgotten(authorId: number): boolean {
     return forgottenStmt().get(authorId) !== undefined;
   }
   ```

4. В `_resetMessageStoreForTests()` удалить строку `_forgottenStmt = null;` (если осталась после п. 1):
   ```typescript
   export function _resetMessageStoreForTests(): void {
     _upsertStmt = null;
     _forgottenStmt = null;   // ← удалить
     _selectWindowStmt = null;
     _selectTopParticipantsStmt = null;
   }
   ```

**Файл 3: `src/stores/message-store.test.ts`** (только если содержит тесты на `isAuthorForgotten`)

Запустить:
```bash
grep -nE "isAuthorForgotten|forgotten" src/stores/message-store.test.ts
```
Если grep возвращает строки — удалить соответствующий describe/it блок (ищем по `describe('isAuthorForgotten'` или `it.*forgotten`). Если grep возвращает 0 — задача файла message-store.test.ts отсутствует, ничего не делаем.
  </action>
  <verify>
    <automated>npm run typecheck && npx vitest run src/stores/message-store.test.ts src/modules/capture</automated>
  </verify>
  <acceptance_criteria>
    - `grep -c "isAuthorForgotten" src/modules/capture/capture.handler.ts` returns 0
    - `grep -c "forgotten" src/modules/capture/capture.handler.ts` returns 0
    - `grep -c "isAuthorForgotten" src/stores/message-store.ts` returns 0
    - `grep -c "forgotten_users" src/stores/message-store.ts` returns 0
    - `grep -c "_forgottenStmt" src/stores/message-store.ts` returns 0
    - `grep -c "forgottenStmt" src/stores/message-store.ts` returns 0
    - `grep -rn "isAuthorForgotten" src/` returns 0 lines (export and all callsites gone)
    - `npm run typecheck` exits 0 (no orphan import or undefined identifier)
    - `npx vitest run` exits 0 (full suite, including capture and message-store tests)
  </acceptance_criteria>
  <done>capture.handler и message-store больше не ссылаются на forgotten_users; все тесты зелёные.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| Migration runner → SQLite | Forward-only DDL; миграции применяются в транзакции (PITFALLS DB-04). |
| Capture handler hot path | Guard убран — каждое сообщение теперь идёт прямо в upsertMessage. |
| GDPR Art. 17 (right to erasure) | До этого плана: write path (`/forget-me`) отсутствовал; read guard был активен но бесполезен. После плана: write path по-прежнему отсутствует, но операторский runbook (Plan 05) даёт ручной путь через sqlite3 CLI. |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-07-02-01 | Tampering | Migration v3 destroys data | accept | `forgotten_users` table в production содержит 0 rows: writer-код (`/forget-me`) никогда не существовал в v2.0 (CMD-07 de-scoped). Pre-check на data-loss не нужен. Документировано в Plan-objective. Если в каком-то forked deployment table не пуста, `DROP TABLE` вернёт error на FK-зависимостях — но FK на `forgotten_users` нет (Phase 4 D — «no FKs in v1»). |
| T-07-02-02 | Tampering | Migration runner has no `down` | accept | Migration system — forward-only by design (D-07, db.service.ts:11-13). Откат: восстановить `CREATE TABLE forgotten_users (...)` через миграцию v4 если когда-либо понадобится. Документировано в JSDoc миграционного массива (комментарий на line 11: «NEVER edit a shipped version; add a new one»). |
| T-07-02-03 | Repudiation | Re-introduction of forgotten-users path | mitigate | Acceptance criteria грэп: `grep -rn "isAuthorForgotten" src/` возвращает 0. Любой PR который вернёт guard упадёт при code review (или мы добавим linting правило в будущем). На v2.0 этого достаточно. |
| T-07-02-04 | Information Disclosure | Capture handler now stores all messages | accept | Capture handler ВСЕГДА хранил все сообщения; guard был active-by-design мёртвым кодом (нет writer'а в forgotten_users). Этот план не меняет risk surface — лишь убирает пустую функцию. PRIV-05 (никакого text body в логах) и retention-sweep (Plan 01, 90-day TTL) — основные mitigations для privacy. |
| T-07-02-05 | Denial of Service | DROP TABLE locks DB | accept | sqlite3 `DROP TABLE` на пустой/малой таблице — операция milliseconds. Migration v3 запускается ровно один раз в boot, до polling-старта (initDb runs before bot.start). Никакого продакшн impact на capture flow. |
| T-07-02-06 | Elevation of Privilege | GDPR Art. 17 compliance gap | mitigate | Operator runbook в `04-OPS-CHECKLIST.md` (Plan 05) даёт явный SQL: `DELETE FROM messages WHERE author_id = ?` — закрывает legal-obligation, хоть и manually. До auto-enforcement через CMD-07 (отложено в v2.1+). |
| T-07-02-07 | Tampering | Cross-wave file race with Plan 07-03 | mitigate | B5 fix: этот план НЕ редактирует `src/stores/tracked-threads-store.test.ts` (owned by Plan 07-03). Existing M2 assertions (`toContain(1)` + `toContain(2)`) passes для superset `[1, 2, 3]` — миграция v3 land'ает без модификации этого файла. Wave-1 parallel safety preserved (zero file overlap). |

Block-on: high. T-07-02-03 (re-introduction prevention), T-07-02-06 (GDPR compliance), T-07-02-07 (cross-plan race) — high severity; митигированы grep-acceptance criterion, кросс-плановой ссылкой на Plan 05 runbook, и file-ownership boundary.
</threat_model>

<verification>
- `npm run typecheck` exits 0.
- `npx vitest run` — полный сьют зелёный (включая `src/services/db.service.test.ts`, `src/stores/message-store.test.ts`, `src/scheduler/cron.test.ts`, `src/stores/tracked-threads-store.test.ts` — последний работает БЕЗ модификации со стороны этого плана).
- `grep -rn "forgotten" src/` возвращает 0 строк (полная зачистка).
- `grep -rn "isAuthorForgotten" src/` возвращает 0.
- Boot smoke: `node dist/index.js` (или vitest startup test) — initDb применяет миграцию v3 без ошибок, schema_migrations имеет version=3.
- Files actually modified by this plan match `files_modified` frontmatter exactly (5 files: db.service.ts, db.service.test.ts, capture.handler.ts, message-store.ts, message-store.test.ts) — никаких лишних edits.
</verification>

<success_criteria>
1. Migration v3 в массиве, описание содержит точную фразу `'Phase 7: drop forgotten_users (CMD-07 de-scoped 2026-04-29)'`.
2. После initDb таблица `forgotten_users` отсутствует (Mig-T2).
3. capture.handler.ts: 0 ссылок на `isAuthorForgotten` или `forgotten_users`.
4. message-store.ts: 0 ссылок на `isAuthorForgotten`, `_forgottenStmt`, `forgottenStmt`, `forgotten_users`.
5. typecheck + полный test suite зелёные (включая tracked-threads-store.test.ts unmodified by this plan).
6. SCHED-04 invariant сохраняется (никакого вмешательства в cron).
7. **B5: zero edits to `src/stores/tracked-threads-store.test.ts` from this plan — file owned by Plan 07-03.**
</success_criteria>

<output>
After completion, create `.planning/phases/07-v2-closure/07-02-SUMMARY.md` со списком созданных/изменённых файлов и подтверждением, что migration v3 применилась идемпотентно. Frontmatter `requirements_completed: []` (этот план — gap-closure, не закрывает REQ-IDs напрямую — только убирает legacy-инфраструктуру).
</output>
</content>
</invoke>