# Telegram-бот «Незаменимые»

## What This Is

Telegram-бот для закрытого подписочного сообщества «Клуб Незаменимых» — среды для профессионалов, строящих персональные AI-системы из агентов. MVP — ежедневный новостной дайджест «AI-радар»: бот парсит 9 RSS-источников, фильтрует через LLM и публикует 3–5 самых значимых новостей в тред Telegram-группы клуба.

## Core Value

Участники клуба получают качественно отфильтрованный AI-дайджест каждое утро — это создаёт привычку заходить в клуб и экономит 30–60 минут ежедневного скроллинга.

## Requirements

### Validated

- ✓ Бот запускается на Grammy + TypeScript, подключается к Telegram по long-polling — Phase 1
- ✓ Команда `/start` — приветствие с описанием бота — Phase 1
- ✓ Graceful shutdown при SIGTERM/SIGINT — Phase 1
- ✓ Логирование через pino (структурированные логи) — Phase 1
- ✓ Конфигурация через .env (BOT_TOKEN, TARGET_CHAT_ID, AI_RADAR_THREAD_ID, AI_API_KEY, AI_MODEL и т.д.) — Phase 1

### Active

- [ ] Cron-задача запускает pipeline дайджеста ежедневно в 09:00 MSK (06:00 UTC)
- [ ] Cron-задача запускает pipeline дайджеста ежедневно в 09:00 MSK (06:00 UTC)
- [ ] RSS-парсер тянет 9 фидов (Habr, vc.ru, OpenAI, HuggingFace, LangChain, VentureBeat, Anthropic, Cursor, Tproger), фильтрует по pubDate за 24 часа
- [ ] AI-фильтр (абстракция под Claude и OpenAI) отбирает 3–5 новостей по системному промпту куратора
- [ ] Квота: ровно 2 новости из vc.ru (бизнес-контекст), 1–3 из технических источников
- [ ] Готовый пост публикуется в конкретный тред «📡 AI-радар» через Bot API (HTML, без превью ссылок)
- [ ] Фоллбек: если < 3 значимых новостей — пост не публикуется, на следующий день расширенный дайджест за 48 часов
- [ ] Команда `/digest` — ручной запуск дайджеста
- [ ] Команда `/status` — статус бота, дата и результат последнего дайджеста
- [ ] Retry: при ошибке отправки дайджест ретраит 1 раз
- [ ] Idempotency: повторный запуск за день не дублирует сообщение

### Out of Scope

- Спринтовые механики бота (пинги, ремайндеры, задания каждые 2-3 дня) — v2, после MVP
- Команда `/analytics` — v2
- Команда `/summary` — v2
- Telegram Mini App — отдельный проект
- Supabase-логирование (мониторинг в БД) — после MVP, пока хватит pino-логов
- Inline-кнопки реакций (🔥 / 💤) — расширение после запуска
- Webhook-интеграции — v2
- Продуктовый дашборд — отдельный сервис

## Context

**Клуб «Незаменимые»** — закрытое Telegram-сообщество (~50–200 участников), где профессионалы строят персональные AI-системы из агентов. Философия: «Система > Навык». Формат — каста, а не курс. 90-дневная траектория спринтов: Инициация → Усиление → Оркестрация.

**Telegram-группа** работает в режиме форума (Topics). У клуба уже есть структура тредов: 🏆 Стена результатов, 📋 Фокус недели, 💬 Общий чат, 📣 Объявления. Бот публикует в новый тред **📡 AI-радар**.

**RSS-источники** — 9 фидов на старте (Habr AI Hub, vc.ru, OpenAI, HuggingFace, LangChain, VentureBeat, Anthropic, Cursor, Tproger). Ожидаемый объём: 20–40 статей/день на входе → 3–5 на выходе.

**AI-фильтр** использует системный промпт «AI-куратора» с критериями отбора, заточенными под контекст клуба: практичность, смена правил игры, влияние на «незаменимых», контринтуитивность. Квота по vc.ru — 2 новости в каждом дайджесте.

**Категории новостей:** 🤖 Агенты, 🔗 Оркестрация, 🧠 Модели, 🛠 Инструменты, ⚡ Технологии, 💰 Бизнес.

## Constraints

- **Стек**: Node.js 20+, Grammy, TypeScript, node-cron, pino, rss-parser — зафиксировано в спеке
- **Деплой**: VPS + Docker, long-polling (не webhooks)
- **LLM**: абстракция ai.service.ts — поддержка Claude API и OpenAI API, переключение через .env
- **Типизация**: строгий TypeScript, никаких `any`
- **Модульность**: каждая функция = модуль в `modules/`, plug-and-play архитектура для будущих расширений
- **Тон бота**: «штурман → пилот», прямой, без восторгов — как разведка докладывает штабу

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Long-polling вместо webhooks | Проще деплой на VPS, нет необходимости в SSL/домене | — Pending |
| Абстракция LLM (Claude + OpenAI) | Гибкость переключения провайдера, устойчивость к outages | — Pending |
| MVP = только дайджест | Быстрый запуск, валидация ценности, спринтовые механики — v2 | — Pending |
| 9 RSS-фидов на старте | Покрывает ключевые категории клуба, расширение позже | — Pending |
| Pino для логирования | Структурированные логи, быстрый, стандарт для Node.js | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-04-13 after Phase 1 completion*
