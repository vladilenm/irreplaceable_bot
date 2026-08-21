# Эксплуатация

## Локальная PostgreSQL

```bash
cp .env.example .env
docker compose -f docker-compose.test.yml up -d --wait
npm ci
npm run seed:members
```

Контейнер поднимает PostgreSQL с pgvector на `127.0.0.1:55432`; логин, база и URL уже указаны в `.env.example`. `seed:members` добавляет ровно 20 вымышленных карточек и обращается к OpenAI, поэтому нужен настоящий `EMBEDDING_API_KEY`.

Быстрая проверка:

```bash
docker compose -f docker-compose.test.yml exec postgres-test \
  psql -U club_bot -d club_bot_test -c "SELECT extversion FROM pg_extension WHERE extname = 'vector';"

docker compose -f docker-compose.test.yml exec postgres-test \
  psql -U club_bot -d club_bot_test -c "SELECT COUNT(*) FROM members WHERE source = 'mock';"
```

Обычная остановка сохраняет данные: `docker compose -f docker-compose.test.yml down`. Ключ `-v` удалит локальный volume — используйте его только намеренно.

## Timeweb Managed PostgreSQL

### 1. Создание кластера

1. Создайте Managed PostgreSQL поддерживаемой версии, предпочтительно PostgreSQL 16, в том же регионе и приватной сети, где будет приложение.
2. Создайте базу `club_bot` и отдельного владельца схемы/миграций.
3. Включите расширение pgvector в панели Timeweb либо подключитесь владельцем и выполните `CREATE EXTENSION IF NOT EXISTS vector;`.
4. Для постоянной связи приложения используйте приватный адрес. Публичный доступ включайте только на время локального импорта/диагностики и затем отключайте.

Справка Timeweb: [Managed PostgreSQL](https://timeweb.cloud/docs/dbaas/postgresql), [расширения PostgreSQL](https://timeweb.cloud/docs/dbaas/postgresql/extensions), [подключение и TLS](https://timeweb.cloud/docs/dbaas/postgresql/connect-to-database), [управление публичным IP](https://timeweb.cloud/docs/dbaas/dbaas-manage/public-ip-access).

### 2. Роли

На вкладке кластера «Пользователи» создайте двух пользователей:

- `club_bot_migration` с правами `CREATE`, `SELECT`, `INSERT`, `UPDATE`, `DELETE`, `REFERENCES` на базу `club_bot`; его URL идёт в `DATABASE_MIGRATION_URL`;
- `club_bot_runtime` только с `SELECT`, `INSERT`, `UPDATE`, `DELETE`; его URL идёт в `DATABASE_URL`.

Timeweb не выдаёт root-доступ и рекомендует управлять пользователями и их привилегиями через панель. На минимальном тарифе 1 CPU / 1 ГБ отдельные пользователи недоступны: для строгого разделения migration/runtime нужен следующий тариф. Пароль с `@`, `:`, `/` или другими специальными символами должен быть percent-encoded внутри URL. См. [пользователи и привилегии PostgreSQL](https://timeweb.cloud/docs/dbaas/postgresql/users-and-privileges).

### 3. TLS

Для Timeweb задайте `DATABASE_SSL=true`. Скачайте корневой сертификат из панели/инструкции Timeweb и передайте PEM через `DATABASE_CA_CERT`. В App Platform удобно сохранить его одной строкой с литеральными разделителями `\n`; приложение превратит их в переводы строк. Проверка сертификата остаётся включённой (`rejectUnauthorized=true`). Не переключайте production на `DATABASE_SSL=false`.

### 4. App Platform

Timeweb пересоздаёт контейнеры приложения, поэтому данные в контейнере не считаются постоянными. `docker-compose.yml` не содержит `volumes` и подключается к внешней Managed PostgreSQL. В App Platform задайте секреты/переменные:

- `DATABASE_URL`, `DATABASE_MIGRATION_URL`, `DATABASE_SSL=true`, `DATABASE_CA_CERT`;
- `DATABASE_POOL_MAX=5`, `DATABASE_STATEMENT_TIMEOUT_MS=10000`;
- `BOT_TOKEN`, `TARGET_CHAT_ID`, Telegram thread ids;
- `AI_API_KEY`, `AI_MODEL` и при необходимости `AI_BASE_URL`;
- `EMBEDDING_API_KEY`, `EMBEDDING_MODEL=text-embedding-3-small`;
- `MEMBER_INDEX_CRON=*/15 * * * *` и ограничения очереди;
- сначала `REQUEST_MATCHING_ENABLED=false`;
- обычно `ALLOW_MOCK_MEMBER_SEED=false`.

Разворачивайте ровно один экземпляр на один `BOT_TOKEN`: Telegram long polling не допускает конкурирующие процессы. Документация: [Docker Compose в App Platform](https://timeweb.cloud/docs/apps/deploying-with-docker-compose), [переменные](https://timeweb.cloud/docs/apps/variables), [жизненный цикл контейнеров](https://timeweb.cloud/docs/apps/how-it-works).

## Rollout

1. Сделайте backup/snapshot Managed PostgreSQL.
2. Разверните приложение с `REQUEST_MATCHING_ENABLED=false`. При старте применятся идемпотентные миграции и выполнится readiness-check.
3. Если нужна старая SQLite, временно разрешите доступ к БД только со своей машины и выполните:

   ```bash
   npm run migrate:sqlite -- /absolute/path/messages.db
   ```

   PostgreSQL должна быть полностью пустой. Импорт идёт одной транзакцией, проверяет количества строк и не изменяет SQLite-файл.
4. Только для тестовой среды создайте mocks: `npm run seed:members`. В production команда дополнительно требует `ALLOW_MOCK_MEMBER_SEED=true`.
5. Проверьте индекс и 20–30 закрытых контрольных запросов. Замените или деактивируйте mocks до загрузки реального каталога.
6. Включите `REQUEST_MATCHING_ENABLED=true` и перезапустите единственный экземпляр.

Проверочные SQL-запросы:

```sql
SELECT extversion FROM pg_extension WHERE extname = 'vector';
SELECT COUNT(*) AS mock_members FROM members WHERE source = 'mock';
SELECT provider, embedding_model, active_count, pending_count, last_success_at
FROM member_index_state;
SELECT status, COUNT(*) FROM member_requests GROUP BY status ORDER BY status;
SELECT COUNT(*) AS captured_messages FROM messages;
SELECT job_name, last_completed_at, last_outcome, item_count FROM job_state;
```

Для приватной оценки:

```bash
npm run eval:member-matching -- /absolute/path/member-matching-eval.json
```

Eval JSON содержит только `query` и `expectedUsernames`, не коммитится и считается успешным при результате не ниже 80%.

## Rollback и восстановление

- Быстрый rollback функции: `REQUEST_MATCHING_ENABLED=false` и перезапуск. Радар и сводки продолжат работать.
- Миграции forward-only; перед изменениями схемы используйте backup/snapshot Timeweb.
- Возврат всего приложения на SQLite возможен только старой версией кода и с нетронутой копией исходного файла. Новые данные из PostgreSQL обратно автоматически не экспортируются.
- База не хранится в Docker-образе или файловой системе App Platform.

## Диагностика и безопасность

- `/status` показывает состояние радара, индекса участников и аптайм.
- При Telegram 409 найдите второй процесс с тем же токеном.
- Тексты сообщений, профили, embeddings, ключи и database URLs не должны попадать в Git или обычные логи.
- Запросы и карточки передаются OpenAI. Перед загрузкой реальных профилей получите информированное согласие участников и проверьте применимые требования к персональным данным и трансграничной передаче с профильным юристом.
