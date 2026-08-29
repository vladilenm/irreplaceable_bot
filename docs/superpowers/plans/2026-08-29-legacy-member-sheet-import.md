# Legacy Member Sheet Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a one-shot, review-gated importer that converts the 23 unique owner-provided legacy member profiles into verified `club-site` records without exposing personal data, fabricating Telegram identities or subscriptions, or partially mutating production.

**Architecture:** `club-site` owns a small `member-import` domain with pure snapshot/profile validators, replaceable Telegram/LLM/access adapters, a full preflight orchestrator, and a single PostgreSQL transaction for apply/rollback. The CLI reads protected JSON artifacts outside Git, defaults to dry-run, and prints safe aggregate reports only. `club_bot` receives no new write path; its existing `club.member_matching_source` sync and embedding pipeline is verified as the downstream consumer.

**Tech Stack:** Node.js 22, TypeScript 5, Next.js 16.3, PostgreSQL 16, Drizzle ORM 0.45, `pg` 8.23, Zod 4.4, OpenAI SDK 6, GramJS `telegram`, Vitest 4, Docker/Timeweb.

## Global Constraints

- The source Google Sheet is read-only. Human review happens in a separate private Google Sheet with a different file ID.
- Real names, usernames, Telegram IDs, biographies, LLM prompts/responses, evidence, tokens, `DATABASE_URL`, and source/review artifacts never enter Git or ordinary logs.
- The CLI accepts local protected JSON artifacts and never receives permanent Google credentials.
- `prepare` and `apply` default to dry-run. Database mutation requires `--write`, an exact UUID `--batch-id`, `--expected-count 23`, and non-empty `--consent-attestation`.
- A batch is all-or-nothing. Any source, review, Telegram, group-membership, Nemiling/admin, profile, policy, or database conflict produces zero writes.
- Telegram usernames resolve only through official MTProto `contacts.resolveUsername`; random lookup bots and scraped identity databases are prohibited.
- A resolved peer must be a non-bot `User`, have the same current username, fit positive PostgreSQL `bigint`, and pass Bot API `getChatMember` for `TARGET_CHAT_ID`.
- Admin access comes only from `ADMIN_TELEGRAM_IDS`; member access comes only from a fresh successful Nemiling response. No synthetic subscription is allowed.
- LLM output may structure only evidenced current work, completed work, measurable experience, skills, and explicit help. Aspirations alone are rejected.
- Profile limits stay identical to the bot contract: name 80, occupation/industry 100, expertise 1000, help 700, 1–12 unique skills of 30, canonical document 2500.
- Matching consent uses exactly `member-matching-v1`; existing `llm_personalization` consent is untouched.
- Import records contain hashes and internal UUIDs only, never source biography, structured profile, username, Telegram ID, evidence, prompt, or response.
- Rollback revokes only the recorded imported consent and hides only an untouched imported profile. It never deletes a user or overwrites a later member edit.
- Mocks remain inactive. No fallback or reactivation path is added.
- Do not run a real-data preflight, production migration, production write, rollback, push, or deploy without the explicit gate in Task 9.

---

## File Structure

### `club-site` repository (`/Users/vladilen/Documents/тнз/club-site`)

- Modify `src/lib/db/schema.ts`: add typed import batch and record tables.
- Create `drizzle/0005_legacy_member_import_audit.sql` and generated metadata: create audit tables and constraints.
- Modify `src/test/db.integration.setup.ts`: truncate audit tables before owned tables.
- Create `src/lib/member-import/types.ts`: artifact, extraction, verified-row, report, and error schemas.
- Create `src/lib/member-import/source.ts`: normalization, deduplication, row/source hashes, snapshot verification.
- Create `src/lib/member-import/profile.ts`: LLM extraction schema, evidence checks, aspiration guard, profile/canonical-document validation.
- Create `src/lib/member-import/telegram.ts`: MTProto username resolver and Bot API membership verifier behind interfaces.
- Create `src/lib/member-import/access.ts`: fresh admin/Nemiling verification with provider-safe result mapping.
- Create `src/lib/member-import/llm.ts`: one-profile structured extraction with one schema retry.
- Create `src/lib/member-import/preflight.ts`: full immutable review/source verification and database conflict checks.
- Create `src/lib/member-import/repository.ts`: transactional apply, idempotency, audit records, rollback.
- Create `src/lib/member-import/report.ts`: allowlisted aggregate output and error-class counting.
- Create `src/lib/member-import/*.test.ts`: synthetic unit fixtures only.
- Create `src/lib/member-import/repository.integration.test.ts`: transaction/view/login/rollback tests.
- Create `scripts/member-import.ts`: argument parsing and `prepare | apply | rollback` command orchestration.
- Modify `package.json` and `package-lock.json`: add `member:import`, `openai`, `telegram`, and `tsx`.
- Modify `Dockerfile`: copy `scripts/` and `src/` so the explicit CLI is available in the release image.
- Modify `.gitignore`: ignore `/tmp/member-import/` and `member-import-*.json` defensively.
- Modify `.env.example`: document optional one-shot-only names without values.
- Create `docs/operations/legacy-member-import.md`: review bridge, commands, gates, verification, cleanup, and rollback.
- Modify `README.md`: link the operator runbook without claiming a production import occurred.

### `club_bot` repository (`/Users/vladilen/Documents/ChatGPT/club_bot`)

- Modify `docs/operations.md`: link the import runbook and add downstream count/index verification commands.
- No runtime or schema change is expected; existing web snapshot/index tests are the contract gate.

---

### Task 1: Isolate `club-site` Work and Add Audit Schema

**Files:**
- Modify: `club-site/src/lib/db/schema.ts`
- Create: `club-site/drizzle/0005_legacy_member_import_audit.sql`
- Create: `club-site/drizzle/meta/0005_snapshot.json`
- Modify: `club-site/drizzle/meta/_journal.json`
- Modify: `club-site/src/lib/db/schema.integration.test.ts`
- Modify: `club-site/src/test/db.integration.setup.ts`

**Interfaces:**
- Produces `memberImportBatches` and `memberImportRecords` Drizzle tables.
- Produces database checks for fixed source, SHA-256 hashes, positive expected count, status/timestamp consistency, and record uniqueness.

- [ ] **Step 1: Create an isolated worktree from the current `club-site` HEAD**

Use the `using-git-worktrees` skill. Create branch `codex/legacy-member-sheet-import` at:

```text
/Users/vladilen/Documents/ChatGPT/club_bot/.worktrees/club-site-legacy-member-import
```

Run in the worktree:

```bash
git status --short --branch
git log --oneline --decorate -8
```

Expected: clean `codex/legacy-member-sheet-import` based on `4723044`.

- [ ] **Step 2: Write failing audit-schema integration tests**

Extend `src/lib/db/schema.integration.test.ts` to prove:

```ts
const batchId = randomUUID();
await db.insert(memberImportBatches).values({
  id: batchId,
  source: "legacy_google_sheet",
  sourceSnapshotHash: "a".repeat(64),
  expectedCount: 23,
  status: "imported",
  importedAt: new Date("2026-08-29T10:00:00.000Z"),
  consentAttestation: "Owner confirmed participant permission on 2026-08-29",
});

await expect(db.insert(memberImportRecords).values({
  batchId,
  userId: user.id,
  sourceRowReference: "members!2",
  sourceHash: "b".repeat(64),
  consentId: consent.id,
  profileUpdatedAt: new Date("2026-08-29T10:00:00.000Z"),
})).resolves.toBeDefined();
```

Also assert duplicate `(batch_id, source_row_reference)`, invalid hash, zero count, unsupported source/status, and `rolled_back` without `rolled_back_at` fail with PostgreSQL constraint errors.

- [ ] **Step 3: Run the focused integration test and verify red**

```bash
npm run db:up
DATABASE_URL=postgresql://club:club@127.0.0.1:54329/club_test DATABASE_SSL=disable DB_POOL_MAX=2 DB_INTEGRATION_RESET=allow npm run test:integration -- src/lib/db/schema.integration.test.ts
```

Expected: FAIL because audit exports/tables do not exist.

- [ ] **Step 4: Add Drizzle schema exports**

Add these shapes to `src/lib/db/schema.ts`:

```ts
export const memberImportBatches = club.table("member_import_batches", {
  id: uuid("id").primaryKey(),
  source: text("source").$type<"legacy_google_sheet">().notNull(),
  sourceSnapshotHash: text("source_snapshot_hash").notNull(),
  expectedCount: integer("expected_count").notNull(),
  status: text("status").$type<"imported" | "rolled_back">().notNull(),
  importedAt: timestamptz("imported_at").notNull(),
  rolledBackAt: timestamptz("rolled_back_at"),
  consentAttestation: text("consent_attestation").notNull(),
}, (table) => [
  check("member_import_batches_source_check", sql`${table.source} = 'legacy_google_sheet'`),
  check("member_import_batches_hash_check", sql`${table.sourceSnapshotHash} ~ '^[0-9a-f]{64}$'`),
  check("member_import_batches_count_check", sql`${table.expectedCount} > 0`),
  check("member_import_batches_status_check", sql`${table.status} in ('imported', 'rolled_back')`),
  check("member_import_batches_rollback_check", sql`(${table.status} = 'imported' and ${table.rolledBackAt} is null) or (${table.status} = 'rolled_back' and ${table.rolledBackAt} is not null)`),
]);
```

Define `memberImportRecords` with foreign keys to batch, user and consent, primary key `(batchId, userId)`, unique index `(batchId, sourceRowReference)`, a 64-hex source-hash check, and nonblank row-reference check.

- [ ] **Step 5: Generate and inspect migration `0005`**

```bash
DATABASE_URL=postgresql://club:club@127.0.0.1:54329/club_dev npm run db:generate -- --name legacy_member_import_audit
```

Expected: one migration named `0005_legacy_member_import_audit.sql` plus snapshot/journal changes. Inspect the SQL and confirm it creates only the two audit tables, constraints, indexes, and foreign keys.

- [ ] **Step 6: Add audit tables to test cleanup and verify green**

In `src/test/db.integration.setup.ts`, truncate in dependency order:

```sql
club.member_import_records,
club.member_import_batches,
club.user_consents,
...
```

Re-run the focused integration test. Expected: PASS.

- [ ] **Step 7: Commit the schema slice**

```bash
git add src/lib/db/schema.ts src/lib/db/schema.integration.test.ts src/test/db.integration.setup.ts drizzle
git commit -m "feat: add legacy member import audit schema"
```

---

### Task 2: Normalize and Freeze the Source Snapshot

**Files:**
- Create: `club-site/src/lib/member-import/types.ts`
- Create: `club-site/src/lib/member-import/source.ts`
- Create: `club-site/src/lib/member-import/source.test.ts`

**Interfaces:**
- `SourceArtifactSchema`: `{ source, exportedAt, rows[] }`.
- `normalizeTelegramUsername(raw): string`.
- `prepareSourceSnapshot(artifact, expectedCount): PreparedSourceSnapshot`.
- `verifySourceSnapshot(artifact, expectedHash, expectedCount): PreparedSourceSnapshot`.

- [ ] **Step 1: Write failing pure unit tests**

Use only synthetic values. Cover NFC, `@` removal, lowercase, control/whitespace collapse, stable row hashes, exact duplicate collapse, conflicting duplicate rejection, duplicate Telegram ID prevention hook, invalid username, blank fields, and exact expected count.

The fixture contract is:

```ts
const artifact = {
  source: "legacy_google_sheet" as const,
  exportedAt: "2026-08-29T09:00:00.000Z",
  rows: [{
    sourceRowReference: "members!2",
    telegramUsername: " @Synthetic_Expert ",
    displayName: " Синтетический эксперт ",
    freeformProfile: "Работаю с B2B-продуктами. Помогаю с CustDev.",
  }],
};
```

- [ ] **Step 2: Verify red**

```bash
npx vitest run src/lib/member-import/source.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement strict artifact schemas and hashing**

Use Zod strict objects and SHA-256 from `node:crypto`. Normalize every string with NFC, replace Unicode control characters with spaces, collapse whitespace, and trim. Validate username against `^[a-z][a-z0-9_]{4,31}$` after removing one leading `@`.

Compute each source hash from the stable JSON tuple:

```ts
JSON.stringify([telegramUsername, displayName, freeformProfile])
```

Compute the snapshot hash from ordered pairs of retained `sourceRowReference` and `sourceHash`; do not include `exportedAt`.

- [ ] **Step 4: Verify green and commit**

```bash
npx vitest run src/lib/member-import/source.test.ts
git add src/lib/member-import/types.ts src/lib/member-import/source.ts src/lib/member-import/source.test.ts
git commit -m "feat: validate legacy member source snapshots"
```

Expected: focused tests PASS and no real profile data appears in the diff.

---

### Task 3: Validate Structured Profiles and Evidence

**Files:**
- Create: `club-site/src/lib/member-import/profile.ts`
- Create: `club-site/src/lib/member-import/profile.test.ts`

**Interfaces:**
- `MemberExtractionSchema` with `{ value, evidence, confidence }` for scalars and skills.
- `validateExtraction(sourceRow, rawExtraction): ValidatedProfile`.
- `buildCanonicalProfileDocument(profile): string`.
- Error classes: `llm-schema-invalid`, `llm-evidence-invalid`, `profile-validation-failed`.

- [ ] **Step 1: Write failing tests for the complete contract**

Cover valid extraction, missing/extra JSON keys, length limits, 0/13 skills, case-insensitive skill dedupe, evidence containment after identical whitespace normalization, control characters, canonical document length, and aspiration-only evidence.

The aspiration test must reject output such as:

```ts
{
  value: "Разработка мобильных приложений",
  evidence: "Хочу научиться создавать мобильные приложения",
  confidence: "high",
}
```

Accept grounded evidence such as `«Создал и запустил мобильное приложение»`.

- [ ] **Step 2: Verify red**

```bash
npx vitest run src/lib/member-import/profile.test.ts
```

- [ ] **Step 3: Implement deterministic validation**

Use scalar limits matching `club_bot/src/member-profile-text.ts`. Reject evidence whose normalized form is absent from the normalized source. Reject evidence beginning with aspiration-only markers (`хочу`, `хотел бы`, `планирую`, `мечтаю`, `цель`, `интересно научиться`) for expertise/help/skills. Deduplicate skills by normalized lowercase key while preserving the first display spelling.

Build the canonical document with exactly:

```ts
[
  `Имя: ${displayName}`,
  `Профессия и специализация: ${occupation}`,
  `Сфера: ${industry}`,
  `Опыт, сильные стороны и кейсы: ${expertise}`,
  `Может помочь с запросами: ${canHelpWith}`,
  `Навыки, технологии и инструменты: ${skills.join(", ")}`,
].join("\n")
```

- [ ] **Step 4: Verify and commit**

```bash
npx vitest run src/lib/member-import/profile.test.ts
git add src/lib/member-import/profile.ts src/lib/member-import/profile.test.ts
git commit -m "feat: validate imported member profile evidence"
```

---

### Task 4: Add Replaceable Telegram, Access, and LLM Adapters

**Files:**
- Create: `club-site/src/lib/member-import/telegram.ts`
- Create: `club-site/src/lib/member-import/telegram.test.ts`
- Create: `club-site/src/lib/member-import/access.ts`
- Create: `club-site/src/lib/member-import/access.test.ts`
- Create: `club-site/src/lib/member-import/llm.ts`
- Create: `club-site/src/lib/member-import/llm.test.ts`
- Modify: `club-site/package.json`
- Modify: `club-site/package-lock.json`

**Interfaces:**
- `TelegramIdentityResolver.resolve(username): Promise<ResolvedTelegramUser>`.
- `TelegramMembershipVerifier.verify(userId): Promise<MembershipGrant>`.
- `MemberAccessVerifier.verify(userId): Promise<AccessGrant>`.
- `MemberProfileExtractor.extract(row): Promise<unknown>`.

- [ ] **Step 1: Add declared packages**

```bash
npm install openai telegram
npm install --save-dev tsx
```

Do not add credentials or fixed real IDs to package scripts.

- [ ] **Step 2: Write failing adapter tests with injected clients/fetchers**

Cover MTProto `User`, bot, channel, missing user, mismatched username, invalid/not-occupied errors, FloodWait, and safe network classification. Cover Bot API `creator | administrator | member | restricted` as current membership and reject `left | kicked`; reject malformed/error responses.

For access, cover configured admin, successful Nemiling member grant, denied subscription, unavailable provider, and sequential calls. For LLM, cover strict-schema success, one retry for malformed/schema-invalid output, no third attempt, and no logging of source/response.

- [ ] **Step 3: Implement official MTProto resolution**

Use `TelegramClient`, `StringSession("")`, and `Api.contacts.ResolveUsername` from `telegram`. Authenticate with `BOT_TOKEN`, `TELEGRAM_API_ID`, and `TELEGRAM_API_HASH`; keep the session in memory and disconnect in `finally`. Convert GramJS integer IDs to decimal strings and validate positive PostgreSQL bigint before returning them.

- [ ] **Step 4: Implement Bot API membership verification**

POST JSON to `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember` with `chat_id` and `user_id`. Never interpolate the URL into an exception or log. Map only allowlisted statuses to a grant; classify provider errors without response bodies.

- [ ] **Step 5: Implement fresh access verification**

Call `isAdminTelegramId` first. For other IDs call `checkNemilingMember` directly with `getNemilingConfig`, not the shared access cache, so write preflight is fresh. Run sequentially and delay only as needed to stay below Nemiling's three-requests-per-second ceiling.

- [ ] **Step 6: Implement one-profile LLM extraction**

Use `OpenAI` with one-shot settings:

```ts
{
  apiKey: environment.TIMEWEB_AI_TOKEN,
  baseURL: "https://api.timeweb.ai/v1",
  model: "openai/gpt-5.6-luna",
  max_completion_tokens: 1800,
  reasoning_effort: "none",
  response_format: { type: "json_schema", json_schema: { name: "legacy_member_profile", strict: true, schema } },
}
```

If the gateway rejects `json_schema` with HTTP 400, use `json_object` while embedding the same schema in the system prompt. Retry at most once when JSON or local schema validation fails. The prompt explicitly distinguishes demonstrated experience from aspirations and asks for verbatim evidence.

- [ ] **Step 7: Verify and commit**

```bash
npx vitest run src/lib/member-import/telegram.test.ts src/lib/member-import/access.test.ts src/lib/member-import/llm.test.ts
git add package.json package-lock.json src/lib/member-import
git commit -m "feat: verify member identities and extract profiles"
```

---

### Task 5: Build Review Artifacts and Full Preflight

**Files:**
- Modify: `club-site/src/lib/member-import/types.ts`
- Create: `club-site/src/lib/member-import/preflight.ts`
- Create: `club-site/src/lib/member-import/preflight.test.ts`
- Create: `club-site/src/lib/member-import/report.ts`
- Create: `club-site/src/lib/member-import/report.test.ts`

**Interfaces:**
- `prepareReview(snapshot, dependencies): Promise<ReviewArtifact>` returns all rows with `approved: false`.
- `preflightApply({ source, review, expectedCount, batchId, ... }): Promise<ApplyPlan>`.
- `SafeImportReport` includes only batch ID, counts, durations, status, and safe error-class counts.

- [ ] **Step 1: Write failing orchestration tests**

Cover exact duplicate collapse to 23 synthetic unique rows, every dependency called once per retained row, all review rows initially unapproved, duplicate Telegram IDs, any resolver/membership/access/LLM failure, source hash drift, edited structured fields with stale evidence, missing approval, stale access snapshot, database username/ID conflict, current consent policy check, existing idempotent batch, and safe report redaction.

- [ ] **Step 2: Verify red**

```bash
npx vitest run src/lib/member-import/preflight.test.ts src/lib/member-import/report.test.ts
```

- [ ] **Step 3: Implement prepare flow**

For each unique source row, resolve identity, verify group membership, verify access, extract and validate the profile, then emit a review row containing the approved logical columns from the design. Do not copy the freeform biography into the review artifact. Set `status` to `ready`, `review_required`, or `error`; always set `approved: false`.

- [ ] **Step 4: Implement apply preflight**

Validate the immutable source and review artifacts before external calls. Require every row to be `ready` and explicitly approved. Revalidate every field/evidence against its source row, re-resolve Telegram username and membership, obtain a fresh access grant, enforce one ID per row, and run read-only database conflict checks.

Check an existing batch first. If the UUID already has the same source snapshot hash/count and status `imported`, return `already_imported` before external calls. A different hash/count or rolled-back status is `import-batch-conflict`.

- [ ] **Step 5: Implement allowlisted reporting**

Serialize only:

```ts
{
  command,
  batchId,
  mode: "dry-run" | "write",
  status,
  sourceRowCount,
  uniqueRowCount,
  readyCount,
  approvedCount,
  errorCounts,
  durationMs,
}
```

Unit tests must serialize the report and assert it excludes every synthetic username, name, ID, biography, evidence string, token, and database URL placed in test inputs.

- [ ] **Step 6: Verify and commit**

```bash
npx vitest run src/lib/member-import/preflight.test.ts src/lib/member-import/report.test.ts
git add src/lib/member-import
git commit -m "feat: preflight legacy member review batches"
```

---

### Task 6: Apply the Batch Atomically and Idempotently

**Files:**
- Create: `club-site/src/lib/member-import/repository.ts`
- Create: `club-site/src/lib/member-import/repository.integration.test.ts`
- Modify: `club-site/src/lib/users/repository.integration.test.ts`

**Interfaces:**
- `inspectImportBatch(batchId): Promise<ExistingBatch | null>`.
- `inspectIdentityConflicts(rows): Promise<IdentityConflictSummary>`.
- `applyMemberImport(plan): Promise<ApplyResult>`.
- `rollbackMemberImport(batchId, now): Promise<RollbackResult>`.

- [ ] **Step 1: Write failing integration tests**

Use 23 generated synthetic rows. Prove:

- successful import creates exactly 23 eligible view rows and exactly one batch plus 23 records;
- the final-row database failure rolls back users, profiles, consents, subscriptions and audit rows;
- same batch/hash/count is idempotent;
- same batch with changed hash/count conflicts;
- existing role and `llm_personalization` consent are preserved;
- a member subscription uses the actual verified project/tariff/end time;
- an admin has no invented subscription;
- first login reuses the imported user UUID and preserves profile/consent;
- no imported biography/evidence exists in audit tables.

- [ ] **Step 2: Verify red**

```bash
DATABASE_URL=postgresql://club:club@127.0.0.1:54329/club_test DATABASE_SSL=disable DB_POOL_MAX=2 DB_INTEGRATION_RESET=allow npm run test:integration -- src/lib/member-import/repository.integration.test.ts src/lib/users/repository.integration.test.ts
```

- [ ] **Step 3: Implement the single transaction**

Inside one Drizzle transaction, first take a transaction advisory lock:

```sql
SELECT pg_advisory_xact_lock(hashtext('club.legacy_member_import'))
```

Then lock existing users by Telegram ID, recheck username-to-ID conflicts, insert the batch row, create missing users or update only current usernames on existing users, upsert approved profiles with one shared `now`, upsert actual member subscription snapshots, revoke an incompatible active matching consent, insert the current consent and capture its ID, and insert audit records referencing the batch. Do not modify display name for an existing user, personalization consent, progress, updates, or sessions.

Before commit, query `club.member_matching_source` for the imported IDs and require exactly `expectedCount`; throw to roll back otherwise.

- [ ] **Step 4: Verify first-login merge**

Extend `src/lib/users/repository.integration.test.ts` with an imported user containing profile and matching consent, then call `provisionAuthenticatedUser`. Assert same UUID, refreshed Telegram username/avatar/subscription, preserved member profile, and preserved active matching consent.

- [ ] **Step 5: Verify green and commit**

```bash
DATABASE_URL=postgresql://club:club@127.0.0.1:54329/club_test DATABASE_SSL=disable DB_POOL_MAX=2 DB_INTEGRATION_RESET=allow npm run test:integration -- src/lib/member-import/repository.integration.test.ts src/lib/users/repository.integration.test.ts
git add src/lib/member-import/repository.ts src/lib/member-import/repository.integration.test.ts src/lib/users/repository.integration.test.ts
git commit -m "feat: import legacy members atomically"
```

---

### Task 7: Add Conflict-Safe Rollback

**Files:**
- Modify: `club-site/src/lib/member-import/repository.ts`
- Modify: `club-site/src/lib/member-import/repository.integration.test.ts`

- [ ] **Step 1: Write failing rollback tests**

Test untouched profiles, member-edited profiles, already-rolled-back batches, unknown batches, consent already revoked, and a mixed batch containing one modified profile. The mixed batch must return `rollback-user-modified` with zero rollback writes.

- [ ] **Step 2: Implement rollback preflight and transaction**

Before mutation, lock the batch and records. Require `status = imported`. Compare every current profile `updated_at` with recorded `profile_updated_at`; any mismatch aborts the entire rollback. In one transaction, revoke only each recorded `consent_id` still active, set `onboarding_completed_at = NULL` only on profiles with the exact recorded timestamp, then set batch status/time to `rolled_back`.

Do not delete users, profiles, subscriptions, progress, updates, or login history.

- [ ] **Step 3: Verify and commit**

```bash
DATABASE_URL=postgresql://club:club@127.0.0.1:54329/club_test DATABASE_SSL=disable DB_POOL_MAX=2 DB_INTEGRATION_RESET=allow npm run test:integration -- src/lib/member-import/repository.integration.test.ts
git add src/lib/member-import/repository.ts src/lib/member-import/repository.integration.test.ts
git commit -m "feat: rollback untouched member import batches"
```

---

### Task 8: Expose the Explicit CLI and Review Bridge

**Files:**
- Create: `club-site/scripts/member-import.ts`
- Create: `club-site/scripts/member-import.test.ts`
- Modify: `club-site/package.json`
- Modify: `club-site/package-lock.json`
- Modify: `club-site/Dockerfile`
- Modify: `club-site/.gitignore`
- Modify: `club-site/.env.example`

- [ ] **Step 1: Write failing CLI parser tests**

Test `prepare`, `apply`, and `rollback`; dry-run default; required absolute artifact paths; exact positive expected count; UUID batch ID; nonblank consent attestation; rejection of `--write` without all guards; unknown flags; exit codes; and safe JSON output.

- [ ] **Step 2: Implement the CLI entry point**

Add the script:

```json
"member:import": "node --conditions=react-server --import tsx scripts/member-import.ts"
```

Commands:

```bash
npm run member:import -- prepare --source /absolute/source.json --review-output /absolute/review.json --expected-count 23
npm run member:import -- apply --source /absolute/source.json --review /absolute/review.json --batch-id 00000000-0000-4000-8000-000000000001 --expected-count 23 --consent-attestation "owner-confirmed:2026-08-29"
npm run member:import -- apply --source /absolute/source.json --review /absolute/review.json --batch-id 00000000-0000-4000-8000-000000000001 --expected-count 23 --consent-attestation "owner-confirmed:2026-08-29" --write
npm run member:import -- rollback --batch-id 00000000-0000-4000-8000-000000000001
npm run member:import -- rollback --batch-id 00000000-0000-4000-8000-000000000001 --write
```

`prepare` writes the private review artifact with mode `0600`. It refuses to overwrite an existing file. All stdout/stderr uses `SafeImportReport`; operational failures use only documented error classes.

- [ ] **Step 3: Package the CLI without starting it**

Copy `scripts/` and `src/` from the builder into the runner image. Do not add the import command to `CMD`, `start`, `start:deploy`, instrumentation, cron, or application boot.

- [ ] **Step 4: Add secret names and artifact ignores**

Document, without values, that the one-shot CLI may use:

```dotenv
BOT_TOKEN=
TARGET_CHAT_ID=
TELEGRAM_API_ID=
TELEGRAM_API_HASH=
TIMEWEB_AI_TOKEN=
```

Keep these optional for normal site boot. Add `/tmp/member-import/` and `member-import-*.json` to `.gitignore`.

- [ ] **Step 5: Verify and commit**

```bash
npx vitest run scripts/member-import.test.ts
npm run member:import -- --help
docker build -t club-site:legacy-member-import .
docker run --rm club-site:legacy-member-import npm run member:import -- --help
git add scripts/member-import.ts scripts/member-import.test.ts package.json package-lock.json Dockerfile .gitignore .env.example
git commit -m "feat: add guarded legacy member import cli"
```

Expected: tests PASS; both help commands exit 0 without credentials or database access; the image does not run imports on startup.

---

### Task 9: Document the Review, Production, and Rollback Gates

**Files:**
- Create: `club-site/docs/operations/legacy-member-import.md`
- Modify: `club-site/README.md`
- Modify: `club_bot/docs/operations.md`

- [ ] **Step 1: Write the operator runbook**

Document this exact sequence:

1. Export the owner-provided Sheet into a protected source JSON outside both repositories.
2. Run `prepare` locally; create a new private Google Sheet from the review artifact; preserve owner sharing and never publish it.
3. Review all 23 rows, edit fields only with matching evidence, set every final `status=ready` and checkbox `approved=true`, then create a protected review JSON.
4. Re-export/rebuild the source artifact and prove its snapshot hash is unchanged.
5. Run all local gates and dry-run with synthetic/local infrastructure.
6. Obtain explicit authorization for schema/code deploy, perform backup/restore gate, deploy migration and CLI code.
7. Run production dry-run and record only safe counts.
8. Obtain separate explicit authorization for `--write` with exact batch ID/count.
9. Verify site view delta, bot sync state, 1536-dimensional embeddings, pending zero, positive/negative matching, requester exclusion, and inactive mocks.
10. Remove protected local artifacts only after the owner confirms retained review/audit evidence is sufficient.

Include rollback commands and the `rollback-user-modified` manual-resolution path. Explicitly state that this implementation does not prove production import occurred.

- [ ] **Step 2: Add downstream bot verification commands**

In `club_bot/docs/operations.md`, add safe count-only SQL for:

- `club.member_matching_source` baseline/delta;
- web active source count;
- `member_index_state.pending_count`;
- current embedding model/dimensions counts;
- active mock count must remain zero.

No query may print username, Telegram ID, profile text, embedding, or credentials.

- [ ] **Step 3: Run documentation safety checks and commit each repository**

```bash
rg -n "docs.google.com|@[A-Za-z0-9_]{5,}|DATABASE_URL=.*<|BOT_TOKEN=.*[^=]" docs README.md .env.example
git diff --check
```

Expected: no real Sheet URL, username, personal Telegram ID, or credential value in new import docs. Commit `club-site` docs as `docs: operate legacy member import`; commit `club_bot` docs separately as `docs: verify imported member catalogue`.

---

### Task 10: Full Verification and Handoff Before Any Production Action

**Files:**
- Verify all changed files in both repositories.
- Do not create real-data artifacts inside either repository.

- [ ] **Step 1: Run the complete `club-site` gate**

```bash
npm test
DATABASE_URL=postgresql://club:club@127.0.0.1:54329/club_test DATABASE_SSL=disable DB_POOL_MAX=2 DB_INTEGRATION_RESET=allow npm run test:integration
npm run lint
npm run build
git diff --check
git status --short --branch
```

Expected: all commands PASS and only intended commits differ from the base.

- [ ] **Step 2: Run the complete `club_bot` downstream gate**

```bash
npm test
npm run typecheck
npm run build
git diff --check
git status --short --branch
```

Expected: all commands PASS; existing member-source/index/requester-exclusion tests remain green.

- [ ] **Step 3: Run privacy and placeholder scans**

```bash
rg -n "TODO|TBD|placeholder|docs.google.com/spreadsheets|member-import-.*\.json|@[A-Za-z0-9_]{5,}" src scripts docs README.md
git ls-files | rg "member-import-.*\.json|source\.json|review\.json"
```

Expected: no implementation placeholders, source/review artifacts, real Sheet URL, or personal identifiers. Legitimate UI uses of the word `placeholder` must be unrelated pre-existing code and are noted, not changed.

- [ ] **Step 4: Review the final diff against every acceptance criterion**

Confirm: source read-only; review separate/private; exact-count guard; official Telegram identity; group membership; real Nemiling/admin access; evidence validation; all-or-nothing and idempotent apply; first-login merge; view eligibility; conflict-safe rollback; safe logs; inactive mocks; no automatic execution.

- [ ] **Step 5: Stop at the production authorization boundary**

Report completed code/tests and provide the exact next dry-run command with artifact paths redacted. Do not push, deploy, migrate production, access real Telegram identities, call Nemiling for real members, create the real review Sheet, write production rows, or rollback production until the user explicitly authorizes that specific phase after reviewing the gate output.
