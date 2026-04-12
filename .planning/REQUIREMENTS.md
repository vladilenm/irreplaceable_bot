# Requirements: Telegram-бот «Незаменимые»

**Defined:** 2026-04-13
**Core Value:** Участники клуба получают качественно отфильтрованный AI-дайджест каждое утро — привычка, экономящая 30–60 минут скроллинга

## v1 Requirements

### Project Setup

- [ ] **SETUP-01**: Проект инициализирован с Node.js 20+, TypeScript, Grammy, модульной структурой из спеки
- [ ] **SETUP-02**: Конфигурация загружается из .env (BOT_TOKEN, TARGET_CHAT_ID, AI_RADAR_THREAD_ID, DIGEST_CRON, AI_API_KEY, AI_MODEL, LOG_LEVEL)
- [ ] **SETUP-03**: Логирование через pino с настраиваемым уровнем (LOG_LEVEL)
- [ ] **SETUP-04**: Dockerfile для деплоя на VPS (long-polling режим)

### RSS Parser

- [ ] **RSS-01**: Парсер тянет 9 RSS-фидов (Habr, vc.ru, OpenAI, HuggingFace, LangChain, VentureBeat, Anthropic, Cursor, Tproger)
- [ ] **RSS-02**: Фильтрация статей по pubDate за последние 24 часа
- [ ] **RSS-03**: Фоллбек: если < 3 статей за 24ч — расширить окно до 48 часов
- [ ] **RSS-04**: Список фидов конфигурируется (легко добавить/убрать источник без изменения кода)
- [ ] **RSS-05**: Формирование JSON-массива с полями: title, description, link, source, pubDate

### AI Filter

- [ ] **AI-01**: Абстракция ai.service.ts поддерживает Claude API и OpenAI API, переключение через .env (AI_MODEL)
- [ ] **AI-02**: Системный промпт AI-куратора с критериями отбора под контекст клуба
- [ ] **AI-03**: Отбор 3–5 новостей из входного массива 20–40 статей
- [ ] **AI-04**: Квота: ровно 2 новости из vc.ru в каждом дайджесте (минимум 1, если нет достойных)
- [ ] **AI-05**: Каждая новость размечена одной из 6 категорий (🤖 Агенты, 🔗 Оркестрация, 🧠 Модели, 🛠 Инструменты, ⚡ Технологии, 💰 Бизнес)
- [ ] **AI-06**: Фоллбек: если < 3 значимых новостей — дайджест не публикуется

### Digest Delivery

- [ ] **DLV-01**: Cron-задача запускает pipeline ежедневно в 09:00 MSK (06:00 UTC)
- [ ] **DLV-02**: Готовый пост публикуется в тред «📡 AI-радар» через Bot API (HTML, disable_web_page_preview)
- [ ] **DLV-03**: Формат поста: заголовок с датой, 3–5 новостей с emoji категории + заголовок + суть + ссылка, футер
- [ ] **DLV-04**: Retry: при ошибке отправки — 1 повторная попытка
- [ ] **DLV-05**: Idempotency: повторный запуск за день не дублирует сообщение

### Bot Commands

- [ ] **CMD-01**: Команда /start — приветствие с описанием бота и его возможностей
- [ ] **CMD-02**: Команда /digest — ручной запуск pipeline дайджеста (вне расписания)
- [ ] **CMD-03**: Команда /status — статус бота, дата и результат последнего дайджеста

### Reliability

- [ ] **REL-01**: Graceful shutdown при SIGTERM/SIGINT (корректное завершение Grammy, cron)
- [ ] **REL-02**: Ошибки логируются, не роняют бота — бот продолжает работу после сбоя дайджеста
- [ ] **REL-03**: Строгий TypeScript (strict: true, никаких any)

## v2 Requirements

### Sprint Mechanics

- **SPRINT-01**: Бот отправляет задания участникам каждые 2-3 дня по таймлайну спринта
- **SPRINT-02**: Пинги и ремайндеры для неактивных участников (5+ дней без движения)
- **SPRINT-03**: Чекпоинты — публичные отчёты прогресса

### Analytics

- **ANLT-01**: Команда /analytics — метрики клуба (активность, retention, рост)
- **ANLT-02**: Логирование дайджестов в Supabase (дата, кол-во статей, публикация, причина пропуска)
- **ANLT-03**: Алерт фаундеру, если бот не публикует 3 дня подряд

### Engagement

- **ENG-01**: Inline-кнопки реакций (🔥 Полезно / 💤 Мимо) на постах дайджеста
- **ENG-02**: Команда /summary — AI-суммаризация обсуждений в чатах клуба

## Out of Scope

| Feature | Reason |
|---------|--------|
| Telegram Mini App | Отдельный проект, другой стек (React + Supabase) |
| Webhook-интеграции | Не нужны для MVP, VPS + long-polling достаточно |
| Продуктовый дашборд | Отдельный сервис, не часть бота |
| OAuth / авторизация пользователей | Бот работает в группе, не требует отдельной авторизации |
| Расширенные RSS-источники (Google AI, The Verge, smol.ai) | Подключить после валидации MVP |
| Supabase для логирования | MVP — только pino-логи, БД позже |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| SETUP-01 | — | Pending |
| SETUP-02 | — | Pending |
| SETUP-03 | — | Pending |
| SETUP-04 | — | Pending |
| RSS-01 | — | Pending |
| RSS-02 | — | Pending |
| RSS-03 | — | Pending |
| RSS-04 | — | Pending |
| RSS-05 | — | Pending |
| AI-01 | — | Pending |
| AI-02 | — | Pending |
| AI-03 | — | Pending |
| AI-04 | — | Pending |
| AI-05 | — | Pending |
| AI-06 | — | Pending |
| DLV-01 | — | Pending |
| DLV-02 | — | Pending |
| DLV-03 | — | Pending |
| DLV-04 | — | Pending |
| DLV-05 | — | Pending |
| CMD-01 | — | Pending |
| CMD-02 | — | Pending |
| CMD-03 | — | Pending |
| REL-01 | — | Pending |
| REL-02 | — | Pending |
| REL-03 | — | Pending |

**Coverage:**
- v1 requirements: 26 total
- Mapped to phases: 0
- Unmapped: 26 ⚠️

---
*Requirements defined: 2026-04-13*
*Last updated: 2026-04-13 after initial definition*
