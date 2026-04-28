---
status: partial
phase: 04-message-capture-persistence
source: [04-VERIFICATION.md]
started: 2026-04-28T00:00:00Z
updated: 2026-04-28T00:00:00Z
---

## Current Test

[awaiting human testing]

## Tests

### 1. E2E happy-path capture
expected: Отправить текстовое сообщение в отслеживаемый forum-тред от обычного участника. Ровно одна строка в таблице messages появляется в течение 5с; повторная доставка того же обновления (перезапуск long-polling, retry Telegram) — по-прежнему одна строка.
result: [pending]

### 2. Edit upsert E2E
expected: Отредактировать захваченное сообщение в Telegram. Та же строка `(chat_id, tg_message_id)` обновляется: `text` и `edited_at` изменены, `created_at` не изменён, дублей нет.
result: [pending]

### 3. Service message filter
expected: Закрепить сообщение (service message `pinned_message`) в отслеживаемом треде. Ноль строк в messages для события закрепления.
result: [pending]

### 4. Channel-forward filter
expected: Убедиться, что канал-форвард (linked-channel auto-forward) не сохраняется. `is_automatic_forward === true` / `sender_chat.type === 'channel'` → ноль строк в messages.
result: [pending]

### 5. Preflight WARN in logs
expected: Проверить preflight WARN в логах при старте. Лог содержит либо `Privacy mode OFF` (хорошо), либо `PRIVACY MODE ON` (требует действия от оператора); статус бота в чате — `administrator` или `creator`.
result: [pending]

### 6. Anonymous admin
expected: Отправить сообщение от анонимного администратора (anonymous admin). Строка в messages содержит `author_id = NULL`, `is_anonymous = 1`, `author_name` = название группы.
result: [pending]

### 7. Graceful shutdown + WAL checkpoint
expected: `docker compose stop bot`. Логи заканчиваются последовательностью: `Shutdown signal received` → `Cron job stopped` → `Bot stopped. Goodbye.` → `Database closed`; WAL-файлы `data/messages.db-wal` и `data/messages.db-shm` исчезают.
result: [pending]

### 8. PRIV-05 E2E (no message text in logs)
expected: Проверить, что текст сообщения НЕ попадает в логи. `docker compose logs bot 2>&1 | grep -E '"text":|"caption":' && echo FAIL || echo PASS` — должно быть `PASS`.
result: [pending]

## Summary

total: 8
passed: 0
issues: 0
pending: 8
skipped: 0
blocked: 0

## Gaps

- truth: "MSG-04 в REQUIREMENTS.md корректно описывает идемпотентную операцию"
  status: partial
  reason: "REQUIREMENTS.md MSG-04 описывает идемпотентность через 'INSERT OR IGNORE', тогда как реализация использует правильный 'ON CONFLICT(chat_id, tg_message_id) DO UPDATE SET'. INSERT OR IGNORE намеренно отвергнут по PITFALLS TG-01, поскольку он молча игнорирует правки (MSG-02 fail). Текст требования вводит в заблуждение, но сама реализация корректна."
  artifacts:
    - path: ".planning/REQUIREMENTS.md"
      issue: "MSG-04 гласит 'INSERT OR IGNORE', но реализация использует ON CONFLICT DO UPDATE — расхождение в документации, не в коде"
  missing:
    - "Обновить текст MSG-04 в REQUIREMENTS.md: заменить 'INSERT OR IGNORE' на 'ON CONFLICT(chat_id, tg_message_id) DO UPDATE SET text/author_name/edited_at' с сохранением created_at"
