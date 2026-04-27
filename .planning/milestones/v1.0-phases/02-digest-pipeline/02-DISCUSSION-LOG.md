# Phase 2: Digest Pipeline - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-13
**Phase:** 02-digest-pipeline
**Areas discussed:** RSS-парсинг, Промпт куратора, LLM-абстракция, Пайплайн

---

## RSS Config

| Option | Description | Selected |
|--------|-------------|----------|
| JSON-файл | feeds.json с массивом {url, name, category} — легко редактировать, git-tracked | ✓ |
| TypeScript-конфиг | Массив в src/config/ с типизацией — проверка на этапе компиляции | |
| Ты решай | Клод выбирает оптимальный формат | |

**User's choice:** JSON-файл
**Notes:** None

## RSS Errors

| Option | Description | Selected |
|--------|-------------|----------|
| Пропустить + лог | Продолжить с остальными фидами, залогировать ошибку | ✓ |
| Ретрай 1 раз | Одна повторная попытка, потом пропустить | |
| Ты решай | Клод выбирает | |

**User's choice:** Пропустить + лог
**Notes:** None

## Промпт куратора

| Option | Description | Selected |
|--------|-------------|----------|
| Как есть | Взять промпт из rss.md почти без изменений, хранить в отдельном файле | ✓ |
| Адаптировать | Структурировать под строгий JSON-выход, добавить инструкции по формату | |
| Ты решай | Клод адаптирует под технические нужды | |

**User's choice:** Как есть
**Notes:** None

## Хранение промпта

| Option | Description | Selected |
|--------|-------------|----------|
| Отдельный файл | prompts/curator.md или .txt — легко редактировать без кода | ✓ |
| В коде | Строковая константа в digest.service.ts | |
| Ты решай | Клод выбирает | |

**User's choice:** Отдельный файл
**Notes:** None

## LLM Output

| Option | Description | Selected |
|--------|-------------|----------|
| JSON структура | LLM возвращает массив объектов {title, summary, url, category} | |
| Готовый текст | LLM сразу генерит финальный текст поста как в rss.md | ✓ |
| Ты решай | Клод выбирает оптимальный подход | |

**User's choice:** Готовый текст
**Notes:** None

## SDK

| Option | Description | Selected |
|--------|-------------|----------|
| Официальные SDK | @anthropic-ai/sdk + openai — нативные клиенты | ✓ |
| Унифицированный SDK | Vercel AI SDK или LangChain — один интерфейс для всех | |
| Ты решай | Клод выбирает | |

**User's choice:** Официальные SDK
**Notes:** None

## Pipeline Architecture

| Option | Description | Selected |
|--------|-------------|----------|
| Оркестратор | digest.service.ts с runDigestPipeline() вызывает fetch → filter → format | ✓ |
| Пайплайн-класс | Pipeline класс с .addStep().run() — расширяемо, но сложнее | |
| Ты решай | Клод выбирает подходящий паттерн | |

**User's choice:** Оркестратор
**Notes:** None

## Fallback 48h

| Option | Description | Selected |
|--------|-------------|----------|
| Флаг в памяти | Хранить lastDigestDate в файле (data/state.json) — переживает рестарт | ✓ |
| Всегда 24ч | Всегда смотреть за 24ч, не усложнять | |
| Ты решай | Клод выбирает | |

**User's choice:** Флаг в памяти
**Notes:** None

## Claude's Discretion

- Timeout values for RSS fetch
- Error messages and log formats
- Internal data structures
- LLM text output parsing

## Deferred Ideas

None
