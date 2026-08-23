# Nezamenimye Bot

Telegram-бот Клуба Незаменимых: AI-радар для RSS, сводки форум-топиков и подбор участников по точному хэштегу `#запрос`. Рабочее хранилище — PostgreSQL с pgvector; production использует Timeweb Managed PostgreSQL.

Контекст для следующих coding-агентов, подтверждённое состояние production и незавершённый WIP собраны в [AGENTS.md](./AGENTS.md).

## Локальный запуск

Нужны Node.js 22+, Docker и Telegram-бот, добавленный администратором в целевую группу с выключенным Privacy Mode.

```bash
cp .env.example .env
docker compose -f docker-compose.test.yml up -d
npm install
npm run build
npm run seed:members
npm run dev
```

Перед запуском заполните в `.env` Telegram-токен и все Telegram ID, а также `TIMEWEB_AI_TOKEN`. Пример `DATABASE_URL` уже указывает на локальный контейнер pgvector. Production-секреты из Timeweb App Platform не появляются в локальном `.env` автоматически; `.env.local` приложение не загружает.

Напишите в forum topic целевой группы `#запрос Ищу специалиста по B2B-продажам`. Хэштег должен быть распознан Telegram как entity. Бот отвечает в том же топике, только если нашёл не менее трёх валидных совпадений.

Остановить локальную БД без удаления данных:

```bash
docker compose -f docker-compose.test.yml down
```

## Переменные production

В App Platform задаются ровно семь значений:

| Переменная | Назначение |
|---|---|
| `BOT_TOKEN` | токен Telegram-бота |
| `TARGET_CHAT_ID` | ID целевой Telegram-группы |
| `AI_RADAR_THREAD_ID` | ID топика AI-радара |
| `THREAD_SUMMARY_THREAD_ID` | ID топика ежедневной сводки |
| `TRACKED_THREAD_IDS` | ID отслеживаемых топиков через запятую |
| `TIMEWEB_AI_TOKEN` | единый ключ Timeweb AI Gateway для чата и embeddings |
| `DATABASE_URL` | URL Managed PostgreSQL; для RFC1918 private IP TLS выключен, для домена или публичного IP используется строгий TLS с CA Timeweb |

Операционные значения моделей, расписаний, лимитов и логирования зафиксированы в `src/runtime-defaults.ts`; они не настраиваются через App Platform. Полный пример локального окружения находится в [.env.example](./.env.example).

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

Команды Telegram: `/start`, `/digest`, `/status`, `/dev-digest`, `/retry_publications [digest|summary|all]`. Последняя команда повторяет доставку уже сформированных scheduled-публикаций, не запуская RSS или LLM заново. В текущей реализации административные команды проверяют права в чате, где была отправлена команда: `/status` в личке всегда отклоняется, даже если пользователь администратор клуба. Используйте команду в целевой группе от неанонимного администратора. Ровно один экземпляр приложения должен работать с одним `BOT_TOKEN`.

Production-образ не содержит `tsx`. Одноразовый mock seed из консоли App Platform запускается так:

```bash
node dist/member.seed.js --allow-production
```

Подробности: [архитектура](./docs/architecture.md) и [эксплуатация в Timeweb](./docs/operations.md).
