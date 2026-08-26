# Интеграция анкет `club-site` с подбором участников `club-bot`

Дата: 26 августа 2026 года
Статус: дизайн согласован в диалоге, ожидает ревью письменной спецификации

## 1. Цель

Сделать анкету участника в `club-site` единственным источником реальных карточек для подбора по `#запрос` в `club-bot`.

Участник входит на сайт через Telegram OpenID Connect, заполняет минимальную экспертную анкету и отдельно соглашается на AI-обработку и публичное упоминание. Сайт сохраняет исходные структурированные ответы в общей Managed PostgreSQL. Бот каждые пять минут читает полный разрешённый snapshot, строит поисковый текст, рассчитывает embeddings только для новых или изменённых карточек и использует их в существующем pipeline `#запрос`.

После контролируемого cutover двадцать mock-карточек деактивируются и никогда не подмешиваются к реальным результатам.

## 2. Подтверждённый исходный контекст

### `club-site`

Локальный проект находится в `/Users/vladilen/Documents/тнз/club-site` и уже содержит:

- Next.js 16 App Router и серверный runtime;
- Telegram OpenID Connect Authorization Code + PKCE;
- серверную проверку ID token и подписанную cookie-сессию;
- PostgreSQL/Drizzle;
- `club.users`, `club.member_profiles` и `club.user_consents`;
- Server Actions чтения и сохранения анкеты;
- существующий черновой shared-PostgreSQL контракт для будущего бота.

Таким образом, отдельный backend профилей не создаётся: серверный слой Next.js уже выполняет эту роль.

### `club-bot`

Бот уже содержит:

- PostgreSQL с pgvector;
- нормализацию карточек и content hash;
- pending-индексацию;
- exact cosine top-20;
- LLM-переранжирование;
- проверку `memberId` и дословного `evidence`;
- публикацию только 3–5 валидных `@username`;
- двадцать активных mock-карточек в production.

Бот пока не читает `club-site`, не хранит стабильный Telegram ID в карточке участника и исключает автора запроса по изменяемому username.

## 3. Границы первой версии

Входит:

- минимальная экспертная форма на сайте;
- отдельное согласие на member matching;
- общий PostgreSQL-кластер с разными схемами и ролями;
- стабильный read-only database contract для бота;
- полная snapshot-синхронизация при старте и каждые пять минут;
- embeddings только для новых и изменённых экспертных текстов;
- исключение автора по `telegram_user_id`;
- деактивация карточки после отзыва согласия, окончания членства или исчезновения публичного username;
- безопасный переход с mock-карточек;
- автоматические и интеграционные тесты в обоих проектах.

Не входит:

- Excel или Google Sheets как источник карточек;
- цели на 90 дней, текущие проекты, барьеры или общий личный контекст;
- LLM-персонализация вне подбора участников;
- поиск единомышленников по похожим проблемам;
- HTTP API между сайтом и ботом;
- webhooks, очередь событий или event-driven индексация;
- редактирование анкеты через Telegram-бота;
- перенос существующих bot-owned таблиц из текущей схемы в отдельную физическую схему `bot`;
- deploy, production-миграции, изменение ролей, seed или cutover без отдельного разрешения пользователя.

## 4. Архитектурное решение

Выбран один Managed PostgreSQL-кластер и database-level интеграция:

```text
Telegram OIDC
  -> club-site Server Action
  -> club.users / club.member_profiles / club.user_consents
  -> club.member_matching_source (read-only contract)
  -> club-bot snapshot sync
  -> bot-owned members / member_embeddings
  -> #запрос top-20 + LLM validation
```

`club-site` владеет исходными анкетами и всеми миграциями схемы `club`. `club-bot` не изменяет схему `club`: он только читает утверждённый contract view и сохраняет нормализованную поисковую проекцию, embeddings и служебное состояние в своих существующих таблицах.

Сайт не создаёт embeddings, не вызывает AI-провайдера и не реализует поиск участников. Бот не становится владельцем исходной анкеты и не пишет обратно в профиль сайта.

## 5. Идентичность

Единственный cross-project ключ — `club.users.telegram_user_id`:

- PostgreSQL: signed `BIGINT`;
- TypeScript: десятичная строка, не JavaScript `number`;
- внутренний ID поисковой карточки: `web:<telegram_user_id>`.

`club.users.id` остаётся внутренним UUID сайта. `telegram_username` является изменяемым display-полем и никогда не используется как join key.

В bot-owned карточке добавляется отдельный `telegram_user_id`. Миграция добавляет nullable `BIGINT` и частичный unique index для непустых значений: это сохраняет совместимость с предыдущим runtime и историческими mock-карточками, а для каждой новой карточки `source = 'web'` Telegram ID обязателен. При обработке `#запрос` автор исключается по `ctx.msg.from.id`, а не по username.

## 6. Минимальная форма и модель сайта

### 6.1. Пользовательские поля

Каждое содержательное поле формы участвует в embedding:

| Поле формы | Поле хранения | Ограничение | Назначение |
|---|---|---:|---|
| Как вас называть | `club.users.display_name` | 80 символов | публичное имя и часть поискового документа |
| Профессия или специализация | `occupation` | 100 символов | роль участника |
| Сфера работы | `industry` | 100 символов | профессиональный домен |
| Опыт, сильные стороны и кейсы | `expertise` | 1000 символов | подтверждённая экспертность |
| С какими запросами можете помочь | `can_help_with` | 700 символов | явная область полезности |
| Навыки, технологии и инструменты | `skills TEXT[]` | до 12 значений, каждое до 30 символов | компактные поисковые сигналы |

Навыки нормализуются, пустые значения удаляются, точные повторы после нормализации исключаются с сохранением первого порядка.

### 6.2. `club.member_profiles`

Целевой активный контракт таблицы:

```text
user_id UUID PRIMARY KEY REFERENCES club.users(id)
occupation TEXT
industry TEXT
expertise TEXT
can_help_with TEXT
skills TEXT[] NOT NULL DEFAULT '{}'
onboarding_completed_at TIMESTAMPTZ
created_at TIMESTAMPTZ NOT NULL
updated_at TIMESTAMPTZ NOT NULL
```

Из формы, Zod-контракта, DAL и активной продуктовой модели удаляются:

- `ai_experience_level`;
- `goal_90_days`;
- `current_project`;
- `bottleneck`;
- `additional_context`;
- старый текст согласия на будущую LLM-персонализацию.

Для безопасного rollback первая production-миграция может физически сохранить старые колонки, прекратив их чтение и запись. Их физическое удаление выполняется отдельной cleanup-миграцией после подтверждённого стабильного релиза. Они не входят в read-only contract бота и не передаются AI-провайдеру.

### 6.3. Серверное сохранение

Server Action получает `user_id` только из проверенной сессии. Он не принимает Telegram ID, роль, username или чужой UUID из формы.

Профиль и решение о согласии сохраняются одной PostgreSQL-транзакцией. Ошибка записи сохраняет введённые значения в форме и не создаёт частично обновлённый профиль.

## 7. Согласие

Отдельное разрешение для этой функции:

```text
purpose = member_matching
policy_version = member-matching-v1
```

Чекбокс не обязателен для сохранения формы или завершения знакомства с сайтом. Без активного согласия профиль хранится только на сайте и не попадает в read contract бота.

Текст согласия явно сообщает, что экспертные ответы:

- обрабатываются AI-провайдером;
- используются для подбора по `#запрос`;
- могут привести к публичному `@username` и короткой причине релевантности в клубном чате;
- перестают использоваться после отзыва согласия с задержкой не более пяти минут при штатной синхронизации.

`llm_personalization` и `member_matching` — разные цели. Старое согласие никогда не переименовывается и не интерпретируется как разрешение на matching. Если исторические строки `llm_personalization` уже существуют, миграция может сохранить их как неиспользуемую историю, расширив допустимые purpose; активная matching-карточка требует нового явного согласия.

Частичный уникальный индекс сохраняет не более одной активной записи на `(user_id, purpose)` при `revoked_at IS NULL`. Отзыв ставит `revoked_at`, а повторное согласие создаёт новую историческую строку.

## 8. Eligibility и read-only contract

`club-site` создаёт принадлежащий схеме `club` view `club.member_matching_source`.

View раскрывает только поля, необходимые боту:

```text
telegram_user_id
telegram_username
display_name
occupation
industry
expertise
can_help_with
skills
consent_policy_version
source_updated_at
```

В snapshot попадает участник, если одновременно выполнено всё:

1. `onboarding_completed_at IS NOT NULL`;
2. все обязательные экспертные поля заполнены;
3. есть активное согласие `purpose = 'member_matching'` и `revoked_at IS NULL`;
4. роль пользователя — `admin` либо его subscription snapshot имеет `active = true` и `ends_at > now()`;
5. `telegram_username` непустой.

View может возвращать разные `consent_policy_version`; бот обрабатывает профиль только если версия входит в явно поддерживаемый набор текущего deployment. Неподдерживаемая версия не разрешает embedding или выдачу.

`source_updated_at` — максимум релевантных времён изменения пользователя, профиля, согласия и subscription snapshot. Полная snapshot-синхронизация не полагается на cursor, поэтому отзыв, истечение подписки или исчезновение строки обнаруживаются даже без монотонного timestamp.

Если Telegram Login не вернул публичный username, пользователь может сохранить форму и согласие, но сайт показывает, что профиль не участвует в подборе. После создания username и следующего успешного Telegram Login поле обновляется, а карточка появляется в ближайшем snapshot.

## 9. Права PostgreSQL

Используются разные credentials:

- site runtime role: DML в принадлежащих сайту таблицах `club`, без прав на bot-owned данные;
- bot runtime role: `SELECT` только на `club.member_matching_source` и необходимые права на существующие bot-owned таблицы;
- migration role: DDL, создание view и выдача grants;
- browser runtime: без database credentials и прямого SQL.

Бот использует существующий `DATABASE_URL` того же кластера; отдельный HTTP token или новая обязательная bot env-переменная не добавляются. Пятиминутное расписание фиксируется в `runtime-defaults.ts`.

## 10. Snapshot-синхронизация

Синхронизация запускается:

- немедленной bounded-попыткой при старте нового runtime до приёма новых `#запрос`, без бесконечного ожидания;
- затем cron `*/5 * * * *`;
- в process-local/advisory single-flight, чтобы два цикла не коммитили snapshot одновременно.

Алгоритм:

1. Одним bounded SQL-запросом получить полный view snapshot.
2. Проверить типы, Telegram ID, consent version и уникальность cross-project ID.
3. Нормализовать каждую карточку.
4. Построить канонический экспертный `profileText`.
5. Одной транзакцией upsert всех `source = 'web'` карточек и деактивировать прежние web-карточки, отсутствующие в успешно прочитанном snapshot.
6. После snapshot commit прочитать только новые или изменённые active-карточки без актуального embedding.
7. Рассчитать embeddings пакетами и сохранить их с текущими model, dimensions и content hash.
8. Зафиксировать counts и состояние индекса без текстов профилей.

Если SQL fetch, schema validation верхнего уровня или snapshot transaction завершается ошибкой, старый каталог не изменяется и отсутствующие строки не деактивируются.

После неуспешной стартовой попытки runtime может продолжить работу с последним полностью сохранённым web-каталогом. Если в базе ещё нет ни одного успешно синхронизированного web snapshot, бот запускается для служебных задач, но `#запрос` получает безопасную техническую ошибку до первого успешного цикла, а не ложный `no_match`.

Ноль строк после полностью успешного чтения является допустимым полным snapshot: это позволяет корректно деактивировать последнего участника после отзыва согласия. Ошибку доступа к view или parse failure нельзя превращать в пустой успешный snapshot.

## 11. Канонический поисковый документ

Бот, а не сайт, владеет форматированием текста:

```text
Имя: <display_name>
Профессия и специализация: <occupation>
Сфера: <industry>
Опыт, сильные стороны и кейсы: <expertise>
Может помочь с запросами: <can_help_with>
Навыки, технологии и инструменты: <skills через запятую>
```

Нормализация:

- Unicode NFC;
- удаление управляющих символов;
- схлопывание пробелов;
- trim;
- фиксированный порядок полей;
- итоговый жёсткий предел 2500 символов.

Лимиты формы подобраны так, чтобы валидный нормализованный документ вместе с подписями укладывался в этот предел. Если граница нарушена из-за Unicode/служебного форматирования, это считается contract error конкретной карточки: она деактивируется и не обрезается молча с потерей смыслового поля.

`contentHash` — SHA-256 полного канонического текста. Изменение username не пересчитывает embedding, но обновляет публичное упоминание. Изменение любого поля поискового документа меняет hash.

## 12. Embedding lifecycle

Карточка участвует в vector search только если одновременно:

- `active = true`;
- embedding model равна текущей модели;
- dimensions равны 1536;
- embedding content hash равен текущему member content hash.

При изменении профиля old vector не используется: после обновления member hash join поиска перестаёт совпадать до успешной переиндексации. Следующий пятиминутный цикл повторяет failed embedding.

При отзыве согласия, истечении членства или исчезновении username карточка становится `active = false` при следующем snapshot. Старый vector может физически оставаться для диагностики или последующей очистки, но search его не видит.

Профили и embedding-векторы не выводятся в обычные логи.

## 13. Pipeline `#запрос`

Существующая схема сохраняется:

1. точная Telegram hashtag entity `#запрос` в forum topic целевой группы;
2. idempotent reservation по `(chat_id, tg_message_id)`;
3. embedding запроса;
4. exact pgvector top-20 active-карточек;
5. исключение автора по `telegram_user_id`;
6. LLM выбирает до пяти кандидатов только из shortlist;
7. код проверяет `memberId`, uniqueness и дословный `evidence`;
8. код подставляет сохранённый username и HTML-escaping;
9. публикуются только 3–5 валидных кандидатов;
10. менее трёх результатов даёт честный `no_match`, без mock fallback.

LLM получает только канонический экспертный `profileText`, а не исходную таблицу сайта, Telegram ID, subscription data или consent metadata.

## 14. Ошибки и наблюдаемость

Безопасные события и counts:

- snapshot started/completed/failed;
- fetched, normalized, active, incomplete и deactivated counts;
- pending, indexed и failed embedding counts;
- unsupported consent version count;
- карточки без username count;
- duration каждого этапа;
- terminal request status и безопасный stage error code.

Не логируются:

- значения полей анкеты;
- поисковый документ;
- текст `#запрос`;
- prompt и ответ LLM;
- embeddings;
- Telegram auth tokens;
- database URLs или credentials.

Ошибка одной embedding-записи не блокирует следующие карточки. Ошибка полного snapshot не меняет активность каталога. Неожиданно большое массовое изменение отражается counts, но не раскрывает профили.

## 15. Изменения по проектам

### `club-site`

- обновить Drizzle schema и forward migrations;
- обновить Zod input/form state;
- сократить `member-profile-form`;
- сделать matching consent отдельным и необязательным для сохранения;
- обновить repository transaction grant/revoke;
- создать `club.member_matching_source`;
- обновить shared database contract;
- добавить schema, repository, action, form и view integration tests.

### `club-bot`

- расширить доменную карточку стабильным Telegram ID и добавить backward-compatible nullable DB column с partial unique index;
- добавить PostgreSQL source adapter для view;
- реализовать transactional source snapshot replace;
- добавить пятиминутный sync + index lifecycle;
- строить экспертный текст и content hash;
- исключать requester по Telegram ID;
- обновить status/counts и безопасные логи;
- добавить unit, repository и cross-project integration tests.

Изменения выполняются отдельными reviewable commits в соответствующих репозиториях. Существующий dirty worktree `club-site` содержит пользовательский WIP и не должен перезаписываться, очищаться или включаться целиком в unrelated commit.

## 16. Тестирование

### `club-site`

- Telegram ID остаётся unique stable identity;
- клиент не может подменить user ID, username, role или consent history;
- минимальная форма принимает только утверждённые поля и limits;
- сохранение без consent успешно, но view не возвращает профиль;
- grant current consent добавляет профиль в view;
- revoke удаляет профиль из view, сохраняя историю;
- старое `llm_personalization` не разрешает matching;
- unsupported matching policy остаётся видимой по version, но бот её не использует;
- inactive/expired subscription исключается;
- admin допускается без subscription;
- отсутствующий username исключается;
- повторное сохранение обновляет одну строку профиля.

### `club-bot`

- canonical builder детерминирован и укладывается в 2500 символов;
- stable member ID строится из Telegram ID;
- requester исключается по Telegram ID даже после смены username;
- unchanged hash не вызывает новый embedding;
- changed hash исключает старый vector до reindex;
- successful full snapshot деактивирует исчезнувшие web-карточки;
- failed/partial snapshot ничего не деактивирует;
- successful empty snapshot деактивирует все web-карточки;
- duplicate Telegram ID отклоняет snapshot;
- unsupported consent version не индексируется;
- missing username не индексируется;
- mock-карточки не используются после cutover;
- top-20 и evidence validation не регрессируют.

### Cross-project

В общей тестовой PostgreSQL:

1. создать Telegram user;
2. сохранить минимальный профиль без consent и подтвердить отсутствие в bot snapshot;
3. выдать `member-matching-v1`;
4. выполнить bot sync с fake embedding provider;
5. подтвердить active member и актуальный vector;
6. изменить expertise и подтвердить один re-embedding;
7. отозвать consent и подтвердить деактивацию;
8. проверить, что `#запрос` не возвращает автора и не использует mock fallback.

## 17. Release gates и cutover

Перед каждым commit/deploy выполняются release gates соответствующего проекта. Для `club-bot` обязательны:

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

Для `club-site` обязательны минимум:

```bash
npm test
npm run lint
npm run build
git diff --check
```

Production-порядок после отдельного разрешения:

1. Сделать backup и подтвердить restore path общей PostgreSQL.
2. Применить additive миграции `club-site` и создать view/grants.
3. Развернуть минимальную форму и собрать реальные matching consents.
4. Проверить минимум три eligible real-профиля.
5. Во время короткого maintenance window остановить polling бота.
6. Применить bot migrations, выполнить полный sync и дождаться `pending_count = 0`.
7. Проверить counts, модели, dimensions и отсутствие unsafe logs.
8. Одной контролируемой транзакцией деактивировать двадцать `source = 'mock'` карточек.
9. Запустить новый bot runtime и проверить три репрезентативных `#запрос`.
10. Наблюдать sync, request statuses и Telegram delivery без вывода профилей.

Моковые строки можно оставить физически для rollback-диагностики, но `active = false`. Реальный pipeline никогда не смешивает active mock и web profiles и не реактивирует mock автоматически.

## 18. Rollback

- Rollback `club-bot`: развернуть предыдущий commit; сохранённые реальные members и embeddings остаются в PostgreSQL, mock-карточки остаются неактивными. Старый runtime временно не синхронизирует новые изменения сайта.
- Rollback `club-site`: additive columns и view остаются; предыдущий код продолжает работать, пока старые колонки физически не удалены.
- Cleanup старых колонок выполняется только после окончания rollback window.
- Отзыв consent остаётся авторитетным: rollback не должен реактивировать профиль или mock fallback.
- Ни один rollback не удаляет Managed PostgreSQL, credentials или исходные анкеты.

## 19. Критерии готовности

Функция готова, когда:

- минимальная форма содержит только поля экспертного embedding и matching consent;
- Telegram ID является единственным cross-project ключом;
- сайт сохраняет исходные поля, но не вызывает AI;
- бот читает только approved view с отдельным credential;
- полный snapshot синхронизируется при старте и каждые пять минут;
- grant/revoke, membership и username отражаются в каталоге не позднее следующего штатного цикла;
- unchanged profile не вызывает повторный embedding;
- изменённый профиль не использует устаревший vector;
- автор исключается по Telegram ID;
- реальный поиск выдаёт 3–5 проверенных участников или честный `no_match`;
- двадцать mock-карточек деактивированы и не участвуют в production;
- cross-project integration scenario и release gates проходят;
- deploy и cutover выполнены только после явного разрешения пользователя.
