---
phase: 03-delivery-operations
fixed_at: 2026-04-14T00:00:00Z
review_path: .planning/phases/03-delivery-operations/03-REVIEW.md
iteration: 1
findings_in_scope: 4
fixed: 4
skipped: 0
status: all_fixed
---

# Phase 03: Code Review Fix Report

**Fixed at:** 2026-04-14
**Source review:** `.planning/phases/03-delivery-operations/03-REVIEW.md`
**Iteration:** 1
**Scope:** Critical + Warning (4 warnings; 5 Info findings deliberately deferred)

## Summary

- Findings in scope: 4
- Fixed: 4
- Skipped: 0
- Все правки прошли `npx tsc --noEmit` (strict, без `any`) — соответствует CLAUDE.md (Node 20+, Grammy, строгий TypeScript).

## Fixed Issues

| ID    | File                                         | Change                                                                                                 | Commit   |
|-------|----------------------------------------------|--------------------------------------------------------------------------------------------------------|----------|
| WR-01 | `src/modules/digest/digest.formatter.ts`     | `unescapeHtml` заменён на `unescapeAmp`: в href разэкранируется только `&amp;`; `&lt;`/`&gt;` остаются экранированными (T-03-01). | `76f9d4d` |
| WR-02 | `src/modules/digest/digest.formatter.ts`     | URL-regex закреплён на конец строки и исключает `\s<>"`, чтобы хвостовая пунктуация не попадала в href.  | `69d9200` |
| WR-03 | `src/config.ts`                              | Добавлен `requireEnvInt`; `TARGET_CHAT_ID` и `AI_RADAR_THREAD_ID` валидируются как целые на старте (fail-fast). | `1f80599` |
| WR-04 | `src/bot.ts`                                 | `isAdmin` кэширует список админов на 5 минут и раннее возвращает `false` в non-group чатах (DoS / rate-limit guard). | `50e9bba` |

### WR-01: Formatter unescapes `&lt;`/`&gt;` inside href attribute

**Files modified:** `src/modules/digest/digest.formatter.ts`
**Commit:** `76f9d4d`
**Applied fix:** Убрана функция `unescapeHtml`, введена `unescapeAmp`, которая возвращает литерал `&` только для query-strings. Угловые скобки внутри атрибута `href` остаются как `&lt;`/`&gt;` — атака через `<` в RSS-ссылке невозможна. Комментарий обновлён, T-03-01 guard восстановлен.

### WR-02: URL regex `\S+` captures trailing punctuation

**Files modified:** `src/modules/digest/digest.formatter.ts`
**Commit:** `69d9200`
**Applied fix:** Regex `/(→\s+)(https?:\/\/[^\s<>"]+)\s*$/` — URL якорится к концу строки (формат гарантирует это), класс символов исключает пробелы, `<`, `>`, `"`. Trailing `.`/`,`/`)` остаются вне href.

### WR-03: `Number(threadId)` silently yields `NaN`

**Files modified:** `src/config.ts`
**Commit:** `1f80599`
**Applied fix:** Добавлен `requireEnvInt(name)`: проверяет `/^-?\d+$/` и бросает с понятным сообщением. Применён к `TARGET_CHAT_ID` и `AI_RADAR_THREAD_ID`. Теперь `Number(params.threadId)` в `src/utils/telegram.ts` гарантированно безопасен — правка в `telegram.ts` не требуется.

### WR-04: `isAdmin` calls `getChatAdministrators` on every command

**Files modified:** `src/bot.ts`
**Commit:** `50e9bba`
**Applied fix:** `Map<chatId, { ids: Set<number>; expires }>` с TTL 5 минут. При попадании в кэш API-вызов не делается. В приватных чатах/каналах `isAdmin` возвращает `false` сразу без запроса (исключает шум в логах от падающего `getChatAdministrators` в DM). Сигнатура функции и контракт для `/digest`, `/status` не изменились.

## Skipped Issues

None — все 4 warning применены.

## Deferred (out of scope)

Info-находки IN-01 … IN-05 не применялись: по инструкции scope = Critical + Warning. Они остаются в `03-REVIEW.md` для следующей итерации при необходимости.

## Verification

- Baseline: `npx tsc --noEmit` — EXIT=0
- После каждого коммита: `npx tsc --noEmit` — EXIT=0
- Строгая типизация сохранена, `any` не добавлено (CLAUDE.md).
- Атомарность: 4 коммита, по одному на finding, каждый с конвенциональным префиксом `fix(03): WR-XX ...`.

---

_Fixed: 2026-04-14_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
