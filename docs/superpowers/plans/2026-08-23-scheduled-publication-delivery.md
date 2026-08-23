# Reliable delivery of scheduled publications — implementation plan

> **For Codex:** Execute this plan in the current workspace with test-driven changes. The user has explicitly authorized committing all existing local WIP together after verification, but has not authorized push or deploy.

**Goal:** Make the daily digest and topic summaries generate on the intended Moscow schedule and deliver reliably to their configured Telegram topic after transient network failures.

**Architecture:** Generation pipelines remain responsible for collecting and rendering content. A PostgreSQL transactional outbox stores rendered Telegram chunks before any send attempt. A single dispatcher claims due publications, sends only the first unfinished chunk, and persists the result; retries and recovery are durable across process restarts. `job_state` advances only after every chunk is acknowledged. A small LLM transport capability cache avoids a failing `json_schema` request on every invocation.

**Tech stack:** TypeScript, node-postgres, node-cron, Zod, Vitest, Telegram Bot API.

**Constraints:** Keep the existing seven production environment variables; retain one shared configured forum topic for both publication types; never log prompts, LLM output, tokens, publication body, database URL, or credentials. Delivery is at-least-once because a network failure can happen after Telegram accepts a message.

---

## 1. Add Moscow-time and outbox database primitives

**Files:**

- Create `src/time.ts`
- Create `src/time.test.ts`
- Modify `src/db/migrations.ts`
- Modify `src/db/migrations.test.ts`
- Modify `src/runtime-defaults.ts`

1. Start with tests for extracting the `YYYY-MM-DD` calendar date in `Europe/Moscow`, calculating the following Moscow midnight in UTC, and classifying an expiry boundary. Include an instant just before and just after 21:00 UTC (midnight in Moscow).
2. Implement `moscowDateKey`, `nextMoscowMidnight`, and a small pure `isExpired` helper. Do not depend on the host timezone.
3. Change the thread-summary cron default from `30 3 * * *` (06:30 Moscow) to `30 6 * * *` (09:30 Moscow). Leave the digest at `0 6 * * *` (09:00 Moscow).
4. Add migration version 2. It creates `scheduled_publications` with `id`, `pipeline`, `publication_date`, `target_chat_id`, `thread_id`, `status`, `next_attempt_at`, `expires_at`, `attempt_count`, `lease_until`, `last_error_code`, `created_at`, `updated_at`, `delivered_at`, and a uniqueness constraint on `(pipeline, publication_date)`. Valid statuses are `ready`, `delivering`, `retrying`, `delivered`, `expired`, and `failed`.
5. Add `scheduled_publication_chunks` with primary key `(publication_id, chunk_index)`, nonempty `text`, and nullable `telegram_message_id` / `delivered_at` that must be present together. Add indexes for due work and incomplete chunks.
6. Extend the migration test expectation to include the two new tables and version 2. Keep the migration idempotent and the existing v1 source untouched.
7. Run the focused tests:

   ```bash
   npm test -- --run src/time.test.ts src/db/migrations.test.ts
   ```

## 2. Build and test the publication repository

**Files:**

- Create `src/scheduled-publication.repository.ts`
- Create `src/scheduled-publication.repository.test.ts`
- Modify `src/persistence.ts`

1. Define domain types for pipeline (`digest | thread-summary`), publication status, persisted chunks, claimed work, and safe status counts.
2. Write repository integration tests using the project's migration/test-database helpers. Cover:
   - creating an outbox row and chunks atomically;
   - same `(pipeline, Moscow date)` being idempotent;
   - claiming only due `ready`/`retrying` work with a lease;
   - reclaiming a `delivering` row whose lease expired;
   - recording one chunk as delivered without reselecting it;
   - persisted retry timing and terminal `failed`/`expired` status;
   - completion only when every chunk is delivered;
   - operator recovery resetting `failed` and `expired` rows with a fresh expiry;
   - cleanup of terminal entries older than seven days.
3. Implement `enqueue`, `claimDue`, `recordChunkDelivered`, `scheduleRetry`, `markFailed`, `markExpired`, `completeIfDelivered`, `recover`, `getStatusCounts`, and `deleteExpiredPublications`.
4. Use `FOR UPDATE SKIP LOCKED` during claiming. A claim sets `delivering`, increments attempts, and sets a finite lease. Fetch only the first undelivered chunk.
5. Use transactions for enqueue, chunk delivery/completion, and recovery. Advance `job_state` from the dispatcher only after `completeIfDelivered` returns the complete publication.
6. Add `publications` to `CorePersistence` and construct it in `createPersistence`; update narrowly typed mock persistence in existing tests.
7. Run the repository suite and TypeScript checking:

   ```bash
   npm test -- --run src/scheduled-publication.repository.test.ts
   npm run typecheck
   ```

## 3. Split Telegram one-attempt sending from legacy retry sending

**Files:**

- Modify `src/telegram.ts`
- Modify `src/telegram.test.ts` (or the existing Telegram-focused test file)

1. Add tests showing the new exported one-attempt API returns a safe error classification for Telegram HTTP response codes, `retry_after` when Telegram provides it, and transport failures that have no Telegram response code.
2. Extract the current private single `sendMessage` attempt into an exported `sendMessageOnce` result API. It must not leak text, token, credentials, or arbitrary response body in logs/errors.
3. Keep `sendMessageWithRetry` as a compatibility wrapper for interactive flows: it invokes `sendMessageOnce`, waits three seconds after a retryable failure, then makes at most one more attempt. Preserve current external behavior.
4. Treat 429 as retryable. Treat 4xx other than 429 as non-retryable. Treat connection/network errors and 5xx as retryable. Retain normal Telegram message ID on success.
5. Run the focused suite:

   ```bash
   npm test -- --run src/telegram.test.ts
   ```

## 4. Implement the durable dispatcher and generation-to-outbox handoff

**Files:**

- Create `src/publication-dispatcher.ts`
- Create `src/publication-dispatcher.test.ts`
- Modify `src/radar.ts`
- Modify `src/summary.ts`
- Modify `src/scheduler.ts`
- Modify `src/application.ts`
- Modify relevant `*.test.ts` files

1. Write dispatcher tests before implementation. Use fake time, a fake repository, and a fake one-attempt Telegram sender. Cover success, partial multi-chunk recovery, transient retry delays of `3s, 15s, 1m, 5m, 15m, 30m`, 429 with a larger `retry_after`, non-retryable 4xx, expiry, and a reclaimed lease.
2. Implement a dispatcher with `dispatchDue(now)` that claims in small batches and processes just the claimed first unfinished chunk. It must make no Telegram call for a publication that is already expired.
3. On a successful chunk, persist its Telegram ID. If that was the final chunk, mark the publication delivered and record the matching digest/summary job state in the same logical completion path.
4. On retryable error, persist the next attempt. The delay is capped at 30 minutes and must not extend beyond that publication’s next Moscow midnight. On failure after expiry, set `expired`; otherwise retain safe error classification only.
5. On non-retryable 4xx other than 429, set `failed`; retain for seven days for operator recovery.
6. Add a timer-owned `start`/`stop` lifecycle around periodic dispatch. The scheduler should trigger immediate dispatch after enqueuing; periodic recovery should run independently so a restart or temporary failure is recovered.
7. Refactor scheduled digest and summary handlers: run generation exactly once per Moscow date, serialize chunks, enqueue them before any Telegram send, then ask the dispatcher to run. Do not call direct send helpers from scheduled handlers.
8. Keep existing direct sender functions for explicit development/interactive paths, so their behavior and tests remain intact. Ensure scheduled code uses target chat/thread metadata captured in the outbox.
9. Wire dispatcher construction and shutdown through `src/application.ts`; stop it before closing the database pool.
10. Add retention cleanup for terminal outbox rows to the existing retention path.
11. Run focused tests:

   ```bash
   npm test -- --run src/publication-dispatcher.test.ts src/scheduler.test.ts src/radar.sender.test.ts src/summary.sender.test.ts
   ```

## 5. Add controlled operator recovery and safe status reporting

**Files:**

- Modify `src/bot.ts`
- Modify `src/bot.test.ts` or its command-specific tests
- Modify `src/application.ts` as needed for injected dispatcher access

1. Start with tests that verify only an administrator in the target group can invoke `/retry_publications`, that the command accepts `digest`, `summary`, or `all`, and that it neither exposes a publication body nor re-runs LLM generation.
2. Add `/retry_publications [digest|summary|all]`. The default is `all`; `summary` maps to `thread-summary`. It moves eligible `failed`/`expired` rows to `ready`, gives each a newly calculated Moscow-midnight expiry, and invokes the dispatcher.
3. Extend `/status` with only safe counts grouped by pipeline/status plus last delivery time. Keep its current access checks and omit message content, prompts, errors with arbitrary data, token usage, and credentials.
4. Update the bot’s persistence/options types so command handling receives the dispatcher dependency without changing behavior of unrelated command paths.
5. Run bot-focused tests:

   ```bash
   npm test -- --run src/bot.test.ts
   ```

## 6. Eliminate repeated unsupported JSON-schema calls and add one validation retry

**Files:**

- Modify `src/llm.ts`
- Modify `src/llm.test.ts`
- Modify `src/radar.curator.ts`
- Modify `src/radar.curator.test.ts`
- Modify `src/summarizer.ts`
- Modify `src/summarizer.test.ts`

1. Add LLM transport tests: first 400 rejection for `json_schema` makes exactly one fallback request using `json_object`; later `requestJson` calls use `json_object` directly; a non-400 error does not poison capability state.
2. Implement a module-level capability cache keyed by endpoint/model. It starts unknown, remembers `json_object` only when the provider rejects `json_schema` with HTTP 400, and otherwise preserves the existing request behavior. Provide a test-only reset hook if needed.
3. Add tests for controlled regeneration: malformed JSON, Zod-invalid output, or an output where every proposed citation/item is rejected cause exactly one second LLM attempt. A valid empty digest causes no retry.
4. Extend the JSON request boundary to accept a concise retry instruction, without logging the original response. Make the second prompt/schema request demand strictly valid JSON and source IDs/URLs only.
5. In the curator and summarizer, perform exactly one retry for validation failure. If the retry fails, retain the existing safe `schema-invalid` outcome. Do not invent links or publish invalid data.
6. Preserve the current uncommitted model/transport WIP (`max_completion_tokens` and `reasoning_effort: 'none'`) and its tests when editing `src/llm.ts`.
7. Run the LLM-focused suite:

   ```bash
   npm test -- --run src/llm.test.ts src/radar.curator.test.ts src/summarizer.test.ts
   ```

## 7. Update operational documentation, verify, and create the requested single WIP commit

**Files:**

- Modify `README.md`
- Modify `docs/architecture.md`
- Modify `docs/operations.md`
- Modify `AGENTS.md`
- Keep this plan as part of the final commit

1. Reconcile existing documentation WIP with the implemented behavior: actual 09:00/09:30 Moscow schedule, shared topic intentional, durable delivery semantics, command recovery, and the old-image `AI_API_KEY` log interpretation. Do not describe an unverified production deployment as complete.
2. Add a safe operator runbook: inspect publication state/counts, verify no duplicate polling workers, use `/retry_publications`, and distinguish retryable outbound network failures from permanent Telegram errors.
3. Search the staged diff for unsafe logging or accidental secret values. Review all modified type interfaces and test mocks.
4. Run the release gate:

   ```bash
   npm test
   npm run typecheck
   npm run build
   git diff --check
   git status --short
   ```

5. If all checks pass, stage the user-authorized current WIP (`README.md`, `AGENTS.md`, `docs/`, and `src/`) and create one local commit such as `feat: make scheduled publications durable`. Do not push, deploy, seed production, or alter Timeweb configuration.
6. Report the commit ID, test results, remaining deployment steps, and the at-least-once duplicate caveat.
