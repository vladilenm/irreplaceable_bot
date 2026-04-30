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

Look for the line emitted by `src/utils/preflight.ts` confirming `can_read_all_group_messages === true`. The log line is INFO-level with message `'Privacy mode OFF, bot will receive group messages'`; if WARN appears (`PRIVACY MODE ON`), privacy-disable did not stick — repeat steps 1-4.

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
