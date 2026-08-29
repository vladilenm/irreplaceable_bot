# Импорт legacy-анкет участников из Google Sheets

**Дата:** 2026-08-29
**Статус:** согласованный дизайн, реализация не начата
**Затрагиваемые системы:** `club-site`, `club_bot`, Google Sheets, Telegram MTProto, Telegram Bot API, Nemiling, Timeweb AI Gateway, PostgreSQL

## Контекст

У клуба есть owner-provided Google Sheet с реальными анкетами участников. Исходная таблица содержит три столбца: Telegram username, имя и один свободный текст. Read-only аудит показал 24 заполненные строки, 23 уникальных username и один полный дубль. В свободном тексте смешаны текущая роль, отрасль, подтверждённый опыт, навыки, проекты, цели обучения и способы помочь другим участникам.

Новый каталог подбора использует структурированный контракт `club.member_matching_source`. Для активной карточки нужны подтверждённый Telegram user ID, актуальный username, имя, профессия, сфера, опыт, `can_help_with`, непустой список навыков, действующее согласие `member_matching` и подтверждённый доступ в клуб. Бот синхронизирует этот view полным snapshot, создаёт embeddings только для изменившихся canonical documents и исключает автора запроса по стабильному Telegram ID.

Владелец клуба подтвердил, что участники дали разрешение на активное использование этих анкет для member matching. Это разрешает импорт, но не разрешает модели придумывать компетенции и не отменяет техническую проверку Telegram identity и действующего доступа.

## Цель

Одноразово преобразовать 23 уникальные свободные анкеты в проверенные структурированные профили, создать или обновить соответствующие site-owned записи и сделать все профили активными в matching-каталоге после полного успешного preflight.

Успешный результат:

- каждый импортированный профиль связан с актуальным Telegram user ID, полученным официальным Telegram API;
- каждый участник подтверждён как член целевой Telegram-группы и как действующий участник по Nemiling либо как явно настроенный администратор;
- каждый структурированный вывод LLM опирается на evidence из исходной анкеты;
- все 23 строки импортируются одной транзакцией или production остаётся неизменным;
- первый Telegram-вход переиспользует импортированного пользователя и не теряет профиль;
- `club.member_matching_source` увеличивается на ожидаемые 23 записи;
- после синхронизации бота все новые карточки имеют актуальные 1536-dimensional embeddings, а `pending_count` равен нулю;
- mock-карточки не реактивируются.

## Не входит в задачу

- постоянная синхронизация Google Sheets;
- использование сторонних Telegram lookup-ботов или неофициальных баз соответствий;
- создание фиктивных Telegram ID;
- импорт неподтверждённых, неактивных или неоднозначно разрешённых участников;
- автоматическое расширение компетенций на основании целей, интересов или желаний учиться;
- хранение реальных анкет, usernames, Telegram ID, LLM-ответов или credentials в Git и обычных runtime-логах;
- изменение production, push или deploy без отдельного явного разрешения и release gate.

## Выбранный подход

Импорт состоит из четырёх изолированных этапов:

1. подготовка и дедупликация исходного snapshot;
2. официальный Telegram identity resolution и проверка доступа;
3. LLM-структурирование с отдельной review-таблицей;
4. all-or-nothing production import, затем синхронизация и индексация ботом.

Исходный Google Sheet остаётся read-only. Review выполняется в отдельном Google Sheet или в его отдельной копии с другим file ID. Runtime приложения не зависит от Google Sheets и не получает постоянных Google credentials.

## Компоненты и владение

### `club-site`

`club-site` остаётся единственным владельцем:

- `club.users`;
- `club.member_profiles`;
- `club.user_consents`;
- `club.subscriptions`;
- `club.member_matching_source`;
- one-shot import CLI и import audit metadata.

Импорт не пишет напрямую в bot-owned `members` или `member_embeddings`. Это предотвратит деактивацию карточек при следующем полном web snapshot.

### `club_bot`

`club_bot` остаётся потребителем `club.member_matching_source` и отвечает только за:

- full snapshot web projection;
- content-hash pending set;
- генерацию embeddings;
- exact vector search;
- LLM rerank и evidence validation;
- Telegram-ответы.

### Внешние сервисы

- Telegram MTProto: `contacts.resolveUsername` для получения peer по public username;
- Telegram Bot API: `getChatMember` для проверки членства в целевой группе по уже известному user ID;
- Nemiling: действующий источник access snapshot;
- Timeweb AI Gateway: структурирование исходной анкеты и существующие embeddings/chat calls;
- Google Sheets: исходный read-only snapshot и отдельная review-поверхность.

## Входные данные и дедупликация

Подготовительный этап читает только три поля исходной таблицы:

- `telegram_username`;
- `display_name`;
- `freeform_profile`.

Нормализация:

- NFC для Unicode;
- username без ведущего `@`, в lowercase;
- схлопывание управляющих символов и лишнего whitespace;
- пустые строки отклоняются;
- исходный текст не сокращается до LLM-этапа;
- для каждой строки вычисляется SHA-256 source hash по нормализованным username, имени и анкете.

Дубли с одинаковым username:

- полный дубль схлопывается в одну запись;
- конфликтующие имя или анкета переводят обе строки в `review_required`;
- один Telegram user ID не может соответствовать двум разным итоговым профилям;
- итоговое ожидаемое количество в этом import batch равно 23.

В Git фиксируются только синтетические fixtures. Временный snapshot и review export хранятся вне репозитория и удаляются после завершения и подтверждённого backup/audit.

## Telegram identity resolution

### Авторизация

One-shot resolver использует официальный MTProto bot login:

- существующий `BOT_TOKEN`;
- отдельные `TELEGRAM_API_ID` и `TELEGRAM_API_HASH`;
- in-memory session без session-файла в репозитории;
- secrets никогда не выводятся и не сохраняются в review Sheet.

Эти параметры нужны только CLI и не становятся новыми обязательными production env-переменными приложения.

### Resolution flow

Для каждого нормализованного username:

1. вызвать `contacts.resolveUsername`;
2. потребовать, чтобы resolved peer был обычным Telegram user, а не каналом, группой или ботом;
3. потребовать положительный user ID в допустимом PostgreSQL `bigint` диапазоне;
4. сравнить возвращённый актуальный username с исходным без учёта регистра;
5. отклонить `USERNAME_INVALID`, `USERNAME_NOT_OCCUPIED`, несовпадение peer type или username;
6. сохранить ID только в защищённый review/import artifact;
7. вызвать `getChatMember(TARGET_CHAT_ID, user_id)` существующим bot token;
8. принять только статус, соответствующий текущему членству; `left`, `kicked` и ошибка проверки блокируют batch.

Если Telegram возвращает rate-limit/FloodWait или временную сетевую ошибку, preflight останавливается без production-записи. Повтор использует тот же immutable source snapshot.

## Проверка доступа Nemiling

После Telegram resolution для каждого user ID вызывается существующая логика доступа `club-site`:

- ID из `ADMIN_TELEGRAM_IDS` получает роль `admin` и не требует искусственной subscription row;
- обычный участник должен получить успешный Nemiling grant;
- subscription row строится только из фактических `projectId`, `tariffId`, `endDate` и времени проверки;
- denied, expired, malformed или service-unavailable результат блокирует весь batch;
- importer не создаёт фиктивных активных подписок и не продлевает срок самостоятельно.

Nemiling вызывается последовательно или с лимитером, соблюдающим подтверждённое ограничение провайдера. Результат preflight не переиспользуется после установленного короткого TTL; перед production transaction выполняется финальная проверка актуальности snapshot.

## LLM-структурирование

Каждая анкета обрабатывается отдельным запросом. Модель не видит анкеты других участников, что снижает риск смешивания evidence.

### Поля результата

Прямые, не генерируемые моделью поля:

- normalized Telegram username;
- resolved Telegram user ID;
- display name из исходной строки;
- source row reference и source hash.

LLM возвращает по строгой JSON Schema:

- `occupation` — до 100 символов;
- `industry` — до 100 символов;
- `expertise` — до 1000 символов;
- `canHelpWith` — до 700 символов;
- `skills` — от 1 до 12 значений, каждое до 30 символов;
- evidence для каждого скалярного поля и каждого навыка;
- confidence `high | medium | low` по каждому извлечённому полю;
- warnings для неоднозначностей и отсутствующей информации.

### Правила извлечения

- Evidence должна быть дословным фрагментом исходной анкеты после одинаковой whitespace-нормализации.
- Текущая работа, завершённые проекты, измеримый опыт и прямо заявленная помощь могут служить evidence.
- Желание научиться, будущая идея, интерес или незапущенный проект не становятся подтверждённой компетенцией сами по себе.
- `canHelpWith` разрешено выводить из прямо заявленной помощи либо из доказанного текущего опыта, но не из одной цели.
- Хобби, политические взгляды, медицинские детали, бытовые сведения и нерелевантные ссылки не включаются в canonical profile.
- Модель не создаёт Telegram links, ID, consent, subscription или membership status.
- Temperature должна быть минимальной; malformed или schema-invalid результат получает не более одной повторной генерации.

### Детерминированная валидация

После LLM код повторно проверяет:

- JSON Schema и все длины;
- непустые обязательные поля;
- число и дедупликацию skills;
- присутствие каждой evidence в исходном тексте;
- отсутствие управляющих символов;
- итоговый canonical document не длиннее 2500 символов;
- совпадение source hash с immutable snapshot.

Любой failed check даёт `review_required` или `error`; автоматического исправления путём догадки нет.

## Отдельный review Sheet

Исходная таблица не редактируется. Создаётся отдельный файл с новым Google Drive file ID и следующими логическими столбцами:

- source row reference;
- normalized username;
- display name;
- resolved Telegram user ID;
- Telegram group membership status;
- Nemiling/admin access status;
- occupation;
- industry;
- expertise;
- can help with;
- skills;
- evidence/confidence summary;
- warnings/error;
- source hash;
- `status`: `ready | review_required | error`;
- `approved`: явный checkbox.

Review Sheet содержит персональные данные и сохраняет исходные права доступа владельца; он не публикуется и не расширяет sharing. Строка готова к production только при `status = ready` и `approved = true`. Изменение структурированных полей после LLM требует повторной детерминированной валидации; ручной текст не получает доверие автоматически.

Перед import review export повторно сверяется с исходным Sheet: изменение исходной строки или source hash после review блокирует batch.

## Import audit metadata

`club-site` добавляет минимальный audit trail без исходных биографий:

### `club.member_import_batches`

- `id uuid primary key`;
- `source text` с фиксированным значением `legacy_google_sheet`;
- `source_snapshot_hash text`;
- `expected_count integer`;
- `status text` (`imported | rolled_back`);
- `imported_at`, `rolled_back_at`;
- `consent_attestation text` — operator-provided ссылка/описание основания подтверждённого разрешения, без secret material.

### `club.member_import_records`

- `batch_id`;
- `user_id`;
- `source_row_reference`;
- `source_hash`;
- `consent_id`;
- `profile_updated_at`;
- primary key `(batch_id, user_id)`;
- unique `(batch_id, source_row_reference)`.

Batch и records создаются только внутри успешной write transaction; dry-run и failed preflight не оставляют audit rows. Audit tables не содержат freeform profile, structured profile, Telegram username, Telegram ID, LLM prompt или response. Они обеспечивают idempotency, точный rollback scope и доказуемое происхождение изменения.

## Production preflight

Production CLI по умолчанию работает как `--dry-run`. Preflight выполняется полностью до открытия write transaction:

1. проверить immutable source/review snapshot и ожидаемые 23 уникальные строки;
2. подтвердить `approved = true` и `status = ready` для каждой строки;
3. повторно проверить JSON/evidence/лимиты;
4. повторно разрешить или подтвердить свежесть Telegram identity;
5. подтвердить членство в целевой Telegram-группе;
6. получить свежий Nemiling/admin access grant;
7. проверить отсутствие конфликтующего Telegram ID, username mapping и import batch;
8. проверить текущую версию consent policy `member-matching-v1`;
9. убедиться, что ожидаемый web source contract доступен;
10. вывести только безопасные counts и классы ошибок.

Если любая из 23 строк не проходит preflight, importer завершает работу с ненулевым exit code и не пишет ничего в production.

Write mode требует отдельного явного флага, точного expected count и import batch ID. CLI не должен запускаться из обычного application boot или scheduler.

## Транзакционный импорт

После успешного preflight одна PostgreSQL transaction обрабатывает весь batch.

Для каждой строки:

1. найти пользователя по `telegram_user_id` с row lock;
2. создать пользователя, если он отсутствует, либо безопасно обновить актуальный username;
3. сохранить существующую роль, если пользователь уже есть; для нового пользователя определить `admin` только по существующей admin-конфигурации, иначе `member`;
4. для member upsert фактический Nemiling subscription snapshot;
5. upsert `member_profiles` с одобренными полями и `onboarding_completed_at`;
6. отозвать несовместимое активное member-matching consent, если оно существует;
7. создать consent текущей версии `member-matching-v1` и сохранить его ID в import record;
8. записать audit record и source hash;
9. не менять `llm_personalization` consent;
10. не трогать unrelated progress, updates или другой пользовательский контент.

Повтор write-команды с тем же batch ID:

- не создаёт второй import;
- сравнивает source snapshot hash и ожидаемое количество;
- возвращает уже импортированный статус без повторного LLM/Telegram/Nemiling side effect;
- конфликтующий batch ID или изменённый snapshot завершает работу ошибкой.

Transaction commit выполняется только после успешной обработки всех 23 строк.

## Первый вход после импорта

Существующий `provisionAuthenticatedUser` выполняет upsert по `telegram_user_id`, поэтому первый реальный Telegram login:

- переиспользует импортированный UUID пользователя;
- обновляет актуальные username, avatar, role и `last_login_at`;
- обновляет фактический Nemiling snapshot;
- не удаляет member profile и active member-matching consent;
- позволяет участнику открыть, исправить или отозвать профиль обычным UI.

Импорт не создаёт session и не имитирует login.

## Bot sync и cutover

Production import сам по себе не гарантирует Telegram matching, пока web-catalog integration не прошла отдельный release gate и не развёрнута в `club_bot`.

После разрешённого deploy и import:

1. `club.member_matching_source` должен увеличиться ровно на 23 eligible rows относительно preflight baseline;
2. bot startup или пяти­минутный scheduler читает полный snapshot;
3. web projection заменяется транзакционно;
4. content hash отправляет только новые/изменённые карточки на embedding;
5. `member_source_state` показывает expected fetched/active/rejected counts;
6. `member_index_state.pending_count` становится равен нулю;
7. все 23 карточки имеют текущую embedding model и 1536 dimensions;
8. mock source остаётся inactive и не используется как fallback.

## Rollback

Rollback является отдельной явной CLI-командой по batch ID и не удаляет пользователей.

Для каждой import record rollback:

- отзывает только сохранённый `consent_id`, если он всё ещё активен;
- скрывает карточку из matching view, устанавливая `onboarding_completed_at = NULL` только если profile `updated_at` всё ещё равен импортированному значению;
- не откатывает профиль, если участник изменил его после импорта; такая строка возвращается как conflict для ручного решения;
- не удаляет user, subscription, login history или пользовательский контент;
- помечает batch `rolled_back` только после успешной обработки всего допустимого scope.

После rollback bot full snapshot деактивирует отсутствующие web cards; embeddings для inactive rows не используются. Автоматическая реактивация mocks запрещена.

## Ошибки и наблюдаемость

Ошибки классифицируются без персональных данных:

- `duplicate-source-username`;
- `conflicting-source-row`;
- `telegram-username-invalid`;
- `telegram-username-not-occupied`;
- `telegram-peer-type-mismatch`;
- `telegram-membership-denied`;
- `telegram-rate-limited`;
- `nemiling-denied`;
- `nemiling-unavailable`;
- `llm-transport-failed`;
- `llm-schema-invalid`;
- `llm-evidence-invalid`;
- `profile-validation-failed`;
- `source-snapshot-changed`;
- `database-identity-conflict`;
- `import-batch-conflict`;
- `rollback-user-modified`.

Обычный вывод содержит batch ID, counts, durations, safe status и error classes. Он не содержит usernames, names, Telegram IDs, biographies, extracted profiles, evidence, prompts, responses, embeddings, tokens, `DATABASE_URL`, bot token, API hash или Nemiling token.

## Тестирование

Реальные данные не становятся fixtures. Все тесты используют синтетические профили.

### Unit tests

- username normalization и deduplication;
- полный дубль против конфликтующего дубля;
- MTProto response: user, bot, channel, invalid/not occupied;
- membership status mapping;
- Nemiling/admin decision mapping;
- LLM JSON Schema, длины и skills dedupe;
- evidence normalization и containment;
- запрет превращать aspiration в expertise/help;
- source hash stability;
- safe error/report redaction.

### PostgreSQL integration tests

- all-or-nothing import 23 synthetic rows;
- zero writes при последней failing row;
- idempotent rerun того же batch;
- conflict при изменённом snapshot;
- правильные users/profile/consent/subscription/audit rows;
- eligibility в `club.member_matching_source`;
- первый login переиспользует user ID и сохраняет профиль;
- rollback скрывает untouched profiles;
- rollback не перезаписывает пользовательские изменения.

### `club_bot` integration/eval

- full snapshot принимает imported site rows;
- content hash создаёт ровно expected pending embeddings;
- requester исключается по Telegram ID;
- top-20 и LLM evidence validation сохраняют контракт 3–5 кандидатов;
- positive queries находят ожидаемые synthetic competencies;
- negative queries не возвращают unrelated profiles;
- mock rows не реактивируются.

## Release и production runbook

До любой production mutation:

1. получить review approval всех 23 строк;
2. выполнить полный `--dry-run`;
3. выполнить PostgreSQL backup и проверить возможность restore;
4. пройти release gate `club-site`: tests, lint, build и diff check;
5. пройти release gate `club_bot`: `npm test`, `npm run typecheck`, `npm run build`, `git diff --check`;
6. отдельно авторизовать push/deploy обоих приложений;
7. подтвердить, что они используют одну Managed PostgreSQL и корректные DB roles;
8. развернуть требуемые schema/code changes;
9. повторить production `--dry-run`;
10. отдельно авторизовать write import с exact batch ID/count;
11. проверить delta `club.member_matching_source = +23`;
12. дождаться bot sync и `pending_count = 0`;
13. выполнить положительные и отрицательные smoke-запросы;
14. проверить, что mocks inactive и не используются;
15. сохранить безопасный итоговый отчёт только со счётчиками и batch status.

Import, deploy, seed, key rotation, Timeweb resource changes и push не выполняются автоматически и требуют отдельного разрешения пользователя.

## Критерии приёмки

- Исходный Google Sheet не изменён.
- Review Sheet имеет другой file ID и не расширяет sharing.
- В review ровно 23 уникальные строки.
- Каждая строка имеет verified Telegram user ID, group membership, Nemiling/admin grant, valid evidence и explicit approval.
- Dry-run при любой ошибке не меняет production.
- Write import атомарен и идемпотентен.
- В site source view появляется ожидаемая delta +23.
- Первый login корректно объединяется с импортированной записью.
- После bot sync все новые active cards индексированы текущей моделью, dimensions = 1536, pending = 0.
- Подбор не публикует менее трёх валидных кандидатов и не возвращает автора самому себе.
- Rollback скрывает импортированные matching cards без удаления user data и без перезаписи последующих правок.
- Реальные персональные данные и credentials отсутствуют в Git и обычных логах.
