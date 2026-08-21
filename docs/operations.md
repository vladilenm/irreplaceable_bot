# Эксплуатация

## Docker и Timeweb

```bash
docker compose up --build -d
```

`docker-compose.yml` не объявляет `volumes`: Timeweb отклоняет такие compose-файлы. В production подключите постоянный диск через панель платформы в `/app/data` и задайте переменные окружения там же. Для локального Docker можно создать gitignored-файл `docker-compose.override.yml` с `env_file: .env` и bind mount `./data:/app/data`.

Запускайте ровно один экземпляр бота на один `BOT_TOKEN`. Telegram допускает только одного long-polling клиента. При конфликте бот пишет ошибку 409, ждёт 60 секунд и завершает процесс, чтобы supervisor не создавал плотный restart loop.

## SQLite

Рабочая база по умолчанию: `data/messages.db`. При старте бот:

1. включает WAL и проверяет, что режим действительно активен;
2. применяет недостающие forward-only миграции;
3. один раз импортирует старый `data/state.json`, только если таблица `job_state` ещё пуста.

После успешного импорта `state.json` больше не используется и может оставаться как rollback-копия. Не запускайте несколько контейнеров с одной базой и одним токеном.

Для резервной копии остановите бот и сохраните весь каталог `/app/data`. При online-backup используйте SQLite backup API или снапшот диска, который согласован с WAL.

## Расписания

Cron-выражения считаются в UTC. Значения по умолчанию:

| Задача | UTC | Москва |
|---|---:|---:|
| AI-радар | `0 6 * * *` | 09:00 |
| Сводка клуба | `30 3 * * *` | 06:30 |
| Очистка сообщений | `0 1 * * *` | 04:00 |

Очистка удаляет сообщения старше `MESSAGE_RETENTION_DAYS` небольшими батчами. Минимальное допустимое значение — 7 дней.

## Telegram

Бот должен быть администратором целевой группы, а Privacy Mode должен быть выключен через BotFather. Startup preflight проверяет оба условия и пишет предупреждение, не останавливая процесс.

При диагностике проверьте:

- совпадает ли `TARGET_CHAT_ID` с группой;
- входят ли нужные forum topic id в `TRACKED_THREAD_IDS`;
- подключён ли постоянный диск к `/app/data`;
- нет ли второго процесса с тем же токеном;
- корректны ли `AI_MODEL`, `AI_API_KEY` и, при необходимости, `AI_BASE_URL`.

Логи структурированные (pino). Текст сообщений участников не логируется.

## Подбор участников по запросу

Функция отвечает только на Telegram entity с точным `#запрос` в `TARGET_CHAT_ID`, в любом forum-топике. Обычные сообщения не вызывают embeddings или LLM. При успехе бот отвечает в исходном топике тремя–пятью `@username`; если надёжных совпадений меньше трёх, упоминаний не будет.

### Настройка и rollout

1. Создайте Notion connection с правом read content и расшарьте ей data source с карточками клуба.
2. В data source обязательны свойства: `Name` (title), `Telegram` (rich text) и `Profile` (rich text).
3. Скопируйте именно ID data source, а не ID родительской database. См. [Notion: query a data source](https://developers.notion.com/reference/query-a-data-source) и [guide по database/data source](https://developers.notion.com/guides/data-apis/working-with-databases).
4. Заполните `NOTION_TOKEN`, `NOTION_DATA_SOURCE_ID`, `EMBEDDING_API_KEY` и `EMBEDDING_MODEL`, но оставьте `REQUEST_MATCHING_ENABLED=false`.
5. Запустите один экземпляр бота, убедитесь через `/status`, что индекс синхронизировался, затем выполните приватную проверку на 20–30 подготовленных запросах:

   ```bash
   npm run eval:member-matching -- /absolute/path/member-matching-eval.json
   ```

   Набор JSON содержит только `query` и `expectedUsernames`, не должен попадать в Git и считается успешным при результате не ниже 80%.
6. Включите `REQUEST_MATCHING_ENABLED=true` и перезапустите единственный production-экземпляр.
7. Для rollback снова выключите флаг и перезапустите процесс: радар, захват сообщений и сводки продолжат работать независимо.

`MEMBER_SYNC_CRON` по умолчанию синхронизирует каталог раз в 15 минут. `REQUEST_MATCH_CONCURRENCY`, `REQUEST_QUEUE_LIMIT` и `REQUEST_PROCESSING_TIMEOUT_MINUTES` ограничивают нагрузку и обрабатывают зависшие запросы.

Не добавляйте реальные карточки, request-тексты, embeddings, Notion token, OpenAI key или eval-набор в коммиты. Логи feature содержат только технические ID, количество результатов и класс ошибки.
