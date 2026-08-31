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

## Каталог участников: локально проверенный WIP

Интеграция реальных анкет проверена локально и **ещё не развёрнута в production**. Её контракт:

```text
club.member_matching_source -> full snapshot -> transactional web projection
-> content-hash pending set -> 1536-dimensional embeddings
-> exact top-20 -> LLM rerank/evidence validation -> 3–5 mentions
```

В canonical document входят все шесть полей сайта: имя, профессия/специализация,
сфера, опыт, чем участник может помочь и навыки. Строка с неподдерживаемой версией
согласия не попадает в active web projection (прежняя web-карточка деактивируется
полным snapshot). Синхронизация выполняется при старте и затем каждые пять минут;
автор `#запрос` исключается по Telegram ID, а не по изменяемому username.

После подтверждённого cutover активный mock fallback запрещён: бот не должен
автоматически реактивировать mock-карточки или подменять ими web-каталог. Полный
guarded runbook и rollback находятся в [docs/operations.md](./docs/operations.md).

## Переменные production

В текущем production подтверждены ровно семь обязательных значений:

| Переменная | Назначение |
|---|---|
| `BOT_TOKEN` | токен Telegram-бота |
| `TARGET_CHAT_ID` | ID целевой Telegram-группы |
| `AI_RADAR_THREAD_ID` | ID топика AI-радара |
| `THREAD_SUMMARY_THREAD_ID` | ID топика ежедневной сводки |
| `TRACKED_THREAD_IDS` | ID отслеживаемых топиков через запятую |
| `TIMEWEB_AI_TOKEN` | единый ключ Timeweb AI Gateway для чата и embeddings |
| `DATABASE_URL` | URL Managed PostgreSQL; для RFC1918 private IP TLS выключен, для домена или публичного IP используется строгий TLS с CA Timeweb |

Локальный WIP дополнительно поддерживает необязательные deployment-specific
`TELEGRAM_PROXY_VLESS_URL` и `PRIVATE_TEST_ADMIN_ID`. Первая переменная содержит
целый VLESS Reality URI для Amsterdam egress; вторая включает owner-only команду
`/test_request <текст>` в личном чате. Их значения не попадают в Git и никогда не
выводятся в логи. При пустом `TELEGRAM_PROXY_VLESS_URL` Telegram работает напрямую;
при пустом `PRIVATE_TEST_ADMIN_ID` приватная команда не регистрируется. До отдельного
согласованного deploy эти переменные не являются подтверждённой
production-конфигурацией.

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

Команды Telegram: `/start`, `/digest`, `/status`, `/dev-digest`,
`/retry_publications [digest|summary|all]` и необязательная
`/test_request <текст>`. Последняя доступна только в DM от точного
`PRIVATE_TEST_ADMIN_ID`, использует настоящий PostgreSQL/pgvector и LLM pipeline,
допускает карточку владельца и один валидный результат. Она не создаёт строку в
`member_requests`; публичный `#запрос` по-прежнему исключает автора и сохраняет
порог три. LLM выбирает участника и ID одного из дословных фрагментов анкеты,
подготовленных кодом. Код принимает только evidence ID выбранного участника и
показывает исходный фрагмент `profileText`; модель не копирует и не формирует
отображаемый текст. Структурно невалидный ответ получает не более одного повтора. Команда
`/retry_publications` повторяет доставку уже сформированных scheduled-публикаций,
не запуская RSS или LLM заново; не запускайте `/digest` или `/dev-digest` для
recovery сохранённой публикации. В текущей реализации остальные административные
команды проверяют права в чате, где была отправлена команда: `/status` в личке
всегда отклоняется, даже если пользователь администратор клуба. Используйте команду
в целевой группе от неанонимного администратора. В локально проверенной интеграции
`/status` выводит только count-only состояние web-источника и индекса (счётчики,
timestamp, generation и embedding model), без анкет, ID, ссылок, canonical
document, credentials или raw errors. Ровно один экземпляр приложения должен
работать с одним `BOT_TOKEN`.

Production-образ не содержит `tsx`. Одноразовый mock seed из консоли App Platform запускается так:

```bash
node dist/member.seed.js --allow-production
```

Подробности: [архитектура](./docs/architecture.md) и [эксплуатация в Timeweb](./docs/operations.md).
