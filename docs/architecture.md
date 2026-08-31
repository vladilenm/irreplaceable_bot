# Архитектура

## Границы системы

Приложение остаётся одним Node.js-процессом, но работа с данными отделена от Telegram, расписаний и LLM через явные асинхронные репозитории. Единственный runtime-источник состояния — PostgreSQL с pgvector. SQLite поддерживается только одноразовым CLI-импортёром и не входит в production-граф приложения.

Основные правила:

1. `application.ts` управляет жизненным циклом: миграции отдельным подключением, readiness-check, репозитории, Telegram polling, scheduler и корректная остановка.
2. Бизнес-сценарии получают `Persistence` и внешние клиенты параметрами; скрытого глобального хранилища нет.
3. LLM возвращает структурированные данные, но не управляет ссылками, Telegram usernames или фактом публикации.
4. Состояние cron-задачи меняется только после подтверждённого внешнего результата.
5. Карточки сначала сохраняются в PostgreSQL, затем независимо индексируются. Ошибка одной карточки не блокирует остальные.

## Production-поток

```text
Telegram -> bot on Timeweb App Platform
         -> local Xray SOCKS (only when TELEGRAM_PROXY_VLESS_URL is set)
         -> Amsterdam VLESS Reality -> Telegram API
         -> Timeweb AI Gateway (chat + embeddings, one token)
         -> Timeweb Managed PostgreSQL (messages + members + vector index)
```

Xray is a userspace child process, binds its SOCKS listener only to loopback and receives the VLESS configuration on stdin. Only grammY traffic uses this branch; PostgreSQL and Timeweb AI remain direct. The VLESS URI, UUID and Reality keys are deployment secrets and never appear in source or logs. A blank optional `TELEGRAM_PROXY_VLESS_URL` retains direct Telegram mode.

Операционные константы — модели, размерность embeddings, расписания, лимиты базы, обработки запросов и логирования — находятся в `src/runtime-defaults.ts`. Текущее production подтверждено для семи значений окружения: `BOT_TOKEN`, `TARGET_CHAT_ID`, `AI_RADAR_THREAD_ID`, `THREAD_SUMMARY_THREAD_ID`, `TRACKED_THREAD_IDS`, `TIMEWEB_AI_TOKEN` и `DATABASE_URL`. Эта ветка требует восьмое точное значение `DIGEST_IMPORT_ENABLED=true|false`; до проверки producer view оно должно оставаться `false`. Локальный WIP также поддерживает необязательные deployment-specific `TELEGRAM_PROXY_VLESS_URL` и `PRIVATE_TEST_ADMIN_ID`; до explicit deploy они не описывают production.

`config/timeweb-cloud-ca.crt` — публичный материал сертификата для проверки TLS Managed PostgreSQL, а не секрет. Для домена, публичного IP и любого адреса вне разрешённых локальных сетей приложение использует этот сертификат. TLS выключается только для loopback и RFC1918 private IPv4 (`10/8`, `172.16/12`, `192.168/16`); private IP допустим только внутри общей приватной сети App Platform и Managed PostgreSQL.

Будущее web-приложение не должно подключаться к PostgreSQL прямо из браузера. Оно вызывает собственный backend, а тот нормализует карточку и использует тот же сервис каталога или эквивалентный application API.

## Локально проверенный pipeline web-каталога

Этот pipeline проверен локально, но не является production-поведением до отдельного
release gate и явно авторизованного deploy:

```text
club.member_matching_source -> full snapshot -> transactional web projection
-> content-hash pending set -> 1536-dimensional embeddings
-> exact top-20 -> LLM rerank/evidence validation -> 3–5 mentions
```

`club.member_matching_source` — единственный read contract: snapshot целиком
валидируется до транзакционной проекции `source = 'web'`. В canonical document
обязательно входят все шесть полей сайта: `display_name`, `occupation`, `industry`,
`expertise`, `can_help_with` и `skills`. Неподдерживаемая версия consent не
принимается в snapshot и деактивирует ранее активную web-карточку как отсутствующую
в новой полной проекции. Попытка чтения выполняется при старте, а scheduler повторяет
её каждые пять минут.

После commit content hash определяет pending set; только он получает
1536-dimensional embeddings. Поиск исключает автора `#запрос` по стабильному Telegram
ID, а не username. После cutover активные mock-карточки не являются fallback: код и
rollback никогда автоматически не реактивируют mocks и не переопределяют согласие.

## Подбор по `#запрос`

1. Обработчик реагирует только на Telegram entity с точным хэштегом `#запрос` в `TARGET_CHAT_ID`.
2. Запрос атомарно резервируется в `member_requests`. Повторная доставка того же сообщения не запускает второй pipeline.
3. Через Timeweb AI Gateway создаётся один 1536-мерный embedding запроса.
4. PostgreSQL вычисляет cosine distance и возвращает точный top-20. При каталоге до 1000 карточек ANN-индекс не нужен: exact search проще и предсказуемее.
5. В поиск попадают только активные карточки, у которых embedding создан текущей моделью и соответствует текущему content hash; автор запроса исключается по Telegram ID. Устаревший vector никогда не используется молча.
6. Код нарезает `profileText` каждого shortlist-кандидата на точные evidence options длиной до 300 символов. LLM выбирает до пяти пар `memberId + evidenceId`. Код валидирует принадлежность обоих ID, подставляет исходный substring, сортирует принятые результаты по `similarity/memberId` и никогда не публикует модельный текст. Структурно испорченный ответ получает ровно один повтор; валидный пустой результат не повторяется.
7. При менее чем трёх валидных результатах ответ не публикуется. Статус запроса переводится в терминальное состояние.

Текущий production отвечает только после завершения embedding, PostgreSQL search и LLM reranking. Подтверждённая проверка на mock-карточках заняла около 139 секунд. Immediate placeholder, stage timeouts, длительности этапов и single-flight одинаковых запросов описаны в latency-design, но ещё не являются production-поведением.

Два разных Telegram message ID создают две независимые записи и могут выполняться параллельно. Повторная доставка одного и того же message ID не запускает pipeline повторно.

## Consumer Topic Digest (проверенная ветка, не production)

При `DIGEST_IMPORT_ENABLED=true` отдельный importer каждые 30 секунд выполняет
только `SELECT` из producer-owned view `digest.telegram_issue_source` за текущую
дату МСК. Документ сначала проходит strict validation `PublishedDigest v3`, затем
локально рендерится в один Rich HTML и идемпотентно сохраняется в outbox с
уникальным `origin_digest_id = digestId`. Main, Radar и Focus сохраняют редакционный
порядок producer-а; consumer не вычисляет score и не вызывает LLM.

Dispatcher отправляет сохранённый HTML через proxy-aware `bot.api.raw.sendRichMessage`
в `TARGET_CHAT_ID` + `AI_RADAR_THREAD_ID`, фиксирует Telegram message ID и
переиспользует существующие lease/backoff/recovery. Публикация истекает в следующую
полночь МСК. Повторный poll или restart не создаёт второй outbox item. При
`DIGEST_IMPORT_ENABLED=false` importer не создаётся; это deployment kill switch,
но producer продолжает работать независимо.

## Авторизация Telegram-команд

`/status` и `/retry_publications` используют список администраторов текущего group/supergroup с пятиминутным process-local cache. Личная переписка намеренно short-circuit-ится как неадминистративная, поэтому администратор целевой группы пока не может вызвать `/status` в DM. Telegram также не раскрывает реальный user ID анонимного администратора. Ручных команд генерации дайджеста больше нет.

Исправление без новой env-переменной должно проверять `ctx.from.id` по администраторам `TARGET_CHAT_ID`, когда команда пришла в личке. До такого изменения административные команды следует запускать в целевой группе от неанонимного аккаунта.

Отдельная `/test_request <текст>` проверяет member matching в DM. Она
регистрируется только при непустом `PRIVATE_TEST_ADMIN_ID` и
молча игнорирует другой user ID или неприватный chat. Handler вызывает тот же
`MemberMatcher`, не исключает карточку владельца и снижает minimum только для этого
вызова с трёх до одного. Публичный `#запрос` по-прежнему исключает автора и
сохраняет threshold три. Приватный вызов использует реальные embedding, PostgreSQL
exact search и LLM evidence validation, но не пишет `member_requests`, потому что
эта таблица хранит идемпотентные forum-topic сообщения. LLM выбирает `memberId` и
один `evidenceId` из подготовленных кодом точных фрагментов; отображаемый текст
всегда подставляет код из `profileText`.

## Данные

| Таблица | Назначение |
|---|---|
| `schema_migrations` | применённые миграции |
| `messages` | сообщения отслеживаемых топиков |
| `job_state` | состояние доставленного дайджеста и сводок |
| `scheduled_publications` | durable outbox финальных digest/summary перед отправкой в Telegram |
| `scheduled_publication_chunks` | подтверждённые Telegram chunks одной публикации |
| `members` | нормализованные карточки и content hash |
| `member_embeddings` | pgvector(1536), модель и hash |
| `member_index_state` | состояние индексации |
| `member_requests` | очередь, идемпотентность и результат запросов |

Telegram id хранятся как `bigint` и на границе приложения проверяются на безопасное преобразование. Удаление старых сообщений выполняется ограниченными батчами. Миграции защищены advisory lock, поэтому конкурентный старт не применит одну миграцию дважды.

## Надёжность и приватность

- Scheduler останавливается раньше Telegram polling, а пул закрывается последним.
- Зависший `member_requests.processing` можно безопасно вернуть в обработку после заданного интервала.
- Логи содержат технические ID, счётчики и классы ошибок, но не тексты запросов, профили, embeddings или ключи.
- Matcher logs содержат только агрегатные счётчики shortlist, validation, retry и outcome; query, profile, evidence, member IDs, usernames и model output исключены.
- Текст карточки и запроса передаётся через Timeweb AI Gateway. До загрузки реальных данных нужны согласие участников и проверка требований к трансграничной обработке.
- Приложение работает как long-polling worker и не открывает HTTP-порт. Health в Timeweb означает живой контейнер; состояние бизнес-pipeline проверяется по app logs, `/status` и PostgreSQL.
- Импортированный Topic Digest и summary могут использовать один forum topic — это штатно. Final HTML сначала сохраняется в outbox, затем dispatcher делает по одной попытке, фиксируя каждый успешный chunk. Повторы `3s/15s/1m/5m/15m/30m` и lease переживают restart процесса; terminal rows хранятся семь дней. Это at-least-once доставка: при обрыве сети после приёма Telegram возможен один дубликат chunk.
