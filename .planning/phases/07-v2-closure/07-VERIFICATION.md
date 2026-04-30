---
phase: 07-v2-closure
verified: 2026-04-30T14:43:00Z
status: human_needed
score: 12/13 must-haves verified
overrides_applied: 0
human_verification:
  - test: "Проверить стейлый top-of-file комментарий в cron.ts: строка 8 содержит 'STUB (Phase 7 implements)' — хотя handler больше не stub. Оценить: обновить ли верхний overview-комментарий или оставить как есть (план-07-01 явно предписал не трогать)."
    expected: "Либо комментарий обновлён: 'retention-sweep ... — Phase 7 PRIV-03 (runRetentionSweep)', либо принято решение оставить с пометкой исторической метки."
    why_human: "Это документационное расхождение, которое план-01 явно решил не трогать. Требуется решение разработчика: принять как есть или закрыть отдельным коммитом."
  - test: "Проверить STORE-03 в REQUIREMENTS.md: wording упоминает 'forgotten_users' как часть схемы, хотя migration v3 (Plan 07-02) её дропает. Оценить: обновить ли STORE-03 wording или оставить как описание Phase 4 original schema."
    expected: "Либо STORE-03 обновлён (убрана ссылка на forgotten_users), либо принято осознанное решение оставить как Phase 4 historical wording."
    why_human: "Plan 07-04 не охватывал исправление STORE-03 wording. Технически схема после migration v3 не имеет forgotten_users — minor documentation drift требует осознанного решения."
---

# Phase 7: v2.0 Closure Verification Report

**Phase Goal:** Close all v2.0 milestone gaps identified in v2.0-MILESTONE-AUDIT.md: retention sweep implementation, forget-me infrastructure removal, dead code cleanup, documentation drift fix, and Phase 0-Ops checklist scaffold.
**Verified:** 2026-04-30T14:43:00Z
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Cron job 'retention-sweep' fires с реальным runRetentionSweep (PRIV-03 реализован) | ✓ VERIFIED | cron.ts line 112: `await runRetentionSweep()`; import on line 21; stub log строка отсутствует |
| 2 | Батч DELETE LIMIT 1000 + structured pino INFO лог | ✓ VERIFIED | retention.service.ts: BATCH_SIZE=1000, correlated subquery, logger.info({event:'retention-sweep', rows_deleted, duration_ms}) |
| 3 | MESSAGE_RETENTION_DAYS из config, без SQL-интерполяции | ✓ VERIFIED | grep на `\${config.messageRetentionDays}` в SQL → 0; config.messageRetentionDays используется для cutoffMs |
| 4 | SCHED-04 invariant сохранён (per-job try/catch) | ✓ VERIFIED | cron.ts registerJob оборачивает каждый handler в try/catch; все 3 job'а изолированы |
| 5 | Migration v3 дропает forgotten_users (идемпотентно) | ✓ VERIFIED | db.service.ts: version:3, DROP TABLE IF EXISTS forgotten_users; тест Mig-T2 проходит |
| 6 | capture.handler.ts и message-store.ts очищены от forgotten_users | ✓ VERIFIED | grep isAuthorForgotten src/ → 0 строк; grep forgotten_users message-store.ts → 0 |
| 7 | isThreadSummaryPublishedToday (bare) удалена из кодовой базы | ✓ VERIFIED | grep src/ → 0 строк; только WithState-версия присутствует |
| 8 | upsertThreadTitle удалена из tracked-threads-store | ✓ VERIFIED | grep upsertThreadTitle src/ → 0 строк |
| 9 | tracking.service.ts: stale Phase 5/7 future-work комментарии заменены | ✓ VERIFIED | Phase 5 как "cancelled 2026-04-29"; нет Phase 7/8 future упоминаний; thread-summary orchestrator упомянут |
| 10 | .env.example MESSAGE_RETENTION_DAYS=90 (было =2) | ✓ VERIFIED | grep → MESSAGE_RETENTION_DAYS=90 |
| 11 | REQUIREMENTS.md: MSG-04 wording, 19 Phase 6 checkbox [x], PRIV-03 [x], 18 cancelled удалены | ✓ VERIFIED | ON CONFLICT wording: 1; SUM-01..07 [x]: 7; PRIV-03 [x]: 1; CMD/OBS/TRK/PRIV-01/02/05 → 0 в main list |
| 12 | Phase 6 SUMMARY frontmatter requirements_completed заполнены | ✓ VERIFIED | 06-01: [SUM-01..07, AI-07]; 06-02: [STATE-01/02, SCHED-01..04]; 06-03: [DLV-06..10] |
| 13 | 04-OPS-CHECKLIST.md создан со всеми 6 секциями + 10 E2E + runbook SQL | ✓ VERIFIED | Файл существует; все 6 H2 секций присутствуют; P4-E1..7 (7 строк); P6-E1..3 (3 строки); DELETE FROM messages WHERE author_id; YAML frontmatter с --- |

**Score:** 13/13 truths verified

### Human Verification Required

Два пункта требуют решения разработчика (не являются блокерами для цели фазы, но создают minor documentation imprecision):

#### 1. Stale STUB comment в top-of-file cron.ts

**Тест:** Проверить строку 8 в `src/scheduler/cron.ts` — там написано:
`//   - retention-sweep (04:00 MSK / config.retentionSweepCron) — STUB (Phase 7 implements)`

**Ожидаемое:** Либо обновить в: `— Phase 7 PRIV-03 (runRetentionSweep, real impl)`, либо принять решение оставить с осознанием.

**Почему требует человека:** Plan 07-01 Task 2 явно предписал не трогать этот top-of-file overview comment. Это документальное расхождение (handler больше не stub), которое образовалось именно потому, что план сознательно ограничил scope изменений. Решение — за разработчиком.

#### 2. STORE-03 в REQUIREMENTS.md упоминает forgotten_users

**Тест:** `grep "STORE-03" .planning/REQUIREMENTS.md` показывает:
`Schema includes messages, tracked_threads, users, forgotten_users tables`

**Ожидаемое:** После migration v3 таблица `forgotten_users` отсутствует. STORE-03 описывает Phase 4 original schema — либо обновить wording, либо принять как историческое описание.

**Почему требует человека:** Plan 07-04 не был нацелен на исправление STORE-03 wording. Это minor documentation drift. Не влияет на функциональность, но создаёт несоответствие между REQUIREMENTS.md и реальной схемой БД.

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/services/retention.service.ts` | Pure retention-sweep с batched DELETE + structured log | ✓ VERIFIED | 101 LOC; runRetentionSweep, RetentionSweepResult, _resetRetentionServiceForTests |
| `src/services/retention.service.test.ts` | Unit tests: batching, cutoff, log shape | ✓ VERIFIED | 5 тестов, все проходят |
| `src/scheduler/cron.ts` | retentionSweepHandler делегирует в runRetentionSweep | ✓ VERIFIED | await runRetentionSweep() на строке 112; import на строке 21 |
| `src/services/db.service.ts` | MIGRATIONS содержит version: 3 | ✓ VERIFIED | DROP TABLE IF EXISTS forgotten_users |
| `src/modules/capture/capture.handler.ts` | Без forgotten_users guard | ✓ VERIFIED | grep isAuthorForgotten → 0; grep forgotten → 0 |
| `src/stores/message-store.ts` | Без isAuthorForgotten и forgottenStmt | ✓ VERIFIED | grep → 0 по всем removed identifiers |
| `.planning/REQUIREMENTS.md` | Post-cleanup, 39 in-scope reqs, Phase 6 [x], PRIV-03 [x] | ✓ VERIFIED | ON CONFLICT wording, 7 SUM [x], traceability 39 строк |
| `.planning/STATE.md` | path fixed: 04-message-capture-persistence/ | ✓ VERIFIED | grep → 1 совпадение; stale path → 0 |
| `.planning/phases/06-thread-summary-pipeline/06-01-SUMMARY.md` | requirements_completed: [SUM-01..07, AI-07] | ✓ VERIFIED | Frontmatter ключ присутствует |
| `.planning/phases/06-thread-summary-pipeline/06-02-SUMMARY.md` | requirements_completed: [STATE-01/02, SCHED-01..04] | ✓ VERIFIED | Frontmatter ключ присутствует |
| `.planning/phases/06-thread-summary-pipeline/06-03-SUMMARY.md` | requirements_completed: [DLV-06..10] | ✓ VERIFIED | Frontmatter ключ присутствует |
| `.planning/phases/04-message-capture-persistence/04-OPS-CHECKLIST.md` | 6 секций + 10 E2E + runbook SQL | ✓ VERIFIED | Все 6 H2 headings; 27 OPERATOR FILLS markers; YAML --- frontmatter |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| cron.ts retentionSweepHandler | retention.service.ts runRetentionSweep | direct import + await | ✓ WIRED | import на строке 21, await на строке 112 |
| retention.service.ts | db.service.ts getDb | prepared statement, параметры не интерполированы | ✓ WIRED | stmt.run(cutoffIso, cutoffIso) — два параметра |
| db.service.ts MIGRATIONS | schema_migrations | applyMigration transaction | ✓ WIRED | version: 3 в массиве; Mig-T1 тест подтверждает |
| capture.handler.ts | message-store.ts | import { upsertMessage } only | ✓ WIRED | isAuthorForgotten import удалён; только upsertMessage остался |
| REQUIREMENTS.md MSG-04 | message-store.ts upsertStmt | wording matches actual SQL | ✓ WIRED | ON CONFLICT(chat_id, tg_message_id) DO UPDATE присутствует |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|-------------------|--------|
| retention.service.ts | rowsDeleted, durationMs | batched DELETE на реальной таблице messages | Да — stmt.run() на живой SQLite | ✓ FLOWING |
| cron.ts retentionSweepHandler | — (void, side effect) | await runRetentionSweep() | Да — делегирует реальному service | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| retention.service.test.ts — 5 тестов проходят | `npx vitest run src/services/retention.service.test.ts` | 5 passed (5) | ✓ PASS |
| cron.test.ts — 8 тестов проходят (включая R1/R2 Phase 7) | `npx vitest run src/scheduler/cron.test.ts` | 8 passed (8) | ✓ PASS |
| db.service.test.ts — Mig-T1..T4 проходят | `npx vitest run src/services/db.service.test.ts` | 4 passed (4) | ✓ PASS |
| Полный suite — 84 теста | `npx vitest run` | 84 passed (84) в 13 test files | ✓ PASS |
| TypeScript typecheck | `npm run typecheck` | exit 0, no errors | ✓ PASS |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| PRIV-03 | Plan 07-01 | 90-day retention sweep, LIMIT 1000 | ✓ SATISFIED | runRetentionSweep реализован, тесты зелёные |
| SETUP-09 | Plan 07-05 | Phase 0-Ops checklist scaffold | ✓ SATISFIED (scaffold) | 04-OPS-CHECKLIST.md создан; operator-fill post-deploy |
| PRIV-04 | Plan 07-05 | GDPR consent evidence | ✓ SATISFIED (scaffold) | Section 4 в checklist; operator-fill post-deploy |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `src/scheduler/cron.ts` | 8 | Top-of-file comment: `— STUB (Phase 7 implements)` — handler больше не stub | ℹ️ Info | Исторический артефакт; план явно предписал не трогать; не влияет на функциональность |
| `.planning/REQUIREMENTS.md` | ~38 | STORE-03 wording упоминает `forgotten_users` — таблица удалена migration v3 | ℹ️ Info | Minor documentation drift; не влияет на код или тесты |

### Gaps Summary

Все 13 наблюдаемых истин верифицированы. Два информационных замечания (stale comment в cron.ts top-of-file и STORE-03 wording в REQUIREMENTS.md) переданы на решение разработчику — оба были результатом сознательных ограничений scope в соответствующих планах, не ошибок исполнения.

Цель фазы достигнута: все v2.0 milestone gap'ы закрыты кодом, инфраструктура forget-me удалена, dead code зачищен, документация синхронизирована, Phase 0-Ops scaffold создан.

---

_Verified: 2026-04-30T14:43:00Z_
_Verifier: Claude (gsd-verifier)_
