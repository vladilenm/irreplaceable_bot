# Phase 3: Delivery & Operations - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-14
**Phase:** 03-delivery-operations
**Areas discussed:** Idempotency, /digest command, /status command, Cron scheduler, Telegram sender, HTML formatting

---

## Idempotency

| Option | Description | Selected |
|--------|-------------|----------|
| По дате в MSK (рекомендуется) | Сравниваем календарную дату последнего дайджеста в state.json с текущей датой по MSK (UTC+3) | ✓ |
| По дате в UTC | То же, но по UTC. Может быть расхождение вокруг полуночи | |
| Ты реши | Claude выберет | |

**User's choice:** По дате в MSK
**Notes:** MSK не меняет летнее/зимнее время, поэтому UTC+3 стабилен.

---

## Поведение при дубликате

| Option | Description | Selected |
|--------|-------------|----------|
| Пропустить тихо (рекомендуется) | Логировать warn и вернуть результат с флагом "already_published". Pipeline не запускается | ✓ |
| Запустить, но не публиковать | Pipeline работает полностью, но пост не отправляется. Тратит токены LLM впустую | |
| Спросить пользователя | Сообщить "Дайджест уже был сегодня" и дать кнопку "Отправить заново" | |

**User's choice:** Пропустить тихо
**Notes:** Экономит LLM-токены.

---

## /digest — доступ

| Option | Description | Selected |
|--------|-------------|----------|
| Только админы (рекомендуется) | Проверка ctx.from — только админы группы. Защищает от спам-запусков | ✓ |
| Все участники | Любой участник группы может запустить | |

**User's choice:** Только админы
**Notes:** Защита от нежелательных запусков и траты LLM-токенов.

---

## /digest — idempotency

| Option | Description | Selected |
|--------|-------------|----------|
| Обходить замок | /digest — ручной оверрайд, всегда запускает pipeline | |
| Уважать замок (рекомендуется) | /digest тоже проверяет idempotency. Если был — отвечает "Дайджест уже опубликован сегодня" | ✓ |

**User's choice:** Уважать замок

---

## /digest — UX во время работы

| Option | Description | Selected |
|--------|-------------|----------|
| Сообщение-статус (рекомендуется) | Сразу ответить "⚙️ Запускаю сборку дайджеста...", потом отредактировать на результат | ✓ |
| Только результат | Молчать, пока pipeline работает. Ответить только когда готово | |

**User's choice:** Сообщение-статус

---

## Куда отвечает бот

| Option | Description | Selected |
|--------|-------------|----------|
| В тот же чат/тред (рекомендуется) | Reply в тот же тред, где была команда | ✓ |
| В личку отправителю | Ответ в личку, чтобы не засорять группу | |

**User's choice:** В тот же чат/тред
**Notes:** Применяется к обеим командам /digest и /status.

---

## /status — информация

| Option | Description | Selected |
|--------|-------------|----------|
| Uptime бота | Сколько времени бот работает | |
| Последний дайджест | Дата и результат (ok/skipped) | ✓ |
| Количество новостей | Сколько новостей было в последнем дайджесте | ✓ |
| Следующий запуск | Когда следующий cron-запуск | ✓ |

**User's choice:** Последний дайджест, Количество новостей, Следующий запуск (multiSelect)
**Notes:** Uptime исключён — не приоритет для MVP.

---

## /status — доступ

| Option | Description | Selected |
|--------|-------------|----------|
| Все участники (рекомендуется) | /status не тратит токены, только читает state.json | |
| Только админы | Ограничить для консистентности с /digest | ✓ |

**User's choice:** Только админы
**Notes:** Пользователь выбрал консистентность с /digest.

---

## Cron — timezone

| Option | Description | Selected |
|--------|-------------|----------|
| UTC в cron-выражении (рекомендуется) | `0 6 * * *` (UTC). Просто, предсказуемо, MSK не меняет DST | ✓ |
| croner вместо node-cron | Пакет croner поддерживает timezone нативно. Но это смена стека | |
| Ты реши | Claude выберет | |

**User's choice:** UTC в cron-выражении

---

## Telegram sender

| Option | Description | Selected |
|--------|-------------|----------|
| bot.api.sendMessage (рекомендуется) | Прямой вызов Grammy API. Не зависит от контекста обработчика, работает из cron и из команды | ✓ |
| Grammy ctx.reply | Контекст обработчика. Работает для /digest, но не для cron | |
| Ты реши | Claude выберет | |

**User's choice:** bot.api.sendMessage

---

## HTML-форматирование

| Option | Description | Selected |
|--------|-------------|----------|
| Отправить as-is, без parse_mode | Telegram отобразит как plain text. Проще | |
| Обернуть в HTML (рекомендуется) | digest.formatter.ts оборачивает заголовки в `<b>`, ссылки в `<a href>` | ✓ |
| Ты реши | Claude выберет | |

**User's choice:** Обернуть в HTML

---

## Claude's Discretion

- Retry delay between attempts
- Exact error message text and log formats
- HTML formatter implementation details
- Admin check implementation approach

## Deferred Ideas

None — discussion stayed within phase scope
