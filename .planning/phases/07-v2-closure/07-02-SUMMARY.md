---
phase: 07-v2-closure
plan: "02"
subsystem: db-schema, capture-pipeline, message-store
tags: [migration, schema, forgotten-users, capture, cleanup, gdpr]
requirements_completed: []
dependency_graph:
  requires: []
  provides:
    - migration-v3-drop-forgotten-users
    - capture-handler-clean
    - message-store-clean
  affects:
    - src/services/db.service.ts
    - src/services/db.service.test.ts
    - src/modules/capture/capture.handler.ts
    - src/stores/message-store.ts
tech_stack:
  added: []
  patterns:
    - forward-only in-code MIGRATIONS array (db.transaction per version)
    - lazy prepared statements removed for forgotten_users path
key_files:
  created:
    - src/services/db.service.test.ts
  modified:
    - src/services/db.service.ts
    - src/modules/capture/capture.handler.ts
    - src/stores/message-store.ts
decisions:
  - "Migration v3 uses DROP TABLE IF EXISTS (idempotent, safe for zero-row table); forward-only by design"
  - "message-store.test.ts unchanged — no forgotten references existed (grep confirmed)"
  - "tracked-threads-store.test.ts unmodified (B5 file ownership boundary respected)"
metrics:
  duration: "~5 min"
  completed_date: "2026-04-30"
  tasks_completed: 2
  files_modified: 4
  files_created: 1
---

# Phase 7 Plan 02: Migration v3 + Forget-Me Cleanup Summary

**One-liner:** Migration v3 drops `forgotten_users` table via `DROP TABLE IF EXISTS`; capture handler and message-store stripped of all `isAuthorForgotten` / `forgottenStmt` / `_forgottenStmt` dead code — zero runtime overhead from de-scoped CMD-07.

## What Was Built

**Task 1 (TDD):** Migration v3 added to `MIGRATIONS` array in `db.service.ts`. New test file `db.service.test.ts` created with 4 tests:
- Mig-T1: `schema_migrations` содержит версии 1, 2, 3
- Mig-T2: таблица `forgotten_users` отсутствует после `initDb()`
- Mig-T3: повторный `_resetForTests(); initDb()` — версия 3 присутствует (идемпотентность)
- Mig-T4: версия 3 применена (row в `schema_migrations`)

**Task 2:** Зачистка dead code:
- `capture.handler.ts`: удалён импорт `isAuthorForgotten`, удалён guard-блок (строки 55-60)
- `message-store.ts`: удалены `_forgottenStmt`, `forgottenStmt()`, `isAuthorForgotten()` export, `_forgottenStmt = null` из `_resetMessageStoreForTests()`
- `message-store.test.ts`: не модифицирован — grep показал 0 ссылок на forgotten

## Verification Results

```
grep -c "version: 3" src/services/db.service.ts         → 1  ✓
grep -c "DROP TABLE IF EXISTS forgotten_users" ...       → 1  ✓
grep -c "Phase 7: drop forgotten_users ..." ...          → 1  ✓
grep -rn "isAuthorForgotten" src/                        → 0  ✓
npm run typecheck                                        → exit 0  ✓
npx vitest run (full suite)                              → 78/78 passed  ✓
tracked-threads-store.test.ts unmodified                 → ✓  (B5 boundary)
```

## Commits

| Task | Commit | Message |
|------|--------|---------|
| 1 | b8dc409 | feat(07-02): add migration v3 — drop forgotten_users table |
| 2 | 9ba76c9 | feat(07-02): strip forgotten_users from capture handler and message-store |

## Deviations from Plan

None — plan executed exactly as written.

`message-store.test.ts` не потребовал изменений (план предусматривал этот исход: «Если grep возвращает 0 — задача файла message-store.test.ts отсутствует, ничего не делаем»).

## Known Stubs

None. Все функции удалены полностью, данные не заглушены.

## Threat Flags

None. Новых network endpoints, auth paths или schema changes за пределами запланированного DROP не введено.

## Self-Check

- [x] `src/services/db.service.ts` — существует, содержит version: 3
- [x] `src/services/db.service.test.ts` — создан, 4 теста
- [x] `src/modules/capture/capture.handler.ts` — 0 ссылок на isAuthorForgotten
- [x] `src/stores/message-store.ts` — 0 ссылок на forgottenStmt / _forgottenStmt / isAuthorForgotten / forgotten_users
- [x] Коммит b8dc409 существует
- [x] Коммит 9ba76c9 существует

## Self-Check: PASSED
