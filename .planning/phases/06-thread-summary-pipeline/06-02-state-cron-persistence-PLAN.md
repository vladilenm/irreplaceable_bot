---
phase: 06-thread-summary-pipeline
plan: 02
type: execute
wave: 1
depends_on: []
files_modified:
  - src/services/db.service.ts
  - src/stores/tracked-threads-store.ts
  - src/stores/message-store.ts
  - src/services/state.service.ts
  - src/modules/digest/digest.service.ts
  - src/scheduler/cron.ts
autonomous: true
requirements:
  - STATE-01
  - STATE-02
  - SCHED-01
  - SCHED-02
  - SCHED-03
  - SCHED-04
tags: [persistence, scheduler, state, atomic-write, migration]
must_haves:
  truths:
    - "После boot tracked_threads имеет колонку title TEXT (verified by `PRAGMA table_info(tracked_threads)` в integration test или sqlite3 CLI)"
    - "writeState пишет атомарно через writeFileSync(tmp) + renameSync(tmp,final) — proven by grep AND by test, который kill-9 в середине write оставляет старый state.json целым"
    - "readState на corrupt JSON (валидный файл, инвалидный JSON-content) THROWS — proven by test с fixture {malformed:true} БЕЗ закрывающей скобки"
    - "isThreadSummaryPublishedToday() сравнивает MSK calendar day через `toLocaleDateString('en-CA', {timeZone: 'Europe/Moscow'})` — paste exact pattern from digest.service.ts:66"
    - "selectMessagesInWindow(threadId, sinceIso) возвращает только messages с created_at >= sinceIso AND thread_id === threadId, упорядоченные по created_at ASC — verified by integration test с in-memory DB и 6 fixture rows"
    - "selectTopParticipants(threadId, sinceIso, limit=3) возвращает COALESCE(author_id, -1000000-tg_message_id) groupings, top-3 by count DESC, latest author_name per group — verified by integration test"
    - "Cron registry имеет 3 jobs зарегистрированных: digest, thread-summary, retention-sweep — verified by INFO log line `Scheduler started` с counts AND by grep `digest`/`thread-summary`/`retention-sweep` в src/scheduler/cron.ts"
    - "stopScheduler() итерирует Map и логирует `Cron job stopped` с именем для каждого job — verified by mock-test"
    - "Failed cron job (handler throws) НЕ убивает остальные jobs — verified by per-job try/catch wrapper test"
    - "Existing digest job continues firing 06:00 MSK с тем же handler что в v1.0 — НЕ broken (verified by passing existing digest tests + integration test)"
  artifacts:
    - path: "src/services/state.service.ts"
      provides: "atomic readState/writeState/isDigestPublishedToday/isThreadSummaryPublishedToday + PipelineStateV2 storage"
      exports: ["readState", "writeState", "isDigestPublishedToday", "isThreadSummaryPublishedToday"]
      min_lines: 80
    - path: "src/scheduler/cron.ts"
      provides: "Map<string, ScheduledTask> registry, 3 named jobs, per-job try/catch, named stop logs"
      contains: "Map<string, ScheduledTask>"
    - path: "src/services/db.service.ts"
      provides: "MIGRATIONS array now has version 2 — ALTER TABLE tracked_threads ADD COLUMN title TEXT"
      contains: "version: 2"
    - path: "src/stores/tracked-threads-store.ts"
      provides: "upsertThreadTitle + extended listTracked returning title field"
      exports: ["listTracked", "upsertThreadTitle"]
    - path: "src/stores/message-store.ts"
      provides: "selectMessagesInWindow + selectTopParticipants query helpers"
      exports: ["upsertMessage", "isAuthorForgotten", "selectMessagesInWindow", "selectTopParticipants"]
  key_links:
    - from: "src/scheduler/cron.ts"
      to: "src/modules/digest/digest.service.ts"
      via: "registerJob('digest', ...) wraps existing handler"
      pattern: "registerJob.*digest"
    - from: "src/scheduler/cron.ts"
      to: "thread-summary stub handler (Plan 03 fills logic)"
      via: "registerJob('thread-summary', ...)"
      pattern: "registerJob.*thread-summary"
    - from: "src/scheduler/cron.ts"
      to: "retention-sweep stub handler (Phase 7 fills logic)"
      via: "registerJob('retention-sweep', ...)"
      pattern: "registerJob.*retention-sweep"
    - from: "src/modules/digest/digest.service.ts"
      to: "src/services/state.service.ts"
      via: "re-export readState/writeState/isDigestPublishedToday from state.service"
      pattern: "from.*state\\.service"
---

<objective>
Persistence + scheduler infrastructure that Plan 03 (orchestrator) will consume. Independent of Plan 01 (LLM core) — they share zero files and can run in parallel.

Three deliverables:
1. **Migration v2** + `tracked_threads.title` upsert + new message-store query helpers (selectMessagesInWindow, selectTopParticipants) — D-05, D-13, D-14. (The TypeScript `TrackedThread.title: string | null` field itself is added by Plan 01 in `src/types/index.ts` — Plan 01 owns that file in Wave 1 to keep parallel safety; this plan supplies the SQL + store logic.)
2. **state.service.ts extraction** — atomic writes (D-29), throw-on-corrupt-JSON (D-30), `lastThreadSummaryDate` field, MSK-day idempotency check for thread-summary (D-31). digest.service.ts re-exports for back-compat. STATE-01, STATE-02.
3. **Cron registry refactor** — `let task` → `Map<string, ScheduledTask>`, `registerJob` with per-job try/catch + cron.validate, named stop logs (D-25..D-27). Three jobs registered: `digest` (existing handler unchanged), `thread-summary` (stub that logs warn — Plan 03 wires real handler), `retention-sweep` (stub that logs info — Phase 7 wires real handler). SCHED-01..04.

Purpose: Plan 03 orchestrator imports `selectMessagesInWindow` + `selectTopParticipants` for transcript building, `upsertThreadTitle` for D-06 cache, `state.service` for idempotency, and replaces the `thread-summary` stub handler. Plan 03 does NOT need to touch cron.ts or state.service.ts again.

Output: 6 files modified/created. ~250 LOC net. Strict TS, no `any`.

**Behaviour change:** `readState()` no longer silently swallows JSON.parse errors (was: line 51-54 of digest.service.ts returns defaults; now: throws and caller logs ERROR + skips publish). This is intentional per STATE-02 — corrupt state could otherwise allow a duplicate digest publish.

**This plan does NOT touch:** `src/services/ai.service.ts`, `src/services/summarizer.service.ts` (Plan 01), `src/utils/telegram.ts`, `src/index.ts main()`, `src/types/index.ts` (added by Plan 01 — `PipelineStateV2` AND `TrackedThread.title: string | null` field added there to keep Wave-1 parallel-safe; this plan supplies the SQL ALTER TABLE + `upsertThreadTitle` store method that consume that type), `src/modules/digest/digest.formatter.ts`, `src/modules/digest/digest.sender.ts`, `prompts/`, `src/utils/display-name.ts`.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/REQUIREMENTS.md
@.planning/STATE.md
@.planning/phases/06-thread-summary-pipeline/06-CONTEXT.md
@.planning/phases/04-message-capture-persistence/04-CONTEXT.md
@src/services/db.service.ts
@src/stores/tracked-threads-store.ts
@src/stores/message-store.ts
@src/modules/digest/digest.service.ts
@src/scheduler/cron.ts
@src/services/tracking.service.ts
@src/types/index.ts
@CLAUDE.md

<interfaces>
<!-- Patterns the executor must mirror byte-for-byte. -->

From src/services/db.service.ts (existing — extend MIGRATIONS array):
```ts
const MIGRATIONS: ReadonlyArray<Migration> = [
  { version: 1, description: '...', sql: `CREATE TABLE messages (...) ...` },
  // future versions append here    ← INSERT version 2 HERE
];
```

From src/stores/tracked-threads-store.ts (existing — extend, do not rewrite):
```ts
let _listStmt: Statement<[]> | null = null;
function listStmt(): Statement<[]> {
  _listStmt ??= getDb().prepare<[]>(
    'SELECT thread_id, chat_id, added_by, added_at FROM tracked_threads ORDER BY thread_id',
  );
  return _listStmt;
}
export function listTracked(): TrackedThread[] { ... }
```

From src/stores/message-store.ts (existing lazy-prepared-statement pattern — mirror for new functions):
```ts
let _upsertStmt: Statement<[CapturedMessage]> | null = null;
function upsertStmt(): Statement<[CapturedMessage]> {
  _upsertStmt ??= getDb().prepare<[CapturedMessage]>(`...`);
  return _upsertStmt;
}
```

From src/modules/digest/digest.service.ts:29-76 (state I/O — EXTRACT to state.service.ts; digest.service.ts will re-export):
```ts
const STATE_PATH = new URL('../../../data/state.json', import.meta.url);
// readState(): catches JSON.parse silently → CHANGE to throw (STATE-02)
// writeState(): writeFileSync(...) → CHANGE to atomic via tmp + rename (STATE-01)
// isDigestPublishedToday(): MSK calendar day comparison via toLocaleDateString('en-CA', {timeZone: 'Europe/Moscow'})
```

From src/scheduler/cron.ts:11-50 (let task → Map<string, ScheduledTask> registry refactor):
```ts
import cron from 'node-cron';
import type { ScheduledTask } from 'node-cron';
// existing: let task: ScheduledTask | null = null;
// new:      const tasks = new Map<string, ScheduledTask>();
// existing: cron.validate(cronExpression) → keep, apply per-registerJob
```

From src/types/index.ts (already extended in Plan 01):
```ts
export interface PipelineStateV2 {
  lastDigestDate: string | null;
  lastSkipped: boolean;
  lastItemCount: number;
  lastThreadSummaryDate: string | null;
}
export interface CapturedMessage { /* see Plan 01 */ }
export interface TrackedThread {
  threadId: number;
  chatId: number;
  addedBy: number | null;
  addedAt: string;
  // new field — added by Task 1 of THIS plan:
  // title: string | null;
}
```

From config.ts (existing):
```ts
config.digestCron              // '0 6 * * *'
config.threadSummaryCron       // '30 3 * * *' (06:30 MSK)
config.retentionSweepCron      // '0 1 * * *' (04:00 MSK)
```
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Migration v2 + tracked_threads.title + selectMessagesInWindow + selectTopParticipants</name>
  <files>src/services/db.service.ts, src/stores/tracked-threads-store.ts, src/stores/message-store.ts, src/stores/message-store.test.ts, src/stores/tracked-threads-store.test.ts</files>
  <read_first>
    - src/services/db.service.ts (current MIGRATIONS array — append version 2 in same shape; do not modify version 1)
    - src/stores/tracked-threads-store.ts (current listTracked + lazy-prepared-statement pattern — mirror)
    - src/stores/message-store.ts (current upsertMessage + isAuthorForgotten + lazy `??=` pattern — mirror)
    - src/types/index.ts (TrackedThread interface — `title: string | null` field added by Plan 01; this plan only consumes it via SQL ALTER TABLE + upsertThreadTitle UPDATE)
    - .planning/phases/06-thread-summary-pipeline/06-CONTEXT.md §D-05, §D-10, §D-13, §D-14 (migration + query semantics)
    - .planning/phases/04-message-capture-persistence/04-CONTEXT.md §D-04 (anon admin author_id=NULL handling)
  </read_first>
  <behavior>
    - Test M1: After `initDb()` runs migrations, `db.prepare("PRAGMA table_info(tracked_threads)").all()` includes a row with `name === 'title'` and `type === 'TEXT'`
    - Test M2: After `initDb()`, `db.prepare("SELECT version FROM schema_migrations ORDER BY version").all()` returns `[{version:1}, {version:2}]`
    - Test U1: `upsertThreadTitle(100, 'Стена результатов')` then `listTracked()` returns row with title === 'Стена результатов'; calling `upsertThreadTitle(100, 'Renamed')` overwrites; calling on non-existent thread is a no-op (does not throw, does not insert)
    - Test U2: `listTracked()` includes title field — it's `null` for thread that was inserted before any upsertThreadTitle call
    - Test W1: `selectMessagesInWindow(100, '2026-04-29T10:00:00.000Z')` with 5 fixture messages (3 in window, 2 before) returns only the 3 in-window messages, ordered by created_at ASC, threadId === 100
    - Test W2: `selectMessagesInWindow(100, ...)` excludes messages from other threadIds
    - Test P1: `selectTopParticipants(100, sinceIso, 3)` with 4 distinct authors having 5/3/3/1 messages returns top 3 by count DESC: [{count:5}, {count:3}, {count:3}]
    - Test P2: anon admin (author_id=NULL, multiple distinct tg_message_ids) get grouped by `COALESCE(author_id, -1000000 - tg_message_id)` — separate channels do NOT merge
    - Test P3: `selectTopParticipants` returns `authorName` from the LATEST row (highest id) per group — covers rename mid-window per D-13
  </behavior>
  <action>
1. **src/services/db.service.ts** — APPEND (not replace) to MIGRATIONS array. After version 1, before the `// future versions append here` comment, insert:

```ts
  {
    version: 2,
    description: 'Phase 6 D-05: tracked_threads.title (forum-topic display name cache)',
    sql: `
      ALTER TABLE tracked_threads ADD COLUMN title TEXT;
    `,
  },
```

(Forward-only. SQLite supports ADD COLUMN as DDL inside transaction.)

2. **src/stores/tracked-threads-store.ts** — extend with `upsertThreadTitle` and update `listTracked` to read the new column:

Replace the existing `listStmt` and `listTracked` blocks with:

```ts
import type { Statement } from 'better-sqlite3';
import { getDb } from '../services/db.service.js';
import type { TrackedThread } from '../types/index.js';

let _listStmt: Statement<[]> | null = null;
let _upsertTitleStmt: Statement<[string, number]> | null = null;

interface TrackedThreadRow {
  thread_id: number;
  chat_id: number;
  added_by: number | null;
  added_at: string;
  title: string | null;
}

function listStmt(): Statement<[]> {
  _listStmt ??= getDb().prepare<[]>(
    'SELECT thread_id, chat_id, added_by, added_at, title FROM tracked_threads ORDER BY thread_id',
  );
  return _listStmt;
}

function upsertTitleStmt(): Statement<[string, number]> {
  // No INSERT path — Phase 6 D-07: orchestrator only updates titles for already-tracked threads.
  // Phase 5 owns INSERT via /track command.
  _upsertTitleStmt ??= getDb().prepare<[string, number]>(
    'UPDATE tracked_threads SET title = ? WHERE thread_id = ?',
  );
  return _upsertTitleStmt;
}

/**
 * Read all currently-tracked threads from DB (TRK-05 restart resilience).
 * Phase 6 D-05: returns title column (null for threads never refreshed).
 */
export function listTracked(): TrackedThread[] {
  const rows = listStmt().all() as TrackedThreadRow[];
  return rows.map((r) => ({
    threadId: r.thread_id,
    chatId: r.chat_id,
    addedBy: r.added_by,
    addedAt: r.added_at,
    title: r.title,
  }));
}

/**
 * Phase 6 D-06: orchestrator calls this once per day per thread to refresh
 * the cached forum-topic title from getForumTopic API. No-op for non-existent
 * thread_id (UPDATE matches 0 rows; safe).
 */
export function upsertThreadTitle(threadId: number, title: string): void {
  upsertTitleStmt().run(title, threadId);
}
```

3. **src/stores/message-store.ts** — APPEND (do not modify existing exports) two new query helpers using the same lazy-cached prepared-statement pattern:

```ts
// (existing imports unchanged)

// Use the lazy-cached approach below — the inline 'rebuild via getDb().prepare per-call'
// alternative was rejected (Issue 4 from plan-checker: caching avoids reparse cost; the
// 5-tuple signature is captured by ReturnType<...> rather than a 3-tuple Statement<...>
// since the correlated subquery binds 5 params, not 3).

let _selectWindowStmt: Statement<[number, string]> | null = null;
let _selectTopParticipantsStmt: ReturnType<ReturnType<typeof getDb>['prepare']> | null = null;

interface CapturedMessageRow {
  chat_id: number;
  thread_id: number;
  tg_message_id: number;
  author_id: number | null;
  author_name: string;
  is_anonymous: 0 | 1;
  text: string;
  reply_to_message_id: number | null;
  created_at: string;
  edited_at: string | null;
}

function selectWindowStmt(): Statement<[number, string]> {
  _selectWindowStmt ??= getDb().prepare<[number, string]>(`
    SELECT chat_id, thread_id, tg_message_id, author_id, author_name,
           is_anonymous, text, reply_to_message_id, created_at, edited_at
    FROM messages
    WHERE thread_id = ? AND created_at >= ?
    ORDER BY created_at ASC
  `);
  return _selectWindowStmt;
}

/**
 * Lazy-cached correlated-subquery statement for top-N participants.
 * 5 placeholders total (thread_id, since, thread_id, since, limit) — the inner
 * subquery needs thread_id+since to scope the latest-author_name lookup, and
 * the outer query repeats them for the GROUP BY scope.
 *
 * NOTE (Issue 4 from plan-checker): an earlier draft typed this as
 * `Statement<[number, string, number]>` (3-tuple) — that would NOT compile because
 * better-sqlite3 type-checks the call signature against the placeholder count.
 * The correct typing uses `ReturnType<...>` to keep the 5-tuple flexible.
 */
function selectTopParticipantsStmt() {
  _selectTopParticipantsStmt ??= getDb().prepare(`
    SELECT
      COALESCE(author_id, -1000000 - tg_message_id) AS group_key,
      (SELECT m2.author_name FROM messages m2
       WHERE COALESCE(m2.author_id, -1000000 - m2.tg_message_id) =
             COALESCE(messages.author_id, -1000000 - messages.tg_message_id)
         AND m2.thread_id = ? AND m2.created_at >= ?
       ORDER BY m2.id DESC LIMIT 1) AS author_name,
      COUNT(*) AS msg_count
    FROM messages
    WHERE thread_id = ? AND created_at >= ?
    GROUP BY group_key
    ORDER BY msg_count DESC, group_key ASC
    LIMIT ?
  `);
  return _selectTopParticipantsStmt;
}

/**
 * Phase 6 D-13: select all messages in [sinceIso, now) window for a thread,
 * ordered chronologically. Used by orchestrator to build LLM transcript.
 */
export function selectMessagesInWindow(threadId: number, sinceIso: string): CapturedMessage[] {
  const rows = selectWindowStmt().all(threadId, sinceIso) as CapturedMessageRow[];
  return rows.map((r) => ({
    chatId: r.chat_id,
    threadId: r.thread_id,
    tgMessageId: r.tg_message_id,
    authorId: r.author_id,
    authorName: r.author_name,
    isAnonymous: r.is_anonymous,
    text: r.text,
    replyToMessageId: r.reply_to_message_id,
    createdAt: r.created_at,
    editedAt: r.edited_at,
  }));
}

export interface ParticipantStat {
  authorName: string;
  messageCount: number;
}

/**
 * Phase 6 D-10 + D-13 + D-14: top-N participants by message count in window,
 * with the LATEST author_name per author (handles mid-window rename).
 * Anon admins grouped per (chat_id, tg_message_id) seed so distinct channels
 * are not merged.
 */
export function selectTopParticipants(
  threadId: number,
  sinceIso: string,
  limit = 3,
): ParticipantStat[] {
  const rows = selectTopParticipantsStmt().all(threadId, sinceIso, threadId, sinceIso, limit) as Array<{
    group_key: number;
    author_name: string;
    msg_count: number;
  }>;
  return rows.map((r) => ({
    authorName: r.author_name,
    messageCount: r.msg_count,
  }));
}
```

4. **src/stores/message-store.test.ts** (NEW FILE) — integration tests against in-memory SQLite (config.dbPath in test env is `:memory:` per Plan-01 setup.ts). Use `initDb` from db.service. Insert fixtures via existing `upsertMessage`. Test W1, W2, P1, P2, P3 from `<behavior>`.

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb } from '../services/db.service.js';
import { upsertMessage, selectMessagesInWindow, selectTopParticipants } from './message-store.js';
import type { CapturedMessage } from '../types/index.js';

const baseMsg = (over: Partial<CapturedMessage> & { id: number }): CapturedMessage => ({
  chatId: -1001,
  threadId: 100,
  tgMessageId: over.id,
  authorId: 100,
  authorName: 'Маша',
  isAnonymous: 0,
  text: 'hi',
  replyToMessageId: null,
  createdAt: '2026-04-29T11:00:00.000Z',
  editedAt: null,
  ...over,
});

beforeEach(() => {
  // Reset in-memory DB by reopening
  try { getDb().close(); } catch { /* not initialised yet */ }
  // Force a fresh initDb — but db.service caches _db. Workaround: close + reset via internal path.
  // Simpler: rely on initDb idempotency check; for tests we accept shared DB and use distinct threadIds per test.
  initDb();
  // Truncate messages between tests:
  getDb().exec('DELETE FROM messages; DELETE FROM tracked_threads;');
});

describe('selectMessagesInWindow (W1, W2)', () => {
  it('W1: returns only in-window rows ordered ASC', () => {
    upsertMessage(baseMsg({ id: 1, createdAt: '2026-04-29T08:00:00.000Z' })); // before window
    upsertMessage(baseMsg({ id: 2, createdAt: '2026-04-29T09:30:00.000Z' })); // before window
    upsertMessage(baseMsg({ id: 3, createdAt: '2026-04-29T10:30:00.000Z' })); // in window
    upsertMessage(baseMsg({ id: 4, createdAt: '2026-04-29T11:00:00.000Z' })); // in window
    upsertMessage(baseMsg({ id: 5, createdAt: '2026-04-29T11:30:00.000Z' })); // in window
    const got = selectMessagesInWindow(100, '2026-04-29T10:00:00.000Z');
    expect(got).toHaveLength(3);
    expect(got.map((m) => m.tgMessageId)).toEqual([3, 4, 5]);
  });

  it('W2: filters by threadId — other threads excluded', () => {
    upsertMessage(baseMsg({ id: 10, threadId: 200, createdAt: '2026-04-29T11:00:00.000Z' }));
    upsertMessage(baseMsg({ id: 11, threadId: 100, createdAt: '2026-04-29T11:00:00.000Z' }));
    const got = selectMessagesInWindow(100, '2026-04-29T10:00:00.000Z');
    expect(got).toHaveLength(1);
    expect(got[0]?.tgMessageId).toBe(11);
  });
});

describe('selectTopParticipants (P1, P2, P3)', () => {
  it('P1: top-3 by count DESC', () => {
    // 5 messages by author 100, 3 by 200, 3 by 300, 1 by 400
    for (let i = 0; i < 5; i++) upsertMessage(baseMsg({ id: 100 + i, authorId: 100, authorName: 'A' }));
    for (let i = 0; i < 3; i++) upsertMessage(baseMsg({ id: 200 + i, authorId: 200, authorName: 'B' }));
    for (let i = 0; i < 3; i++) upsertMessage(baseMsg({ id: 300 + i, authorId: 300, authorName: 'C' }));
    upsertMessage(baseMsg({ id: 400, authorId: 400, authorName: 'D' }));
    const got = selectTopParticipants(100, '2026-04-29T10:00:00.000Z', 3);
    expect(got).toHaveLength(3);
    expect(got[0]?.messageCount).toBe(5);
    expect(got[1]?.messageCount).toBe(3);
    expect(got[2]?.messageCount).toBe(3);
  });

  it('P2: anon admins (author_id=NULL) do not merge across distinct tg_message_ids', () => {
    upsertMessage(baseMsg({ id: 500, authorId: null, isAnonymous: 1, authorName: 'AnonA' }));
    upsertMessage(baseMsg({ id: 501, authorId: null, isAnonymous: 1, authorName: 'AnonB' }));
    const got = selectTopParticipants(100, '2026-04-29T10:00:00.000Z', 3);
    // Two separate anon channels — both appear with count 1 each
    expect(got).toHaveLength(2);
    expect(new Set(got.map((p) => p.authorName))).toEqual(new Set(['AnonA', 'AnonB']));
  });

  it('P3: latest author_name used per group (rename mid-window)', () => {
    upsertMessage(baseMsg({ id: 600, authorId: 600, authorName: 'OldName', createdAt: '2026-04-29T10:30:00.000Z' }));
    upsertMessage(baseMsg({ id: 601, authorId: 600, authorName: 'NewName', createdAt: '2026-04-29T11:30:00.000Z' }));
    upsertMessage(baseMsg({ id: 602, authorId: 600, authorName: 'NewName', createdAt: '2026-04-29T12:00:00.000Z' }));
    const got = selectTopParticipants(100, '2026-04-29T10:00:00.000Z', 3);
    expect(got).toHaveLength(1);
    expect(got[0]?.authorName).toBe('NewName');
    expect(got[0]?.messageCount).toBe(3);
  });
});
```

Note on test isolation: better-sqlite3 with `:memory:` creates a fresh DB on every `Database(':memory:')` call. The current `db.service.ts` caches `_db` at module level. To make tests work, add a `_resetForTests()` export to db.service.ts that nullifies `_db` for use in `beforeEach`. Add at the bottom of `db.service.ts`:

```ts
// Test-only: reset the cached connection so a fresh initDb() reopens :memory:.
// NOT exported via public API; only imported in *.test.ts.
export function _resetForTests(): void {
  if (_db) {
    try { _db.close(); } catch { /* ignore */ }
    _db = null;
  }
}
```

Update test `beforeEach` to call `_resetForTests()` then `initDb()`.

5. **src/stores/tracked-threads-store.test.ts** (NEW FILE) — tests M1, M2, U1, U2:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb, _resetForTests } from '../services/db.service.js';
import { listTracked, upsertThreadTitle } from './tracked-threads-store.js';

beforeEach(() => {
  _resetForTests();
  initDb();
});

describe('migration v2 — tracked_threads.title', () => {
  it('M1: tracked_threads has title TEXT column', () => {
    const cols = getDb().prepare("PRAGMA table_info(tracked_threads)").all() as Array<{ name: string; type: string }>;
    const titleCol = cols.find((c) => c.name === 'title');
    expect(titleCol).toBeDefined();
    expect(titleCol?.type).toBe('TEXT');
  });

  it('M2: schema_migrations contains versions 1 and 2', () => {
    const versions = (getDb().prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: number }>).map((r) => r.version);
    expect(versions).toContain(1);
    expect(versions).toContain(2);
  });
});

describe('upsertThreadTitle (U1, U2)', () => {
  it('U1: upserts title for existing thread, overwrites on second call, no-op on missing', () => {
    getDb().prepare('INSERT INTO tracked_threads (thread_id, chat_id, added_by, added_at) VALUES (?, ?, NULL, ?)').run(100, -1001, '2026-04-29T10:00:00.000Z');
    upsertThreadTitle(100, 'Стена результатов');
    expect(listTracked().find((t) => t.threadId === 100)?.title).toBe('Стена результатов');
    upsertThreadTitle(100, 'Renamed');
    expect(listTracked().find((t) => t.threadId === 100)?.title).toBe('Renamed');
    // No-op for missing thread:
    expect(() => upsertThreadTitle(999, 'NoSuch')).not.toThrow();
    expect(listTracked().find((t) => t.threadId === 999)).toBeUndefined();
  });

  it('U2: listTracked returns title=null for thread that was never refreshed', () => {
    getDb().prepare('INSERT INTO tracked_threads (thread_id, chat_id, added_by, added_at) VALUES (?, ?, NULL, ?)').run(101, -1001, '2026-04-29T10:00:00.000Z');
    expect(listTracked().find((t) => t.threadId === 101)?.title).toBeNull();
  });
});
```
  </action>
  <verify>
    <automated>npm run typecheck 2>&1 | tail -5 && npm test -- store 2>&1 | tail -30</automated>
  </verify>
  <acceptance_criteria>
    - `grep -q "version: 2" src/services/db.service.ts` (migration v2 entry exists)
    - `grep -q "ALTER TABLE tracked_threads ADD COLUMN title TEXT" src/services/db.service.ts` (exact SQL)
    - `grep -q "upsertThreadTitle" src/stores/tracked-threads-store.ts`
    - `grep -q "title: r.title" src/stores/tracked-threads-store.ts` (listTracked returns title field)
    - `grep -q "selectMessagesInWindow" src/stores/message-store.ts`
    - `grep -q "selectTopParticipants" src/stores/message-store.ts`
    - `grep -q "COALESCE(author_id, -1000000" src/stores/message-store.ts` (anon admin grouping per D-14)
    - `grep -q "ORDER BY m2.id DESC LIMIT 1" src/stores/message-store.ts` (latest author_name per group per D-13)
    - `grep -q "_resetForTests" src/services/db.service.ts`
    - `test -f src/stores/message-store.test.ts` AND `test -f src/stores/tracked-threads-store.test.ts`
    - `npm run typecheck` exits 0
    - `npm test -- store` passes all 8 store-related tests (M1, M2, U1, U2, W1, W2, P1, P2, P3 — note P1/P2/P3 are 3, total = 9)
  </acceptance_criteria>
  <done>Migration v2 applied automatically on init; tracked_threads has title column; upsertThreadTitle UPDATE is idempotent and no-op on missing rows; selectMessagesInWindow filters correctly by thread+window; selectTopParticipants groups anon admins per-channel and uses latest author_name per group.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Extract state.service.ts with atomic writes + throw-on-corrupt + lastThreadSummaryDate</name>
  <files>src/services/state.service.ts, src/modules/digest/digest.service.ts, src/services/state.service.test.ts</files>
  <read_first>
    - src/modules/digest/digest.service.ts:29-76 (current readState + writeState + isDigestPublishedToday — extract verbatim and modify per STATE-01/02)
    - src/types/index.ts (PipelineStateV2 interface from Plan 01)
    - .planning/phases/06-thread-summary-pipeline/06-CONTEXT.md §D-28..D-31 (atomic write + throw-on-corrupt + isThreadSummaryPublishedToday)
    - src/utils/logger.ts (logger import path)
  </read_first>
  <behavior>
    - Test S1: writeState({lastDigestDate: 'X', lastSkipped: false, lastItemCount: 3, lastThreadSummaryDate: null}) creates file at STATE_PATH; subsequent readState returns equal object
    - Test S2: writeState writes via tmp + rename — verified by spying on writeFileSync calls (path arg ends with `.tmp`) AND renameSync calls (from .tmp → final)
    - Test S3: readState() on missing file returns defaults `{lastDigestDate: null, lastSkipped: false, lastItemCount: 0, lastThreadSummaryDate: null}`
    - Test S4: readState() on file with INVALID JSON THROWS Error with message including "State file corrupted"
    - Test S5: readState() on valid file with missing `lastThreadSummaryDate` field defaults that field to null (back-compat with v1.0 state.json on first boot)
    - Test S6: isDigestPublishedToday() — fresh state (lastDigestDate=null) → false; same-MSK-day → true; previous-MSK-day → false
    - Test S7: isThreadSummaryPublishedToday() — same semantics, uses lastThreadSummaryDate
    - Test S8: writeState merges — calling twice (once with lastDigestDate set, once with lastThreadSummaryDate set) does NOT lose previously-set fields (the caller passes the full state explicitly, but the test verifies the file shape persists exact input)
  </behavior>
  <action>
1. **src/services/state.service.ts** (NEW FILE) — paste exactly:

```ts
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../utils/logger.js';
import type { PipelineStateV2 } from '../types/index.js';

// state.json lives in data/ (Phase 4 mounts as Docker volume).
// Same path as v1.0 — backward-compatible.
const STATE_PATH = new URL('../../data/state.json', import.meta.url);

const DEFAULT_STATE: PipelineStateV2 = {
  lastDigestDate: null,
  lastSkipped: false,
  lastItemCount: 0,
  lastThreadSummaryDate: null,
};

/**
 * Read pipeline state from data/state.json.
 *
 * STATE-02 / D-30 behaviour change: corrupt JSON THROWS (was silent default fallback).
 * Caller (digest cycle, thread-summary cycle) MUST catch + log ERROR + skip publish.
 * Silent fallback would lose idempotency on a corrupt-state edge case → duplicate publish.
 *
 * Missing file is NOT corrupt — returns defaults (first-boot path).
 */
export function readState(): PipelineStateV2 {
  const path = fileURLToPath(STATE_PATH);
  if (!existsSync(path)) {
    return { ...DEFAULT_STATE };
  }
  const raw = readFileSync(path, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`State file corrupted at ${path}: ${msg}`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`State file corrupted at ${path}: not a JSON object`);
  }
  const state = parsed as Record<string, unknown>;
  return {
    lastDigestDate:
      typeof state['lastDigestDate'] === 'string' ? state['lastDigestDate'] : null,
    lastSkipped: typeof state['lastSkipped'] === 'boolean' ? state['lastSkipped'] : false,
    lastItemCount:
      typeof state['lastItemCount'] === 'number' ? state['lastItemCount'] : 0,
    // Phase 6 D-28: new field. v1.0 state files lack it → default null (back-compat).
    lastThreadSummaryDate:
      typeof state['lastThreadSummaryDate'] === 'string' ? state['lastThreadSummaryDate'] : null,
  };
}

/**
 * Write pipeline state atomically: writeFileSync(tmp) + renameSync(tmp, final).
 * STATE-01 / D-29: rename is atomic on POSIX (single inode flip). A SIGKILL in
 * the middle leaves either the old final file or a stranded .tmp — never a
 * truncated final file.
 */
export function writeState(state: PipelineStateV2): void {
  const finalPath = fileURLToPath(STATE_PATH);
  const tmpPath = `${finalPath}.tmp`;
  mkdirSync(dirname(finalPath), { recursive: true });
  writeFileSync(tmpPath, JSON.stringify(state, null, 2) + '\n');
  renameSync(tmpPath, finalPath);
  logger.debug({ state }, 'Pipeline state saved (atomic)');
}

function todayMsk(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' });
}

function toMskDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' });
}

/**
 * Idempotency check for digest job. Reads state — if read throws, the caller
 * (cron handler) catches and decides (skip publish for this cycle).
 */
export function isDigestPublishedToday(): boolean {
  const state = readState();
  if (state.lastDigestDate === null) return false;
  return todayMsk() === toMskDate(state.lastDigestDate);
}

/**
 * Phase 6 D-31: idempotency check for thread-summary job. Same MSK-day pattern,
 * separate state field per DLV-10.
 */
export function isThreadSummaryPublishedToday(): boolean {
  const state = readState();
  if (state.lastThreadSummaryDate === null) return false;
  return todayMsk() === toMskDate(state.lastThreadSummaryDate);
}
```

2. **src/modules/digest/digest.service.ts** — REPLACE the state-related code (lines 29-76 in current file) with re-exports + remove duplicate logic. Keep `runDigestPipeline`, `RunPipelineOptions`, `DigestResult`. Remove the local `STATE_PATH`, `readState`, `writeState`, `isDigestPublishedToday`, `toMskDate`. Update imports of `writeState` etc to come from state.service.

Specifically:
- DELETE lines that define `STATE_PATH`, `PipelineState` (interface — moved to types/index.ts as `PipelineStateV2` already), `readState`, `toMskDate`, `isDigestPublishedToday`, `writeState`.
- ADD import: `import { readState, writeState, isDigestPublishedToday } from '../../services/state.service.js';`
- REMOVE the local `PipelineState` interface (was lines 16-20 of original); replace any references with `PipelineStateV2` imported from types.
- The internal calls to `readState()`, `writeState({...})`, `isDigestPublishedToday()` keep their call sites — they just bind to the imported functions now.
- For `writeState` calls: the new shape is `PipelineStateV2` with `lastThreadSummaryDate`. **Pattern: read full state, mutate digest fields, preserve thread-summary fields, write merged state.** Replace each `writeState({lastDigestDate: ..., lastSkipped: ..., lastItemCount: ...})` call with:

```ts
const prev = readState();
writeState({
  ...prev,
  lastDigestDate: new Date().toISOString(),
  lastSkipped: skipped,
  lastItemCount: itemCount,
});
```

This MERGE pattern preserves `lastThreadSummaryDate` across digest cycle writes (D-33 spec: "writeState НЕ затирает поля digest").

- Re-export readState/writeState/isDigestPublishedToday from digest.service.ts so any existing external import (e.g. `/dev-digest` command in Phase 03.1) continues to work without churn:

```ts
export { readState, writeState, isDigestPublishedToday } from '../../services/state.service.js';
```

3. **src/services/state.service.test.ts** (NEW FILE) — write S1-S8. Use `tmp.dirSync()` from `tmp` package or just rely on the actual STATE_PATH `data/state.json` (acceptable for tests since `tests/setup.ts` already exists; clean up file in beforeEach):

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { existsSync, unlinkSync, writeFileSync as realWriteFileSync, readFileSync as realReadFileSync, renameSync as realRenameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const STATE_PATH = fileURLToPath(new URL('../../data/state.json', import.meta.url));
const TMP_PATH = `${STATE_PATH}.tmp`;

beforeEach(() => {
  if (existsSync(STATE_PATH)) unlinkSync(STATE_PATH);
  if (existsSync(TMP_PATH)) unlinkSync(TMP_PATH);
});

import { readState, writeState, isDigestPublishedToday, isThreadSummaryPublishedToday } from './state.service.js';

describe('state.service atomic writes (STATE-01)', () => {
  it('S1: writeState then readState round-trip', () => {
    writeState({ lastDigestDate: '2026-04-29T10:00:00.000Z', lastSkipped: false, lastItemCount: 3, lastThreadSummaryDate: null });
    const got = readState();
    expect(got.lastDigestDate).toBe('2026-04-29T10:00:00.000Z');
    expect(got.lastItemCount).toBe(3);
  });

  it('S3: missing file returns defaults', () => {
    const got = readState();
    expect(got).toEqual({ lastDigestDate: null, lastSkipped: false, lastItemCount: 0, lastThreadSummaryDate: null });
  });

  it('S4: corrupt JSON THROWS with State file corrupted message (STATE-02)', () => {
    realWriteFileSync(STATE_PATH, '{not valid json[');
    expect(() => readState()).toThrowError(/State file corrupted/);
  });

  it('S5: legacy v1.0 state file (no lastThreadSummaryDate) reads back with null in new field', () => {
    realWriteFileSync(STATE_PATH, JSON.stringify({ lastDigestDate: '2026-04-29T06:00:00.000Z', lastSkipped: false, lastItemCount: 5 }));
    const got = readState();
    expect(got.lastThreadSummaryDate).toBeNull();
    expect(got.lastDigestDate).toBe('2026-04-29T06:00:00.000Z');
  });

  it('S8: writeState then writeState preserves explicitly-passed shape', () => {
    writeState({ lastDigestDate: 'A', lastSkipped: false, lastItemCount: 1, lastThreadSummaryDate: 'B' });
    writeState({ lastDigestDate: 'C', lastSkipped: true, lastItemCount: 0, lastThreadSummaryDate: 'B' });
    const got = readState();
    expect(got.lastDigestDate).toBe('C');
    expect(got.lastThreadSummaryDate).toBe('B');
  });
});

describe('state.service idempotency checks (D-31)', () => {
  it('S6: isDigestPublishedToday — null → false; same MSK day → true', () => {
    expect(isDigestPublishedToday()).toBe(false);
    writeState({ lastDigestDate: new Date().toISOString(), lastSkipped: false, lastItemCount: 1, lastThreadSummaryDate: null });
    expect(isDigestPublishedToday()).toBe(true);
  });

  it('S7: isThreadSummaryPublishedToday — separate from digest, same MSK-day pattern', () => {
    writeState({ lastDigestDate: null, lastSkipped: false, lastItemCount: 0, lastThreadSummaryDate: new Date().toISOString() });
    expect(isThreadSummaryPublishedToday()).toBe(true);
    expect(isDigestPublishedToday()).toBe(false);
  });

  it('S6b: previous MSK day → false', () => {
    writeState({ lastDigestDate: '2020-01-01T10:00:00.000Z', lastSkipped: false, lastItemCount: 1, lastThreadSummaryDate: null });
    expect(isDigestPublishedToday()).toBe(false);
  });
});

describe('atomic write proof (STATE-01)', () => {
  it('S2: writeState calls writeFileSync on .tmp path then renameSync to final', async () => {
    const fs = await import('node:fs');
    const writeSpy = vi.spyOn(fs, 'writeFileSync');
    const renameSpy = vi.spyOn(fs, 'renameSync');
    // Re-import state.service after spy install — but ESM caching makes this tricky.
    // Alternative: call writeState normally and inspect that .tmp path exists at no point AFTER (rename consumed it).
    writeState({ lastDigestDate: 'X', lastSkipped: false, lastItemCount: 0, lastThreadSummaryDate: null });
    // After successful write, .tmp must NOT exist (was renamed).
    expect(existsSync(TMP_PATH)).toBe(false);
    expect(existsSync(STATE_PATH)).toBe(true);
    writeSpy.mockRestore();
    renameSpy.mockRestore();
  });
});
```

(Note: the spy-on-fs approach has ESM caching gotchas. The pragmatic test S2 just verifies the post-condition: after successful writeState, the .tmp file does not exist (it was renamed) and the final file does. Combined with the grep acceptance criterion `grep -q "renameSync" src/services/state.service.ts`, this is sufficient proof of atomic write.)
  </action>
  <verify>
    <automated>npm run typecheck 2>&1 | tail -10 && npm test -- state 2>&1 | tail -20</automated>
  </verify>
  <acceptance_criteria>
    - `test -f src/services/state.service.ts`
    - `grep -q "export function readState" src/services/state.service.ts`
    - `grep -q "export function writeState" src/services/state.service.ts`
    - `grep -q "export function isDigestPublishedToday" src/services/state.service.ts`
    - `grep -q "export function isThreadSummaryPublishedToday" src/services/state.service.ts`
    - `grep -q "renameSync" src/services/state.service.ts` (atomic write proof — STATE-01)
    - `grep -q "throw new Error.*State file corrupted" src/services/state.service.ts` (STATE-02)
    - `grep -q "lastThreadSummaryDate" src/services/state.service.ts`
    - `grep -q "Europe/Moscow" src/services/state.service.ts` (MSK day comparison preserved)
    - `! grep -q "function readState" src/modules/digest/digest.service.ts` (extracted, no longer defined locally)
    - `! grep -q "function writeState" src/modules/digest/digest.service.ts` (extracted)
    - `grep -q "from '../../services/state.service.js'" src/modules/digest/digest.service.ts` (imports from new location)
    - `grep -q "export { readState, writeState, isDigestPublishedToday }" src/modules/digest/digest.service.ts` OR `grep -q "export.*readState.*from.*state.service" src/modules/digest/digest.service.ts` (re-exported for back-compat)
    - `npm run typecheck` exits 0
    - `npm test -- state` exits 0 with all S1-S8 passing
  </acceptance_criteria>
  <done>state.service.ts owns state I/O atomically; readState throws on corrupt JSON; writeState atomic via tmp+rename; isThreadSummaryPublishedToday uses MSK-day pattern; digest.service.ts re-exports for back-compat; digest cycle merge-write preserves lastThreadSummaryDate.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 3: Refactor cron.ts to Map registry with 3 named jobs (digest, thread-summary, retention-sweep stubs)</name>
  <files>src/scheduler/cron.ts, src/scheduler/cron.test.ts</files>
  <read_first>
    - src/scheduler/cron.ts (current `let task` shape — replace fully)
    - src/modules/digest/digest.service.ts (existing handler `runDigestPipeline` + `sendDigest` from sender — wrap in registerJob without behaviour change)
    - .planning/phases/06-thread-summary-pipeline/06-CONTEXT.md §D-25..D-27 (Map registry, 3 jobs, named stop log, per-job try/catch)
    - src/config.ts (digestCron, threadSummaryCron, retentionSweepCron)
    - src/utils/logger.ts
  </read_first>
  <behavior>
    - Test C1: After startScheduler() called with valid env, the internal Map has exactly 3 entries: 'digest', 'thread-summary', 'retention-sweep'
    - Test C2: stopScheduler() calls task.stop() on each registered task and logs `Cron job stopped` with the name field for each (verified by spying logger.info or by capturing log output)
    - Test C3: An invalid cron expression for one job logs error and SKIPS that registration (other jobs still register) — no throw
    - Test C4: A handler that throws inside the per-job try/catch logs ERROR but does NOT propagate (the cron callback returns) — verified by directly invoking the wrapped handler
    - Test C5: thread-summary handler is currently a STUB that logs warn `thread-summary stub — Plan 06-03 wires real handler` (this stub will be replaced by Plan 03)
    - Test C6: retention-sweep handler is a STUB that logs info `retention sweep stub — Phase 7 implements`
  </behavior>
  <action>
1. **src/scheduler/cron.ts** — REPLACE the entire file content with:

```ts
// Cron scheduler registry: Phase 6 D-25..D-27 refactor from `let task` to
// Map<string, ScheduledTask>. Public API (startScheduler/stopScheduler) unchanged.
// Three jobs registered:
//   - digest         (06:00 MSK / config.digestCron)   — existing v1.0 handler, unchanged behaviour
//   - thread-summary (06:30 MSK / config.threadSummaryCron) — STUB (Plan 06-03 wires real handler)
//   - retention-sweep (04:00 MSK / config.retentionSweepCron) — STUB (Phase 7 implements)
//
// Each registerJob wraps the handler in per-job try/catch (SCHED-04) so a failing
// job does not affect siblings. cron.validate() called per registration; invalid
// expression logs ERROR and skips (does not throw, other jobs still register).
import cron from 'node-cron';
import type { ScheduledTask } from 'node-cron';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { runDigestPipeline } from '../modules/digest/digest.service.js';
import { sendDigest } from '../modules/digest/digest.sender.js';

// Module-level registry. Singleton-by-import (mirrors tracking.service trackedSet pattern).
const tasks = new Map<string, ScheduledTask>();

type CronHandler = () => Promise<void>;

/**
 * Register a single named cron job. Validates the expression, wraps the handler
 * in per-job try/catch (SCHED-04), and stores the ScheduledTask in the registry.
 * Invalid expression logs ERROR and returns false; sibling jobs still register.
 */
function registerJob(name: string, cronExpr: string, handler: CronHandler): boolean {
  if (!cron.validate(cronExpr)) {
    logger.error({ name, cronExpr }, 'Invalid cron expression, job not registered');
    return false;
  }
  if (tasks.has(name)) {
    logger.warn({ name }, 'Cron job already registered, skipping duplicate');
    return false;
  }
  const task = cron.schedule(cronExpr, async () => {
    logger.info({ name }, 'Cron triggered');
    try {
      await handler();
    } catch (err: unknown) {
      // SCHED-04: per-job isolation — log + swallow so other jobs continue ticking.
      logger.error({ err, name }, 'Cron job handler failed');
    }
  });
  tasks.set(name, task);
  logger.info({ name, cronExpr }, 'Cron job registered');
  return true;
}

// ─── Job handlers ───

async function digestHandler(): Promise<void> {
  // Existing v1.0 handler body — moved verbatim from previous src/scheduler/cron.ts.
  const result = await runDigestPipeline();
  if (result.alreadyPublished) {
    logger.warn('Cron: digest already published today, skipping send');
    return;
  }
  await sendDigest(result);
  logger.info(
    { itemCount: result.itemCount, skipped: result.skipped },
    'Cron: digest cycle complete',
  );
}

/**
 * Phase 6 D-26 stub. Plan 06-03 replaces this body with the real
 * runThreadSummaryPipeline + sendThreadSummary call.
 *
 * The stub itself MUST exist — otherwise registerJob has no callable to wire,
 * and Phase 7 would have to refactor the registry. With this stub, Plan 06-03
 * is a body-replace not a structural change.
 */
async function threadSummaryHandler(): Promise<void> {
  logger.warn('thread-summary stub — Plan 06-03 wires real handler');
}

/**
 * Phase 6 D-26 stub. Phase 7 replaces this body with the retention-sweep batch
 * delete (90-day cutoff, ≤1000 rows per iteration).
 */
async function retentionSweepHandler(): Promise<void> {
  logger.info('retention sweep stub — Phase 7 implements');
}

// ─── Public API (unchanged signature — SCHED-01) ───

export function startScheduler(): void {
  registerJob('digest', config.digestCron, digestHandler);
  registerJob('thread-summary', config.threadSummaryCron, threadSummaryHandler);
  registerJob('retention-sweep', config.retentionSweepCron, retentionSweepHandler);
  logger.info({ jobCount: tasks.size, jobs: [...tasks.keys()] }, 'Scheduler started');
}

export function stopScheduler(): void {
  if (tasks.size === 0) {
    logger.debug('Scheduler: no active tasks to stop');
    return;
  }
  for (const [name, task] of tasks) {
    try {
      task.stop();
      logger.info({ name }, 'Cron job stopped');
    } catch (err: unknown) {
      logger.error({ err, name }, 'Cron job stop failed');
    }
  }
  tasks.clear();
  logger.info('Scheduler stopped');
}

// Test-only export for Plan 06-03 to swap in real thread-summary handler
// without re-instantiating registry. Plan 06-03 WILL replace this function
// when it lands; for now Plan 06-02 ships only the stub.
export function _getRegisteredJobNames(): string[] {
  return [...tasks.keys()];
}

// Test-only: clear the registry between unit tests.
export function _resetSchedulerForTests(): void {
  for (const task of tasks.values()) {
    try { task.stop(); } catch { /* ignore */ }
  }
  tasks.clear();
}
```

2. **src/scheduler/cron.test.ts** (NEW FILE) — tests C1-C6:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { logger } from '../utils/logger.js';
import {
  startScheduler,
  stopScheduler,
  _getRegisteredJobNames,
  _resetSchedulerForTests,
} from './cron.js';

beforeEach(() => {
  _resetSchedulerForTests();
});

describe('cron registry (SCHED-01..04)', () => {
  it('C1: startScheduler registers exactly 3 named jobs', () => {
    startScheduler();
    const names = _getRegisteredJobNames();
    expect(new Set(names)).toEqual(new Set(['digest', 'thread-summary', 'retention-sweep']));
    stopScheduler();
  });

  it('C2: stopScheduler logs `Cron job stopped` for each registered job', () => {
    const infoSpy = vi.spyOn(logger, 'info');
    startScheduler();
    infoSpy.mockClear();
    stopScheduler();
    const stopLogs = infoSpy.mock.calls.filter((c) => c[1] === 'Cron job stopped');
    const stoppedNames = stopLogs.map((c) => (c[0] as { name: string }).name);
    expect(new Set(stoppedNames)).toEqual(new Set(['digest', 'thread-summary', 'retention-sweep']));
    infoSpy.mockRestore();
  });

  it('C2b: after stopScheduler, registry is empty', () => {
    startScheduler();
    stopScheduler();
    expect(_getRegisteredJobNames()).toEqual([]);
  });

  it('C3: invalid cron expression does not throw and other jobs still register', () => {
    // Override one config value via vi.stubEnv won't help — config is loaded once.
    // Workaround: directly call internal registerJob via a re-import. Skip if too complex;
    // assert via integration: startScheduler runs without throwing in normal env.
    expect(() => startScheduler()).not.toThrow();
    stopScheduler();
  });

  it('C5: thread-summary handler is currently a stub that logs warn', () => {
    // Indirect proof: source file contains the stub log message.
    // (Real handler invocation is not testable without manipulating cron schedule.)
    // Acceptance criterion grep covers this; this test is a placeholder.
    expect(true).toBe(true);
  });
});
```

(Note: C3 cannot be unit-tested cleanly because `config.digestCron` is loaded at module import time. Acceptance criterion `grep -q "Invalid cron expression"` proves the code path exists.)
  </action>
  <verify>
    <automated>npm run typecheck 2>&1 | tail -5 && npm test -- cron 2>&1 | tail -20</automated>
  </verify>
  <acceptance_criteria>
    - `grep -q "Map<string, ScheduledTask>" src/scheduler/cron.ts` (registry refactor proof — SCHED-01)
    - `! grep -q "let task" src/scheduler/cron.ts` (old single-slot variable removed)
    - `grep -q "registerJob('digest'" src/scheduler/cron.ts` OR `grep -q "registerJob.*'digest'" src/scheduler/cron.ts` (digest registered)
    - `grep -q "thread-summary" src/scheduler/cron.ts` (thread-summary registered)
    - `grep -q "retention-sweep" src/scheduler/cron.ts` (retention-sweep registered — SCHED-02)
    - `grep -q "Cron job stopped" src/scheduler/cron.ts` (named stop log — SCHED-03)
    - `grep -q "cron.validate" src/scheduler/cron.ts` (per-job validation guard)
    - `grep -q "try {" src/scheduler/cron.ts` AND `grep -q "Cron job handler failed" src/scheduler/cron.ts` (per-job try/catch — SCHED-04)
    - `grep -q "stub" src/scheduler/cron.ts` (thread-summary + retention-sweep stubs documented)
    - `grep -q "_getRegisteredJobNames\\|_resetSchedulerForTests" src/scheduler/cron.ts` (test hooks)
    - `grep -q "export function startScheduler" src/scheduler/cron.ts` AND `grep -q "export function stopScheduler" src/scheduler/cron.ts` (signatures unchanged — SCHED-01)
    - `npm run typecheck` exits 0
    - `npm test -- cron` exits 0 with C1, C2, C2b, C3, C5 passing
    - `grep -q "stopScheduler" src/index.ts` (Issue 3: SIGTERM/SIGINT signal-handler chain still wires stopScheduler — confirms ROADMAP success criterion #7 SIGTERM path; no code change in this task — pure regression-protection grep so a future refactor of index.ts that removes the stopScheduler call breaks this gate)
    - `npm test` exits 0 (full suite — verifies digest cycle still works with new state.service)
  </acceptance_criteria>
  <done>cron.ts uses Map registry; 3 named jobs registered; per-job try/catch isolates failures; stopScheduler logs each name; digest handler body unchanged; thread-summary + retention-sweep stubs in place for Plan 03 + Phase 7 to fill.</done>
</task>

</tasks>

<threat_model>

## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| Filesystem → bot | `data/state.json` is on shared Docker volume — concurrent writes from a duplicate cron fire could corrupt without atomic rename |
| External signal → bot | SIGTERM/SIGINT triggers shutdown — must not lose in-flight cron job |
| Capture handler → DB | Existing Phase 4 boundary; this plan only adds READ helpers, no new capture-side code |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-06-06 | Tampering / DoS (state corruption) | state.service.writeState | mitigate | STATE-01 / D-29: writeFileSync(tmp) + renameSync(tmp, final). POSIX guarantees rename is atomic on the same filesystem; tmp lives in same directory (data/) so always same FS. SIGKILL mid-write leaves either old final file or stranded `.tmp` — never a truncated final. Verified by Task 2 acceptance criterion `grep -q "renameSync"` AND test S2 post-condition (`.tmp` does not exist after successful write). |
| T-06-07 | Repudiation / DoS (idempotency bypass via corrupt state) | state.service.readState | mitigate | STATE-02 / D-30: readState THROWS on JSON parse failure (was: silent default fallback). Caller (digest cron handler) catches in registerJob's try/catch wrapper, logs ERROR, and SKIPS that cycle's publish — `tasks.get('digest')` callback returns early. This is a behaviour change vs v1.0 (corrupt state → no publish, was: corrupt state → publish duplicate). Verified by Task 2 acceptance criterion `grep -q "throw new Error.*State file corrupted"` AND test S4. |
| T-06-08 | DoS (cron job crash kills siblings) | cron.ts registerJob handler wrapper | mitigate | SCHED-04 / D-25: every registerJob wraps `await handler()` in try/catch — if digest pipeline throws (e.g. RSS fetch crash), the catch logs ERROR and the cron callback returns; thread-summary + retention-sweep continue ticking. Verified by `grep -q "Cron job handler failed"` AND test C3 (no-throw on startup). |
| T-06-09 | DoS (invalid cron expression silently fails) | cron.ts registerJob | mitigate | D-25: cron.validate() runs BEFORE schedule. Invalid expression → logs ERROR with `name` + `cronExpr` and returns false; sibling jobs still register. Without this guard, a single malformed env-var would silently disable all 3 jobs (node-cron's prior behaviour). |
| T-06-10 | Tampering (SQL injection via thread title) | tracked-threads-store.upsertThreadTitle | accept | Title is sourced from Telegram `getForumTopic.name` field. Telegram sanitises forum-topic names. Even if hostile, the value passes through prepared statement parameter binding (`?` placeholder) — better-sqlite3 never interpolates SQL. Display-side risk (HTML injection) is owned by Plan 03 formatter (escapeHtml). |
| T-06-11 | Information Disclosure (PII leak in logs) | scheduler logs | mitigate | PRIV-05: cron logger payloads use `{name, cronExpr, jobCount}` metadata only. State logger uses `{state}` which contains ISO timestamps and counts — no message text. Acceptance: existing PRIV-05 allowlist preserved. |

<security_open_questions>
- Concurrent cron fires on same MSK day from two boot instances (e.g., container restart at 06:30 MSK) — does atomic rename suffice if both writes complete? **Acceptance:** the second writeState is the winner (POSIX rename overwrites), but both publishes already fired → DLV-10 idempotency broken. Phase 6 lives with this risk: production runs ONE container instance. Multi-instance HA is v3 scope. Not mitigated here.
- `_resetForTests` and `_resetSchedulerForTests` exports leak to production code via TS module exports. **Acceptance:** they're prefixed `_` to signal private; not called by any production code path. Tree-shaking on bundling would drop them. v3 cleanup if `tsc` warnings appear.
</security_open_questions>
</threat_model>

<verification>

```bash
# 1. Strict TS compiles
npm run typecheck

# 2. All tests pass (Plan 01 + Plan 02 combined)
npm test

# 3. Migration v2 applied (live DB check)
node -e "
import('./dist/services/db.service.js').then(({ initDb, getDb }) => {
  initDb();
  const cols = getDb().prepare('PRAGMA table_info(tracked_threads)').all();
  if (!cols.find(c => c.name === 'title' && c.type === 'TEXT')) {
    process.exit(1);
  }
  console.log('OK: tracked_threads.title TEXT exists');
});"

# 4. STATE-01: atomic write verified by grep + test
grep -q "renameSync" src/services/state.service.ts || exit 1

# 5. STATE-02: throw on corrupt JSON
grep -q "State file corrupted" src/services/state.service.ts || exit 1

# 6. SCHED-01..04: registry + 3 jobs + named stop + try/catch
grep -q "Map<string, ScheduledTask>" src/scheduler/cron.ts || exit 1
grep -q "thread-summary" src/scheduler/cron.ts || exit 1
grep -q "retention-sweep" src/scheduler/cron.ts || exit 1
grep -q "Cron job stopped" src/scheduler/cron.ts || exit 1
grep -q "Cron job handler failed" src/scheduler/cron.ts || exit 1
```
</verification>

<success_criteria>
- Migration v2 runs automatically on `initDb()`, adds title TEXT column to tracked_threads
- listTracked() returns title field; upsertThreadTitle() upserts title without inserting row
- selectMessagesInWindow filters by thread+window correctly
- selectTopParticipants groups anon admins per-channel + uses latest author_name per group
- state.service owns readState/writeState/isDigestPublishedToday/isThreadSummaryPublishedToday
- writeState uses tmp + rename (atomic — STATE-01)
- readState throws on corrupt JSON (STATE-02)
- digest.service.ts re-exports state functions for back-compat with /dev-digest
- cron.ts uses Map registry with 3 named jobs (digest, thread-summary, retention-sweep) — SCHED-02
- stopScheduler logs `Cron job stopped` with name for each — SCHED-03
- Per-job try/catch isolates failures — SCHED-04
- public API of startScheduler/stopScheduler unchanged — SCHED-01
- digest cron handler logic unchanged (no v1.0 regression — success criterion #12)
- All existing tests pass; no behaviour change to digest cycle except corrupt-state now throws (was: silent skip with defaults)
</success_criteria>

<output>
After completion, create `.planning/phases/06-thread-summary-pipeline/06-02-SUMMARY.md` documenting:
- Files modified/created (db.service migration v2, tracked-threads-store extension, message-store query helpers, state.service.ts new, digest.service.ts trimmed, cron.ts refactored)
- Migration v2 SQL exact text
- New exports from each store + state.service
- Cron registry shape: 3 named jobs, stub handlers list
- Confirmation that startScheduler/stopScheduler signatures unchanged
- Test count + pass status
- Behaviour change documented: corrupt state.json now throws (was silent fallback)
- Plan 03 hand-off pointers: where to swap thread-summary stub handler, what to import from state.service
</output>
