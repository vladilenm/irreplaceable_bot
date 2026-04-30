---
phase: 07-v2-closure
plan: 05
type: execute
wave: 1
depends_on: []
files_modified:
  - .planning/phases/04-message-capture-persistence/04-OPS-CHECKLIST.md
autonomous: true
requirements:
  - SETUP-09
  - PRIV-04
tags: [ops, gdpr, checklist, manual, e2e, runbook]
must_haves:
  truths:
    - "File `.planning/phases/04-message-capture-persistence/04-OPS-CHECKLIST.md` exists with all six required H2 sections: Privacy Mode, Topic ID Capture, Volume Permissions, GDPR Consent, Live E2E Tests, /forget-me Runbook."
    - "Each section contains an evidence placeholder (URL, screenshot path, log excerpt, or command output) that the operator fills during execution."
    - "The Live E2E Tests section enumerates 7 Phase 4 tests + 3 Phase 6 tests = 10 tests with PASS/FAIL/N-A markers and a placeholder for the result of each."
    - "The /forget-me runbook section contains a copy-paste-ready raw SQL recipe (`DELETE FROM messages WHERE author_id = ?` plus optional `users` cleanup) and instructions on how to invoke it via `docker compose exec bot sqlite3 /app/data/messages.db ...`."
    - "The file front-matter is YAML-delimited with `---` lines (NOT `***`) so `gsd-tools.cjs frontmatter validate` and `awk '/^---$/{...}'` parse it correctly. Body section dividers may use either `---` or `***`; only the YAML wrapper MUST be `---`."
    - "Front-matter declares `status: pending` (operator updates to `complete` after all checks pass) and lists `requirements_to_close: [SETUP-09, PRIV-04]`."
    - "Scaffold file exists at `.planning/phases/04-message-capture-persistence/04-OPS-CHECKLIST.md` with all 6 sections + 10 E2E rows + runbook SQL — autonomous executor's job ends here."
    - "Operator-fill phase happens out-of-band post-deploy; tracked in 07-05-SUMMARY.md post-execution notes — closure of SETUP-09 + PRIV-04 happens after operator works through the checklist on a live VPS, not during this autonomous run."
  artifacts:
    - path: ".planning/phases/04-message-capture-persistence/04-OPS-CHECKLIST.md"
      provides: "Phase 0-Ops manual gate artifact with all required sections + runbook"
      contains: "## Live E2E Tests"
  key_links:
    - from: ".planning/phases/04-message-capture-persistence/04-OPS-CHECKLIST.md"
      to: "PRIV-03 / PRIV-04 / SETUP-09 evidence"
      via: "OPERATOR FILLS sections"
      pattern: "OPERATOR FILLS"
---

<objective>
Закрыть Success Criterion 6: создать manual-gate артефакт `04-OPS-CHECKLIST.md` со всеми обязательными секциями и placeholder'ами под evidence. Этот план — scaffolding-only: autonomous Claude создаёт markdown-структуру; field-fills (privacy-mode log evidence, screenshot URLs, E2E test results) операторски-управляемые и не могут быть автоматизированы (требуют живой Telegram + production deployment).

**Plan-level autonomy posture (W2 fix):** plan-frontmatter `autonomous: true`. Task 1 (scaffold creation) is fully autonomous markdown write. Operator-fill phase happens out-of-band post-deploy — the executor's responsibility ends at scaffold creation. Closure of SETUP-09 + PRIV-04 (flipping their REQUIREMENTS.md checkboxes from `[ ]` to `[x]`) happens later, after operator works through the checklist on a live VPS, and is recorded in 07-05-SUMMARY.md «Operator execution log» section.

Покрытие success criterion 6:
1. Privacy-mode startup-log evidence (`getMe().can_read_all_group_messages === true` printed by Bot init).
2. THREAD_SUMMARY_THREAD_ID capture procedure («🧵 Сводки тредов» topic creation + ID copy into `.env`).
3. Host volume permissions confirmation (`docker compose exec bot id` + `touch /app/data/.write_test`).
4. GDPR consent announcement URL/screenshot placeholder (lawful-basis evidence per GDPR Art. 13 — PRIV-04).
5. Results of 10 deferred live E2E tests: 7 from Phase 4 VERIFICATION.md + 3 from Phase 6 VERIFICATION.md.
6. Manual `/forget-me` runbook (operator opens sqlite3, runs `DELETE FROM messages WHERE author_id = ?`).

Эта же артефактная цель закрывает auditing требования SETUP-09 + PRIV-04 (после operator-fill, не после autonomous task).

Output:
- Один markdown-файл `.planning/phases/04-message-capture-persistence/04-OPS-CHECKLIST.md` (~200 LOC) со всеми шестью секциями, явными `OPERATOR FILLS:` маркерами, runbook-командами, и табличкой 10 E2E тестов.
- Файл закоммичен (`docs(07): scaffold Phase 0-Ops checklist`).
- Operator после деплоя заполняет файл — это offline-задача, не часть autonomous executor flow. Closure REQ-IDs происходит позже.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@.planning/ROADMAP.md
@.planning/v2.0-MILESTONE-AUDIT.md
@.planning/phases/04-message-capture-persistence/04-VERIFICATION.md
@.planning/phases/06-thread-summary-pipeline/06-VERIFICATION.md
@src/utils/preflight.ts
@src/services/db.service.ts

<interfaces>
<!-- Source-of-truth для секций scaffold'а -->

ROADMAP.md Phase 0-Ops Success Criteria (lines 53-56):
1. `getMe().can_read_all_group_messages === true` confirmed in startup log
2. `«🧵 Сводки тредов»` forum topic exists; `THREAD_SUMMARY_THREAD_ID` captured in .env
3. `./data` exists owned by uid 1001 + docker-compose mounts `./data:/app/data`
4. In-chat GDPR consent announcement URL or screenshot

Phase 4 VERIFICATION.md «Требуется проверка человеком» (lines 192-232):
- E2E #1: capture happy-path
- E2E #2: edit upsert
- E2E #3: service message + channel-forward filter
- E2E #4: preflight log check
- E2E #5: graceful shutdown + WAL checkpoint
- E2E #6: PRIV-05 — нет text body в логах
- E2E #7: anonymous admin message

Phase 6 VERIFICATION.md «Требуется проверка человеком» (lines 165-181):
- E2E #1: cron 06:30 MSK fires → один пост
- E2E #2: idempotency — двойной запуск в тот же MSK-день
- E2E #3: coexistence digest 06:00 + thread-summary 06:30

Total: 7 + 3 = 10 deferred live E2E tests.

src/services/db.service.ts:59 (forgotten_users — дропнется в Plan 07-02 Migration v3, runbook должен учитывать что после v3 deploy таблица отсутствует):
- Up to deploy 07-02: можно удалять и в `messages` и в `forgotten_users`.
- After deploy 07-02: только `messages` (forgotten_users больше нет).
Runbook должен содержать ОБЕ инструкции с примечанием на deploy version.
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Scaffold 04-OPS-CHECKLIST.md with all six sections + 10-row E2E table + /forget-me runbook (YAML wrapper uses `---`, not `***`)</name>
  <files>.planning/phases/04-message-capture-persistence/04-OPS-CHECKLIST.md</files>
  <read_first>
    - .planning/ROADMAP.md строки 47-57 (Phase 0-Ops success criteria — точные требования)
    - .planning/phases/04-message-capture-persistence/04-VERIFICATION.md строки 190-232 (точные тексты семи Phase 4 E2E тестов — переносим в чек-лист)
    - .planning/phases/06-thread-summary-pipeline/06-VERIFICATION.md строки 165-181 (трёх Phase 6 E2E тестов — переносим в чек-лист)
    - src/utils/preflight.ts (точная формулировка startup-log про privacy mode и admin status)
  </read_first>
  <action>
**B4 fix:** YAML frontmatter MUST be delimited by `---` lines. Body section dividers may stay as `***` or also use `---`. Only the **first two** delimiters (the ones wrapping the YAML block at the very top of the file) MUST be `---`.

Создать файл `.planning/phases/04-message-capture-persistence/04-OPS-CHECKLIST.md` со следующим содержанием (точно — executor копирует целиком, заменяя `{plan-author-date}` на текущую дату 2026-04-30). **Обратить внимание:** первые два разделителя (вокруг YAML frontmatter) — это `---`, не `***`. Внутренние разделители секций (между H2 секциями) могут оставаться `***`.

```markdown
---
phase: 0-Ops
artifact: operational-pre-flight-checklist
created: 2026-04-30
created_by: gsd-plan-phase 07-05
status: pending
requirements_to_close:
  - SETUP-09
  - PRIV-04
deferred_e2e_tests:
  phase_4: 7
  phase_6: 3
  total: 10
---

# Phase 0-Ops Manual Pre-Flight Checklist

> **Status legend:** `pending` (operator hasn't run check) · `complete` (filled with evidence) · `failed` (check did not pass — fix bot config and re-run) · `n/a` (not applicable to this deployment).
>
> This artifact is the manual gate that closes SETUP-09 + PRIV-04 of milestone v2.0. Until **all six sections** below are `complete` (or explicitly `n/a` with a written rationale), Phase 4 + Phase 6 VERIFICATION cannot transition from `human_needed` to `passed`.
>
> **Workflow:**
> 1. Deploy bot to production VPS via `docker compose up -d`.
> 2. Work through each section top-to-bottom, filling the `OPERATOR FILLS:` placeholders with real evidence (commands you ran + their outputs, screenshot paths, URLs).
> 3. Once a section's evidence is in, change its `**Status:** pending` line to `**Status:** complete`.
> 4. After all six are `complete`, update front-matter `status: pending` → `status: complete` and the milestone is ready to ship.

***

## 1. Privacy Mode

**Goal:** Bot must be able to read every message in the group, not only commands. BotFather defaults privacy mode to ON, which silences `bot.on('message')` for non-command messages → capture handler receives nothing.

**Status:** pending

### Pre-flight steps

1. Open BotFather → `/setprivacy` → choose this bot → set to **Disable**.
2. Kick the bot from the club group.
3. Re-invite the bot.
4. Re-promote the bot to admin (capture handler also requires admin status to receive `is_topic_message` payload reliably).

### Evidence to capture

After `docker compose up -d`, run:

```bash
docker compose logs bot 2>&1 | head -50
```

Look for the line emitted by `src/utils/preflight.ts` confirming `can_read_all_group_messages === true`. The log line is INFO-level; if WARN appears (`PRIVACY MODE ON`), privacy-disable did not stick — repeat steps 1-4.

OPERATOR FILLS:

```text
<paste log lines from docker compose logs bot 2>&1 | head -50 here>
```

OPERATOR FILLS — admin status confirmation (run `docker compose logs bot 2>&1 | grep -i admin`):

```text
<paste output here — should NOT contain "NOT admin" WARN>
```

***

## 2. Topic ID Capture

**Goal:** Forum topic «🧵 Сводки тредов» exists in club group, and `THREAD_SUMMARY_THREAD_ID` env var is set to its `message_thread_id`.

**Status:** pending

### Pre-flight steps

1. In the club group (must have forum mode enabled), create topic «🧵 Сводки тредов».
2. Get its thread ID: forward any message from the topic to `@RawDataBot` — copy the `message_thread_id` field from the response.
3. Add to `.env`:
   ```
   THREAD_SUMMARY_THREAD_ID=<int>
   ```
4. Restart container: `docker compose restart bot`.

### Evidence to capture

OPERATOR FILLS — thread ID:

```text
THREAD_SUMMARY_THREAD_ID = <paste integer here>
```

OPERATOR FILLS — topic URL or screenshot path:

```text
<paste t.me/c/<chat_id>/<thread_id> deep-link or screenshot path>
```

OPERATOR FILLS — boot succeeds with the env var (config.ts requires it via `requireEnvInt` — missing env crashes startup):

```text
<paste tail of `docker compose logs bot 2>&1 | head -10` showing successful "Bot is running" line>
```

***

## 3. Volume Permissions

**Goal:** Host directory `./data` exists, is owned by uid 1001 (matches `botuser` in Dockerfile), and is mounted as `./data:/app/data` in `docker-compose.yml`. Container can write to `/app/data` — required for `messages.db` and `state.json` to persist across restarts.

**Status:** pending

### Pre-flight steps

```bash
# 1. Ensure host dir exists and is owned by uid 1001
mkdir -p ./data
sudo chown -R 1001:1001 ./data

# 2. Confirm docker-compose.yml has the mount
grep -A2 "volumes:" docker-compose.yml
# expected output contains: - ./data:/app/data
```

### Evidence to capture

OPERATOR FILLS — host dir ownership (`ls -lan ./data`):

```text
<paste output — first column should show 1001 for owner uid>
```

OPERATOR FILLS — container-side identity (`docker compose exec bot id`):

```text
<paste output — should show uid=1001(botuser)>
```

OPERATOR FILLS — write test (`docker compose exec bot touch /app/data/.write_test && docker compose exec bot ls -la /app/data/.write_test`):

```text
<paste output — file should exist owned by botuser>
```

OPERATOR FILLS — DB persists across restart (do not skip this — it's the actual SETUP-06 contract):

```bash
# Capture row count, restart, confirm count survives
docker compose exec bot sqlite3 /app/data/messages.db "SELECT COUNT(*) FROM messages;"
docker compose down && docker compose up -d
sleep 5
docker compose exec bot sqlite3 /app/data/messages.db "SELECT COUNT(*) FROM messages;"
```

```text
<paste two count outputs — they MUST match>
```

***

## 4. GDPR Consent (PRIV-04)

**Goal:** In-chat consent announcement is published in the club group BEFORE first capture. The bot starts collecting members' messages — under GDPR Art. 13 the data subjects must be informed of the lawful basis (legitimate interest in club operations) before processing begins.

**Status:** pending

### Announcement template (Russian, штурман→пилот tone)

Adjust the template to match exact bot capabilities and operator contact info. Post it AS A PINNED MESSAGE in the club's general topic (not in «🧵 Сводки тредов» — pin in main chat for visibility).

```
🛡️ Уведомление о работе бота клуба

С [DATE] бот @<bot_username> сохраняет тексты сообщений из отслеживаемых тредов
форум-чата клуба. Цель — ежедневная утренняя сводка обсуждений (06:30 MSK,
тред «🧵 Сводки тредов»). Пайплайн обработки локальный, на VPS клуба;
третьим сторонам данные не передаются. Тексты автоматически удаляются через
90 дней. Запрос на удаление — лично @<operator_username>; ответ в течение 30 дней.
```

### Evidence to capture

OPERATOR FILLS — announcement URL (Telegram t.me deep link to the pinned message):

```text
<paste https://t.me/c/<chat_id>/<message_id> here>
```

OPERATOR FILLS — screenshot path (relative to repo root, e.g. `.planning/evidence/gdpr-announcement-2026-04-30.png`):

```text
<paste path here>
```

OPERATOR FILLS — date of announcement publication:

```text
<YYYY-MM-DD>
```

OPERATOR FILLS — confirmation of pin status (forwarded message header should say "Pinned message"):

```text
<paste confirmation note here>
```

> **Note:** GDPR consent recorded in markdown is operator-managed evidence, not a cryptographic record. For ≤200-user club this is the documented, accepted form. If membership scales (>500) revisit lawful-basis approach.

***

## 5. Live E2E Tests

**Goal:** Confirm the 10 E2E scenarios that depend on a running bot + real Telegram traffic. These were deferred from Phase 4 (7 tests) and Phase 6 (3 tests) because they cannot be validated by unit tests alone.

**Status:** pending

For each test row, fill the **Result** column with `PASS`, `FAIL`, or `N-A` plus a one-line note. If `FAIL`, file an issue and link it in the Notes column.

### Phase 4 deferred E2E (7 tests)

| # | Test | Source | Result | Notes |
|---|------|--------|--------|-------|
| P4-E1 | Capture happy-path: regular user sends text in tracked topic → exactly one row in `messages` within 5s; redelivery still one row | 04-VERIFICATION.md §1 | OPERATOR FILLS | |
| P4-E2 | Edit upsert: edit captured message → same row updated (`text`, `edited_at`); `created_at` unchanged; COUNT(*) unchanged | 04-VERIFICATION.md §2 | OPERATOR FILLS | |
| P4-E3 | Service-message + channel-forward filter: pin a message, wait for linked-channel auto-forward → 0 new rows in `messages` | 04-VERIFICATION.md §3 | OPERATOR FILLS | |
| P4-E4 | Preflight log order: `Starting bot → Database initialised → Tracking whitelist loaded → Cron job started → Bot is running → privacy + admin checks` | 04-VERIFICATION.md §4 | OPERATOR FILLS | |
| P4-E5 | Graceful shutdown + WAL checkpoint: `docker compose stop bot` → logs show `Cron job stopped → Bot stopped → Database closed`; `data/messages.db-wal` + `-shm` disappear | 04-VERIFICATION.md §5 | OPERATOR FILLS | |
| P4-E6 | PRIV-05 — нет text body в логах: `docker compose logs bot 2>&1 \| grep -E '"text":\|"caption":' && echo FAIL \|\| echo PASS` returns PASS | 04-VERIFICATION.md §6 | OPERATOR FILLS | |
| P4-E7 | Anonymous admin message: send as anon admin → `author_id=NULL`, `is_anonymous=1`, `author_name=<group title>` | 04-VERIFICATION.md §7 | OPERATOR FILLS | |

### Phase 6 deferred E2E (3 tests)

| # | Test | Source | Result | Notes |
|---|------|--------|--------|-------|
| P6-E1 | Cron 06:30 MSK fires → один HTML-пост в «🧵 Сводки тредов» с заголовком `🧵 Сводки тредов · DD.MM.YYYY` and footer `тихо: N тредов` (если есть low-volume) | 06-VERIFICATION.md §1 | OPERATOR FILLS | |
| P6-E2 | Idempotency double-fire: после первой публикации повторно вызвать pipeline → второй вызов возвращает `{alreadyPublished: true}`; новый пост не появляется; WARN «already published today» в логах | 06-VERIFICATION.md §2 | OPERATOR FILLS | |
| P6-E3 | Coexistence digest 06:00 + thread-summary 06:30 в одни сутки: AI-радар в `AI_RADAR_THREAD_ID`; thread-summary в `THREAD_SUMMARY_THREAD_ID`; `state.json` содержит обе даты — `lastDigestDate` + `lastThreadSummaryDate` | 06-VERIFICATION.md §3 | OPERATOR FILLS | |

OPERATOR FILLS — overall E2E pass/fail aggregate:

```text
PASS: __ / 10
FAIL: __ / 10
N-A:  __ / 10
Date completed: <YYYY-MM-DD>
```

***

## 6. /forget-me Runbook (Manual GDPR Art. 17 Compliance)

**Goal:** Document the operator-only procedure for handling «forget me» requests. The in-chat `/forget-me` command was de-scoped from v2.0 (CMD-07 cancelled 2026-04-29). Until v2.1 reintroduces an automated path, GDPR Art. 17 (right to erasure) is honoured manually by the operator running raw SQL.

**Status:** pending — this section is reference; mark `complete` only after first real request has been processed (or after 30 days from milestone ship if no requests).

### Identifying the requester

User sends DM to operator (or messages the club channel) requesting deletion. Capture their `author_id` from any past message:

```bash
docker compose exec bot sqlite3 /app/data/messages.db \
  "SELECT DISTINCT author_id, author_name FROM messages WHERE author_name LIKE '%<partial-name>%';"
```

OPERATOR FILLS (template — replace `<author_id>` with actual integer):

### Deletion procedure (current — after Plan 07-02 Migration v3 deploys)

After Plan 07-02 ships, `forgotten_users` table no longer exists. The deletion is a single statement:

```bash
# Optional pre-count — prove how many rows will be deleted (transparency)
docker compose exec bot sqlite3 /app/data/messages.db \
  "SELECT COUNT(*) FROM messages WHERE author_id = <author_id>;"

# Hard delete
docker compose exec bot sqlite3 /app/data/messages.db \
  "DELETE FROM messages WHERE author_id = <author_id>;"

# Optional: also nullify `users` row so display name no longer surfaces in summaries
docker compose exec bot sqlite3 /app/data/messages.db \
  "UPDATE users SET display_name = '[deleted]' WHERE author_id = <author_id>;"

# Confirm zero rows remain
docker compose exec bot sqlite3 /app/data/messages.db \
  "SELECT COUNT(*) FROM messages WHERE author_id = <author_id>;"
```

The DELETE runs in a single sqlite transaction; capture handler at the same time will not interleave because better-sqlite3 in WAL mode serialises writes.

> **Re-capture risk:** The user can post a new message in a tracked thread immediately after deletion → that message will be captured and a new row will appear. To prevent re-capture, the user must (a) leave the tracked threads, OR (b) request the operator to add a custom filter (out of scope for v2.0). Document this caveat in the response to the user.

### Pre-Plan-07-02 fallback (transitional)

If Plan 07-02 has not yet deployed and `forgotten_users` table still exists, ALSO insert into the audit table to keep the schema consistent:

```bash
docker compose exec bot sqlite3 /app/data/messages.db <<SQL
BEGIN;
INSERT INTO forgotten_users (author_id, forgotten_at, deleted_count, requested_via)
  VALUES (<author_id>, datetime('now'), (SELECT COUNT(*) FROM messages WHERE author_id = <author_id>), 'manual-runbook');
DELETE FROM messages WHERE author_id = <author_id>;
COMMIT;
SQL
```

### Evidence log per request

For each processed request, append a row to the table below.

| Date | Request method | author_id | rows_deleted | Operator | Notes |
|------|----------------|-----------|---------------|----------|-------|
| OPERATOR FILLS | (DM / chat / email) | | | | |

***

## Closure

Once all six sections above are `complete` (or explicitly `n/a` with rationale), update the front-matter:

```yaml
status: complete
completed: <YYYY-MM-DD>
operator: <name or handle>
```

Then create `.planning/phases/07-v2-closure/07-05-SUMMARY.md` summarising the operator's evidence (counts, key findings, any failed tests with linked issues). At that point SETUP-09 + PRIV-04 are satisfied and milestone v2.0 may be marked `shipped`.

***

_Scaffold created 2026-04-30 by gsd-plan-phase 07-05. Operator fills field-by-field._
```

После создания файла прогнать:
```bash
test -f .planning/phases/04-message-capture-persistence/04-OPS-CHECKLIST.md
```
exit 0 — файл существует.

Прогнать grep на все шесть headings:
```bash
grep -cE "^## (1\\. Privacy Mode|2\\. Topic ID Capture|3\\. Volume Permissions|4\\. GDPR Consent|5\\. Live E2E Tests|6\\. /forget-me Runbook)" .planning/phases/04-message-capture-persistence/04-OPS-CHECKLIST.md
```
должно вернуть 6.

**B4 acceptance — YAML frontmatter parsable:**

```bash
# extract YAML body between first two `---` lines; should print non-empty content
awk '/^---$/{c++; if(c==2)exit} c==1' .planning/phases/04-message-capture-persistence/04-OPS-CHECKLIST.md
```
Должно вывести непустые YAML строки (phase, artifact, created, …).

И прогнать gsd-tools валидацию (если schema поддерживает):
```bash
node "$HOME/.claude/get-shit-done/bin/gsd-tools.cjs" frontmatter validate .planning/phases/04-message-capture-persistence/04-OPS-CHECKLIST.md 2>&1 || true
```
Не должно быть YAML parse error (если возвращает «schema not found» — допустимо; критично — отсутствие parse error).
  </action>
  <verify>
    <automated>test -f .planning/phases/04-message-capture-persistence/04-OPS-CHECKLIST.md && grep -cE "^## " .planning/phases/04-message-capture-persistence/04-OPS-CHECKLIST.md && awk '/^---$/{c++; if(c==2)exit} c==1' .planning/phases/04-message-capture-persistence/04-OPS-CHECKLIST.md | grep -c "phase:"</automated>
  </verify>
  <acceptance_criteria>
    - `test -f .planning/phases/04-message-capture-persistence/04-OPS-CHECKLIST.md` exits 0
    - `grep -c "^## 1\\. Privacy Mode" .planning/phases/04-message-capture-persistence/04-OPS-CHECKLIST.md` returns 1
    - `grep -c "^## 2\\. Topic ID Capture" .planning/phases/04-message-capture-persistence/04-OPS-CHECKLIST.md` returns 1
    - `grep -c "^## 3\\. Volume Permissions" .planning/phases/04-message-capture-persistence/04-OPS-CHECKLIST.md` returns 1
    - `grep -c "^## 4\\. GDPR Consent" .planning/phases/04-message-capture-persistence/04-OPS-CHECKLIST.md` returns 1
    - `grep -c "^## 5\\. Live E2E Tests" .planning/phases/04-message-capture-persistence/04-OPS-CHECKLIST.md` returns 1
    - `grep -c "^## 6\\. /forget-me Runbook" .planning/phases/04-message-capture-persistence/04-OPS-CHECKLIST.md` returns 1
    - `grep -c "OPERATOR FILLS" .planning/phases/04-message-capture-persistence/04-OPS-CHECKLIST.md` returns ≥10 (как минимум по одному placeholder в каждой секции, чаще больше)
    - `grep -c "P4-E[1-7]" .planning/phases/04-message-capture-persistence/04-OPS-CHECKLIST.md` returns 7 (все семь Phase 4 E2E rows присутствуют)
    - `grep -c "P6-E[1-3]" .planning/phases/04-message-capture-persistence/04-OPS-CHECKLIST.md` returns 3 (все три Phase 6 E2E rows присутствуют)
    - `grep -c "DELETE FROM messages WHERE author_id" .planning/phases/04-message-capture-persistence/04-OPS-CHECKLIST.md` returns ≥1 (runbook содержит SQL)
    - `grep -c "can_read_all_group_messages" .planning/phases/04-message-capture-persistence/04-OPS-CHECKLIST.md` returns 1 (privacy-mode evidence target)
    - `grep -c "GDPR Art\\. 13" .planning/phases/04-message-capture-persistence/04-OPS-CHECKLIST.md` returns ≥1 (lawful basis cited per PRIV-04)
    - `grep -c "GDPR Art\\. 17" .planning/phases/04-message-capture-persistence/04-OPS-CHECKLIST.md` returns ≥1 (right to erasure cited)
    - `grep -c "status: pending" .planning/phases/04-message-capture-persistence/04-OPS-CHECKLIST.md` returns ≥1 (front-matter placeholder)
    - `grep -c "requirements_to_close" .planning/phases/04-message-capture-persistence/04-OPS-CHECKLIST.md` returns 1
    - `grep -E "SETUP-09|PRIV-04" .planning/phases/04-message-capture-persistence/04-OPS-CHECKLIST.md | wc -l` returns ≥2 (оба REQ-IDs упомянуты)
    - **B4 acceptance: `awk '/^---$/{c++; if(c==2)exit} c==1' .planning/phases/04-message-capture-persistence/04-OPS-CHECKLIST.md | grep -c "^phase:"` returns 1 (YAML body extractable between first two `---` markers — wrapper is `---` not `***`)**
    - **B4 acceptance: `head -1 .planning/phases/04-message-capture-persistence/04-OPS-CHECKLIST.md` returns exactly `---` (first line is YAML start delimiter)**
    - **B4 acceptance: `awk '/^---$/{c++} c==1{next} c==2{exit} c==1{print}' .planning/phases/04-message-capture-persistence/04-OPS-CHECKLIST.md | wc -l` returns ≥5 (≥5 YAML lines between delimiters: phase, artifact, created, created_by, status, requirements_to_close header, deferred_e2e_tests header, etc.)**
  </acceptance_criteria>
  <done>Скаффолд готов с валидным YAML frontmatter (`---` wrapper); operator получает чёткий путь от deploy до milestone-shipped. Закрытие SETUP-09 + PRIV-04 происходит post-deploy в operator-fill phase, не в этом autonomous run.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| markdown evidence ↔ legal compliance | Markdown-evidence в .planning/ — operator-managed; не cryptographic record. Подходит для small-club (≤200 users) GDPR posture. |
| sqlite3 raw SQL runbook | Operator-only path; runbook раскрывает структуру БД и команды на удаление; доступ к runbook = доступ к VPS. |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-07-05-01 | Tampering | GDPR consent record stored as plain markdown (not signed/timestamped) | accept | Документировано в section 4 как «operator-managed evidence; not a cryptographic record». Acceptable для ≤200-user closed club; revisit при scale >500. Альтернативы (signed PDF, blockchain audit log) дают diminishing returns на club-scale. |
| T-07-05-02 | Information Disclosure | /forget-me runbook discloses raw SQL + DB path | mitigate | Runbook размещён в private `.planning/` внутри репозитория; commit'ы не публичны (private repo). Операторские повествовательные команды специально content-аппроприированы (нет hardcoded passwords, IDs). Access control = git-репо access control. |
| T-07-05-03 | Repudiation | Operator processes /forget-me request without leaving an audit row | mitigate | Section 6 содержит mandatory «Evidence log per request» table; каждое удаление требует строки `Date | author_id | rows_deleted | Operator | Notes`. Это compensating control в отсутствие auto-table forgotten_users (после Plan 07-02 deploy). |
| T-07-05-04 | Elevation of Privilege | Wrong author_id deletes wrong user's data | mitigate | Section 6 предписывает pre-count `SELECT COUNT(*) FROM messages WHERE author_id = ?` ДО DELETE — operator видит число строк до удаления. Дополнительный шаг: section 6 требует подтвердить identifier через DM с пользователем. Документировано в «Identifying the requester» подсекции. |
| T-07-05-05 | Denial of Service | Operator runs DELETE during high-traffic window → WAL bloat | accept | better-sqlite3 в WAL mode + busy_timeout=5000ms (config'ed in db.service.ts). Capture handler кратковременно blocks if DELETE удерживает write lock; recovery automatic. На low-traffic club (≤200 users) impact <100ms. |
| T-07-05-06 | Tampering | Phase 0-Ops gate marked complete без real evidence | mitigate | Acceptance criterion на структуру файла + scaffold содержит `OPERATOR FILLS:` markers — autonomous Claude executor не может «закрыть» секцию без replacement of these markers. Audit re-run после operator fill сравнит markers с placeholder template и flag'нет если всё ещё все pending. |
| T-07-05-07 | Repudiation | GDPR consent announcement URL unreachable later | mitigate | Section 4 требует ОБА: URL + screenshot path. Screenshot — local artifact в `.planning/evidence/` (создаётся оператором), survives любой Telegram chat hijack/migration. |
| T-07-05-08 | Tampering | Markdown HR `***` confuses YAML parsers (gsd-tools.cjs) | mitigate | B4 acceptance criterion явно проверяет, что первые два разделителя — `---`, не `***`. `awk '/^---$/{c++}'` extraction подтверждает YAML body parsable. |

Block-on: high. T-07-05-04 (wrong-deletion), T-07-05-06 (premature gate close), T-07-05-08 (YAML parsability) — high severity для compliance gate; митигированы pre-count step, `OPERATOR FILLS` marker pattern, и `---` wrapper enforcement.
</threat_model>

<verification>
- `test -f .planning/phases/04-message-capture-persistence/04-OPS-CHECKLIST.md` exits 0.
- Все шесть headings присутствуют (acceptance criterion grep).
- 10 E2E test rows присутствуют (P4-E1..7 + P6-E1..3).
- /forget-me runbook содержит точный SQL (`DELETE FROM messages WHERE author_id = ?`) и оба варианта (post-Plan-07-02 default + pre-Plan-07-02 transitional).
- YAML frontmatter валиден (первые два разделителя — `---`; `awk` extraction works, `status: pending` present).
- Никаких изменений в коде или других planning-артефактах (этот план — только новый markdown).
</verification>

<success_criteria>
1. Файл создан в правильном пути (`.planning/phases/04-message-capture-persistence/04-OPS-CHECKLIST.md` — `-persistence` суффикс обязателен).
2. Все шесть обязательных секций (Privacy Mode, Topic ID, Volume, GDPR, Live E2E, /forget-me) присутствуют.
3. 10 E2E test rows (7 Phase 4 + 3 Phase 6) явно перечислены с placeholder'ами.
4. /forget-me runbook содержит копи-пастабельный SQL.
5. Frontmatter `status: pending` + `requirements_to_close: [SETUP-09, PRIV-04]`.
6. `OPERATOR FILLS` markers ≥10 (минимум по одному на секцию + по одной на E2E test row).
7. **YAML frontmatter wrapper использует `---`, не `***`** — `awk` извлекает frontmatter корректно; `gsd-tools.cjs frontmatter validate` парсит без YAML errors.
8. Plan-level `autonomous: true` — Task 1 (scaffold creation) выполняется автономно; operator-fill phase отдельный, post-deploy, документирован в objective.
</success_criteria>

<output>
Файл создан scaffold-only, `status` в его frontmatter остаётся `pending` до operator-fill.

Создать `.planning/phases/07-v2-closure/07-05-SUMMARY.md` с пометкой «scaffold complete, awaiting operator execution». Frontmatter `requirements_completed: []` — закрытие SETUP-09 + PRIV-04 произойдёт после operator-fill, не в этом autonomous run.

В body 07-05-SUMMARY.md добавить секцию «Operator execution log» с шаблоном:
```markdown
## Operator execution log

- [ ] Section 1 (Privacy Mode) complete — date, evidence link
- [ ] Section 2 (Topic ID) complete — date, evidence link
- [ ] Section 3 (Volume) complete — date, evidence link
- [ ] Section 4 (GDPR Consent) complete — date, evidence link
- [ ] Section 5 (Live E2E) complete — date, PASS/FAIL counts
- [ ] Section 6 (/forget-me Runbook) — first request processed (or 30-day no-request marker)

Once all six are checked, operator updates SETUP-09 + PRIV-04 in REQUIREMENTS.md to `[x]` (a separate small commit; not part of this milestone close).
```
</output>
</content>
</invoke>