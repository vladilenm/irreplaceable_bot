---
status: partial
phase: 06-thread-summary-pipeline
source: [06-VERIFICATION.md]
started: 2026-04-29T18:25:00Z
updated: 2026-04-29T18:25:00Z
---

## Current Test

[awaiting human testing]

## Tests

### 1. Cron 06:30 MSK fires → один HTML-пост в теме «🧵 Сводки тредов»
expected: Один HTML-пост появляется в теме «🧵 Сводки тредов» (THREAD_SUMMARY_THREAD_ID); повторный запуск в тот же MSK-день — ноль новых постов (idempotency).
why_human: Требует живого Telegram-бота с настроенным THREAD_SUMMARY_THREAD_ID, реальными данными в tracked_threads и DB-сообщениями за последние 24ч.
result: [pending]

### 2. HTML-формат поста (header + thread sections + footer)
expected: Пост содержит корректный HTML — заголовок `<b>🧵 Сводки тредов · DD.MM.YYYY</b>`, секции тредов (headline + bullets + participants), footer «тихо: N тредов» если есть low-volume.
why_human: Требует Phase 0-Ops — бот с admin-правами, privacy mode OFF, GDPR-consent, реальные сообщения в базе. Запуск pipeline через `/dev-summary` (Phase 7) или прямой вызов `runThreadSummaryPipeline`.
result: [pending]

### 3. Coexistence: digest 06:00 + thread-summary 06:30 без конфликта state.json
expected: AI-радар публикуется в `ai_radar_thread_id` в 06:00 MSK; через 30 мин thread-summary публикуется в `thread_summary_thread_id`; конкурентных конфликтов нет.
why_human: Требует обоих cron-циклов на живом боте; гарантировать отсутствие state.json-конфликта между двумя записями невозможно без реального прогона.
result: [pending]

## Summary

total: 3
passed: 0
issues: 0
pending: 3
skipped: 0
blocked: 0

## Gaps
