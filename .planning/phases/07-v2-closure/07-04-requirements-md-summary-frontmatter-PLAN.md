---
phase: 07-v2-closure
plan: 04
type: execute
wave: 1
depends_on: []
files_modified:
  - .planning/REQUIREMENTS.md
  - .planning/STATE.md
  - .planning/phases/06-thread-summary-pipeline/06-01-SUMMARY.md
  - .planning/phases/06-thread-summary-pipeline/06-02-SUMMARY.md
  - .planning/phases/06-thread-summary-pipeline/06-03-SUMMARY.md
autonomous: true
requirements: []
tags: [docs, requirements, traceability, frontmatter]
must_haves:
  truths:
    - "REQUIREMENTS.md MSG-04 wording reflects the actual implementation: `ON CONFLICT(chat_id, tg_message_id) DO UPDATE SET text/author_name/edited_at` (replaces stale `INSERT OR IGNORE`)."
    - "All 19 Phase 6 code requirements (SUM-01..07, AI-07, DLV-06..10, STATE-01/02, SCHED-01..04) are checked `[x]` in REQUIREMENTS.md (matches VERIFICATION.md status)."
    - "All 18 cancelled/de-scoped requirements are removed from REQUIREMENTS.md: TRK-01..05 (Phase 5 cancelled), CMD-04..08 + PRIV-01/02/05 + OBS-01..04 + REL-05 (Phase 7 v2.0 originals removed). PRIV-03 is RETAINED, reassigned to Phase 7 closure, and FLIPPED to `[x]` in this plan (Plan 07-01 lands the impl in the same wave-1 atomic milestone close)."
    - "Traceability table at end of REQUIREMENTS.md is rebuilt to match the post-cleanup state: 39 in-scope requirements (was 57 with deferred), each row maps to its actual phase."
    - "Coverage-by-phase block reflects new totals: Phase 0-Ops 2 (SETUP-09 + PRIV-04), Phase 4 = 17, Phase 6 = 19, Phase 7 closure = 1 (PRIV-03). Total = 39 requirements (36 satisfied + 3 pending: SETUP-09, PRIV-03, PRIV-04). Note: PRIV-03 prose flips to `[x]` per ROADMAP success criterion 4 — implemented by Plan 07-01 in this same milestone close; SETUP-09 and PRIV-04 remain `[ ]` until Phase 0-Ops operator-fill."
    - "PRIV-04 phase assignment is consistent across REQUIREMENTS.md, traceability table, and coverage block: PRIV-04 → Phase 0-Ops (matches ROADMAP coverage block + Plan 07-05 frontmatter)."
    - "Phase 6 SUMMARY frontmatter for 06-01, 06-02, 06-03 has `requirements_completed:` YAML list populated (was empty/missing)."
    - "STATE.md line 110 reference to `04-message-capture/04-OPS-CHECKLIST.md` is fixed to `04-message-capture-persistence/04-OPS-CHECKLIST.md` (matches the real directory name + Plan 07-05 file path)."
  artifacts:
    - path: ".planning/REQUIREMENTS.md"
      provides: "Cleaned-up v2.0 requirements doc reflecting actual milestone scope"
      contains: "ON CONFLICT(chat_id, tg_message_id) DO UPDATE"
    - path: ".planning/STATE.md"
      provides: "Phase 0-Ops checklist path fixed to match real directory name"
    - path: ".planning/phases/06-thread-summary-pipeline/06-01-SUMMARY.md"
      provides: "frontmatter requirements_completed: [SUM-01..07, AI-07]"
    - path: ".planning/phases/06-thread-summary-pipeline/06-02-SUMMARY.md"
      provides: "frontmatter requirements_completed: [STATE-01, STATE-02, SCHED-01..04]"
    - path: ".planning/phases/06-thread-summary-pipeline/06-03-SUMMARY.md"
      provides: "frontmatter requirements_completed: [DLV-06..10]"
  key_links:
    - from: ".planning/REQUIREMENTS.md MSG-04 row"
      to: "src/stores/message-store.ts upsertStmt"
      via: "wording matches actual SQL"
      pattern: "ON CONFLICT\\(chat_id, tg_message_id\\) DO UPDATE"
---

<objective>
Закрыть Success Criteria 4 + 5: REQUIREMENTS.md drift fix + Phase 6 SUMMARY.md frontmatter `requirements_completed` backfill + path-drift fix in STATE.md / REQUIREMENTS.md SETUP-09 (W1).

Контекст drift'а (от audit):
- MSG-04 в REQUIREMENTS.md цитирует `INSERT OR IGNORE` (rejected pattern); реализация использует `ON CONFLICT(chat_id, tg_message_id) DO UPDATE SET text/author_name/edited_at` (PITFALLS TG-01: INSERT OR IGNORE молча игнорирует правки и нарушает MSG-02).
- 19 Phase 6 requirements помечены `[ ] Pending` хотя VERIFICATION.md статус — passed (SUM-01..07 = 7 + AI-07 = 1 + DLV-06..10 = 5 + STATE-01/02 = 2 + SCHED-01..04 = 4 = **19**).
- 18 requirements (TRK-01..05 + CMD-04..08 + PRIV-01/02/05 + OBS-01..04 + REL-05) отмечены как Pending под v2.0 milestone, но Phase 5 cancelled и оригинальная Phase 7 (commands/privacy/observability) удалена.
- PRIV-03 remains in v2.0 (переназначен в Phase 7 closure — этот milestone). По ROADMAP success criterion 4 PRIV-03 должен флипнуться в `[x]` атомарно с этим milestone close — Plan 07-01 (в том же wave 1) реализует impl, Plan 07-04 фиксирует docs.
- PRIV-04 → Phase 0-Ops (manual checklist). Согласовано с ROADMAP coverage block + Plan 07-05 frontmatter `requirements_to_close: [SETUP-09, PRIV-04]`.
- Phase 6 SUMMARY frontmatter не имеет машинно-читаемого `requirements_completed:` ключа (только в body тексте).
- SETUP-09 строка в REQUIREMENTS.md (line 21) и STATE.md (line 110) указывают на `.planning/phases/04-message-capture/04-OPS-CHECKLIST.md`, но реальная директория `04-message-capture-persistence/`. Plan 07-05 создаёт файл в правильной директории; этот план фиксирует stale reference.

Output:
- `.planning/REQUIREMENTS.md` обновлён: MSG-04 wording фикс, 19 Phase 6 чекбоксов flip, PRIV-03 flip, 18 deferred requirements удалены, traceability + coverage refreshed, SETUP-09 path fixed.
- `.planning/STATE.md` line 110 path fixed.
- `.planning/phases/06-thread-summary-pipeline/06-01-SUMMARY.md` frontmatter получает `requirements_completed: [SUM-01, SUM-02, SUM-03, SUM-04, SUM-05, SUM-06, SUM-07, AI-07]`.
- `.planning/phases/06-thread-summary-pipeline/06-02-SUMMARY.md` frontmatter получает `requirements_completed: [STATE-01, STATE-02, SCHED-01, SCHED-02, SCHED-03, SCHED-04]`.
- `.planning/phases/06-thread-summary-pipeline/06-03-SUMMARY.md` frontmatter получает `requirements_completed: [DLV-06, DLV-07, DLV-08, DLV-09, DLV-10]`.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@.planning/ROADMAP.md
@.planning/REQUIREMENTS.md
@.planning/v2.0-MILESTONE-AUDIT.md
@.planning/phases/06-thread-summary-pipeline/06-01-SUMMARY.md
@.planning/phases/06-thread-summary-pipeline/06-02-SUMMARY.md
@.planning/phases/06-thread-summary-pipeline/06-03-SUMMARY.md
@.planning/phases/06-thread-summary-pipeline/06-VERIFICATION.md

<interfaces>
<!-- Маппинг Phase 6 plans → requirements (источник истины: 06-VERIFICATION.md status + 06-0X-SUMMARY.md body «All Phase 6 Requirements Covered» секция) -->

Plan 06-01 (summarizer-core, TDD) → SUM-01, SUM-02, SUM-03, SUM-04, SUM-05, SUM-06, SUM-07, AI-07 — 8 IDs
Plan 06-02 (state + cron + persistence) → STATE-01, STATE-02, SCHED-01, SCHED-02, SCHED-03, SCHED-04 — 6 IDs
Plan 06-03 (orchestrator + delivery) → DLV-06, DLV-07, DLV-08, DLV-09, DLV-10 — 5 IDs

Все 19 Phase 6 requirements (8 + 6 + 5) распределяются ровно по этим трём планам без пересечений.

Структура REQUIREMENTS.md (текущая): секции по группам (SETUP-*, MSG-*, STORE-*, TRK-*, SUM-*, AI-*, DLV-*, STATE-*, SCHED-*, CMD-*, PRIV-*, OBS-*, REL-*) → секция «Future Requirements (deferred to v2.1)» → секция «Out of Scope» → секция «Traceability» → секция «Coverage by Phase».

Удаляются целиком группы:
- TRK-* (5 requirements: TRK-01..05) — Phase 5 cancelled
- CMD-* удаляется ЧАСТИЧНО (CMD-04..08 уходят, CMD-01..03 уже в v1.0 архиве — но я сейчас вижу в файле только CMD-04..08; уточнить при чтении). Из текущего REQUIREMENTS.md удалятся CMD-04..08.
- PRIV-* удаляется ЧАСТИЧНО: PRIV-01, PRIV-02, PRIV-05 уходят; PRIV-03 + PRIV-04 ОСТАЮТСЯ. PRIV-03 → Phase 7 (`[x]` после Plan 07-01); PRIV-04 → Phase 0-Ops (`[ ]` до operator-fill).
- OBS-* (4 requirements: OBS-01..04) — Phase 7 (originals) removed
- REL-* удаляется ЧАСТИЧНО: REL-04 уже satisfied (Phase 4); REL-05 удаляется.

В Future Requirements секцию (deferred to v2.1) executor должен ДОБАВИТЬ markdown-блок упоминающий «v2.0 originally scoped TRK-01..05, CMD-04..08, PRIV-01/02/05, OBS-01..04, REL-05; cancelled/removed 2026-04-29; revisit in v2.1 if needed». Это сохраняет историческую traceability без spam'а главного списка.
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Fix REQUIREMENTS.md MSG-04 wording + flip Phase 6 + PRIV-03 checkboxes + remove cancelled requirements + rebuild traceability + fix SETUP-09 path</name>
  <files>.planning/REQUIREMENTS.md, .planning/STATE.md</files>
  <read_first>
    - .planning/REQUIREMENTS.md полностью (текущая структура — 232 строки)
    - .planning/STATE.md строки 105-115 (line 110 stale path reference)
    - .planning/v2.0-MILESTONE-AUDIT.md секция «Documentation Gaps» строки 158-165 (точные fix-recommendations)
    - .planning/ROADMAP.md строки 75-105 (источник truth для cancelled/removed phases — точные роли)
    - .planning/ROADMAP.md строки 106-118 (Phase 7 success criteria — locked decisions, в т.ч. «PRIV-03 reassigned to Phase 7 with `[x]`» — обязателен FLIP в этом плане)
  </read_first>
  <action>
**Изменение 1: MSG-04 wording fix (строка 28)**

Текущий текст:
```markdown
- [x] **MSG-04**: Idempotent insert via `UNIQUE(chat_id, tg_message_id)` and `INSERT OR IGNORE` — same message delivered twice (Telegram retry, polling replay) results in one row
```

Заменить на:
```markdown
- [x] **MSG-04**: Idempotent upsert via `UNIQUE(chat_id, tg_message_id)` and `ON CONFLICT(chat_id, tg_message_id) DO UPDATE SET text/author_name/edited_at` — preserves `created_at` on edit redelivery; `INSERT OR IGNORE` was rejected (PITFALLS TG-01) because it silently ignores edits and breaks MSG-02.
```

**Изменение 2: Удалить целиком секцию «### Thread Tracking (TRK-*)»** (строки 41-47, всё включая heading и > Phase 5 префикс если есть). После удаления секция «### Storage (STORE-*)» переходит сразу в «### Summarizer (SUM-*)».

**Изменение 3: Flip 19 Phase 6 чекбоксов с `[ ]` на `[x]`**

В секциях:
- `### Summarizer (SUM-*)` строки 51-57: SUM-01, SUM-02, SUM-03, SUM-04, SUM-05, SUM-06, SUM-07 — все 7 → `[x]`
- `### AI service extension (AI-*)` строка 63: AI-07 → `[x]`
- `### Daily Delivery (DLV-*)` строки 69-73: DLV-06, DLV-07, DLV-08, DLV-09, DLV-10 — все 5 → `[x]`
- `### State management (STATE-*)` строки 77-78: STATE-01, STATE-02 — оба → `[x]`
- `### Scheduler (SCHED-*)` строки 82-85: SCHED-01, SCHED-02, SCHED-03, SCHED-04 — все 4 → `[x]`

Итого: 7 + 1 + 5 + 2 + 4 = **19** чекбоксов. Final state — все 19 Phase 6 requirements имеют `[x]`.

**Изменение 4: Удалить целиком секцию «### Operational Commands (CMD-*)»** (строки 87-95, включая `> Extends v1.0...` blockquote, и все CMD-04..CMD-08 буллеты).

**Изменение 5: Privacy секция (PRIV-*) — flip PRIV-03 to `[x]`, удалить PRIV-01/02/05, оставить PRIV-04 как `[ ]`**

Удалить только PRIV-01, PRIV-02, PRIV-05. ОСТАВИТЬ PRIV-03 + PRIV-04. PRIV-03 ФЛИПНУТЬ в `[x]` атомарно с этим milestone close (per ROADMAP line 115 success criterion 4: "PRIV-03 reassigned to Phase 7 with `[x]`"; impl лендится Plan 07-01 в том же wave 1 — оба плана коммитятся в одном milestone close). PRIV-04 текст обновить: явно ссылаться на Phase 0-Ops manual gate.

После изменения секция выглядит так:
```markdown
### Privacy (PRIV-*)

- [x] **PRIV-03**: 90-day retention sweep (`RETENTION_SWEEP_CRON`, default 04:00 MSK) deletes messages older than `MESSAGE_RETENTION_DAYS`; batched at ≤1000 rows per iteration with `LIMIT` to avoid lock storms (implemented by Plan 07-01 in this same milestone close)
- [ ] **PRIV-04**: Phase 0-Ops manual checklist captures URL or screenshot of in-chat consent announcement (lawful-basis evidence per GDPR Art. 13). Closes when `04-OPS-CHECKLIST.md` section 4 is filled by operator post-deploy.
```

**Изменение 6: Удалить целиком секцию «### Observability (OBS-*)»** (строки 105-110 включая heading и OBS-01..04).

**Изменение 7: В секции «### Reliability (REL-*)» удалить только строку с REL-05 (строка 117). REL-04 остаётся (`[x]` — Phase 4 завершена).**

**Изменение 8: Добавить блок в «### Future Requirements (deferred to v2.1)»** — после существующих буллетов добавить:

```markdown
### v2.0 originally-scoped requirements deferred 2026-04-29

The following 18 requirements were part of the v2.0 milestone draft but moved out of scope during planning. They are kept here for historical traceability and may be reconsidered in v2.1 once first-month production data informs priority:

- **Phase 5 cancelled (in-chat tracking commands):** TRK-01, TRK-02, TRK-03, TRK-04, TRK-05 — admin whitelist is now managed via env-seed (`INITIAL_TRACKED_THREAD_IDS`) and direct DB writes; in-chat commands are not required for ≤200-user club.
- **Phase 7 originals removed (operational/privacy/observability commands + REL-05):** CMD-04, CMD-05, CMD-06, CMD-07, CMD-08, PRIV-01, PRIV-02, PRIV-05, OBS-01, OBS-02, OBS-03, OBS-04, REL-05 — operator-side maintenance is performed via direct sqlite3 CLI and pino-log inspection (see `.planning/phases/04-message-capture-persistence/04-OPS-CHECKLIST.md` for runbooks). Note: PRIV-03 is RETAINED in v2.0 and is implemented by Phase 7 closure (current milestone gap-closure phase, Plan 07-01); PRIV-04 is RETAINED as Phase 0-Ops manual gate.
```

**Изменение 9: Полностью переписать «Traceability» таблицу**

Таблица должна содержать ТОЛЬКО in-scope v2.0 requirements (39) — никаких deferred строк. Колонки те же: `Requirement | Phase | Status`.

In-scope rows (по группам):
- SETUP-05, SETUP-06, SETUP-07, SETUP-08 → Phase 4 → Complete (4 строки)
- SETUP-09 → Phase 0-Ops → Pending
- MSG-01..MSG-08 → Phase 4 → Complete (8 строк)
- STORE-01..STORE-04 → Phase 4 → Complete (4 строки)
- SUM-01..SUM-07 → Phase 6 → Complete (7 строк)
- AI-07 → Phase 6 → Complete
- DLV-06..DLV-10 → Phase 6 → Complete (5 строк)
- STATE-01, STATE-02 → Phase 6 → Complete (2 строки)
- SCHED-01..SCHED-04 → Phase 6 → Complete (4 строки)
- PRIV-03 → Phase 7 (v2.0 closure) → Complete (flipped в этом плане атомарно с Plan 07-01 impl)
- PRIV-04 → Phase 0-Ops → Pending
- REL-04 → Phase 4 → Complete

Итого: 4 + 1 + 8 + 4 + 7 + 1 + 5 + 2 + 4 + 1 + 1 + 1 = **39** строк.

Под таблицей обновить:
```
> Maps each v2.0 REQ-ID → Phase that owns it. Generated 2026-04-30 against `.planning/ROADMAP.md` (post-cleanup). 39/39 in-scope v2.0 requirements mapped (100% coverage). 36 Complete + 3 Pending (SETUP-09 + PRIV-04 manual gates; PRIV-03 prose flipped to Complete in this plan, code lands in Plan 07-01 within the same wave).
```

**Изменение 10: Полностью переписать «Coverage by Phase» блок**

```markdown
### Coverage by Phase

> 2026-04-30: post Phase 7 v2.0-closure cleanup. Phase 5 (Thread Tracking Commands) cancelled; original Phase 7 (Operational & Privacy Commands) deferred to v2.1; Phase 7 slot reused for v2.0 closure (PRIV-03 retention sweep + Phase 0-Ops execution).

| Phase | REQ Count | REQ-IDs |
|-------|-----------|---------|
| Phase 0-Ops | 2 | SETUP-09, PRIV-04 |
| Phase 4 | 17 | SETUP-05/06/07/08, MSG-01..08, STORE-01..04, REL-04 |
| Phase 6 | 19 | SUM-01..07, AI-07, DLV-06..10, STATE-01..02, SCHED-01..04 |
| Phase 7 (v2.0 closure) | 1 | PRIV-03 (retention sweep impl by Plan 07-01) |
| **Total** | **39** | **100% in-scope coverage; 36 Complete + 3 Pending (SETUP-09, PRIV-03 awaiting Plan 07-01 lands, PRIV-04)** |
```

Note: PRIV-03 в Coverage block описан как «1 in Phase 7». В таблице (Изменение 9) он помечен Complete потому что флипается чекбокс в этом плане; impl-код приземляется Plan 07-01 в том же wave 1 atomic commit. Если по причинам политики хочется консервативнее — оставить «Pending» в таблице до фактического code-merge — но это противоречит ROADMAP success criterion 4 wording «with `[x]`». Используем Complete (flip).

**Изменение 11: Обновить «Last updated» в frontmatter REQUIREMENTS.md**

Строка 5:
```
**Last updated:** 2026-04-27
```
→
```
**Last updated:** 2026-04-30
```

**Изменение 12: Fix SETUP-09 path drift in REQUIREMENTS.md (W1)**

Строка 21 (SETUP-09 текст) содержит:
```
checklist artifact stored at `.planning/phases/04-message-capture/04-OPS-CHECKLIST.md`
```

Заменить на:
```
checklist artifact stored at `.planning/phases/04-message-capture-persistence/04-OPS-CHECKLIST.md`
```

Реальная директория `04-message-capture-persistence/`; Plan 07-05 создаёт файл по правильному пути.

**Изменение 13: Fix STATE.md path drift (W1)**

`.planning/STATE.md` строка 110:
```
- In-chat consent announcement (GDPR Art. 13) URL/screenshot captured at `.planning/phases/04-message-capture/04-OPS-CHECKLIST.md`
```
→
```
- In-chat consent announcement (GDPR Art. 13) URL/screenshot captured at `.planning/phases/04-message-capture-persistence/04-OPS-CHECKLIST.md`
```

`v2.0-MILESTONE-AUDIT.md` — historical artifact, не трогаем.
  </action>
  <verify>
    <automated>grep -c "^| TRK-0" .planning/REQUIREMENTS.md && grep -c "ON CONFLICT" .planning/REQUIREMENTS.md && grep -cE "SUM-0[1-7].*\\[x\\]" .planning/REQUIREMENTS.md && grep -c "04-message-capture-persistence/04-OPS-CHECKLIST.md" .planning/STATE.md</automated>
  </verify>
  <acceptance_criteria>
    - `grep -c "^| TRK-0" .planning/REQUIREMENTS.md` returns 0 (TRK rows removed from traceability)
    - `grep -c "TRK-01\|TRK-02\|TRK-03\|TRK-04\|TRK-05" .planning/REQUIREMENTS.md` returns matches ONLY in the "deferred to v2.1" historical block (single block, ≤1 line listing all five)
    - `grep -c "ON CONFLICT(chat_id, tg_message_id) DO UPDATE" .planning/REQUIREMENTS.md` returns 1 (MSG-04 wording fixed)
    - `grep -c "INSERT OR IGNORE" .planning/REQUIREMENTS.md` returns ≤1 (only the historical note about rejected pattern, не основное wording)
    - `grep -cE "^- \\[x\\] \\*\\*SUM-0[1-7]" .planning/REQUIREMENTS.md` returns 7 (all SUM-* checked)
    - `grep -cE "^- \\[x\\] \\*\\*AI-07" .planning/REQUIREMENTS.md` returns 1
    - `grep -cE "^- \\[x\\] \\*\\*DLV-0[6-9]\\|^- \\[x\\] \\*\\*DLV-10" .planning/REQUIREMENTS.md` returns 5
    - `grep -cE "^- \\[x\\] \\*\\*STATE-0[12]" .planning/REQUIREMENTS.md` returns 2
    - `grep -cE "^- \\[x\\] \\*\\*SCHED-0[1-4]" .planning/REQUIREMENTS.md` returns 4
    - **B2 acceptance: `grep -c "^- \\[x\\] \\*\\*PRIV-03" .planning/REQUIREMENTS.md` returns 1 (PRIV-03 flipped to `[x]` per ROADMAP success criterion 4)**
    - `grep -c "^- \\[ \\] \\*\\*PRIV-03" .planning/REQUIREMENTS.md` returns 0 (нет stale `[ ]` для PRIV-03)
    - `grep -cE "^- \\[ \\] \\*\\*PRIV-04\\b" .planning/REQUIREMENTS.md` returns 1 (retained, Phase 0-Ops, остаётся `[ ]` до operator-fill)
    - **B3 acceptance: `grep -c "PRIV-04.*Phase 0-Ops" .planning/REQUIREMENTS.md` returns ≥1 (single phase assignment for PRIV-04)**
    - `grep -cE "^- \\[ \\] \\*\\*CMD-0[4-8]" .planning/REQUIREMENTS.md` returns 0 (CMD-04..08 removed from main list)
    - `grep -cE "^- \\[ \\] \\*\\*OBS-0[1-4]" .planning/REQUIREMENTS.md` returns 0 (OBS removed)
    - `grep -cE "^- \\[ \\] \\*\\*PRIV-0[125]\\b" .planning/REQUIREMENTS.md` returns 0 (PRIV-01/02/05 removed)
    - `grep -cE "^- \\[ \\] \\*\\*REL-05" .planning/REQUIREMENTS.md` returns 0
    - `grep -c "^| Phase 5 |" .planning/REQUIREMENTS.md` returns 0 (no orphan Phase 5 row in coverage)
    - `grep -c "Phase 7 (v2.0 closure)" .planning/REQUIREMENTS.md` returns ≥1 (new coverage row exists)
    - `grep -c "deferred 2026-04-29" .planning/REQUIREMENTS.md` returns 1 (historical block exists with correct date)
    - `grep -c "Last updated:.*2026-04-30" .planning/REQUIREMENTS.md` returns 1
    - **W1 acceptance: `grep -c "04-message-capture-persistence/04-OPS-CHECKLIST.md" .planning/REQUIREMENTS.md` returns ≥1 (path fixed in SETUP-09)**
    - **W1 acceptance: `grep -c "04-message-capture/04-OPS-CHECKLIST.md" .planning/REQUIREMENTS.md` returns 0 (stale path gone — отрицательный тест должен быть точный, без "-persistence" суффикса; используется `\b04-message-capture/` regex с границей слова)** — реальная команда: `grep -E "04-message-capture/04-OPS" .planning/REQUIREMENTS.md` returns 0 lines
    - **W1 acceptance: `grep -c "04-message-capture-persistence/04-OPS-CHECKLIST.md" .planning/STATE.md` returns 1`**
    - `grep -E "04-message-capture/04-OPS" .planning/STATE.md` returns 0 lines
  </acceptance_criteria>
  <done>REQUIREMENTS.md полностью отражает post-cleanup state v2.0; traceability + coverage rebuilt; PRIV-03 flipped к `[x]`; PRIV-04 → Phase 0-Ops консистентно; SETUP-09 path fixed; STATE.md path fixed; никаких stale `[ ]` Pending для satisfied reqs.</done>
</task>

<task type="auto">
  <name>Task 2: Backfill requirements_completed YAML in 06-01/06-02/06-03 SUMMARY frontmatters</name>
  <files>.planning/phases/06-thread-summary-pipeline/06-01-SUMMARY.md, .planning/phases/06-thread-summary-pipeline/06-02-SUMMARY.md, .planning/phases/06-thread-summary-pipeline/06-03-SUMMARY.md</files>
  <read_first>
    - .planning/phases/06-thread-summary-pipeline/06-01-SUMMARY.md frontmatter (строки 1-N до закрывающего `---`)
    - .planning/phases/06-thread-summary-pipeline/06-02-SUMMARY.md frontmatter
    - .planning/phases/06-thread-summary-pipeline/06-03-SUMMARY.md frontmatter
    - .planning/v2.0-MILESTONE-AUDIT.md строка 128 («frontmatter requirements_completed empty» evidence)
  </read_first>
  <action>
В каждом из трёх файлов добавить YAML-ключ `requirements_completed:` в frontmatter. Размещение: после `metrics:` блока (или после `decisions:` если `metrics` отсутствует), перед закрывающим `---`. Используем стиль массива в одну строку (соответствует frontmatter conventions проекта).

**06-01-SUMMARY.md** (Plan 06-01 — summarizer-core, TDD):
Добавить:
```yaml
requirements_completed: [SUM-01, SUM-02, SUM-03, SUM-04, SUM-05, SUM-06, SUM-07, AI-07]
```

**06-02-SUMMARY.md** (Plan 06-02 — state + cron + persistence):
Добавить:
```yaml
requirements_completed: [STATE-01, STATE-02, SCHED-01, SCHED-02, SCHED-03, SCHED-04]
```

**06-03-SUMMARY.md** (Plan 06-03 — orchestrator + delivery):
Добавить:
```yaml
requirements_completed: [DLV-06, DLV-07, DLV-08, DLV-09, DLV-10]
```

Контракт допустимости: ключ `requirements_completed:` — массив строк, каждая строка — REQ-ID. Никаких других ключей не трогаем (tags, dependency_graph, key_files, decisions, metrics — остаются intact).

**Точное место вставки:** после строки `metrics:` блока в каждом файле, перед закрывающим `---`. Если выбрать другое место (например, после `tags`) — допустимо, главное чтобы валидным YAML.

Validation: после редактирования прогнать
```bash
node "$HOME/.claude/get-shit-done/bin/gsd-tools.cjs" frontmatter validate .planning/phases/06-thread-summary-pipeline/06-01-SUMMARY.md
```
если schema поддерживает `requirements_completed` — должно validate; если нет — это новый ключ, validator его проигнорирует (не fail).
  </action>
  <verify>
    <automated>grep -E "^requirements_completed:" .planning/phases/06-thread-summary-pipeline/06-0{1,2,3}-SUMMARY.md</automated>
  </verify>
  <acceptance_criteria>
    - `grep -c "^requirements_completed:" .planning/phases/06-thread-summary-pipeline/06-01-SUMMARY.md` returns 1
    - `grep -c "^requirements_completed:" .planning/phases/06-thread-summary-pipeline/06-02-SUMMARY.md` returns 1
    - `grep -c "^requirements_completed:" .planning/phases/06-thread-summary-pipeline/06-03-SUMMARY.md` returns 1
    - `grep "^requirements_completed:" .planning/phases/06-thread-summary-pipeline/06-01-SUMMARY.md | grep -E "SUM-01.*SUM-07.*AI-07"` exits 0 (полный список Plan 06-01 в порядке)
    - `grep "^requirements_completed:" .planning/phases/06-thread-summary-pipeline/06-02-SUMMARY.md | grep -E "STATE-01.*SCHED-04"` exits 0
    - `grep "^requirements_completed:" .planning/phases/06-thread-summary-pipeline/06-03-SUMMARY.md | grep -E "DLV-06.*DLV-10"` exits 0
    - YAML frontmatter всё ещё валиден: `awk '/^---$/{c++} c==1{next} c==2{exit} c==1{print}' file | head` показывает корректный YAML без ошибок.
    - Нет дубликатов REQ-IDs между плановыми SUMMARY (e.g. SUM-01 не появляется в 06-02 или 06-03).
    - Total REQ-IDs across three SUMMARYs = 19 (8 + 6 + 5).
  </acceptance_criteria>
  <done>Все три Phase 6 SUMMARY файла имеют machine-readable requirements_completed YAML.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| Documentation accuracy | REQUIREMENTS.md служит source-of-truth для milestone gating; drift подрывает доверие к gsd-audit-milestone tool. |
| Frontmatter machine-readability | Tools (gsd-tools.cjs frontmatter validate) парсят SUMMARY frontmatters; пустые поля = ложные orphan-warnings в audit. |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-07-04-01 | Tampering | Wrong REQ-ID assignment in SUMMARY frontmatter | mitigate | acceptance criterion проверяет точный набор REQ-IDs per плану через regex; источник truth — `06-VERIFICATION.md` секция «All Phase 6 Requirements Covered» (audit line 128 + ROADMAP plans bullet). |
| T-07-04-02 | Repudiation | Removing CMD/PRIV/OBS rows loses historical context | mitigate | Изменение 8 (Future Requirements deferred-block) сохраняет полный список с датой 2026-04-29 и причиной. Никакая информация не теряется — только перемещается из «Pending» в «Deferred» bucket. |
| T-07-04-03 | Information Disclosure | Public REQUIREMENTS.md exposes future-roadmap | accept | REQUIREMENTS.md находится в `.planning/` — внутренний planning-артефакт. Ничего sensitive не раскрывается. |
| T-07-04-04 | Tampering | Coverage table arithmetic error breaks audit | mitigate | acceptance criterion проверяет конкретное число (39); executor должен пересчитать после удалений; audit re-run после плана подтвердит. |
| T-07-04-05 | Denial of Service | Malformed YAML breaks gsd-tools | mitigate | acceptance criterion: `awk` извлечение frontmatter работает без ошибок; `grep -c "^requirements_completed:"` точно 1 на файл. |
| T-07-04-06 | Tampering | PRIV-03 checkbox state inconsistent with code-state | mitigate | PRIV-03 flipped в `[x]` атомарно с Plan 07-01 impl (оба в wave 1 одного milestone close); ROADMAP success criterion 4 explicit; rollback процедура — git revert обоих коммитов. |

Block-on: high. T-07-04-01 (точный REQ-ID assignment) и T-07-04-06 (atomic flip) — high severity для milestone audit; mitigated через explicit list в `<action>` + acceptance regex + ROADMAP-anchored decision.
</threat_model>

<verification>
- `grep -c "ON CONFLICT(chat_id, tg_message_id) DO UPDATE" .planning/REQUIREMENTS.md` returns 1.
- `grep -E "^- \\[x\\] \\*\\*SUM-0[1-7]\\b" .planning/REQUIREMENTS.md | wc -l` returns 7.
- `grep -E "^- \\[x\\] \\*\\*PRIV-03\\b" .planning/REQUIREMENTS.md | wc -l` returns 1.
- Все три SUMMARY frontmatters имеют `requirements_completed:` ключ.
- `grep -c "04-message-capture-persistence/04-OPS-CHECKLIST.md" .planning/STATE.md` returns 1.
- `node $HOME/.claude/get-shit-done/bin/gsd-tools.cjs frontmatter validate .planning/phases/06-thread-summary-pipeline/06-01-SUMMARY.md` (если такой комманд exists) — без ошибок YAML парсинга.
- Re-run `node $HOME/.claude/get-shit-done/bin/gsd-tools.cjs audit-milestone v2.0` (если доступно) — orphan-frontmatter warning по 06-01/02/03 disappears.
</verification>

<success_criteria>
1. REQUIREMENTS.md MSG-04 wording исправлено (`ON CONFLICT ... DO UPDATE` без "one row updated in place" формулировки).
2. Все 19 Phase 6 чекбоксов flipped в `[x]`.
3. PRIV-03 flipped в `[x]` (атомарно с Plan 07-01 impl, в одном wave 1).
4. PRIV-04 явно ассоциирован с Phase 0-Ops в SECTION + Traceability + Coverage (3 места — единая фраза).
5. Удалены 18 cancelled requirements (TRK-01..05 + CMD-04..08 + PRIV-01/02/05 + OBS-01..04 + REL-05).
6. PRIV-03 + PRIV-04 retained (PRIV-03 в Phase 7 Complete, PRIV-04 в Phase 0-Ops Pending).
7. Traceability table содержит ровно 39 строк.
8. Coverage-by-Phase обновлён: Phase 0-Ops 2, Phase 4 17, Phase 6 19, Phase 7 1.
9. Все три Phase 6 SUMMARY frontmatters получили `requirements_completed:` YAML с правильными REQ-IDs.
10. SETUP-09 path в REQUIREMENTS.md и STATE.md → `04-message-capture-persistence/04-OPS-CHECKLIST.md`.
11. Никаких изменений в коде (этот план doc-only).
</success_criteria>

<output>
After completion, create `.planning/phases/07-v2-closure/07-04-SUMMARY.md` со списком: число изменённых строк REQUIREMENTS.md (delete/insert/modify), STATE.md path-fix, три SUMMARY-frontmatter изменения, before/after coverage totals. Frontmatter `requirements_completed: []` (план doc-only — не закрывает REQ-IDs самостоятельно — только зеркалит post-Plan-07-01 state в docs).
</output>
</content>
</invoke>