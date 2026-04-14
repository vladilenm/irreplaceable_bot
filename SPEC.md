# Спецификация: Telegram-бот «Незаменимые»

## Обзор

Telegram-бот для обслуживания клуба «Незаменимые». MVP-фокус — ежедневный новостной дайджест. Архитектура закладывает расширение на аналитику, summary и продуктовый дашборд.

## Стек

| Компонент | Технология |
|-----------|-----------|
| Runtime | Node.js 20+ |
| Фреймворк бота | Grammy |
| Язык | TypeScript |
| Cron/Scheduler | node-cron |
| HTTP-клиент | Встроенный fetch / ofetch |
| Переменные окружения | dotenv |
| Логирование | pino |
| Деплой | VPS / Docker (опционально) |

## Структура проекта

```
nezamenimye-bot/
├── src/
│   ├── index.ts                 # Точка входа, инициализация бота
│   ├── bot.ts                   # Конфигурация Grammy-инстанса
│   ├── config.ts                # Загрузка env, константы
│   ├── scheduler/
│   │   └── cron.ts              # Регистрация cron-задач
│   ├── modules/
│   │   └── digest/
│   │       ├── digest.service.ts    # Бизнес-логика сборки дайджеста
│   │       ├── digest.formatter.ts  # Форматирование сообщения (Markdown/HTML)
│   │       ├── digest.sender.ts     # Отправка в целевой чат
│   │       └── digest.types.ts      # Типы данных дайджеста
│   ├── services/
│   │   └── ai.service.ts        # Обёртка для LLM-вызовов (summary, аналитика)
│   ├── utils/
│   │   ├── logger.ts
│   │   └── telegram.ts          # Хелперы для работы с Telegram API
│   └── types/
│       └── index.ts             # Общие типы
├── .env.example
├── package.json
├── tsconfig.json
└── README.md
```

## MVP: Ежедневный дайджест

### Поведение

1. Каждый день в **09:00 MSK** (UTC+3) cron-задача запускает pipeline дайджеста
2. `digest.service.ts` собирает данные из источников (логика описана в отдельной спеке)
3. `digest.formatter.ts` формирует HTML-сообщение для Telegram
4. `digest.sender.ts` отправляет сообщение в целевой чат/канал клуба

### Интерфейс источника данных

```typescript
// digest.types.ts

export interface DigestSource {
  id: string;
  name: string;
  fetch(): Promise<DigestItem[]>;
}

export interface DigestItem {
  title: string;
  summary: string;
  url?: string;
  source: string;
  category: DigestCategory;
  publishedAt: Date;
}

export type DigestCategory = 'ai' | 'frontend' | 'career' | 'tools' | 'community';

export interface DigestPayload {
  date: Date;
  items: DigestItem[];
  greeting?: string;       // AI-сгенерированное приветствие
  totalSources: number;
}
```

### Формат сообщения

```
📬 Дайджест «Незаменимые» — 12 апреля 2026

Доброе утро! Вот что важного произошло:

🤖 AI & Нейросети
• <заголовок> — <краткое summary>
• <заголовок> — <краткое summary>

⚛️ Frontend
• <заголовок> — <краткое summary>

🛠 Инструменты
• <заголовок> — <краткое summary>

👥 Клуб
• <обновление по клубу, если есть>

Хорошего дня! 🚀
```

## Конфигурация (.env)

```env
BOT_TOKEN=                    # Telegram Bot Token
TARGET_CHAT_ID=               # ID чата/канала для отправки дайджеста
DIGEST_CRON="0 6 * * *"       # 06:00 UTC = 09:00 MSK
AI_API_KEY=                   # Ключ для LLM (Anthropic/OpenAI)
AI_MODEL=                     # Модель для summary
LOG_LEVEL=info
NODE_ENV=production
```

## Команды бота (заготовка на будущее)

| Команда | Описание | MVP |
|---------|----------|-----|
| `/start` | Приветствие, описание бота | ✅ |
| `/digest` | Ручной запуск дайджеста | ✅ |
| `/status` | Статус бота, последний дайджест | ✅ |
| `/analytics` | Аналитика клуба | ❌ v2 |
| `/summary` | Summary обсуждений за период | ❌ v2 |

## Расширения (v2+)

- **Аналитический модуль** — сбор метрик клуба (активность, retention, рост), визуализация в дашборде
- **Summary-модуль** — AI-суммаризация обсуждений в чатах клуба за день/неделю
- **Форматтер сообщений** — шаблоны для анонсов, событий, welcome-сообщений
- **Webhook-интеграции** — приём данных от внешних сервисов
- **Продуктовый дашборд** — веб-интерфейс для просмотра метрик (отдельный сервис)

## Принципы разработки

1. **Модульность** — каждая функция = отдельный модуль в `modules/`, plug-and-play
2. **Типизация** — строгий TypeScript, никаких `any`
3. **Graceful shutdown** — корректное завершение при SIGTERM/SIGINT
4. **Error handling** — ошибки логируются, не роняют бота, дайджест ретраит 1 раз при фейле
5. **Idempotency** — повторный запуск дайджеста за день не дублирует сообщение

## Запуск

```bash
# Установка
npm install

# Разработка
npm run dev

# Продакшен
npm run build && npm start
```
