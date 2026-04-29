---
phase: 06-thread-summary-pipeline
reviewed: 2026-04-29T00:00:00Z
depth: standard
files_reviewed: 29
files_reviewed_list:
  - package.json
  - prompts/thread-summarizer.md
  - src/modules/digest/digest.service.ts
  - src/modules/thread-summary/thread-summary.formatter.test.ts
  - src/modules/thread-summary/thread-summary.formatter.ts
  - src/modules/thread-summary/thread-summary.sender.test.ts
  - src/modules/thread-summary/thread-summary.sender.ts
  - src/modules/thread-summary/thread-summary.service.test.ts
  - src/modules/thread-summary/thread-summary.service.ts
  - src/scheduler/cron.test.ts
  - src/scheduler/cron.ts
  - src/services/db.service.ts
  - src/services/state.service.test.ts
  - src/services/state.service.ts
  - src/services/summarizer.adversarial.test.ts
  - src/services/summarizer.anonymisation.test.ts
  - src/services/summarizer.service.test.ts
  - src/services/summarizer.service.ts
  - src/stores/message-store.test.ts
  - src/stores/message-store.ts
  - src/stores/tracked-threads-store.test.ts
  - src/stores/tracked-threads-store.ts
  - src/types/index.ts
  - src/utils/display-name.test.ts
  - src/utils/display-name.ts
  - tests/fixtures/adversarial-transcript.txt
  - tests/fixtures/normal-transcript.txt
  - tests/setup.ts
  - vitest.config.ts
findings:
  critical: 0
  warning: 3
  info: 5
  total: 8
status: issues_found
---

# Phase 06: Code Review Report

**Reviewed:** 2026-04-29T00:00:00Z
**Depth:** standard
**Files Reviewed:** 29
**Status:** issues_found

## Summary

Standard-depth review of the complete Phase 6 thread-summary pipeline: summarizer service, orchestrator, formatter, sender, cron wiring, state service, DB stores, and tests. This supersedes the prior quick review (the quick review's WR-02 about `.env.example` is dropped — verification confirms the env var IS documented at `.env.example:18`).

Security posture is solid. The HTML formatter escapes every user-controlled field (title, headline, bullets, participants, open questions). The prompt-injection sandwich (`<<<TRANSCRIPT_START>>> … <<<TRANSCRIPT_END>>>` + post-transcript reaffirm) is correctly implemented and exercised by both `summarizer.anonymisation.test.ts` and `summarizer.adversarial.test.ts`. PII anonymisation (numeric `author_id` never reaches the LLM payload) is enforced and tested. State writes are atomic (tmp + rename), corrupt-state JSON throws (no silent default-fallback), and the merge-write pattern preserves cross-cycle fields. Test coverage is thorough — 11 formatter cases, 7 orchestrator cases, gating tests, schema tests, adversarial fixture, anonymisation fixture, Unicode normalisation, and DB store tests.

The most significant finding (WR-01) is that **the title-refresh feature is non-functional in production**: `bot.api.getForumTopic` is not a real method in Telegram Bot API 7.x or in grammy 1.42.0 (verified — grammy exposes only `getForumTopicIconStickers`). The `typeof api.getForumTopic === 'function'` runtime guard will always be false, so every cron run silently falls back to the cached title (or `Тред #N` when no cache exists). Two further warnings cover (a) malformed-JSON responses being mis-classified as `llm-error` instead of `schema-invalid`, and (b) a race in `runThreadSummaryPipeline` where state is read twice with no consistency guarantee. Five info items document smaller code-quality and maintainability concerns.

No critical issues. No hardcoded secrets. No injection vectors. No null-pointer risks.

---

## Warnings

### WR-01: `bot.api.getForumTopic` does not exist — title refresh is permanently a no-op in production

**File:** `src/modules/thread-summary/thread-summary.service.ts:36-68`

**Issue:** The `refreshThreadTitle` function attempts to call `bot.api.getForumTopic(chatId, threadId)` via a double-cast workaround:

```typescript
const api = bot.api as unknown as ForumTopicCapableApi;
try {
  if (typeof api.getForumTopic === 'function') {
    const topic = await api.getForumTopic(config.targetChatId, threadId);
    ...
  }
} catch (err: unknown) {
  ...
}
```

Verification against `node_modules/grammy/out/core/api.d.ts` (grammy 1.42.0) shows that the only forum-topic-related method exposed is `getForumTopicIconStickers` — there is no `getForumTopic` and no `getForumTopics` method. Telegram Bot API 7.x does not document such a method either. The runtime guard `typeof api.getForumTopic === 'function'` will therefore **always** evaluate to false in production, the API call is never attempted, and `upsertThreadTitle` is never invoked. Every cron run silently falls through to the cached title (or `Тред #N` when no cache exists).

In-source comment at lines 36-42 acknowledges that the method is undocumented but says "tests mock it" — and indeed the tests mock `mockGetForumTopic.mockResolvedValue({ ... })`, so unit tests pass while the real binding is silently dead. The orchestrator test `O7` only verifies the *failure* path (rejection); there is no test that asserts a successful real-world call writes through to `upsertThreadTitle`.

Net effect: the daily title cache will never populate from this code path. The only way a title ends up in `tracked_threads.title` is via Phase 5's `/track` command, which per the recent commit history is cancelled — meaning every tracked thread will render as `Тред #N` indefinitely.

**Fix:** Either (a) replace the call with a direct HTTP call via `bot.api.raw` or grammy's `apiCallFn` that hits the actual Telegram Bot API method `getMessage` against the topic creation message (Telegram's documented workaround), or (b) remove the `refreshThreadTitle` call entirely until a working source-of-truth exists, and document the limitation. Option (a) sketch:

```typescript
// Use grammy's raw transport to call any Bot API method, even ones not in the typed surface.
// If/when Telegram adds getForumTopic, this becomes a one-liner. Until then,
// remove this block and rely on /track to capture the title at registration time.
async function refreshThreadTitle(threadId: number): Promise<string> {
  // Cached-title-only path until a real source-of-truth exists.
  const cached = listTracked().find((t) => t.threadId === threadId)?.title;
  return cached ?? `Тред #${threadId}`;
}
```

If the team wants to keep the speculative call as a future-proofing hook, add an `O8` test that asserts the success path actually writes through to `upsertThreadTitle` so the dead-code state becomes visible.

---

### WR-02: Malformed-JSON from OpenAI-compatible provider classified as `llm-error` instead of `schema-invalid`

**File:** `src/services/summarizer.service.ts:154`

**Issue:** Inside `callOpenAICompatible`, line 154 reads:

```typescript
return JSON.parse(content) as LLMSummaryOutput;
```

If `content` is non-empty but not valid JSON (provider returns `"sorry, I can't help with that"` or similar plain-text refusal), `JSON.parse` throws a `SyntaxError`. This propagates out of `callOpenAICompatible` and is caught by the outer try/catch at `summarizer.service.ts:209-215`, which classifies the failure as `reason: 'llm-error'`.

This is functionally safe (the skip happens, the orchestrator continues, no crash), but the classification is wrong — a malformed-JSON response from a provider with known-good API uptime is a **schema** failure, not a transport failure. Operators looking at logs to diagnose model regressions will see `LLM call failed` and assume network/auth issues, while the actual cause is the model going off-schema. The Zod last-gate (D-23) is also bypassed for this case, so the `schema-invalid` reason path is never exercised against malformed-JSON inputs even though the inputs are conceptually schema failures.

The Anthropic path does not have this issue because tool_choice forces `tool_use` blocks with structured `input`.

**Fix:** Catch `JSON.parse` separately and re-throw a tagged error, or return a sentinel that the caller maps to `schema-invalid`:

```typescript
async function callOpenAICompatible(userMessage: string): Promise<LLMSummaryOutput> {
  // ... existing code ...
  const content = response.choices[0]?.message?.content ?? '';
  if (content === '') {
    throw new Error('OpenAI-compatible response empty content');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    // Malformed JSON is a schema failure, not a transport failure.
    // Surface with a tagged class so the caller can classify it correctly.
    const e = new Error(
      `OpenAI-compatible response is not valid JSON (first 100 chars): ${content.slice(0, 100)}`,
    );
    (e as Error & { kind?: string }).kind = 'schema-invalid';
    throw e;
  }
  return parsed as LLMSummaryOutput;
}
```

Then in `summarizeThread` catch block at line 209, branch on `kind === 'schema-invalid'` and return the appropriate skip reason. Alternatively, rely on the existing Zod `safeParse` by relaxing the type on the LLM path: have `callOpenAICompatible` return `unknown`, parse JSON inside, and let the existing Zod gate at line 219 do the classification.

---

### WR-03: `runThreadSummaryPipeline` reads state twice with no consistency guarantee

**File:** `src/modules/thread-summary/thread-summary.service.ts:92-109`

**Issue:** The pipeline reads `state.json` twice: first via `readState()` at line 94 (wrapped in try/catch for STATE-02), then via `isThreadSummaryPublishedToday()` at line 103, which itself calls `readState()` internally (`state.service.ts:103`). The second call is unguarded — if the file becomes corrupt between the two reads (concurrent writer, disk error mid-cycle, file truncated), the second read will throw and the error will not be caught locally. It will propagate up to the cron handler's outer try/catch (`cron.ts:43-48`), which logs and swallows.

In practice the race is impossible — there are no concurrent writers at this point in the pipeline — but the redundant read is wasteful (two `readFileSync` + JSON parses on every cron tick) and the local `prevState` variable already holds a valid snapshot. The defensive try/catch at the first read implies the team is aware that corrupt state is possible; the inconsistency between the guarded first read and the unguarded second read is a code smell that suggests the second read shouldn't exist.

**Fix:** Use the already-cached `prevState` to perform the idempotency check, eliminating the second I/O:

```typescript
let prevState: PipelineStateV2;
try {
  prevState = readState();
} catch (err: unknown) {
  logger.error({ err }, 'runThreadSummaryPipeline: state read failed (corrupt state.json), publish blocked');
  return emptyResult(false);
}

// Inline idempotency check using already-loaded state — no second readState() call.
const alreadyPublishedToday =
  prevState.lastThreadSummaryDate !== null &&
  new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' }) ===
    new Date(prevState.lastThreadSummaryDate).toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' });

if (!skipIdempotency && alreadyPublishedToday) {
  logger.warn(
    { lastThreadSummaryDate: prevState.lastThreadSummaryDate },
    'Thread-summary already published today (MSK), skipping',
  );
  return emptyResult(true);
}
```

To keep the helper-function abstraction, refactor `state.service.ts` to expose `isThreadSummaryPublishedTodayWithState(state: PipelineStateV2): boolean` so callers can avoid the double-read.

---

## Info

### IN-01: Stale comment in `cron.ts` references "Plan 06-02 ships only the stub"

**File:** `src/scheduler/cron.ts:138-140`

**Issue:** Lines 138-140 read:

```typescript
// Test-only export for Plan 06-03 to swap in real thread-summary handler
// without re-instantiating the registry. Plan 06-03 WILL replace this function
// when it lands; for now Plan 06-02 ships only the stub.
```

Plan 06-03 has shipped (lines 76-102 contain the real handler invoking `runThreadSummaryPipeline` + `sendThreadSummary`). The comment is a leftover from an intermediate state and will confuse future readers.

**Fix:** Replace with a short, current comment:

```typescript
// Test-only export — returns names of registered jobs. Used by cron.test.ts
// to verify the registry contents without depending on internal state.
export function _getRegisteredJobNames(): string[] {
```

---

### IN-02: `upsertThreadTitle` is misnamed — it is UPDATE-only, never INSERT

**File:** `src/stores/tracked-threads-store.ts:29-36, 56-62`

**Issue:** The function is exported as `upsertThreadTitle` and the prepared statement is named `upsertTitleStmt`, but per the code comment at line 30 ("No INSERT path — Phase 6 D-07: orchestrator only updates titles for already-tracked threads") and the SQL itself (`UPDATE tracked_threads SET title = ? WHERE thread_id = ?`), the function is strictly UPDATE-only. Calling it with a non-existent `threadId` is a silent no-op (UPDATE matches 0 rows), which is by design but contradicts the "upsert" naming. Test U1 line 47-49 verifies the no-op behaviour explicitly: `expect(() => upsertThreadTitle(999, 'NoSuch')).not.toThrow()` and `expect(listTracked().find(t => t.threadId === 999)).toBeUndefined()`.

A future maintainer reading `upsertThreadTitle` on a call site will reasonably assume that calling it ensures the title is recorded; in fact, if the thread isn't already tracked, the call has no effect.

**Fix:** Rename to `updateThreadTitle` (and `updateTitleStmt`). Update call site in `thread-summary.service.ts:58`. This is a low-risk rename with a single import and one call site. Alternatively, if the intent is to allow future INSERT (e.g., for forum topics auto-discovered without `/track`), make the SQL a real upsert:

```sql
INSERT INTO tracked_threads (thread_id, chat_id, added_by, added_at, title)
VALUES (?, ?, NULL, ?, ?)
ON CONFLICT(thread_id) DO UPDATE SET title = excluded.title
```

Either rename or extend, but don't leave the misleading name in place.

---

### IN-03: `formatThreadSummaryPost` "single section overflow" warn fires once even when it should fire per oversized chunk

**File:** `src/modules/thread-summary/thread-summary.formatter.ts:159-177`

**Issue:** When a single section's length exceeds `MAX_CHUNK_LENGTH`, the splitter logs a WARN at line 170 and accepts the overflow. But the warn is logged once per *first overflow detection*, not per *emitted oversize chunk*. If a thread has multiple successive oversize sections, the loop emits each as its own oversize chunk but the warn only fires when the candidate-test fails — so an operator looking at logs cannot count how many oversize chunks are actually being shipped to Telegram.

Practically, Telegram will reject any message > 4096 chars with a 400 error. The retry wrapper in `sendMessageWithRetry` (out of scope here) does not split-and-retry, so the chunk simply fails to publish. The current behaviour means a thread with 2+ oversized sections will fail silently for downstream sections without an audit trail.

This is unlikely to be hit in practice (a single thread section ≥4096 chars implies an LLM that returned a paragraph-length headline, which Zod prevents). Flagging as info because the failure mode is real but low-probability.

**Fix:** Move the warn-log emission into the `chunks.push` site so every oversize emission gets its own log line:

```typescript
} else {
  if (currentChunk.length > MAX_CHUNK_LENGTH) {
    logger.warn(
      { chunkLength: currentChunk.length, limit: MAX_CHUNK_LENGTH },
      'Emitting oversize chunk — Telegram may reject',
    );
  }
  chunks.push(currentChunk);
  // ... existing fresh-section logic ...
}
```

---

### IN-04: `sendThreadSummary` log field `chunkCount` includes empty-string-skipped chunks

**File:** `src/modules/thread-summary/thread-summary.sender.ts:26-29`

**Issue:** The per-chunk send log emits `chunkIndex: i + 1, chunkCount: chunks.length`. When `chunks` contains empty-string entries that are filtered by the `if (chunk === undefined || chunk === '')` guard at line 19, the `chunkCount` field still reflects the unfiltered length. For example, with `['c1', '', 'c3']`, the logs will read `chunk 1 of 3` and `chunk 3 of 3` — never `chunk 2 of 2` even though only 2 actual sends occurred. Operators correlating "I sent N chunks" against this log will be confused.

The defensive empty-string filter is itself a good practice (keeps the sender robust against formatter regressions), but the log should reflect what was actually sent.

**Fix:** Pre-filter and use the filtered length:

```typescript
export async function sendThreadSummary(chunks: string[]): Promise<void> {
  const nonEmpty = chunks.filter((c) => c !== undefined && c !== '');
  if (nonEmpty.length === 0) {
    logger.debug('sendThreadSummary: zero non-empty chunks, skipping');
    return;
  }
  for (let i = 0; i < nonEmpty.length; i++) {
    const chunk = nonEmpty[i] as string;
    await sendMessageWithRetry({ ... });
    logger.info(
      { chunkIndex: i + 1, chunkCount: nonEmpty.length, chunkLength: chunk.length },
      'Thread-summary chunk sent',
    );
  }
}
```

Test S2b at `thread-summary.sender.test.ts:34-37` will continue to pass with this refactor.

---

### IN-05: Defensive headline-length guard is unreachable dead code

**File:** `src/services/summarizer.service.ts:235-238`

**Issue:** Lines 235-238 implement a defensive truncation:

```typescript
const headline =
  validated.headline.length > 80
    ? `${validated.headline.slice(0, 79)}…`
    : validated.headline;
```

But `validated` is the output of `ThreadSummarySchema.safeParse` on line 219, and the schema declares `headline: z.string().max(80)`. Zod **rejects** any input where `headline.length > 80` — meaning the `parsed.success === true` branch can never have a headline > 80 chars. The conditional at line 236 is therefore dead.

The inline comment at line 233 acknowledges this: "(D-08 headline overflow guard — defensive even though schema enforces ≤80)". So it's intentional defence-in-depth, not a bug. The cost is negligible (one length comparison per cycle). Flagging as info because dead defensive code accumulates over time and a future reader may assume the schema's `max(80)` is informational rather than enforcing.

**Fix:** Either remove the conditional (Zod is the contract):

```typescript
const headline = validated.headline;
const bullets = validated.bullets.slice(0, 6);
const openQuestions = validated.openQuestions.slice(0, 3);
```

Or keep it and add an `// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition` (or equivalent comment) to declare it as deliberate dead code so future linters don't strip it. Same applies to `bullets.slice(0, 6)` and `openQuestions.slice(0, 3)` — those are also redundant with `bullets.max(6)` and `openQuestions.max(3)` in the schema.

---

_Reviewed: 2026-04-29T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
