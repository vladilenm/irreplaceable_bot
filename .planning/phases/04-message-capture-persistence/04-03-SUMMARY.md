---
phase: 04-message-capture-persistence
plan: 03
subsystem: capture
tags: [grammy, telegram-capture, idempotent-upsert, forum-topics, anonymous-admin, preflight, gdpr, long-polling]

requires:
  - phase: 04-message-capture-persistence
    provides: db.service.ts (initDb/getDb/closeDb), MIGRATIONS v1 (4 product tables), CapturedMessage type
  - phase: 04-message-capture-persistence
    provides: message-store (upsertMessage + isAuthorForgotten), tracking.service (loadTrackingWhitelist + isThreadTracked + listTrackedThreadIds)

provides:
  - capture.mapper — pure (Context) → CapturedMessage|null with anonymous-admin detection (D-04), text??caption no-prefix (D-09), defensive edit_date throw (PITFALL-NEW-02)
  - capture.handler — single combined Grammy filter ['message:text','message:caption','edited_message:text','edited_message:caption']; 5-step guard chain; entire body in try/catch (REL-04); metadata-only debug log (PRIV-05)
  - preflight.ts — runPreflight(bot) calling getMe + getChatMember; logs WARN on privacy-on or non-admin status; never throws (MSG-08, OPS-03)
  - bot.ts wiring — registerCaptureHandlers(bot) appended AFTER 4 commands and bot.catch (CODE-01)
  - index.ts wiring — main() ordering initDb → loadTrackingWhitelist → startScheduler → bot.start (with onStart→runPreflight); shutdown() ordering stopScheduler → bot.stop → closeDb → process.exit
  - REQUIREMENTS.md MSG-03 rewritten per D-08 (text + caption only, placeholder rows rejected)

affects: [05-thread-tracking-commands, 06-thread-summarizer, 07-daily-summary-delivery, 08-operational-privacy-commands]

tech-stack:
  added: []
  patterns:
    - "Single combined Grammy filter array (Pattern 3 from RESEARCH §1.1) — service messages auto-filtered by query, no explicit enumeration needed"
    - "5-step guard chain with module-private short-circuits before any DB call: is_topic_message → is_automatic_forward → sender_chat.type === 'channel' → isThreadTracked → mapper → isAuthorForgotten → upsertMessage"
    - "Entire capture body wrapped in try { ... } catch (err: unknown) — exceptions logged, long-polling loop survives (REL-04)"
    - "Metadata-only debug log (6 fields: chat_id, thread_id, author_id, message_length, is_edit, has_media) — message text NEVER logged (PRIV-05)"
    - "Defensive Grammy contract narrowing — if (ed === undefined) throw — Grammy/Bot API drift surfaces as caught error"
    - "Capture handler appended LAST in bot.ts (after bot.catch + 4 commands) — terminal middleware (no next() call)"
    - "Preflight self-check is non-blocking inside bot.start onStart callback — failures log ERROR but never crash bot"
    - "Anon-admin name fallback via narrowing 'title' in senderChat — Grammy strict typing satisfied with single-line ternary"

key-files:
  created:
    - src/modules/capture/capture.mapper.ts (115 LOC — pure mapping with 4 author cases + edit branch)
    - src/modules/capture/capture.handler.ts (100 LOC — combined Grammy filter + 5-step guard chain + try/catch)
    - src/utils/preflight.ts (62 LOC — getMe + getChatMember WARN-on-misconfig)
  modified:
    - src/bot.ts (added 1 import + 4-line capture-handler registration block at file bottom; 4 commands and bot.catch untouched)
    - src/index.ts (full rewrite — 4 new imports, 5 new wiring lines: initDb, loadTrackingWhitelist, runPreflight, closeDb; all 4 process.on handlers preserved)
    - .planning/REQUIREMENTS.md (MSG-03 rewrite per D-08; all other lines untouched)

key-decisions:
  - "Filter array is exactly 4 elements ['message:text','message:caption','edited_message:text','edited_message:caption'] — single bot.on call (Pattern 3); 4 separate bot.on calls rejected (less idiomatic, harder to reason about middleware count)"
  - "Guard order is non-negotiable: is_topic_message FIRST (cheapest, shorts non-forum reply chains TG-03), then is_automatic_forward, then sender_chat.type, then isThreadTracked, then mapper, then isAuthorForgotten, then upsertMessage"
  - "Anon-admin authorName uses 'title' in senderChat narrowing + 'Anonymous Admin' fallback — Grammy stricter Chat type marks title optional even on supergroup; Bot API spec guarantees title for sender_chat=chat case but TS doesn't know it"
  - "Capture handler is terminal (no next()) — commands MUST register before it (CODE-01 enforced by line-number ordering)"
  - "Preflight non-blocking inside onStart — bot starts polling immediately; preflight runs concurrently and logs ERROR on failure (catch block) but never crashes"
  - "closeDb() AFTER await bot.stop() — in-flight capture transactions drain through Grammy's stop() Promise before WAL checkpoint(TRUNCATE) runs (REL-05 prep)"
  - "MSG-03 rewrite preserves the - [ ] checkbox state (still pending), changes only the wording — Phase 4 satisfies the rewritten MSG-03 itself, traceability table row unchanged"

patterns-established:
  - "Pattern: single combined Grammy filter array for capture/listen handlers — applies to any future bot.on with multiple correlated query types"
  - "Pattern: handler-entry guard chain (cheap → expensive → DB) with explicit return per step — readable, testable line-by-line"
  - "Pattern: try/catch wrapping the entire handler body for long-polling resilience (REL-04) — every future capture-style handler should mirror this"
  - "Pattern: metadata-only structured logging with field allowlist — PRIV-05 for v2.0 capture, reusable for any future handler that touches user content"
  - "Pattern: preflight self-check inside onStart (non-blocking) — generic mechanism for any future startup gate (e.g. /summary topic existence in Phase 7)"
  - "Pattern: Grammy strict-type narrowing via 'key' in obj for legitimate runtime invariants — preferred over `as` cast or `!` non-null assertion"

requirements-completed:
  - MSG-01
  - MSG-02
  - MSG-03
  - MSG-05
  - MSG-06
  - MSG-07
  - MSG-08
  - REL-04

duration: ~5min32s
completed: 2026-04-28
---

# Phase 04 Plan 03: Capture Handler Wiring Summary

**Bot переходит из publish-only в listen+publish: захватывает text-bearing сообщения из whitelisted forum-тредов идемпотентно по `(chat_id, tg_message_id)`, отбрасывает service-messages/channel-forwards/reply-chain-false-positives, переживает рестарты long-polling без сбоев, никогда не пишет message body в логи; preflight на старте даёт оператору WARN при включенном privacy mode или потере админ-статуса.**

## Performance

- **Duration:** ~5min 32s
- **Started:** 2026-04-28T06:08:02Z
- **Completed:** 2026-04-28T06:13:34Z
- **Tasks:** 3 (all atomic, no checkpoints)
- **Files affected:** 6 (3 created, 3 modified)

## Accomplishments

- `src/modules/capture/capture.mapper.ts` — чистая `(ctx) → CapturedMessage|null` с обработкой anon-admins (D-04), text??caption (D-09), reply-context (D-05), ISO-8601 UTC (D-03), defensive edit_date throw (PITFALL-NEW-02). Без I/O.
- `src/modules/capture/capture.handler.ts` — `registerCaptureHandlers(bot)` регистрирует ОДИН Grammy filter `['message:text','message:caption','edited_message:text','edited_message:caption']` с 5-step guard chain. Тело завернуто в `try/catch (err: unknown)` — REL-04. Debug log emit'ит ровно 6 metadata полей, никакого `text` body.
- `src/utils/preflight.ts` — `runPreflight(bot)` вызывает `getMe()` и `getChatMember()`, логирует WARN при `can_read_all_group_messages !== true` ("PRIVACY MODE ON") или статусе ≠ administrator/creator ("NOT admin in target chat"). Все обернуто в try/catch — никогда не падает (MSG-08, OPS-03).
- `src/bot.ts` — добавлен ровно 1 import и 4-строчный блок `registerCaptureHandlers(bot)` в самом низу файла после 4 команд и `bot.catch`. Никаких других правок (CODE-01 ordering).
- `src/index.ts` — полная перепись: добавлены `initDb()`, `loadTrackingWhitelist()` ДО `startScheduler()`; `void runPreflight(bot)` ВНУТРИ `onStart` callback; `closeDb()` ПОСЛЕ `await bot.stop()` в shutdown. Все 4 v1.0 process.on handlers сохранены verbatim.
- `.planning/REQUIREMENTS.md` — MSG-03 переписана с "placeholder rows" на "text + caption only — пустое отбрасывается, ноль строк в БД" с прямой ссылкой на D-08. Traceability row и все остальные REQ-IDs не тронуты.
- Все верификации пройдены: `npx tsc --noEmit` exit 0, `npm run build` exit 0, mapper smoke (6 cases), integration smoke (idempotency, edit, forgotten guard) — всё PASS.

## Task Commits

1. **Task 1: capture.mapper.ts + capture.handler.ts** — `6ccaafe` (feat)
2. **Task 2: preflight.ts + bot.ts wiring + index.ts startup/shutdown** — `914c2e5` (feat)
3. **Task 3: REQUIREMENTS.md MSG-03 rewrite** — `fd8e1f5` (docs)

## Files Created / Modified

| Path | Status | LOC | Purpose |
|------|--------|-----|---------|
| `src/modules/capture/capture.mapper.ts` | created | 115 | Pure (ctx) → CapturedMessage \| null |
| `src/modules/capture/capture.handler.ts` | created | 100 | Combined Grammy filter + 5-step guard + try/catch |
| `src/utils/preflight.ts` | created | 62 | getMe + getChatMember WARN-only checks |
| `src/bot.ts` | modified | +5 | import + registerCaptureHandlers(bot) at bottom |
| `src/index.ts` | modified | +20 / -2 | initDb / loadTrackingWhitelist / runPreflight / closeDb wiring |
| `.planning/REQUIREMENTS.md` | modified | +1 / -1 | MSG-03 rewritten per D-08 |

## Final Capture Mapper (excerpt — author-detection branch)

```typescript
if (senderChat && senderChat.id === ctx.chat?.id) {
  // Anonymous admin: sender_chat is the supergroup itself.
  authorId = null;
  authorName = 'title' in senderChat && senderChat.title !== undefined
    ? senderChat.title
    : 'Anonymous Admin';
  isAnonymous = 1;
} else if (senderChat && senderChat.type === 'channel') {
  // Linked-channel auto-forward — handler.ts should already have filtered.
  // Belt-and-suspenders: drop here too.
  return null;
} else if (fromUser) {
  authorId = fromUser.id;
  authorName = formatDisplayName(fromUser);
  isAnonymous = 0;
} else {
  logger.warn({ tg_message_id: msg.message_id }, 'Message with no recognised author — dropping');
  return null;
}
```

`formatDisplayName(user)` строит `"first_name [last_name] [@username]"` через явный `UserLike` interface — никаких `as User` или `any`.

## Final Capture Handler (excerpt — guard chain + try/catch shell)

```typescript
async function captureHandler(ctx: Context): Promise<void> {
  try {
    const msg = ctx.msg;
    if (!msg) return;
    if (msg.is_topic_message !== true) return;             // step 1
    if (msg.is_automatic_forward === true) return;          // step 2a
    if (msg.sender_chat?.type === 'channel') return;        // step 2b
    const threadId = msg.message_thread_id;
    if (threadId === undefined || !isThreadTracked(threadId)) return; // step 3

    const captured = mapTelegramMessageToCaptured(ctx);     // step 4 (mapper)
    if (captured === null) return;

    if (captured.authorId !== null && isAuthorForgotten(captured.authorId)) {
      logger.debug({ author_id: captured.authorId }, 'Skipping message from forgotten user');
      return;                                               // step 5 (forgotten)
    }

    upsertMessage(captured);                                // step 6 (persist)

    logger.debug(
      {
        chat_id: captured.chatId, thread_id: captured.threadId, author_id: captured.authorId,
        message_length: captured.text.length, is_edit: captured.editedAt !== null,
        has_media: !!(msg.photo || msg.video || msg.document || msg.voice ||
                       msg.audio || msg.animation || msg.video_note || msg.sticker),
      },
      'Message captured',
    );
  } catch (err: unknown) {
    logger.error(
      { err, update_id: ctx.update.update_id, chat_id: ctx.chat?.id, tg_message_id: ctx.msg?.message_id },
      'Capture handler failed',
    );
  }
}
```

The 6 debug-log fields are an exhaustive metadata allowlist; PRIV-05 acceptance criterion (`! grep -E "logger\\.(debug|info)\\(.*text:" capture.handler.ts`) verified empty.

## Final preflight.ts (full content)

```typescript
import type { Bot } from 'grammy';
import { config } from '../config.js';
import { logger } from './logger.js';

export async function runPreflight(bot: Bot): Promise<void> {
  try {
    const me = await bot.api.getMe();
    if (me.can_read_all_group_messages !== true) {
      logger.warn(
        { botId: me.id, username: me.username, can_read_all_group_messages: me.can_read_all_group_messages },
        'PRIVACY MODE ON — bot will not see normal user messages. Disable in BotFather and re-promote.',
      );
    } else {
      logger.info({ botId: me.id, username: me.username }, 'Privacy mode OFF, bot will receive group messages');
    }

    const targetChatId = Number(config.targetChatId);
    if (!Number.isInteger(targetChatId)) {
      logger.warn({ targetChatId: config.targetChatId }, 'TARGET_CHAT_ID is not numeric — skipping admin status check');
      return;
    }
    const member = await bot.api.getChatMember(targetChatId, me.id);
    if (member.status !== 'administrator' && member.status !== 'creator') {
      logger.warn(
        { chatId: targetChatId, status: member.status },
        'Bot is NOT admin in target chat — capture may behave unexpectedly. Promote in chat settings.',
      );
    } else {
      logger.info({ chatId: targetChatId, status: member.status }, 'Bot is admin in target chat');
    }
  } catch (err: unknown) {
    logger.error({ err }, 'Preflight check failed (non-fatal)');
  }
}
```

## bot.ts diff summary

```
@@ src/bot.ts @@
 import { sendDigest } from './modules/digest/digest.sender.js';
+import { registerCaptureHandlers } from './modules/capture/capture.handler.js';

   ... (216 LOC of v1.0 commands UNCHANGED — bot.catch + 4 commands) ...

 });
+
+// v2.0 Phase 4: capture handler — MUST be registered AFTER all commands and
+// AFTER bot.catch() (CODE-01: Grammy middleware order). Capture is terminal
+// (does not call next()), so commands must match first.
+registerCaptureHandlers(bot);
```

Verified ordering by line numbers: last `bot.command` at line 167, `registerCaptureHandlers(bot)` at line 221.

## index.ts full content (rewritten)

```typescript
import 'dotenv/config';
import { bot } from './bot.js';
import { logger } from './utils/logger.js';
import { startScheduler, stopScheduler } from './scheduler/cron.js';
import { initDb, closeDb } from './services/db.service.js';
import { loadTrackingWhitelist } from './services/tracking.service.js';
import { runPreflight } from './utils/preflight.js';

async function main(): Promise<void> {
  logger.info('Starting bot...');
  initDb();                          // line 15  ← BEFORE scheduler/polling (DB-01 fail-fast)
  loadTrackingWhitelist();           // line 20  ← BEFORE bot.start (TRK-05 race-free)
  startScheduler();                  // line 22
  void bot.start({                   // line 26
    onStart: () => {
      logger.info('Bot is running (long-polling mode)');
      void runPreflight(bot);        // line 31  ← non-blocking inside onStart (MSG-08, OPS-03)
    },
  }).catch((err: unknown) => {
    logger.fatal({ err }, 'bot.start() failed');
    process.exit(1);
  });
}

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Shutdown signal received, stopping gracefully...');
  stopScheduler();                   // line 42
  await bot.stop();                  // line 43  ← drains in-flight handlers
  closeDb();                         // line 46  ← AFTER bot.stop (REL-05 prep, WAL checkpoint(TRUNCATE))
  logger.info('Bot stopped. Goodbye.');
  process.exit(0);                   // line 48
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('uncaughtException', (err) => { logger.fatal({ err }, 'Uncaught exception'); process.exit(1); });
process.on('unhandledRejection', (reason) => { logger.fatal({ reason }, 'Unhandled rejection'); process.exit(1); });

main().catch((err: unknown) => { logger.fatal({ err }, 'Failed to start bot'); process.exit(1); });
```

Verified main() ordering: 15 < 20 < 22 < 26. Verified shutdown() ordering: 42 < 43 < 46 < 48. All 4 v1.0 `process.on` handlers preserved verbatim.

## REQUIREMENTS.md MSG-03 — Before / After

**Before:**

```
- [ ] **MSG-03**: Non-text messages stored as `[photo]` / `[voice 0:42]` / `[video]` / `[document: name.pdf]` / `[sticker]` / `[poll: "Q?"]` placeholder in `text` field; captions captured alongside placeholder when present
```

**After:**

```
- [ ] **MSG-03**: Phase 4 captures only text-bearing messages — `messages.text` stores `ctx.message.text` OR `ctx.message.caption` (no prefix, no `[photo]`/`[video]` placeholder). Pure non-text messages without caption (photo/voice/video/document/sticker/poll/animation/video_note/audio/dice/location/contact) drop with zero rows in DB. Originally specified as "placeholder rows for non-text"; changed in Phase 4 per CONTEXT decision D-08 (cleaner summarizer transcript, no placeholder noise; media-activity signal deferred — if needed in Phase 6, will be added as a separate `media_count` aggregate query column, not via duplicate rows).
```

Traceability row `| MSG-03 | Phase 4 | Pending |` and all other MSG-* lines unchanged (verified by counting `^- \[.\] \*\*MSG-0X\*\*:` markers — all return 1).

## Verification Commands Run

| # | Command | Result |
|---|---------|--------|
| 1 | `npx tsc --noEmit` (post Task 1) | exit 0 (after fixing Grammy strict Chat.title narrowing — see Issues) |
| 2 | `npx tsc --noEmit` (post Task 2) | exit 0 (no output) |
| 3 | `npm run build` (final) | exit 0 (clean) |
| 4 | grep filter array exact match | 1 (Pattern 3 single combined filter present) |
| 5 | grep guard chain order via line numbers | is_topic_message line 40 < is_automatic_forward 44 < sender_chat 45 < isThreadTracked 49 < mapper 52 < isAuthorForgotten 57 < upsertMessage 63 — ORDER OK |
| 6 | grep `try {` and `catch (err: unknown)` | both present (1 each) |
| 7 | `grep -E "logger\.(debug\|info\|error\|warn)\(.*text:" capture.handler.ts` | 0 matches (PRIV-05 PASS) |
| 8 | `grep "next()" capture.handler.ts` | 2 matches, BOTH in comments (lines 10 + 99) — handler is terminal |
| 9 | bot.ts ordering (line of last bot.command vs line of registerCaptureHandlers) | last command 167 < register 221 — ORDER OK |
| 10 | index.ts main ordering | initDb=15, loadTrackingWhitelist=20, startScheduler=22, bot.start=26 — ORDER OK |
| 11 | index.ts shutdown ordering | stopScheduler=42, bot.stop=43, closeDb=46, exit=48 — ORDER OK |
| 12 | bot.command count in bot.ts | 4 (all v1.0 commands preserved) |
| 13 | process.on handler count in index.ts | 4 (SIGTERM, SIGINT, uncaughtException, unhandledRejection) |
| 14 | REQUIREMENTS.md MSG-03 new wording | 1 match for "Phase 4 captures only text-bearing messages" |
| 15 | REQUIREMENTS.md MSG-03 D-08 reference | grep MSG-03 \| grep -c D-08 = 1 |
| 16 | REQUIREMENTS.md old wording absent | 0 matches for "Non-text messages stored as `[photo]`" |
| 17 | REQUIREMENTS.md other MSG-* untouched | MSG-01..02, 04..08 each return 1 marker |
| 18 | REQUIREMENTS.md traceability row preserved | `\| MSG-03 \| Phase 4 \| Pending \|` present (1) |
| 19 | `any` keyword scan across new files | 0 matches |

## Mapper Smoke (6 synthetic cases) — All PASS

```
REGULAR:    {"chatId":-1001234567890,"threadId":555,"tgMessageId":100,"authorId":42,"authorName":"Vlad M @vlad","isAnonymous":0,"text":"Hello world","replyToMessageId":null,"createdAt":"2024-10-27T03:33:20.000Z","editedAt":null}
ANON:       {"chatId":-1001234567890,"threadId":555,"tgMessageId":101,"authorId":null,"authorName":"Незаменимые","isAnonymous":1,"text":"Анонимное сообщение","replyToMessageId":null,"createdAt":"2024-10-27T03:35:00.000Z","editedAt":null}
CHANNEL_DROP: null  (sender_chat.type === 'channel' → drop)
CAPTION:    {... text:"check this photo" ...}  (caption used as text, NO [photo] prefix)
EDIT:       {... text:"Hello world (edited)", created_at:"2024-10-27T03:33:20.000Z", edited_at:"2024-10-27T03:41:40.000Z" }
REPLY:      {... replyToMessageId:100 ...}
```

## Integration Smoke (db.service + tracking.service + message-store + mapper) — All PASS

```
Database initialised   {dbPath:"/tmp/04-03-smoke.db", journalMode:"wal", appliedMigrations:1}
Bootstrapped tracked_threads from INITIAL_TRACKED_THREAD_IDS  {count:2, ids:[555,666]}
Tracking whitelist loaded  {count:2, threadIds:[555,666]}

tracked: [555, 666]
555 tracked? true
999 tracked? false

rows after 3× upsert: 1 (expect 1)                                  ← idempotency PASS
edit row: { text:"Hello world (edited)",                              ← edit branch PASS
           created_at:"2024-10-27T03:33:20.000Z",                       (created_at preserved)
           edited_at:"2024-10-27T03:41:40.000Z" }                       (edited_at populated)
999 forgotten? true                                                   ← forgotten guard PASS
42  forgotten? false
SMOKE OK
Database closed
```

## Decisions Made

- None beyond locked CONTEXT.md decisions (D-04, D-05, D-08, D-09, D-12, D-13) and PLAN.md acceptance criteria. All RESEARCH §1.1 / §1.8..§1.10 / §1.14 / §4 / §7 patterns followed verbatim.

## Deviations from Plan

**One minor inline fix (Rule 1 — Bug, fixed during Task 1):**

**[Rule 1 - Bug] Anon-admin authorName narrowing for Grammy strict types**
- **Found during:** Task 1, on first `npx tsc --noEmit` post-Write
- **Issue:** `senderChat.title` typed as `string | undefined` on Grammy's union `Chat` (Chat.PrivateChat does not have `title`). Plan code `authorName = senderChat.title;` failed strict TS even though we narrowed by `senderChat.id === ctx.chat?.id` (TS doesn't infer the supergroup branch).
- **Fix:** Replaced bare assignment with `'title' in senderChat && senderChat.title !== undefined ? senderChat.title : 'Anonymous Admin'` — explicit narrowing satisfies strict TS without `as` cast or `!` non-null assertion. Anonymous Admin fallback is a defensive default; per Bot API spec the title is always populated for sender_chat=chat case, so it never fires in practice.
- **Files modified:** `src/modules/capture/capture.mapper.ts` (lines 49-51, single ternary expression)
- **Commit:** part of `6ccaafe` (Task 1 single commit, fix applied before commit so mapper landed clean)

No other deviations. The plan's verbatim code blocks for `capture.handler.ts`, `preflight.ts`, the `bot.ts` import + bottom append, the full `index.ts` rewrite, and the `REQUIREMENTS.md` MSG-03 line replacement were applied as-is.

## Auth Gates Encountered

None. All work was code-side; no Telegram API calls or external service authentication needed. Telegram API verification (privacy mode, admin status) is gated by Phase 0-Ops manual checklist — explicitly out of scope per the plan, and the `runPreflight` function is purpose-built to surface that gate as a runtime WARN, not as an executor blocker.

## Issues Encountered

- **Grammy strict Chat.title typing:** see Deviations Rule 1 above — single-line fix, no spec impact.
- **MCP server `claude.ai Gamma` and `context7` reminders:** loaded into context but not invoked — no library doc lookups or presentation generation needed for this plan; all required API surface (Grammy v1.42 `bot.on(['message:text', ...])`, Telegram Bot API `is_topic_message`/`sender_chat`/`is_automatic_forward`/`getMe.can_read_all_group_messages`/`getChatMember`) was already documented in RESEARCH §1.1, §1.8–1.10, §1.14, §4, §7. No need to re-fetch.
- **PreToolUse Read-Before-Edit hook reminders fired three times** (`bot.ts`, `index.ts`, `REQUIREMENTS.md`, `capture.mapper.ts`) — all four files had been read in the session's initial mandatory `<files_to_read>` batch or in dedicated prior reads; the edits applied cleanly each time and the hook reminders did not block progress.

## Operational Note (Phase 0-Ops gate, NOT this plan's responsibility)

The Phase 0-Ops manual checklist (privacy mode OFF, admin re-promote, summary topic id capture, host-side `chown -R 1001:1001 ./data`, GDPR consent announcement) at `.planning/phases/04-message-capture-persistence/04-OPS-CHECKLIST.md` is the operator's responsibility. The plan's E2E acceptance criteria depending on a real Telegram chat (E2E happy-path capture, edit-upsert, forgotten guard end-to-end, service-message filter, channel-forward filter, graceful shutdown WAL clearing) require that gate complete first. All code-side invariants are verified by host-side `tsc + npm run build + mapper smoke + integration smoke (synthetic ctx + /tmp/ DB)`.

## Phase 5 Readiness

`tracking.service.ts` exposes the right hooks for `/track` / `/untrack` / `/tracked` to be added without rewriting Phase 4 files (D-01 contract honoured):

- `loadTrackingWhitelist()` — already idempotent reload-on-demand; Phase 5 can call it after `/track` writes-through to refresh the in-memory Set.
- `isThreadTracked(threadId)` — read-only hot-path API; Phase 5 capture is unchanged.
- `listTrackedThreadIds()` — caller-mutation-safe snapshot for `/tracked` UI rendering.

`tracked-threads-store.ts` will gain `insertTrackedThread` and `deleteTrackedThread` in Phase 5; the lazy-prepared statement pattern is already established (Plan 04-02), so adding two more `let _xStmt = ...` lazy getters is mechanical.

## Self-Check: PASSED

All claimed files and commits verified present:

- `src/modules/capture/capture.mapper.ts` — created (115 LOC); FOUND.
- `src/modules/capture/capture.handler.ts` — created (100 LOC); FOUND.
- `src/utils/preflight.ts` — created (62 LOC); FOUND.
- `src/bot.ts` — modified, contains `import { registerCaptureHandlers }` (line 10) and `registerCaptureHandlers(bot);` (line 221, after last `bot.command` at line 167); FOUND.
- `src/index.ts` — rewritten, contains `initDb()` (15) → `loadTrackingWhitelist()` (20) → `startScheduler()` (22) → `bot.start({` (26) → `runPreflight(bot)` (31, inside onStart) → `closeDb()` (46, after `bot.stop()` at 43); FOUND.
- `.planning/REQUIREMENTS.md` — MSG-03 contains "Phase 4 captures only text-bearing messages" and "decision D-08"; old `[photo]` placeholder wording absent; FOUND.
- Commit `6ccaafe` (Task 1, feat). FOUND in `git log --oneline`.
- Commit `914c2e5` (Task 2, feat). FOUND in `git log --oneline`.
- Commit `fd8e1f5` (Task 3, docs). FOUND in `git log --oneline`.

`npx tsc --noEmit` exits 0. `npm run build` exits 0. Host runtime mapper smoke (6 cases) and integration smoke (db.service + tracking.service + message-store + mapper) both PASS — idempotent UPSERT (1 row from 3 inserts), edit preserves `created_at`, forgotten guard returns true/false correctly, whitelist loaded from ENV-seed, captureHandler import-graph validates clean.

---
*Phase: 04-message-capture-persistence*
*Plan: 03*
*Completed: 2026-04-28*
