# Архитектура

## Принципы

1. **Вертикальные продуктовые срезы.** Радар живёт в `radar*`, сводка — в `summary*` и `summarizer.ts`.
2. **Один источник состояния.** Сообщения, миграции и состояние cron-задач хранятся в SQLite через `database.ts`.
3. **LLM не управляет публикацией.** Модель возвращает JSON по схеме; код проверяет ссылки и message id, экранирует HTML и решает, когда публиковать.
4. **Явные зависимости.** Telegram `Api` передаётся в отправщики параметром. Глобальных хранилищ и service locator нет.
5. **Состояние после результата.** Успешный запуск фиксируется только после подтверждённой доставки Telegram. Дайджест и сводка обновляют независимые строки SQLite.
6. **Проверяемый подбор.** `#запрос` получает semantic top-20 в памяти, а LLM возвращает только ID, reason и точный evidence. Код валидирует evidence по исходной карточке и сам подставляет Telegram username.

## Потоки данных

```mermaid
flowchart LR
  Telegram["Telegram updates"] --> Capture["capture.ts"] --> DB["database.ts / SQLite"]
  RSS["RSS feeds"] --> Radar["radar.sources.ts → radar.curator.ts → radar.ts"]
  Radar --> LLM["llm.ts"]
  DB --> Summary["summarizer.ts → summary.ts"]
  Summary --> LLM
  Notion["Notion data source"] --> MemberSync["members.notion.ts → MemberSyncService"]
  MemberSync --> Embeddings["OpenAI embeddings"]
  Embeddings --> MemberDB["members + embeddings / SQLite"]
  Telegram --> Requests["requests.ts (#запрос)"]
  Requests --> MemberDB
  Requests --> Matcher["top-20 + request.matcher.ts"]
  Matcher --> LLM
  Matcher --> TelegramAPI
  Scheduler["scheduler.ts"] --> Radar
  Scheduler --> Summary
  Scheduler --> MemberSync
  Radar --> TelegramAPI["telegram.ts"]
  Summary --> TelegramAPI
  TelegramAPI --> Telegram
```

## Файлы

| Область | Файлы | Ответственность |
|---|---|---|
| Запуск | `index.ts`, `startup.ts` | миграции, polling, preflight, сигналы завершения |
| Telegram | `bot.ts`, `capture.ts`, `requests.ts`, `telegram.ts` | команды, приём сообщений, `#запрос`, надёжная отправка |
| AI-радар | `radar.ts`, `radar.sources.ts`, `radar.curator.ts` | RSS → отбор → HTML → публикация |
| Сводка | `summary.ts`, `summarizer.ts` | окно сообщений → JSON-сводка → deep links → публикация |
| Подбор участников | `members*.ts`, `embeddings.ts`, `request.matcher.ts`, `request.runtime.ts`, `request.repository.ts` | Notion snapshot, embeddings, cosine search, grounded rerank, идемпотентность |
| Данные | `database.ts` | SQLite, миграции, сообщения, cron-state, snapshots участников, retention |
| Инфраструктура | `scheduler.ts`, `llm.ts`, `config.ts`, `logger.ts`, `types.ts` | cron, провайдеры LLM, env, логи, общие типы |

Тесты находятся рядом с кодом: `*.test.ts`. Новая абстракция оправдана только если у неё есть отдельная ответственность, второй реальный потребитель или изолируемая внешняя граница.

## Надёжность

- Захват принимает сообщения только из `TARGET_CHAT_ID` и `TRACKED_THREAD_IDS`.
- Повторная доставка Telegram обрабатывается SQLite UPSERT-ом.
- Цитаты сводки проходят проверку по id входных сообщений; выдуманные id отбрасываются.
- URL радара принимаются только из входного набора статей.
- Ошибка одного форум-топика не останавливает остальные.
- Полный отказ LLM блокирует публикацию сводки и не продвигает состояние cron.
- Отправка Telegram повторяется один раз; состояние записывается только после успеха.
- Snapshot карточек и vectors обновляются в одной SQLite-транзакции; при ошибке сохраняется предыдущий доступный индекс.
- Повторная доставка одного Telegram-сообщения резервируется через `member_requests`, поэтому не запускает второй LLM pipeline.
- При менее чем трёх валидных grounded matches бот не публикует ни одного упоминания.
