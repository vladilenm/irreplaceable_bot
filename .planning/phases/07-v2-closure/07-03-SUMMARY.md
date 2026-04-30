---
plan: 07-03-dead-code-cleanup
phase: 07-v2-closure
status: complete
requirements_completed: []
commits:
  - a8f7c56
  - bf6f61a
---

## Summary

Удалены 5 мёртвых артефактов после де-скопа Phase 5 + Phase 7.

## What was built

**Task 1** (commit `a8f7c56`):
- `isThreadSummaryPublishedToday` удалена из `state.service.ts` — остался только канонический `isThreadSummaryPublishedTodayWithState`
- Тест S7 в `state.service.test.ts` заменён на S7-WithState версию
- JSDoc `RunThreadSummaryOptions.skipIdempotency` в `types/index.ts` обновлён

**Tasks 2–4** (commit `bf6f61a`):
- `upsertThreadTitle`, `_upsertTitleStmt`, `upsertTitleStmt()` удалены из `tracked-threads-store.ts`
- Тест U1 (upsertThreadTitle) удалён из `tracked-threads-store.test.ts`; U2 сохранён как `listTracked — title column`
- JSDoc `refreshThreadTitle` в `thread-summary.service.ts` обновлён — упоминает Phase 7 cleanup и Phase 5 cancellation
- Stale Phase 5/7 комментарии в `tracking.service.ts` заменены на current-state язык; trailing footer блок удалён
- `types/index.ts` — убрана устаревшая ссылка на `upsertThreadTitle` из комментария `TrackedThread.title`
- `.env.example`: `MESSAGE_RETENTION_DAYS=2` → `90` (matches code-enforced default; `=2` < min=7 вызвал бы startup-throw)

## Acceptance criteria delta

| Check | Result |
|-------|--------|
| `grep -rn "isThreadSummaryPublishedToday\b" src/` | 0 строк |
| `grep -rn "upsertThreadTitle" src/` | 0 строк |
| `grep -rn "_upsertTitleStmt" src/` | 0 строк |
| `grep -c "Phase 5 will add" tracking.service.ts` | 0 |
| `grep -c "Phase 5.*cancelled" tracking.service.ts` | 1 |
| `grep -c "Phase 7" thread-summary.service.ts` | 1 |
| `MESSAGE_RETENTION_DAYS` in .env.example | `=90` |
| `npm run typecheck` | ✓ clean |
| `npx vitest run` | ✓ 84/84 |

## Self-Check: PASSED
