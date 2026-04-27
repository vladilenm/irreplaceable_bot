# Telegram-бот «Незаменимые»

## What This Is

Telegram-бот для закрытого подписочного сообщества «Клуб Незаменимых» — среды для профессионалов, строящих персональные AI-системы из агентов. **v1.0 (shipped):** ежедневный новостной дайджест «AI-радар» — бот парсит 9 RSS-источников, фильтрует через LLM (Claude или OpenAI-совместимый провайдер) и публикует 3–5 самых значимых новостей в тред Telegram-группы клуба в 09:00 MSK. **v2.0 (planned):** утренние summary переписки тредов — бот превращается из публикующего в слушающего агента.

## Current State

**v1.0 MVP — AI Radar Digest** (shipped 2026-04-27)

- 854 LOC TypeScript across 12 source files (strict mode, no `any`)
- 9 RSS feeds in `config/feeds.json`, 24h/48h fallback, per-feed error isolation
- Dual-provider LLM via `ai.service.ts` (Anthropic SDK + OpenAI SDK, switch by model prefix and `AI_BASE_URL`)
- Cron (node-cron) + idempotency via `data/state.json` (MSK calendar day)
- Admin-gated commands: `/start`, `/digest`, `/status`, `/dev-digest` (with 5-min admin-list cache)
- Docker multi-stage build, non-root botuser uid 1001, log rotation
- Threat model retroactively hardened via WR-01..04 fixes

## Current Milestone: v2.0 Thread Summaries

**Goal:** Превратить бот из публикующего в слушающий агент — захватывать сообщения whitelisted тредов в SQLite и публиковать единый сводный пост каждое утро в 06:30 MSK в выделенный тред «🧵 Сводки тредов».

**Target features:**
- **Message Capture & Persistence** — `bot.on('message'|'edited_message')` + `better-sqlite3` (WAL, in-code migrations); capture только из whitelisted тредов, идемпотентность по `(chat_id, tg_message_id)`
- **Thread Tracking Commands** — admin-only `/track`, `/untrack`, `/tracked`; in-memory `Set<number>` синхронизирован с БД, переживает рестарт без code change
- **Thread Summarizer Service** — чистая функция `summarizeThread(threadId, hours): ThreadSummary` поверх `ai.service.ts`, low-volume skip (<5 сообщений), анонимизация numeric IDs, map-reduce при >15k токенов
- **Daily Summary Delivery** — cron 06:30 MSK, единый консолидированный HTML-пост в `THREAD_SUMMARY_THREAD_ID`, idempotency через `lastThreadSummaryDate` в `state.json`, мирное сосуществование с AI-радаром в 06:00 MSK
- **Operational & Privacy Commands** — admin `/summary`, `/dev-summary`, `/storage`; user-facing `/forget-me` (GDPR); 90-дневный retention sweep; ingest-rate counter в pino

**Pre-flight (Phase 0-Ops, manual checklist):**
- BotFather → privacy mode OFF
- Bot rejoin как admin клубной группы
- Создан форум-топик «🧵 Сводки тредов», `THREAD_SUMMARY_THREAD_ID` зафиксирован
- Docker volume `./data:/app/data` добавлен в `docker-compose.yml`
- В чате клуба опубликован анонс о сборе сообщений + `/forget-me`

## Core Value

Участники клуба получают качественно отфильтрованный AI-дайджест каждое утро — это создаёт привычку заходить в клуб и экономит 30–60 минут ежедневного скроллинга. **Подтверждено в v1.0 запуске** — ценность core feature осталась корректной.

## Requirements

### Validated

**v1.0 (shipped 2026-04-27):**
- ✓ SETUP-01..04 — Project + env config + pino + Dockerfile — v1.0
- ✓ RSS-01..05 — 9 feeds, 24h filter, 48h fallback, JSON config, typed output — v1.0
- ✓ AI-01..06 — Dual-provider abstraction, curator prompt, 3-5 selection, vc.ru quota, 6 categories, skip-on-low — v1.0
- ✓ DLV-01..05 — Cron 09:00 MSK, HTML to thread, formatted post, single retry, MSK-day idempotency — v1.0
- ✓ CMD-01..03 — `/start`, `/digest`, `/status` (плюс bonus `/dev-digest`) — v1.0
- ✓ REL-01..03 — Graceful shutdown, error resilience, strict TypeScript — v1.0

### Active

**v2.0 Thread Summaries (started 2026-04-27, full list in `.planning/REQUIREMENTS.md`):**
- [ ] MSG-* — `bot.on('message'|'edited_message')` capture from whitelisted threads
- [ ] STORE-* — `better-sqlite3` (WAL, in-code migrations) + `messages` / `tracked_threads` / `users` schema
- [ ] TRK-* — Admin-only `/track`, `/untrack`, `/tracked`; whitelist Set + DB sync, hot-reload
- [ ] SUM-* — `summarizeThread()` service with low-volume skip, anonymisation, map-reduce
- [ ] DLV-06+ — 06:30 MSK consolidated post, HTML, idempotent via new state field
- [ ] CMD-* — `/summary`, `/dev-summary`, `/storage`, `/forget-me`
- [ ] PRIV-* — GDPR forget-me + 90-day retention sweep
- [ ] OBS-* — Ingest-rate counter in pino

### Out of Scope

| Feature | Reason |
|---------|--------|
| Спринтовые механики (пинги, ремайндеры, задания) | v3, после Thread Summaries |
| `/analytics` команда | v3 |
| Telegram Mini App | Отдельный проект, другой стек |
| Supabase / external DB | Локальный SQLite достаточен для клуба ≤200 человек |
| Inline-кнопки реакций (🔥 / 💤) | После запуска v2.0, validate по поведению участников |
| Webhook-интеграции | Long-polling достаточен для клубной нагрузки |
| Продуктовый дашборд | Отдельный сервис |
| MTProto user-bot для backfill истории | Решено: v2.0 стартует «с момента включения», без backfill |

## Context

**Клуб «Незаменимые»** — закрытое Telegram-сообщество (~50–200 участников), где профессионалы строят персональные AI-системы из агентов. Философия: «Система > Навык». Формат — каста, а не курс. 90-дневная траектория спринтов: Инициация → Усиление → Оркестрация.

**Telegram-группа** работает в режиме форума (Topics). У клуба структура тредов: 🏆 Стена результатов, 📋 Фокус недели, 💬 Общий чат, 📣 Объявления. v1.0 публикует в тред **📡 AI-радар**. v2.0 потребует ещё один тред «🧵 Сводки тредов».

**RSS-источники (v1.0)** — 9 фидов: Habr AI Hub, vc.ru, OpenAI, HuggingFace, LangChain, VentureBeat, Anthropic, Cursor, Tproger. Фактически в production оказалось 11 источников после расширения (см. `config/feeds.json`).

**AI-фильтр** использует системный промпт «AI-куратора» с критериями отбора: практичность, смена правил игры, влияние на «незаменимых», контринтуитивность. Квота по vc.ru — 2 новости.

**Категории новостей:** 🤖 Агенты, 🔗 Оркестрация, 🧠 Модели, 🛠 Инструменты, ⚡ Технологии, 💰 Бизнес.

**Tech debt rolled into v2.0 scope:**
- `data/state.json` не в Docker volume — переживает `restart`, теряется на `down`. v2.0 Phase 4-01 фиксит volume для БД и state.json одновременно.
- Dockerfile на `node:20-alpine` без build-toolchain — нужно добавить `python3 make g++` для нативного `better-sqlite3` в v2.0 Phase 4-01.

## Constraints

- **Стек**: Node.js 20+, Grammy, TypeScript, node-cron, pino, rss-parser — зафиксировано в спеке. v2.0 добавляет `better-sqlite3`.
- **Деплой**: VPS + Docker, long-polling (не webhooks)
- **LLM**: абстракция `ai.service.ts` — поддержка Claude API и OpenAI-совместимых провайдеров (включая DeepSeek через `AI_BASE_URL`), переключение через `.env`
- **Типизация**: строгий TypeScript, никаких `any`
- **Модульность**: каждая функция = модуль в `modules/`, plug-and-play архитектура
- **Тон бота**: «штурман → пилот», прямой, без восторгов — как разведка докладывает штабу
- **GDPR (v2.0)**: хранение текстов участников требует in-chat анонса + `/forget-me` + 90-дневного retention

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Long-polling вместо webhooks | Проще деплой на VPS, нет необходимости в SSL/домене | ✓ Good (v1.0 stable, no webhook outages) |
| Абстракция LLM (Claude + OpenAI) | Гибкость переключения провайдера | ✓ Good (валидировано в v1.0 — DeepSeek через `AI_BASE_URL` подключен mid-Phase 3 без рефакторинга) |
| MVP = только дайджест | Быстрый запуск, валидация ценности | ✓ Good (shipped в 2 dev-дня, core value подтверждён) |
| 9 RSS-фидов на старте | Покрывает ключевые категории | ✓ Good (расширено до 11 в production без code changes) |
| Pino для логирования | Структурированные логи, стандарт Node.js | ✓ Good |
| ESM module system (`type: module`) | Modern Node.js compatibility | ✓ Good (zero issues across 51 commits) |
| `noUncheckedIndexedAccess` + bracket notation для process.env | Safer access | ✓ Good (поймал бы typo до runtime) |
| `bot.catch()` ДО command handlers | Error isolation | ✓ Good (никаких unhandled Grammy errors в v1.0) |
| File-based state (`data/state.json`) для idempotency | MVP simplicity, no DB | ⚠️ Revisit — v2.0 переезжает на SQLite, state.json может остаться или мигрировать в БД |
| Idempotency на MSK calendar day через `toLocaleDateString('en-CA', {timeZone: 'Europe/Moscow'})` | Избегает UTC midnight drift | ✓ Good |
| Options-объект в `runDigestPipeline(opts)` для расширения | Backwards-compatible signature | ✓ Good (паттерн пригодится в v2.0 для `summarizeThread`) |
| Admin-list cache 5 min TTL (WR-04 fix) | DoS mitigation для `getChatAdministrators` | ✓ Good (паттерн переиспользуется в v2.0 командах `/track` и др.) |
| v2.0 публикация — единый сводный пост, а не per-thread | Менее навязчиво, легче скан | — Pending v2.0 validation |
| v2.0 без backfill через MTProto | Сложность и ToS-риск > value | — Pending v2.0 validation |
| v2.0 storage — better-sqlite3 (sync), не Postgres | Нет сервера, файл в Docker volume, sync ergonomics | — Pending v2.0 validation |

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
*Last updated: 2026-04-27 — v2.0 Thread Summaries milestone started*
