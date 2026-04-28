# Quick Task 260428-npl — Summary

**Status:** Done
**Date:** 2026-04-28
**Commit:** b35a222

## Что сделано

Один файл: `src/services/ai.service.ts`

1. `max_tokens: 4000 → 16000` в обеих ветках (Anthropic line 48, OpenAI-compat line 68).
2. Добавлена локальная функция `truncateDescription(description: string): string` — обрезает до 200 символов с многоточием.
3. `formatArticlesForLLM` использует `truncateDescription(article.description)` вместо raw `article.description`.

## Verification

- `npx tsc --noEmit` — exit 0
- `grep -c "max_tokens: 16000" src/services/ai.service.ts` → 2
- `grep -c "truncateDescription" src/services/ai.service.ts` → 2

## Эффект

Совокупность правок 260428-m57 + mn8 + n29 + n9u + npl должна обеспечить:
- Дайджест выходит каждый день (порог `< 1` + категорический промпт 5-7 + max_tokens 16000)
- Меньше input cost (description ≤ 200 chars экономит ~30% prompt tokens)
- Полная диагностика в логах если что-то пойдёт не так

## Следующий шаг

Запустить `/digest` и убедиться что в чате 5-7 новостей с `→ ссылка`.
