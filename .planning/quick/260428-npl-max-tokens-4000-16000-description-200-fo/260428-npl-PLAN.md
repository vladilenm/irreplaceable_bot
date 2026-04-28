# Quick Task 260428-npl: max_tokens 4000 → 16000 + ужать description до 200 символов

**Created:** 2026-04-28
**Mode:** quick (inline — без spawning subagents для тривиальной правки)
**Files:** src/services/ai.service.ts

## Контекст

Диагностика из 260428-n9u показала:
- `finishReason: "length"` — упёрлись в `max_tokens: 4000`
- `usage.completion_tokens_details.reasoning_tokens: 3838` — DeepSeek V4 это reasoning-модель, тратит почти весь бюджет на внутренние размышления
- В дайджесте оказалась только 1 новость (output обрезан после первой карточки)
- `prompt_tokens: 17733` — input при 80 статьях довольно жирный

## Задачи

### Task 1 — поднять max_tokens до 16000

**Файл:** src/services/ai.service.ts

**Действие:** оба `max_tokens: 4000` (Anthropic ветка ~line 48, OpenAI ветка ~line 68) заменить на `max_tokens: 16000`.

**Verify:** `grep -c "max_tokens: 16000" src/services/ai.service.ts` → 2.

### Task 2 — обрезать description до 200 символов

**Файл:** src/services/ai.service.ts

**Действие:**
1. Добавить локальную функцию `truncateDescription(description: string): string` — slice до 200 символов + многоточие, если длиннее.
2. В `formatArticlesForLLM` заменить `${article.description}` на `${truncateDescription(article.description)}`.

**Verify:** `grep -c "truncateDescription" src/services/ai.service.ts` → 2 (определение + вызов).

## Verification

- `npx tsc --noEmit` clean.
- Strict TS preserved (no `any`).
- Atomic commit: одна правка, один файл.

## Done

Дайджест должен выходить с 5-7 новостями вместо 1.
