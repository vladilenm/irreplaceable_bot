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

Xray is a userspace child process, binds its SOCKS listener only to loopback and receives the VLESS configuration on stdin. Only grammY traffic uses this branch; PostgreSQL, Timeweb AI and RSS remain direct. The VLESS URI, UUID and Reality keys are deployment secrets and never appear in source or logs. A blank optional `TELEGRAM_PROXY_VLESS_URL` retains direct Telegram mode.

Операционные константы — модели, размерность embeddings, расписания, лимиты базы, обработки запросов и логирования — находятся в `src/runtime-defaults.ts`. Текущее production подтверждено для семи значений окружения: `BOT_TOKEN`, `TARGET_CHAT_ID`, `AI_RADAR_THREAD_ID`, `THREAD_SUMMARY_THREAD_ID`, `TRACKED_THREAD_IDS`, `TIMEWEB_AI_TOKEN` и `DATABASE_URL`. Локальный WIP добавляет необязательный deployment-specific `TELEGRAM_PROXY_VLESS_URL`; до explicit deploy он не описывает production.

`config/timeweb-cloud-ca.crt` — публичный материал сертификата для проверки TLS Managed PostgreSQL, а не секрет. Для домена, публичного IP и любого адреса вне разрешённых локальных сетей приложение использует этот сертификат. TLS выключается только для loopback и RFC1918 private IPv4 (`10/8`, `172.16/12`, `192.168/16`); private IP допустим только внутри общей приватной сети App Platform и Managed PostgreSQL.

Будущее web-приложение не должно подключаться к PostgreSQL прямо из браузера. Оно вызывает собственный backend, а тот нормализует карточку и использует тот же сервис каталога или эквивалентный application API.

## Подбор по `#запрос`

1. Обработчик реагирует только на Telegram entity с точным хэштегом `#запрос` в `TARGET_CHAT_ID`.
2. Запрос атомарно резервируется в `member_requests`. Повторная доставка того же сообщения не запускает второй pipeline.
3. Через Timeweb AI Gateway создаётся один 1536-мерный embedding запроса.
4. PostgreSQL вычисляет cosine distance и возвращает точный top-20. При каталоге до 1000 карточек ANN-индекс не нужен: exact search проще и предсказуемее.
5. В поиск попадают только активные карточки, у которых embedding создан текущей моделью и соответствует текущему content hash. Устаревший vector никогда не используется молча.
6. LLM выбирает 3–5 кандидатов только из top-20 и обязан вернуть evidence из карточки. Код проверяет ID и evidence, затем сам формирует упоминания.
7. При менее чем трёх валидных результатах ответ не публикуется. Статус запроса переводится в терминальное состояние.

Текущий production отвечает только после завершения embedding, PostgreSQL search и LLM reranking. Подтверждённая проверка на mock-карточках заняла около 139 секунд. Immediate placeholder, stage timeouts, длительности этапов и single-flight одинаковых запросов описаны в latency-design, но ещё не являются production-поведением.

Два разных Telegram message ID создают две независимые записи и могут выполняться параллельно. Повторная доставка одного и того же message ID не запускает pipeline повторно.

## Авторизация Telegram-команд

`/digest`, `/status` и `/dev-digest` используют список администраторов текущего group/supergroup с пятиминутным process-local cache. Личная переписка намеренно short-circuit-ится как неадминистративная, поэтому администратор целевой группы пока не может вызвать `/status` в DM. Telegram также не раскрывает реальный user ID анонимного администратора.

Исправление без новой env-переменной должно проверять `ctx.from.id` по администраторам `TARGET_CHAT_ID`, когда команда пришла в личке. До такого изменения административные команды следует запускать в целевой группе от неанонимного аккаунта.

## Данные

| Таблица | Назначение |
|---|---|
| `schema_migrations` | применённые миграции |
| `messages` | сообщения отслеживаемых топиков |
| `job_state` | состояния радара и сводок |
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
- Текст карточки и запроса передаётся через Timeweb AI Gateway. До загрузки реальных данных нужны согласие участников и проверка требований к трансграничной обработке.
- Приложение работает как long-polling worker и не открывает HTTP-порт. Health в Timeweb означает живой контейнер; состояние бизнес-pipeline проверяется по app logs, `/status` и PostgreSQL.
- Scheduled digest (09:00 МСК) и summary (09:30 МСК) могут использовать один forum topic — это штатно. После генерации они сначала сохраняют отрендеренные chunks в outbox, затем dispatcher делает по одной попытке, фиксируя каждый успешный chunk. Повторы `3s/15s/1m/5m/15m/30m` и lease переживают restart процесса; terminal rows хранятся семь дней. Это at-least-once доставка: при обрыве сети после приёма Telegram возможен один дубликат chunk.
