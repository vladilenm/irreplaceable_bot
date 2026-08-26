# Руководство для агентов

Этот файл — короткая точка входа для работы с репозиторием. Код и тесты остаются источником истины; README и документы ниже объясняют подтверждённое состояние, эксплуатацию и текущий незавершённый контекст.

## Сначала прочитать

1. `README.md` — назначение, локальный запуск и публичные команды.
2. `docs/architecture.md` — границы приложения и pipeline `#запрос`.
3. `docs/operations.md` — Timeweb, production, диагностика и безопасные команды.
4. `src/runtime-defaults.ts` — модели, расписания, лимиты и прочие значения, которые намеренно не вынесены в env.
5. Для latency-WIP: `docs/superpowers/specs/2026-08-22-member-request-latency-design.md` и соответствующий plan.

Перед изменениями всегда выполнить:

```bash
git status --short --branch
git log --oneline --decorate -8
```

Не считать незакоммиченный код готовым и не перезаписывать чужие изменения.

## Подтверждённое состояние на 2026-08-23

- Production в Timeweb App Platform развёрнут из `origin/main` на commit `597be1c`.
- Это worker без HTTP-сервера: сообщение Timeweb `No HTTP ports discovered` ожидаемо. Критерий готовности — запущенный контейнер и Telegram long polling.
- Данные находятся в Timeweb Managed PostgreSQL с включённым pgvector. App Platform и база подключены к одной приватной сети; RFC1918 private IP используется без TLS.
- Миграции выполняются автоматически перед стартом бота командой из `Dockerfile`.
- В production один раз загружены и проиндексированы 20 mock-карточек. Они используют несуществующие usernames `club_demo_member_*` и предназначены только для проверки.
- Production-проверка `#запрос` вернула 5 кандидатов. Измеренная задержка успешного запроса была около 139 секунд; второй почти одновременный запрос завершился `processing-failed` примерно через 269 секунд.
- Наблюдались временные сетевые ошибки отправки в Telegram `Network request for 'sendMessage' failed`; встроенный retry успешно восстановил отправку.
- `/start` подтверждён. `/status` в текущем коде проверяет администраторов только для group/supergroup. В личной переписке команда всегда отклоняется; анонимный администратор также не сопоставляется с реальным user ID.

## Production-инцидент 2026-08-23: расписание и недоставленные публикации

- Текущий production запускает AI-радар по cron `0 6 * * *`, то есть в 09:00 МСК. Это соответствует целевому времени.
- Production `597be1c` запускает сводку по `30 3 * * *` (06:30 МСК). В текущем локальном WIP это исправлено на `30 6 * * *` (09:30 МСК), но ещё не развёрнуто.
- AI-радар и сводка намеренно публикуются в один Telegram forum topic. Одинаковый target thread не является дефектом конфигурации.
- На запуске сводки Timeweb AI Gateway трижды отклонил `json_schema` с HTTP 400, после чего transport штатно перешёл на `json_object`. Два ответа не прошли локальную schema-валидацию, один ответ был успешным.
- Сводка была подготовлена к публикации, но первоначальный `sendMessage` и единственный retry через 3 секунды завершились транспортной ошибкой `Network request for 'sendMessage' failed` без Telegram API error code. Cron handler завершился ошибкой, сообщение не было доставлено, job state не продвинулся.
- В 09:00 МСК AI-радар дошёл до `AI filtering complete` и `Digest ready`, но обе попытки `sendMessage` завершились той же транспортной ошибкой. Дайджест не был доставлен, job state не продвинулся.
- Ошибка без Telegram API code указывает на сбой сетевого пути App Platform → Telegram до получения ответа, а не на Telegram permissions или отклонённый thread ID.
- В production автоматического отложенного повтора после исчерпания двух попыток нет. Текущий локальный WIP добавляет PostgreSQL outbox, persisted backoff и `/retry_publications [digest|summary|all]` без повторного вызова LLM; это ещё не production-поведение.
- Ранние crash-loop записи `Missing required environment variable: AI_API_KEY` относятся к предыдущему образу с устаревшим env-контрактом. Текущий успешный boot начинается после `PostgreSQL migrations complete` и использует семипеременный production-контракт с `TIMEWEB_AI_TOKEN`.

Локальный WIP реализует: `30 6 * * *` для summary; durable PostgreSQL outbox с backoff до полуночи МСК; safe `/status` counts и `/retry_publications`; capability cache `json_schema` → `json_object`; одну validation retry для malformed/schema-invalid/all-hallucinated LLM output. До release gate и явного deploy это не production-поведение.

## Текущий локальный WIP

Локальный `main` содержит непушенный WIP: документацию latency-патча, изменения defaults моделей/LLM transport и исправления scheduled delivery. Полный latency-патч из plan ещё не реализован и не проверен целиком.

В изолированной локальной worktree проверена интеграция реального каталога: чтение
`club.member_matching_source`, full snapshot с transactional web projection,
content-hash indexing 1536-dimensional embeddings, sync на старте и каждые пять
минут, исключение автора по Telegram ID и count-only `/status`. Это не production:
до release gate и явного deploy production по-прежнему содержит только 20 активных
mock-карточек. После будущего авторизованного cutover mocks должны остаться inactive;
не добавлять автоматический fallback, не реактивировать mocks и не переосмысливать
отозванное/неподдерживаемое consent.

Не деплоить и не пушить этот WIP без явного запроса пользователя и полного release gate:

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

## Карта кода

| Область | Основные файлы |
|---|---|
| Старт и lifecycle | `src/index.ts`, `src/application.ts`, `src/startup.ts` |
| Конфигурация | `src/config.ts`, `src/database-config.ts`, `src/runtime-defaults.ts` |
| Telegram-команды | `src/bot.ts` |
| `#запрос` orchestration | `src/requests.ts`, `src/request.repository.ts` |
| Поиск участников | `src/request.matcher.ts`, `src/members.repository.ts`, `src/embeddings.ts` |
| PostgreSQL | `src/db/migrations.ts`, `src/db/pool.ts`, `src/persistence.ts` |
| Scheduler/радар/сводки | `src/scheduler.ts`, `src/radar.ts`, `src/summarizer.ts` |
| Безопасные логи | `src/logger.ts`, `src/telegram.ts` |

## Environment

Подтверждённый production использует ровно семь переменных:

```text
BOT_TOKEN
TARGET_CHAT_ID
AI_RADAR_THREAD_ID
THREAD_SUMMARY_THREAD_ID
TRACKED_THREAD_IDS
TIMEWEB_AI_TOKEN
DATABASE_URL
```

Локальный WIP дополнительно реализует необязательный `TELEGRAM_PROXY_VLESS_URL` для scoped Telegram egress через Amsterdam VLESS. До наблюдаемого deploy он не считается production-поведением. Значение является полным credential URI: не читать, не печатать, не добавлять в Git. Пустое значение сохраняет direct mode.

Секреты App Platform не синхронизируются в Git или локальный `.env`. Приложение загружает `.env`, а не `.env.local`. `.env.example` содержит только имена и безопасный локальный `DATABASE_URL`; остальные значения пользователь заполняет сам.

Не читать значения секретов в вывод, не добавлять их в документацию и не коммитить `.env`. В рабочем дереве может находиться локальный секретный файл `.envt`: не удалять, не открывать без необходимости и никогда не добавлять в Git.

## Инварианты production

- Ровно один экземпляр приложения на один `BOT_TOKEN`; иначе Telegram вернёт 409 polling conflict.
- Бот должен быть администратором целевой группы, а Privacy Mode должен быть выключен.
- `#запрос` принимается только как точная Telegram hashtag entity в forum topic внутри `TARGET_CHAT_ID`.
- Повторная доставка того же Telegram message ID идемпотентна через `member_requests`.
- В ответ публикуются 3–5 кандидатов; при меньшем числе валидных совпадений mentions не публикуются.
- Username и evidence валидирует код. LLM не получает право самостоятельно формировать Telegram-ссылки.
- Не логировать текст запроса, карточки, prompt, ответ модели, embedding, токены или `DATABASE_URL`.
- Для loopback и RFC1918 private IPv4 TLS выключен. Для домена/публичного IP обязателен строгий TLS с `config/timeweb-cloud-ca.crt`.

## Рабочие команды

Локально:

```bash
docker compose -f docker-compose.test.yml up -d
npm install
npm run build
npm run seed:members
npm run dev
```

В production-консоли dev dependency `tsx` отсутствует, поэтому mock seed запускается из собранного JavaScript:

```bash
node dist/member.seed.js --allow-production
```

Не повторять production seed без понимания последствий: upsert идемпотентен для mock source, но карточки останутся активными и могут попасть в реальные ответы.

## Диагностика

Ожидаемая последовательность успешного старта:

```text
PostgreSQL migrations complete
Starting bot...
Bot is running (long-polling mode)
Scheduler started
Initial member directory indexing complete
```

Последние результаты `#запрос` безопасно проверяются из консоли приложения без печати credentials:

```bash
node --input-type=module -e 'import{Pool}from"pg";const p=new Pool({connectionString:process.env.DATABASE_URL});const{rows}=await p.query("SELECT thread_id,tg_message_id,status,match_count,error_code,started_at,completed_at FROM member_requests ORDER BY started_at DESC LIMIT 10");console.table(rows);await p.end()'
```

Интерпретация: нет строки — extractor отклонил сообщение; `processing` — pipeline ещё работает; `completed` — ответ отправлен; `no_match` — меньше трёх валидных кандидатов; `failed` — смотреть безопасный `error_code` и app logs.

## Правила изменения

- Сначала воспроизводить дефект тестом, затем менять реализацию.
- Сохранять семь обязательных production env-переменных; `TELEGRAM_PROXY_VLESS_URL` допустим только как необязательный deployment-specific secret для scoped Telegram egress. Новые операционные настройки добавлять в `runtime-defaults.ts`, если нет веской причины делать их deployment-specific.
- Не менять schema/embedding model без плана переиндексации карточек.
- Не выполнять deploy, seed production, ротацию ключей, изменение Timeweb-ресурсов или push без явного разрешения пользователя.
- Не коммитить планы как будто они являются реализованным поведением. В документации явно разделять production, проверенный local state и proposed/WIP.
