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
2. Подтвердите `openai/gpt-4.1-mini` через `/models` и убедитесь, что `openai/text-embedding-3-large` возвращает 1536 значений при передаче `dimensions: 1536`.
3. Создайте Managed PostgreSQL с pgvector и используйте его TLS-домен в `DATABASE_URL`.
4. Настройте семь переменных в существующем приложении App Platform: `BOT_TOKEN`, `TARGET_CHAT_ID`, `AI_RADAR_THREAD_ID`, `THREAD_SUMMARY_THREAD_ID`, `TRACKED_THREAD_IDS`, `TIMEWEB_AI_TOKEN`, `DATABASE_URL`.
5. Разверните один экземпляр бота и проверьте `/status`.
6. Один раз запустите `npm run seed:members -- --allow-production`, чтобы добавить 20 временных карточек.
7. Проверьте `#запрос` на трёх репрезентативных запросах и убедитесь, что каждый ответ содержит 3–5 упоминаний.

Для Managed PostgreSQL используйте TLS-домен: приложение автоматически включает TLS для не-локального хоста и проверяет цепочку по включённому публичному сертификату `config/timeweb-cloud-ca.crt`.

В App Platform должен работать ровно один экземпляр для одного `BOT_TOKEN`, поскольку Telegram long polling не допускает конкурентные процессы. Контейнеры App Platform заменяемы; данные остаются в Managed PostgreSQL.

## Rollback

При rollback разверните предыдущий commit приложения. Managed PostgreSQL оставьте без изменений; не удаляйте и не ротируйте credentials во время rollback.

## Диагностика и безопасность

- `/status` показывает состояние радара, индекса участников и аптайм.
- При Telegram 409 найдите второй процесс с тем же токеном.
- Тексты сообщений, профили, embeddings, ключи и database URLs не должны попадать в Git или обычные логи.
- Запросы и карточки передаются OpenAI. Перед загрузкой реальных профилей получите информированное согласие участников и проверьте применимые требования к персональным данным и трансграничной передаче с профильным юристом.
