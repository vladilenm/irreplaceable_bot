# Надёжная доставка scheduled-публикаций

**Дата:** 2026-08-23

**Область:** AI-радар, сводка Telegram-топиков, Timeweb structured output, Telegram delivery и operational recovery

## 1. Контекст

23 августа production выполнил оба scheduled LLM pipeline, но не опубликовал результат. Сводка запустилась в 06:30 МСК вместо целевых 09:30, потому что runtime default равен `30 3 * * *` UTC. AI-радар корректно запустился в 09:00 МСК по `0 6 * * *` UTC.

Timeweb AI Gateway отклонил `json_schema` с HTTP 400 и transport перешёл на `json_object`. Из трёх результатов сводки два не прошли локальную schema-валидацию, один был успешным. Сводка и готовый дайджест затем не были доставлены: первоначальный Telegram `sendMessage` и единственный retry через 3 секунды завершились `Network request for 'sendMessage' failed` без Telegram API error code.

AI-радар и сводка намеренно используют один Telegram forum topic. Это остаётся штатным поведением и не меняется патчем.

## 2. Цели

Патч должен:

1. запускать AI-радар в 09:00 МСК и сводку в 09:30 МСК;
2. сохранять готовую публикацию до первой попытки Telegram delivery;
3. переживать рестарт контейнера и продолжать доставку без повторного RSS/LLM pipeline;
4. возобновлять частично доставленную многочастную сводку с первого недоставленного chunk;
5. автоматически повторять доставку с bounded backoff до конца соответствующего московского дня;
6. не продвигать `job_state`, пока все chunks не подтверждены Telegram;
7. не запускать LLM второй раз для уже сформированной публикации того же pipeline и московской даты;
8. давать администратору безопасный способ повторно активировать недоставленную публикацию без LLM;
9. не логировать payload, prompt, ответ модели, тексты исходных сообщений или secrets;
10. контролируемо повторять один schema-invalid LLM результат.

## 3. Не-цели и ограничения

- Патч не меняет общий target topic радара и сводки.
- Патч не создаёт новую environment variable: расписание, backoff, lease и retention остаются runtime defaults.
- Патч не превращает весь RSS/LLM pipeline в persistent job queue. В PostgreSQL сохраняется только окончательно отформатированный Telegram payload.
- Telegram Bot API не предоставляет idempotency key для `sendMessage`. При потере ответа после фактического принятия сообщения Telegram возможен редкий дубль. Гарантия delivery поэтому **at-least-once**, а не exactly-once.
- Патч не деплоится и не пушится без отдельного разрешения и полного release gate.

## 4. Расписание

Cron выполняется в UTC:

| Pipeline | Cron | Время МСК |
|---|---:|---:|
| AI-радар | `0 6 * * *` | 09:00 |
| Сводка тем | `30 6 * * *` | 09:30 |
| Outbox recovery | `* * * * *` | каждую минуту |

`threadSummaryCron` меняется с `30 3 * * *` на `30 6 * * *`. Новый recovery cron нужен только как restart-safe страховка. После обычной неудачи dispatcher также ставит process-local timer на точный `next_attempt_at`, чтобы выдерживать интервалы короче минуты.

## 5. PostgreSQL outbox

Следующая forward-only миграция создаёт две таблицы.

### `scheduled_publications`

| Поле | Назначение |
|---|---|
| `publication_id bigint identity primary key` | внутренний ID |
| `pipeline text` | `digest` или `thread-summary` |
| `publication_date date` | календарная дата в `Europe/Moscow` |
| `target_chat_id bigint` | Telegram chat |
| `target_thread_id bigint` | общий forum topic |
| `status text` | `ready`, `delivering`, `retrying`, `delivered`, `expired` или `failed` |
| `item_count integer` | число элементов дайджеста; для сводки `0` |
| `persist_job_state boolean` | нужно ли продвинуть production state после delivery |
| `attempt_count integer` | число начатых Telegram attempts |
| `next_attempt_at timestamptz` | ближайшее допустимое время retry |
| `lease_until timestamptz` | срок process lease для crash recovery |
| `expires_at timestamptz` | следующая полночь `Europe/Moscow` |
| `last_error_code text` | только безопасный классифицированный код |
| `created_at timestamptz` | время постановки в outbox |
| `delivered_at timestamptz` | подтверждённая доставка всех chunks |
| `expired_at timestamptz` | терминальное автоматическое истечение |
| `failed_at timestamptz` | терминальная неретраибельная Telegram-ошибка |

Ограничение `UNIQUE(pipeline, publication_date)` не позволяет cron, рестарту или ручной команде повторно сгенерировать публикацию за ту же московскую дату.

Индекс по `(status, next_attempt_at)` обслуживает due-выборку. Check constraints ограничивают pipeline, status, неотрицательные counts и согласованность terminal timestamps.

### `scheduled_publication_chunks`

| Поле | Назначение |
|---|---|
| `publication_id bigint` | FK с `ON DELETE CASCADE` |
| `chunk_index integer` | стабильный порядок, начиная с `0` |
| `text text` | окончательный HTML payload |
| `telegram_message_id bigint` | ID после подтверждённого `sendMessage` |
| `delivered_at timestamptz` | подтверждённая доставка chunk |

Primary key `(publication_id, chunk_index)` сохраняет порядок и позволяет после рестарта пропустить уже доставленные chunks.

Payload удаляется retention sweep через семь дней после `delivered_at`, `expired_at` или `failed_at`. Исходные prompts, модельные ответы и RSS/transcript inputs в outbox не сохраняются.

## 6. Создание публикации и идемпотентность

Перед запуском RSS/LLM pipeline handler проверяет outbox по `(pipeline, publicationDateMsk)`:

- `delivered` — ничего не генерировать и завершить как already published;
- `ready`, `delivering` или `retrying` — не вызывать LLM, попросить dispatcher продолжить delivery;
- `expired` или `failed` — не вызывать LLM и ждать явного admin recovery;
- строки нет — выполнить текущий pipeline.

После успешного форматирования handler одной транзакцией создаёт publication и все chunks, затем просит dispatcher выполнить первую попытку. Ни один `sendMessage` не вызывается до commit outbox.

Пустой/пропущенный дайджест сохраняет существующую семантику: `recordDigest(..., skipped=true)` выполняется без outbox, потому что Telegram payload отсутствует. Сводка с нулём валидных topics также не создаёт пустую публикацию.

`/dev-digest` остаётся development-only запуском с `persistState=false`; он не создаёт production outbox row и не меняет `job_state`.

Обычная административная `/digest` сначала использует тот же outbox lookup. Если активный payload текущего дня уже существует, команда возобновляет delivery вместо повторного LLM-вызова. Для `expired` или `failed` row команда не вызывает LLM и направляет администратора к `/retry_publications digest`.

## 7. Delivery state machine

```text
ready -------> delivering -------> delivered
                  |
                  v
               retrying ---------> delivering
                  |
                  +-------------> expired
                  |
                  +-------------> failed

expired -- explicit admin recovery --> retrying
failed  -- explicit admin recovery --> retrying
```

Dispatcher атомарно claim-ит одну due publication через transaction и `FOR UPDATE SKIP LOCKED`, переводит её в `delivering`, увеличивает `attempt_count` и задаёт lease. Хотя production сохраняет инвариант одной реплики, lease и row lock защищают от overlap cron/startup/manual recovery и будущих rolling restarts.

Dispatcher отправляет chunks строго по `chunk_index`. После каждого подтверждённого ответа Telegram он немедленно сохраняет `telegram_message_id` и `delivered_at`. При рестарте chunks с `delivered_at IS NOT NULL` не отправляются повторно.

Когда доставлены все chunks, одна repository transaction:

1. переводит publication в `delivered`;
2. очищает lease/error;
3. записывает `delivered_at`;
4. при `persist_job_state=true` обновляет соответствующую строку `job_state`.

Для digest transaction сохраняет `item_count` и `last_outcome=success`; для thread summary — `last_outcome=success`. Это исключает состояние, в котором job отмечен завершённым до delivery.

Если process завершился с активным `delivering`, publication снова доступна после `lease_until`. Lease должен быть больше сетевого timeout одной попытки; runtime default — 5 минут.

## 8. Backoff и expiry

Каждая outbox attempt выполняет один Telegram API call. Существующий внутренний retry helper не оборачивает этот call вторым скрытым retry: schedule полностью принадлежит outbox.

После последовательных ошибок интервалы равны:

1. 3 секунды;
2. 15 секунд;
3. 1 минута;
4. 5 минут;
5. 15 минут;
6. и далее 30 минут.

После ретраибельной ошибки repository сохраняет безопасный `last_error_code`, переводит publication в `retrying`, очищает lease и выставляет `next_attempt_at`. Для Telegram 429 используется больший интервал из provider `retry_after` и локального backoff, но попытка не переносится за `expires_at`.

Telegram 4xx кроме 429 считается неретраибельной ошибкой текущей конфигурации или прав. Publication сразу получает `failed`; автоматические попытки прекращаются до явного admin recovery. Network errors, Telegram 5xx и неизвестные transport failures остаются ретраибельными до expiry.

Перед каждой claim/attempt проверяется `expires_at`. Если следующая попытка наступила после полуночи `Europe/Moscow`, publication переводится в `expired` без Telegram call. Новая календарная дата получает независимый outbox row и не отправляет старую публикацию автоматически.

Время expiry вычисляется общей timezone-aware функцией через `Europe/Moscow`, а не из timezone контейнера. Границы 23:59/00:00 покрываются тестами с injected clock.

## 9. Telegram transport и ошибка ambiguous delivery

Новый single-attempt primitive выполняет один `api.sendMessage` и возвращает Telegram message. Outbox dispatcher владеет retry/backoff. Существующий `sendMessageWithRetry` остаётся для недолговечных путей, которые не переведены на outbox, и переиспользует тот же primitive.

Safe error classification различает как минимум:

- `telegram-network` — нет Telegram API response/code;
- `telegram-rate-limit` — HTTP/Telegram 429;
- `telegram-client` — Telegram 4xx кроме 429;
- `telegram-server` — Telegram 5xx;
- `telegram-unknown` — неклассифицированный результат.

Произвольный error message или Telegram description не сохраняется в PostgreSQL. Структурированный log может содержать разрешённые `errorClass`, numeric Telegram status/code, pipeline, publication ID, attempt number, chat/thread IDs и duration, но не `text`.

Если Telegram принял сообщение, но network response потерян, dispatcher не получает `message_id` и повторит chunk. Такой дубль неустраним без server-side idempotency API; документация и `/status` обозначают delivery как at-least-once.

## 10. Structured output

Timeweb endpoint является единственным production chat transport. После подтверждённого HTTP 400 для `json_schema` transport использует `json_object` с полной schema-инструкцией в system prompt. Capability запоминается process-local, чтобы не повторять заведомо отклоняемый `json_schema` для каждого thread в том же процессе.

Domain validation остаётся обязательной и code-owned:

- summarizer повторяет LLM call один раз при malformed JSON, Zod schema failure или результате, где все citations отброшены как hallucinated;
- curator повторяет один раз при malformed JSON, Zod schema failure или результате, где модель предложила items, но все URLs были отклонены allowlist-проверкой;
- явный валидный пустой `items: []` остаётся корректным skipped digest и не вызывает retry;
- после второй неудачи применяется текущий безопасный skip/failure path;
- invalid output, validation issues с пользовательским содержимым и model response не логируются.

Retry использует исходный безопасно построенный prompt и усиленную schema-инструкцию, но не включает первый невалидный model response в новый prompt.

## 11. Admin recovery и status

Новая административная команда:

```text
/retry_publications [digest|summary|all]
```

Команда использует существующую admin-проверку. Она находит последние `expired` или `failed` publications выбранных pipeline в пределах семидневного retention, сообщает их московскую дату и переводит в `retrying` с `next_attempt_at=now()`. При recovery `expires_at` переносится на следующую полночь текущего московского дня, а прежние terminal timestamps очищаются. LLM/RSS pipeline не запускается. Если подходящих rows нет, команда отвечает без side effect.

`/status` дополнительно показывает только безопасные counts:

- ready/delivering/retrying publications;
- expired/failed publications в пределах retention;
- pipeline/date последней недоставленной публикации;
- безопасный `last_error_code`.

Payload и prompt в Telegram status не выводятся.

## 12. Lifecycle

После успешного Telegram polling application запускает scheduler и outbox dispatcher. Dispatcher немедленно делает recovery sweep, затем periodic cron каждую минуту подбирает due publications. Process-local short timers ускоряют retry 3/15 секунд, но correctness не зависит от них.

При shutdown dispatcher сначала прекращает выдачу новых claims и отменяет timers, затем останавливаются scheduler и Telegram polling, после чего закрывается PostgreSQL pool. Незавершённый lease восстанавливается после `lease_until` в новом процессе.

## 13. Наблюдаемость

Основные terminal events:

- `scheduled-publication-created`;
- `scheduled-publication-delivery-ok`;
- `scheduled-publication-delivery-retry`;
- `scheduled-publication-expired`;
- `scheduled-publication-failed`;
- `scheduled-publication-recovered`;
- `scheduled-publication-cleanup`;
- `structured-output-retry`.

Общие поля: `pipeline`, `publicationId`, `publicationDate`, `chunkIndex`, `attemptCount`, `durationMs`, `outcome`, safe error metadata. Ни один event не содержит chunk text, query, transcript, RSS descriptions, prompt или model response.

## 14. Тестирование

Работа выполняется по TDD. Обязательные проверки:

1. Summary cron равен `30 6 * * *`, digest остаётся `0 6 * * *`.
2. Миграция создаёт обе таблицы, constraints, unique key и due index.
3. Payload сохраняется до первого Telegram call.
4. Повторный cron текущего дня не вызывает RSS/LLM, если outbox row уже существует.
5. Job state не меняется до delivery всех chunks.
6. Успешный delivery атомарно завершает publication и продвигает job state.
7. После process restart due row подбирается без нового LLM.
8. Expired lease позволяет восстановить `delivering` row.
9. Частичная многочастная отправка возобновляется с первого недоставленного chunk.
10. Backoff точно следует `3s, 15s, 1m, 5m, 15m, 30m cap`.
11. После московской полуночи автоматический Telegram call не выполняется, status становится `expired`.
12. Telegram 4xx кроме 429 переводит publication в `failed` без автоматического retry.
13. Telegram 429 учитывает `retry_after`, но не переносит попытку за expiry.
14. Admin recovery переводит expired/failed row в retrying, обновляет expiry и не вызывает LLM.
15. `/status` показывает безопасные delivery counts без payload.
16. `json_schema` HTTP 400 включает process-local capability fallback.
17. Summarizer и curator делают не более одного controlled validation retry.
18. Валидный пустой digest не повторяется и остаётся skipped.
19. Logs не содержат payload, transcript, prompt, model response или secrets.
20. Cleanup удаляет terminal outbox payload старше семи дней и не затрагивает active rows.
21. Existing member-request Telegram behavior и retries не регрессируют.

После focused tests выполняются `npm test`, `npm run typecheck`, `npm run build` и `git diff --check`.

## 15. Rollout и rollback

Перед deploy:

1. проверить миграцию на чистой и существующей PostgreSQL schema;
2. выполнить полный release gate;
3. подтвердить, что target chat/thread IDs не меняются;
4. подтвердить runtime defaults 09:00/09:30 МСК;
5. выполнить controlled Telegram failure test без production LLM content;
6. проверить recovery после test-process restart;
7. только затем отдельно запросить разрешение на production deploy.

Rollback разворачивает предыдущий application commit, но не удаляет outbox tables. Старый код их игнорирует. При последующем повторном rollout новый код продолжит retained rows, если они ещё не delivered/expired и не старше retention. Ручное удаление rows или payload не входит в rollback.

## 16. Критерии готовности

Патч готов, когда сводка запускается в 09:30 МСК, готовый payload durable сохраняется до Telegram, restart не вызывает повторный LLM, частичная отправка корректно продолжается, retries прекращаются в московскую полночь, admin может возобновить expired/failed delivery без LLM, structured-output validation имеет один контролируемый retry, а полный release gate проходит без раскрытия пользовательского содержимого.
