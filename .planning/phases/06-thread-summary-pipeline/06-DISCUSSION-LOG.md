# Phase 6: Thread Summary Pipeline — Discussion Log

> **Audit trail only.** Не использовать как input для planner / researcher / executor.
> Решения зафиксированы в 06-CONTEXT.md — этот лог сохраняет рассмотренные альтернативы.

**Date:** 2026-04-29
**Phase:** 6-thread-summary-pipeline
**Areas discussed:** Visual format + thread titles, Schema ThreadSummary + display-name, Промпт + JSON enforcement
**Areas declined:** Pipeline edge-cases (window semantics, empty digest, per-thread error, plan partitioning) — переданы Claude's discretion + planner

---

## Area selection

| Option | Description | Selected |
|--------|-------------|----------|
| Визуальный формат поста + thread titles | Layout per-thread секции, ordering, participants render, footer, dated header, thread title resolution | ✓ |
| Схема ThreadSummary + display-name | Field bounds, display name source, anon admin label, schema validation | ✓ |
| Промпт + JSON enforcement | Tone, conflict handling, JSON enforcement, reasoning | ✓ |
| Pipeline edge-cases | Window, empty digest, per-thread errors, plan partitioning | (skipped — Claude's discretion) |

---

## Area 1: Visual format + thread titles

### Q1.1: Per-thread section layout

| Option | Description | Selected |
|--------|-------------|----------|
| Compact (Recommended) | Минимальный chrome: thread title bold, headline italic, bullets без иконок, 1-line participants `👥 names · 💬 N`, optional «Открытые вопросы» блок | ✓ |
| Spaced sections | Явные ярлыки «Главное:/Пункты:/Участники:/Открытые вопросы:» перед каждым блоком | |
| Telegraph-like | Headline жирный, bullets с emoji-категориями (🔥/💡/⚠️), participant chips | |

**User's choice:** Compact
**Notes:** Bias к плотности и числу тредов в посте, mobile-first чтение.

### Q1.2: Thread ordering

| Option | Description | Selected |
|--------|-------------|----------|
| By message count desc (Recommended) | Самый активный тред сверху | ✓ |
| By thread_id (insertion order) | Стабильный порядок | |
| Alphabetical by title | Предсказуемый, но требует title resolved до сортировки | |

**User's choice:** By message count desc

### Q1.3: Thread title resolution

| Option | Description | Selected |
|--------|-------------|----------|
| DB cache + lazy fetch (Recommended) | Migration v2 — `title TEXT` в `tracked_threads`; `getForumTopic` per-cycle с upsert; fallback на старый кэш или `Тред #N` | ✓ |
| API per-cycle, no cache | Прямой вызов каждый cycle, всегда свежее, но Telegram API jitter блокирует cycle | |
| Hardcoded ID-only `Тред #N` | Никакого резолва, продуктово хуже | |

**User's choice:** DB cache + lazy fetch
**Notes:** Изоляция от Telegram API jitter; Phase 5 `/track` остаётся минимальным.

### Q1.4: Header + footer

| Option | Description | Selected |
|--------|-------------|----------|
| Dated header + count-only footer (Recommended) | `🧵 Сводки тредов · DD.MM.YYYY` + `тихо: N тредов` | ✓ |
| Dated header + footer with thread titles | `тихо: 📄 Объявления, 📄 Стена результатов` | |
| Plain header, no footer | Нарушает DLV-08 | |

**User's choice:** Dated header + count-only footer

### Q1.5: Participants render

| Option | Description | Selected |
|--------|-------------|----------|
| Names with separator (Recommended) | `👥 Маша·Петя·Аня · 💬 23` top-3, без @-mentions | ✓ |
| Names with msg count | `👥 Маша (12) · Петя (8) · Аня (3)` | |
| Top-5 instead of top-3 | Больше прозрачности, больше символов | |

**User's choice:** Names with separator (top-3)

### Q1.6: Continue area or move on?

**User's choice:** Next area

---

## Area 2: ThreadSummary schema + display-name

### Q2.1: Headline bound + overflow policy

| Option | Description | Selected |
|--------|-------------|----------|
| ≤80 chars, truncate с «…» (Recommended) | Server-side truncate до 79+«…», WARN log, никогда не блокирует cycle | ✓ |
| ≤80, reject + retry | Лишний LLM-call (cost, latency) | |
| ≤80, hard reject (skip thread) | Резко в LLM-jitter | |

**User's choice:** ≤80, truncate

### Q2.2: Bullets count + minimum

| Option | Description | Selected |
|--------|-------------|----------|
| 3-6, soft-min 3 (Recommended) | Schema `.min(1).max(6)`; <3 — WARN log, принимаем; >6 — truncate | ✓ |
| 3-6, hard-min 3 | Skip thread если <3; гарантирует thickness, но padding/halo | |
| 1-6, no min | LLM пишет сколько есть, но dense-skew по дням | |

**User's choice:** 3-6, soft-min 3

### Q2.3: Display-name source

| Option | Description | Selected |
|--------|-------------|----------|
| messages.author_name snapshot (Recommended) | LATEST author_name per author_id из БД (1 GROUP BY query) | ✓ |
| Lazy populate users.display_name | Чище архитектурно, но новый capture-side write или sync | |
| Telegram API resolve per-cycle | 10-50 API calls, latency, теряет историчность | |

**User's choice:** messages.author_name snapshot
**Notes:** Phase 4 D-04 уже денормализовал, не делаем работу дважды.

### Q2.4: Anon admin label

| Option | Description | Selected |
|--------|-------------|----------|
| sender_chat.title (Recommended) | Использовать `messages.author_name` (Phase 4 D-04 уже хранит sender_chat.title для anon) | ✓ |
| Анонимный админ (literal) | Все аноны одинаковые, LLM может слить разные channel'ы | |
| [anon] | Min surface, но выбивается из тона | |

**User's choice:** sender_chat.title

### Q2.5: Open questions in schema

| Option | Description | Selected |
|--------|-------------|----------|
| 0-3, опциональный массив (Recommended) | Schema `.max(3)`, default `[]`; formatter скрывает блок если empty | ✓ |
| 1-3 мандаторных | Принуждает hallucinate в фактуальных тредах | |
| Не включать в schema | Нарушает SUM-01 | |

**User's choice:** 0-3, опциональный

### Q2.6: Participants ranking + cap

| Option | Description | Selected |
|--------|-------------|----------|
| Top-3 by msg count desc (Recommended) | SUM-01 разрешает 3-5; нижняя граница — меньше шума | ✓ |
| Top-5 by msg count desc | Полная прозрачность команды, больше символов | |
| Top-3, drop если 1 author | Edge case, низкая ценность | |

**User's choice:** Top-3 by msg count desc

### Q2.7: Schema validation library

| Option | Description | Selected |
|--------|-------------|----------|
| Zod (Recommended) | Runtime validation + TypeScript inference + JSON Schema export для provider-native enforcement | ✓ |
| Manual validation (functions) | Zero deps, ручной sync schema↔type, ~50 LOC boilerplate | |
| AJV (JSON Schema) | Native JSON Schema, manual TS types | |

**User's choice:** Zod

### Q2.8: Continue area or move on?

**User's choice:** Next area

---

## Area 3: Промпт + JSON enforcement

### Q3.1: Prompt tone + bullets focus

| Option | Description | Selected |
|--------|-------------|----------|
| Штурман→пилот + decisions/commitments focus (Recommended) | Bullets приоритизируют решения и обязательства | |
| Нейтральный пересказ | Описать обсуждаемое без выделения accountability | ✓ |
| Quote-driven | Прямые цитаты, GDPR-проблема через /forget-me | |

**User's choice:** Нейтральный пересказ
**Notes:** Документальный стиль; в закрытом клубе social trение от ежедневных callouts больше, чем product value от accountability frame'а. Open questions ловят «нерешённое» без атрибуции.

### Q3.2: Conflict handling in thread

| Option | Description | Selected |
|--------|-------------|----------|
| Call out с именами (Recommended) | «Маша за X, Петя за Y — не решили» | |
| Neutral statement без имён | «Мнения разделились по выбору timeout'а» | ✓ |
| Игнорировать конфликты | Только consensus/decisions, теряет accountability | |

**User's choice:** Neutral statement без имён
**Notes:** Кохерентно с Q3.1 — бот не накладывает социальное давление через ежедневный callout механизм.

### Q3.3: JSON output enforcement

| Option | Description | Selected |
|--------|-------------|----------|
| Provider-native + Zod fallback (Recommended) | Anthropic tool-use forced JSON, OpenAI `response_format: json_schema` или `json_object`, Zod parse on entry | ✓ |
| Plain prompt + Zod-only | Простой code path, но риск invalid-JSON выше | |
| Anthropic tool-use only, OpenAI plain | Asymmetric, нарушает SUM-06 dual-provider parity | |

**User's choice:** Provider-native + Zod fallback

### Q3.4: Reasoning chain before JSON

| Option | Description | Selected |
|--------|-------------|----------|
| Schema-only output (Recommended) | LLM возвращает только JSON, минимизирует tokens/latency | ✓ |
| Reasoning fields в schema | `_reasoning: string` для debug, post-hoc rationalization risk | |
| Pre-JSON think-aloud блок | Несовместимо с tool-use forced-JSON | |

**User's choice:** Schema-only output

### Q3.5: Wrap up?

**User's choice:** Готов, пиши CONTEXT.md

---

## Claude's Discretion (carried into CONTEXT.md)

- **Window semantics** — sliding 24h от cron-fire (НЕ MSK calendar day) — даёт стабильный 24h window вне DST.
- **Per-thread error isolation** — skip с пометкой в footer, не abort cycle.
- **Empty digest** — publish «тихо: N из N» (trust signal), не skip cycle.
- **Plan partitioning** — bias к 2-3 vertical-slice планам (Phase 4 D-11 precedent), planner финально решит.
- **Per-thread error footer wording** — отдельно «ошибка: N» vs объединение с «тихо» — planner UX-decision.
- **`escapeHtml` extraction** в shared util vs дубликат — planner-discretion.
- **`zod-to-json-schema` package vs ручной JSON Schema** — single schema OK ручной; planner выберет.

## Deferred Ideas (carried into CONTEXT.md `<deferred>`)

См. полный список в 06-CONTEXT.md `<deferred>`. Хайлайты:
- v2.1: map-reduce, decisions-callout, quote-of-the-thread, links-mentioned, costEstimateUsd, state.json → SQLite migration.
- Phase 7: `/summary`, `/dev-summary`, `/storage`, `/forget-me`, OBS-* counters, retention sweep, REL-05 closeDb wiring.
