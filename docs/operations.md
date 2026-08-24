# Эксплуатация

## Локальный runbook

```bash
cp .env.example .env
docker compose -f docker-compose.test.yml up -d
npm install
npm run build
npm run seed:members
npm run dev
```

Заполните локальный `.env` Telegram-токеном, всеми Telegram ID и `TIMEWEB_AI_TOKEN`. Пример `DATABASE_URL` уже настроен на pgvector-контейнер на `127.0.0.1:55432`.

App Platform хранит production-переменные отдельно и не переносит их в локальные файлы. Репозиторий не содержит реальных значений, а приложение читает `.env`, не `.env.local`.

Быстрая проверка:

```bash
docker compose -f docker-compose.test.yml exec postgres-test \
  psql -U club_bot -d club_bot_test -c "SELECT extversion FROM pg_extension WHERE extname = 'vector';"

docker compose -f docker-compose.test.yml exec postgres-test \
  psql -U club_bot -d club_bot_test -c "SELECT COUNT(*) FROM members WHERE source = 'mock';"
```

Обычная остановка сохраняет данные: `docker compose -f docker-compose.test.yml down`. Ключ `-v` удалит локальный volume — используйте его только намеренно.


## Timeweb: подтверждение перед действиями

До создания платного кластера, постоянного ключа AI Gateway, внесения ключа или реквизитов базы в App Platform, а также до подтверждения списания, остановитесь и получите action-time подтверждение. Оно должно включать конфигурацию PostgreSQL, регион, период оплаты, выбор публичного IP и backup, а также точную сумму из панели Timeweb.

## Timeweb: production checklist

После этого подтверждения выполните шаги по порядку:

1. Создайте один ключ AI Gateway и сохраните его как `TIMEWEB_AI_TOKEN`.
2. Для задеплоенного `597be1c` подтвердите `openai/gpt-4.1-mini` через `/models` и убедитесь, что `openai/text-embedding-3-large` возвращает 1536 значений при передаче `dimensions: 1536`. Локальный latency-WIP переключает defaults на `openai/gpt-5.6-luna` и `openai/text-embedding-3-small`; это изменение нельзя деплоить без полного release gate и переиндексации карточек.
3. Создайте Managed PostgreSQL с pgvector. Для подключения по private IP добавьте App Platform и базу в одну приватную сеть и используйте RFC1918-адрес в `DATABASE_URL`; для подключения по домену или публичному IP используйте защищённый URL.
4. Настройте семь обязательных переменных в существующем приложении App Platform: `BOT_TOKEN`, `TARGET_CHAT_ID`, `AI_RADAR_THREAD_ID`, `THREAD_SUMMARY_THREAD_ID`, `TRACKED_THREAD_IDS`, `TIMEWEB_AI_TOKEN`, `DATABASE_URL`. Необязательный `TELEGRAM_PROXY_VLESS_URL` добавляется только после отдельного согласования proxy rollout; значение — полный VLESS URI, его нельзя печатать, коммитить или передавать в обычные логи.
5. Разверните один экземпляр бота и проверьте `/start`, затем `/status` в целевой группе от неанонимного администратора. В текущем коде `/status` в личке не подтверждает права администратора клуба.
6. Один раз запустите `node dist/member.seed.js --allow-production` из консоли приложения, чтобы добавить 20 временных карточек. Production-образ не содержит dev dependency `tsx`, поэтому `npm run seed:members` внутри контейнера не является правильной командой.
7. Проверьте `#запрос` на трёх репрезентативных запросах и убедитесь, что каждый ответ содержит 3–5 упоминаний.

Для Managed PostgreSQL приложение отключает TLS только для loopback и RFC1918 private IPv4 (`10/8`, `172.16/12`, `192.168/16`). Такое подключение допустимо только внутри общей приватной сети Timeweb. Для доменов, публичных IP и остальных адресов приложение включает строгий TLS и проверяет цепочку по сертификату `config/timeweb-cloud-ca.crt`.

В App Platform должен работать ровно один экземпляр для одного `BOT_TOKEN`, поскольку Telegram long polling не допускает конкурентные процессы. Контейнеры App Platform заменяемы; данные остаются в Managed PostgreSQL.

Приложение не поднимает HTTP-сервер. Строка deploy log `No HTTP ports discovered` нормальна для этого worker, если далее Timeweb пишет `App is healthy` и `Deploy succeeded`.

Ожидаемый app log успешного старта:

```text
PostgreSQL migrations complete
Starting bot...
Bot is running (long-polling mode)
Scheduler started
Initial member directory indexing complete
```

## Расписание публикаций и инцидент 2026-08-23

Cron выражения интерпретируются в UTC. В локальном WIP, который ещё не развёрнут в production, расписание такое:

| Pipeline | Cron | Время МСК |
|---|---:|---:|
| AI-радар | `0 6 * * *` | 09:00 |
| Сводка тем | `30 6 * * *` | 09:30 |

Production `597be1c` всё ещё содержит старое `30 3 * * *` для сводки (06:30 МСК), пока этот WIP не пройдёт release gate и не будет явно развёрнут.

AI-радар и сводка намеренно отправляются в один Telegram forum topic. Совпадение target thread для этих pipeline является штатной конфигурацией.

23 августа оба scheduled pipeline успешно дошли до LLM, но не опубликовали результат:

- Сводка выполнила три fallback-вызова после того, как Timeweb AI Gateway отклонил `json_schema` с HTTP 400. Два результата не прошли локальную schema-валидацию, один был успешным.
- После формирования сводки первоначальный Telegram `sendMessage` и retry через 3 секунды завершились `Network request for 'sendMessage' failed` с `error_code=no-code`.
- AI-радар в 09:00 дошёл до `AI filtering complete` и `Digest ready`, но обе попытки Telegram `sendMessage` завершились такой же транспортной ошибкой.
- В обоих случаях Telegram не вернул API error code. Это отличает сетевой сбой до ответа Telegram от ошибок permissions, chat ID или thread ID.
- Job state меняется только после подтверждённой доставки, поэтому состояния обоих pipeline не продвинулись. Однако scheduler не делает отложенный автоматический повтор после исчерпания встроенного retry.

В реализованном локальном WIP final payload сохраняется в PostgreSQL outbox до первого Telegram request. Dispatcher сохраняет результат каждого chunk и повторяет transport/5xx/429 ошибки с persisted backoff `3s → 15s → 1m → 5m → 15m → 30m` до следующей полуночи МСК. Не-429 4xx переводят публикацию в `failed`; просроченные публикации — в `expired`. В обоих случаях администратор целевой группы запускает `/retry_publications [digest|summary|all]`; это повторяет только доставку, не RSS и не LLM. `/status` показывает только безопасные counts очереди.

## Telegram egress через Amsterdam VLESS (локальный WIP до deploy)

При заданном `TELEGRAM_PROXY_VLESS_URL` процесс запускает bundled Xray, ждёт loopback SOCKS и направляет через него только grammY. Проверка после deploy — `getMe` в startup/preflight и успешная доставка существующей outbox-публикации через `/retry_publications digest`; не запускайте `/digest` или `/dev-digest` для восстановления. Если прокси не стартует или Telegram всё ещё недоступен, удалите только optional secret и сделайте rollback приложения: direct mode будет восстановлен, а сохранённая публикация останется в outbox. Личный mobile URI не используется ботом; его ротация и ротация bot URI выполняются независимо.

Отправка является at-least-once: обрыв сети после того, как Telegram принял запрос, нельзя надёжно отличить от неполученного сообщения. Поэтому при recovery возможен один дубликат конкретного chunk. Terminal записи очищаются через семь дней.

Timeweb AI Gateway в инциденте отвергал `json_schema` с 400. Локальный WIP кэширует эту capability по endpoint/model и после первого rejection использует `json_object` сразу; malformed/schema-invalid/all-hallucinated output получает ровно одну повторную генерацию. Это не меняет production до deploy.

Ранние повторяющиеся записи `Missing required environment variable: AI_API_KEY` и `PostgreSQL migrations failed` относятся к предыдущему образу с устаревшим env-контрактом. При анализе текущего процесса отсчитывайте boot от последовательности `PostgreSQL migrations complete` → `Starting bot...` → `Bot is running`.

## Проверка `#запрос`

После тестового сообщения проверьте последние записи из консоли приложения:

```bash
node --input-type=module -e 'import{Pool}from"pg";const p=new Pool({connectionString:process.env.DATABASE_URL});const{rows}=await p.query("SELECT thread_id,tg_message_id,status,match_count,error_code,started_at,completed_at FROM member_requests ORDER BY started_at DESC LIMIT 10");console.table(rows);await p.end()'
```

- Нет строки: сообщение не прошло extractor. Проверяйте `TARGET_CHAT_ID`, forum topic, `message_thread_id` и точную hashtag entity `#запрос`.
- `processing`: pipeline ещё выполняется.
- `completed`: Telegram подтвердил итоговый ответ; `match_count` должен быть от 3 до 5.
- `no_match`: после evidence-проверки осталось меньше трёх кандидатов.
- `failed`: используйте `error_code` и app logs, не выводя query или credentials.

Два разных `tg_message_id` — два реальных Telegram-сообщения, а не повторная обработка одного update. При production-проверке 2026-08-22 успешный запрос занял около 139 секунд, а второй почти одновременный запрос завершился `processing-failed` примерно через 269 секунд. Это исходная точка для latency-патча, а не целевая производительность.

## Rollback

При rollback разверните предыдущий commit приложения. Managed PostgreSQL оставьте без изменений; не удаляйте и не ротируйте credentials во время rollback.

## Диагностика и безопасность

- `/status` показывает состояние радара, индекса участников и аптайм.
- `/status` в текущей реализации разрешён только неанонимному администратору того group/supergroup, где отправлена команда. DM всегда получает отказ.
- При Telegram 409 найдите второй процесс с тем же токеном.
- `Network request for 'sendMessage' failed` без Telegram error code означает транспортный сбой до ответа Telegram. Если далее есть `Telegram sendMessage ok (after retry)`, отправка восстановилась автоматически.
- В Timeweb используйте **Логи приложения** для runtime-событий. Deploy logs подтверждают только сборку и lifecycle контейнера, а dashboard показывает ресурсы, не бизнес-этапы.
- Тексты сообщений, профили, embeddings, ключи и database URLs не должны попадать в Git или обычные логи.
- Запросы и карточки обрабатываются через Timeweb AI Gateway. Перед загрузкой реальных профилей получите информированное согласие участников и проверьте применимые требования к персональным данным и трансграничной передаче с профильным юристом.
