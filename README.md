# Nezamenimye Bot

Telegram-бот Клуба Незаменимых с тремя продуктовыми сценариями:

- AI-радар отбирает материалы из RSS и публикует дайджест;
- сводка клуба сохраняет сообщения выбранных форум-топиков и готовит ежедневную выжимку;
- подбор участников реагирует на точный хэштег `#запрос`, ищет по карточкам клуба и отвечает 3–5 релевантными Telegram-упоминаниями с проверяемыми причинами.

Рабочее хранилище — PostgreSQL с расширением pgvector. В production предполагается Timeweb Managed PostgreSQL; диск контейнера для данных не используется. OpenAI `text-embedding-3-small` строит 1536-мерные embeddings карточек и запросов, а LLM делает только финальный выбор из найденных кандидатов. Telegram usernames всегда подставляет код, а не модель.

## Локальный запуск

Нужны Node.js 22+, Docker и Telegram-бот, добавленный администратором в целевую группу с выключенным Privacy Mode.

```bash
cp .env.example .env
docker compose -f docker-compose.test.yml up -d --wait
npm ci
```

Заполните в `.env` как минимум `BOT_TOKEN`, `TARGET_CHAT_ID`, `AI_API_KEY` и `EMBEDDING_API_KEY`. Для радара и сводки задайте соответствующие thread id. Локальные `DATABASE_URL` из примера уже указывают на контейнер pgvector на порту `55432`.

Создать 20 тестовых карточек и их embeddings:

```bash
npm run seed:members
```

После этого включите `REQUEST_MATCHING_ENABLED=true` и запустите бот:

```bash
npm run dev
```

Напишите в целевой группе сообщение вида `#запрос Ищу специалиста по B2B-продажам`. Бот должен ответить в том же топике. Если после всех проверок осталось меньше трёх уверенных совпадений, он намеренно ничего не тегает.

Остановить локальную БД без удаления данных:

```bash
docker compose -f docker-compose.test.yml down
```

## Основные переменные

| Переменная | Назначение |
|---|---|
| `DATABASE_URL` | URL runtime-роли PostgreSQL |
| `DATABASE_MIGRATION_URL` | URL владельца схемы для миграций |
| `DATABASE_SSL` | `true` в Timeweb, `false` только для локального контейнера |
| `DATABASE_CA_CERT` | CA-сертификат Timeweb; в панели можно передать одной строкой с `\n` |
| `DATABASE_POOL_MAX` | размер пула, по умолчанию 5 |
| `EMBEDDING_API_KEY` | ключ OpenAI для embeddings |
| `EMBEDDING_MODEL` | зафиксированная модель индекса, по умолчанию `text-embedding-3-small` |
| `MEMBER_INDEX_CRON` | доиндексация новых и изменённых карточек |
| `REQUEST_MATCHING_ENABLED` | feature flag подбора участников |
| `ALLOW_MOCK_MEMBER_SEED` | обязательное явное разрешение тестовых карточек в production |

Полный список находится в [.env.example](./.env.example). Cron-выражения интерпретируются в UTC.

## Команды

```bash
npm test
npm run typecheck
npm run build
npm run seed:members
npm run migrate:sqlite -- /absolute/path/messages.db
npm run eval:member-matching -- /absolute/path/member-matching-eval.json
```

Импорт SQLite допустим только в полностью пустую PostgreSQL-схему и не изменяет исходный файл. Eval-набор и реальные карточки не должны попадать в Git.

Команды Telegram: `/start`, `/digest`, `/status`, `/dev-digest`. Запускайте ровно один экземпляр приложения на один `BOT_TOKEN`.

Подробности: [архитектура](./docs/architecture.md) и [эксплуатация в Timeweb](./docs/operations.md).
