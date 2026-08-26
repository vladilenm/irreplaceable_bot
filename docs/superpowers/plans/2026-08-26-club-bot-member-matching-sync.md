# Club Bot Member Matching Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Synchronize consented expert profiles from `club.member_matching_source` into the bot-owned member directory, index only changed canonical documents, exclude the requester by Telegram ID, and safely replace the production mock catalogue.

**Architecture:** `club-bot` reads one full read-only PostgreSQL snapshot at startup and every five minutes. Structural read failures leave the previous catalogue intact; a successful snapshot atomically upserts accepted `source = 'web'` records, deactivates missing/rejected web records, and records source state before incremental embedding. The existing exact pgvector top-20, LLM reranking, evidence validation, and 3–5-result publication pipeline stay intact.

**Tech Stack:** Node.js 22+, TypeScript 6, PostgreSQL 16 + pgvector, `pg`, Zod 3, OpenAI-compatible Timeweb AI Gateway, grammY, node-cron, Vitest.

## Global Constraints

- Project root: `/Users/vladilen/Documents/ChatGPT/club_bot`.
- Required upstream contract: `/Users/vladilen/Documents/тнз/club-site` has applied its site-plan migration and exposes `club.member_matching_source` with the ten approved columns.
- Keep the seven required production environment variables unchanged. The existing `DATABASE_URL` login receives `club_bot_reader` membership; do not add a second bot database URL.
- Runtime source schedule is exactly `*/5 * * * *` in `src/runtime-defaults.ts`, not an env value.
- Supported consent versions are an explicit runtime constant containing only `member-matching-v1` for v1.
- PostgreSQL/TypeScript identity is `BIGINT`/decimal string. Never convert the cross-project Telegram ID to a JavaScript `number`.
- New `source = 'web'` records require Telegram ID. The new bot column remains nullable so old runtime and inactive mock records remain rollback-compatible.
- The canonical document is labeled, NFC-normalized, control-character-free, whitespace-normalized, deterministic, and at most 2500 characters. Never silently truncate an over-limit card.
- Embeddings remain 1536-dimensional and use the deployment's configured embedding model. This feature must not independently change the model.
- A vector is searchable only when model, dimensions, and embedding content hash match the active member content hash.
- Keep exact top-20 search, LLM shortlist-only selection, code-owned usernames, verbatim evidence validation, and the minimum-three rule.
- Structural snapshot failure must not deactivate any existing web card. A successful empty snapshot must deactivate every web card.
- Do not log request text, profile fields, canonical documents, prompts, model responses, embeddings, Telegram credentials, or database URLs.
- Mock deactivation, production migration, deploy, and push require a separate explicit user instruction.

---

### Task 1: Add stable Telegram identity and persistent source-sync state

**Files:**
- Modify: `src/db/migrations.ts`
- Modify: `src/db/migrations.test.ts`
- Modify: `src/members.ts`
- Modify: `src/member-directory.service.ts`
- Modify: `src/member-directory.service.test.ts`
- Modify fixture builders in: `src/members.repository.test.ts`, `src/member.seed.ts`, `src/member.seed.test.ts`, `src/request.runtime.test.ts`, `src/migrate-sqlite.ts`, `src/migrate-sqlite.test.ts`

**Interfaces:**
- Consumes: existing `members`, `member_embeddings`, and `member_index_state` tables.
- Produces: nullable `members.telegram_user_id BIGINT`, partial unique index `idx_members_telegram_user_id_uidx`, table `member_source_state`, `MemberSourceRecord.telegramUserId: string | null`, and canonical hashing over `profileText` alone.

- [ ] **Step 1: Add failing migration assertions**

Append to `src/db/migrations.test.ts`:

```ts
it('adds stable Telegram identity and source snapshot state', async () => {
  await runMigrations(pool);

  const columns = await pool.query<{ column_name: string; is_nullable: string }>(`
    SELECT column_name, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'members'
      AND column_name = 'telegram_user_id'
  `);
  expect(columns.rows).toEqual([
    { column_name: 'telegram_user_id', is_nullable: 'YES' },
  ]);

  const index = await pool.query<{ indexname: string }>(`
    SELECT indexname FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'idx_members_telegram_user_id_uidx'
  `);
  expect(index.rows).toEqual([
    { indexname: 'idx_members_telegram_user_id_uidx' },
  ]);

  const sourceState = await pool.query<{ present: string | null }>(
    "SELECT to_regclass('public.member_source_state')::text AS present",
  );
  expect(sourceState.rows[0]?.present).toBe('member_source_state');
});
```

- [ ] **Step 2: Run the migration test and verify the new schema is absent**

Run:

```bash
docker compose -f docker-compose.test.yml up -d
npm test -- src/db/migrations.test.ts
```

Expected: FAIL because migration version 3 does not exist.

- [ ] **Step 3: Add PostgreSQL migration version 3**

Append to `POSTGRES_MIGRATIONS` in `src/db/migrations.ts`:

```ts
{
  version: 3,
  description: 'Add web member identity and source snapshot state',
  sql: `
    ALTER TABLE members ADD COLUMN telegram_user_id bigint;
    CREATE UNIQUE INDEX idx_members_telegram_user_id_uidx
      ON members(telegram_user_id)
      WHERE telegram_user_id IS NOT NULL;

    CREATE TABLE member_source_state (
      provider text PRIMARY KEY CHECK (provider = 'web'),
      generation bigint NOT NULL CHECK (generation >= 1),
      last_success_at timestamptz NOT NULL,
      fetched_count integer NOT NULL CHECK (fetched_count >= 0),
      active_count integer NOT NULL CHECK (active_count >= 0),
      rejected_count integer NOT NULL CHECK (rejected_count >= 0),
      deactivated_count integer NOT NULL CHECK (deactivated_count >= 0)
    );
  `,
},
```

Update the expected table list in the existing schema test to include `member_source_state`.

- [ ] **Step 4: Change the domain record and canonical hash contract**

In `src/members.ts`, use:

```ts
export interface MemberSourceRecord {
  source: 'mock' | 'web' | 'notion';
  externalId: string;
  telegramUserId: string | null;
  displayName: string;
  telegramUsername: string;
  profileText: string;
  sourceUpdatedAt: string;
  active: boolean;
}
```

Change canonical input to the already labeled complete document:

```ts
export function canonicalSearchText(
  member: Pick<MemberSourceRecord, 'profileText'>,
): string {
  return member.profileText;
}
```

`memberContentHash()` continues to SHA-256 the exact return value.

- [ ] **Step 5: Make normalization reject, rather than truncate, invalid web contracts**

In `src/member-directory.service.ts`, replace slice-based normalization with:

```ts
function normalizeVisibleText(raw: string, maxLength: number, field: string): string {
  const value = raw
    .normalize('NFC')
    .replace(/[\p{C}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (value.length > maxLength) throw new Error(`member-${field}-too-long`);
  return value;
}

function normalizeProfileText(raw: string): string {
  const value = raw
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[\p{C}]/gu, '').replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
  if (value.length > 2500) throw new Error('member-profile-text-too-long');
  return value;
}

function normalizeTelegramUserId(raw: string | null): string | null {
  if (raw === null) return null;
  const value = raw.trim();
  if (!/^[1-9]\d*$/.test(value)) throw new Error('member-telegram-id-invalid');
  return value;
}
```

Finish `normalizeMemberCard()` with the exact field ownership rules:

```ts
const externalId = normalizeVisibleText(record.externalId, 256, 'external-id');
if (externalId === '') throw new Error('member-external-id-required');
const telegramUserId = normalizeTelegramUserId(record.telegramUserId);
if (record.source === 'web' && telegramUserId === null) {
  throw new Error('member-telegram-id-required');
}
const displayName = normalizeVisibleText(record.displayName, 200, 'display-name');
const telegramUsername = normalizeTelegramUsername(record.telegramUsername);
const profileText = normalizeProfileText(record.profileText);
const sourceUpdatedAt = new Date(record.sourceUpdatedAt);
if (Number.isNaN(sourceUpdatedAt.getTime())) {
  throw new Error('member-source-updated-at-invalid');
}
return {
  ...record,
  externalId,
  telegramUserId,
  displayName,
  telegramUsername,
  profileText,
  sourceUpdatedAt: sourceUpdatedAt.toISOString(),
  active: record.active
    && displayName !== ''
    && telegramUsername !== ''
    && profileText !== '',
};
```

`normalizeVisibleText()` applies limits 256 for external ID and 200 for display name. `normalizeProfileText()` preserves the six line breaks. Mock/notion records remain nullable for compatibility.

- [ ] **Step 6: Update all record fixtures explicitly**

Every `MemberSourceRecord` fixture must add either:

```ts
telegramUserId: null,
```

for mock/notion compatibility, or a positive decimal string for web fixtures:

```ts
telegramUserId: '94659185',
```

Update the canonical-text expectation in `member-directory.service.test.ts` from `Анна Иванова\nB2B SaaS` to the exact supplied `profileText`. Add a test that a 2501-character profile and a web card without Telegram ID throw safe error codes and never reach `repository.upsertCards`.

- [ ] **Step 7: Run migration and domain tests**

Run:

```bash
npm test -- src/db/migrations.test.ts src/member-directory.service.test.ts src/member.seed.test.ts src/migrate-sqlite.test.ts
npm run typecheck
```

Expected: PASS; the legacy seed/import paths compile with nullable IDs, and no field is silently truncated.

- [ ] **Step 8: Commit the backward-compatible identity foundation**

```bash
git add src/db/migrations.ts src/db/migrations.test.ts src/members.ts src/member-directory.service.ts src/member-directory.service.test.ts src/members.repository.test.ts src/member.seed.ts src/member.seed.test.ts src/request.runtime.test.ts src/migrate-sqlite.ts src/migrate-sqlite.test.ts
git commit -m "feat: add stable member Telegram identity"
```

### Task 2: Read and validate the site-owned view

**Files:**
- Create: `src/member-source.repository.ts`
- Create: `src/member-source.repository.test.ts`
- Create: `src/member-profile-text.ts`
- Create: `src/member-profile-text.test.ts`

**Interfaces:**
- Consumes: view columns `telegram_user_id`, `telegram_username`, `display_name`, `occupation`, `industry`, `expertise`, `can_help_with`, `skills`, `consent_policy_version`, `source_updated_at`.
- Produces: `ClubMemberSourceRow`, `MemberSourceRepository.readSnapshot(): Promise<readonly ClubMemberSourceRow[]>`, and `projectClubMember(row, supportedPolicies): MemberProjection`.

- [ ] **Step 1: Write failing canonical-document tests**

Create `src/member-profile-text.test.ts` with this fixture and expectations:

```ts
import { expect, it } from 'vitest';
import { projectClubMember } from './member-profile-text.js';
import type { ClubMemberSourceRow } from './member-source.repository.js';

const row = (overrides: Partial<ClubMemberSourceRow> = {}): ClubMemberSourceRow => ({
  telegramUserId: '94659185',
  telegramUsername: 'Vladilen_Minin',
  displayName: ' Владилен\u0000  Минин ',
  occupation: ' Автор и\nпреподаватель ',
  industry: ' EdTech ',
  expertise: ' Запустил  несколько продуктов ',
  canHelpWith: ' Упаковка экспертизы ',
  skills: [' Product strategy ', 'EdTech', 'Product  strategy'],
  consentPolicyVersion: 'member-matching-v1',
  sourceUpdatedAt: '2026-08-26T10:00:00.000Z',
  ...overrides,
});

it('builds the deterministic labeled expert document', () => {
  expect(projectClubMember(row(), new Set(['member-matching-v1']))).toEqual({
    accepted: true,
    record: {
      source: 'web',
      externalId: '94659185',
      telegramUserId: '94659185',
      displayName: 'Владилен Минин',
      telegramUsername: 'vladilen_minin',
      profileText: [
        'Имя: Владилен Минин',
        'Профессия и специализация: Автор и преподаватель',
        'Сфера: EdTech',
        'Опыт, сильные стороны и кейсы: Запустил несколько продуктов',
        'Может помочь с запросами: Упаковка экспертизы',
        'Навыки, технологии и инструменты: Product strategy, EdTech',
      ].join('\n'),
      sourceUpdatedAt: '2026-08-26T10:00:00.000Z',
      active: true,
    },
  });
});

it('rejects unsupported consent without exposing profile values', () => {
  expect(projectClubMember(
    row({ consentPolicyVersion: 'member-matching-v2' }),
    new Set(['member-matching-v1']),
  )).toEqual({ accepted: false, reason: 'unsupported-consent-version' });
});
```

Add these exact boundary assertions:

```ts
it.each([
  [{ telegramUsername: 'bad name' }, 'invalid-telegram-username'],
  [{ occupation: '   ' }, 'invalid-profile-field'],
  [{ skills: [] }, 'invalid-profile-field'],
  [{ sourceUpdatedAt: 'not-a-date' }, 'invalid-profile-field'],
] as const)('rejects an invalid card with a safe reason', (overrides, reason) => {
  expect(projectClubMember(
    row(overrides),
    new Set(['member-matching-v1']),
  )).toEqual({ accepted: false, reason });
});

it('keeps the maximum valid card within the document ceiling', () => {
  const result = projectClubMember(row({
    displayName: 'x'.repeat(80),
    occupation: 'x'.repeat(100),
    industry: 'x'.repeat(100),
    expertise: 'x'.repeat(1000),
    canHelpWith: 'x'.repeat(700),
    skills: Array.from({ length: 12 }, (_, index) =>
      String(index).padEnd(30, 'x')),
  }), new Set(['member-matching-v1']));
  expect(result.accepted).toBe(true);
  if (result.accepted) {
    expect(result.record.profileText.length).toBeLessThanOrEqual(2500);
  }
});

it('deduplicates skills after normalization', () => {
  const result = projectClubMember(row({
    skills: ['Product strategy', ' Product  strategy '],
  }), new Set(['member-matching-v1']));
  expect(result.accepted).toBe(true);
  if (result.accepted) {
    expect(result.record.profileText.match(/Product strategy/g) ?? []).toHaveLength(1);
  }
});
```

- [ ] **Step 2: Run the test and verify the projection module is missing**

Run:

```bash
npm test -- src/member-profile-text.test.ts
```

Expected: FAIL because `member-profile-text.ts` does not exist.

- [ ] **Step 3: Implement the projection boundary**

Create `src/member-profile-text.ts` with this public result type:

Control characters in source fields are replaced with a normalizable space before
whitespace collapse. They never remain in the canonical document, but a control
between words preserves the word boundary: `Автор и\nпреподаватель` becomes
`Автор и преподаватель`.

```ts
export type MemberProjection =
  | { accepted: true; record: MemberSourceRecord }
  | {
      accepted: false;
      reason:
        | 'unsupported-consent-version'
        | 'invalid-telegram-id'
        | 'invalid-telegram-username'
        | 'invalid-profile-field'
        | 'profile-document-too-long';
    };

const scalar = (raw: string, maxLength: number): string | null => {
  const value = raw
    .normalize('NFC')
    .replace(/[\p{C}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return value !== '' && value.length <= maxLength ? value : null;
};

export function projectClubMember(
  row: ClubMemberSourceRow,
  supportedPolicies: ReadonlySet<string>,
): MemberProjection {
  if (!supportedPolicies.has(row.consentPolicyVersion)) {
    return { accepted: false, reason: 'unsupported-consent-version' };
  }
  if (!/^[1-9]\d*$/.test(row.telegramUserId)) {
    return { accepted: false, reason: 'invalid-telegram-id' };
  }
  const telegramUsername = row.telegramUsername.trim().replace(/^@/, '').toLowerCase();
  if (!/^[a-z][a-z0-9_]{4,31}$/.test(telegramUsername)) {
    return { accepted: false, reason: 'invalid-telegram-username' };
  }
  const displayName = scalar(row.displayName, 80);
  const occupation = scalar(row.occupation, 100);
  const industry = scalar(row.industry, 100);
  const expertise = scalar(row.expertise, 1000);
  const canHelpWith = scalar(row.canHelpWith, 700);
  const normalizedSkills = row.skills.map((skill) => scalar(skill, 30));
  if (normalizedSkills.some((skill) => skill === null)) {
    return { accepted: false, reason: 'invalid-profile-field' };
  }
  const skills = [...new Set(normalizedSkills as string[])];
  if (!displayName || !occupation || !industry || !expertise || !canHelpWith
    || skills.length === 0 || skills.length > 12) {
    return { accepted: false, reason: 'invalid-profile-field' };
  }
  const sourceUpdatedAt = new Date(row.sourceUpdatedAt);
  if (Number.isNaN(sourceUpdatedAt.getTime())) {
    return { accepted: false, reason: 'invalid-profile-field' };
  }
  const profileText = [
    `Имя: ${displayName}`,
    `Профессия и специализация: ${occupation}`,
    `Сфера: ${industry}`,
    `Опыт, сильные стороны и кейсы: ${expertise}`,
    `Может помочь с запросами: ${canHelpWith}`,
    `Навыки, технологии и инструменты: ${skills.join(', ')}`,
  ].join('\n');
  if (profileText.length > 2500) {
    return { accepted: false, reason: 'profile-document-too-long' };
  }
  return {
    accepted: true,
    record: {
      source: 'web',
      externalId: row.telegramUserId,
      telegramUserId: row.telegramUserId,
      displayName,
      telegramUsername,
      profileText,
      sourceUpdatedAt: sourceUpdatedAt.toISOString(),
      active: true,
    },
  };
}
```

Import `MemberSourceRecord` and `ClubMemberSourceRow` as types. Catch no arbitrary exception; the function above maps only known validation failures to safe reason codes.

- [ ] **Step 4: Write failing view-reader tests against a real PostgreSQL view fixture**

In `src/member-source.repository.test.ts`, use `createTestPool()`. In setup, drop/recreate only schema `club`, create a backing table with the ten contract columns, and expose a view:

```sql
CREATE SCHEMA club;
CREATE TABLE club.member_matching_fixture (
  telegram_user_id bigint NOT NULL,
  telegram_username text NOT NULL,
  display_name text NOT NULL,
  occupation text NOT NULL,
  industry text NOT NULL,
  expertise text NOT NULL,
  can_help_with text NOT NULL,
  skills text[] NOT NULL,
  consent_policy_version text NOT NULL,
  source_updated_at timestamptz NOT NULL
);
CREATE VIEW club.member_matching_source AS
SELECT * FROM club.member_matching_fixture;
```

Assert `readSnapshot()` returns bigint as a decimal string and timestamps as ISO strings. Add a duplicate Telegram ID case and expect rejection with `duplicate-member-source-id`; rename one fixture column and expect the PostgreSQL read to fail without returning an empty array.

- [ ] **Step 5: Implement the read-only repository**

Create `src/member-source.repository.ts`:

```ts
import type { Pool } from 'pg';

export interface ClubMemberSourceRow {
  telegramUserId: string;
  telegramUsername: string;
  displayName: string;
  occupation: string;
  industry: string;
  expertise: string;
  canHelpWith: string;
  skills: string[];
  consentPolicyVersion: string;
  sourceUpdatedAt: string;
}

export interface MemberSourceRepository {
  readSnapshot(): Promise<readonly ClubMemberSourceRow[]>;
}

export class PgMemberSourceRepository implements MemberSourceRepository {
  constructor(private readonly pool: Pool) {}

  async readSnapshot(): Promise<readonly ClubMemberSourceRow[]> {
    const result = await this.pool.query<{
      telegram_user_id: string;
      telegram_username: string;
      display_name: string;
      occupation: string;
      industry: string;
      expertise: string;
      can_help_with: string;
      skills: string[];
      consent_policy_version: string;
      source_updated_at: Date;
    }>(`
      SELECT telegram_user_id, telegram_username, display_name, occupation,
        industry, expertise, can_help_with, skills, consent_policy_version,
        source_updated_at
      FROM club.member_matching_source
      ORDER BY telegram_user_id
    `);
    const seen = new Set<string>();
    return result.rows.map((row) => {
      const telegramUserId = String(row.telegram_user_id);
      if (!/^[1-9]\d*$/.test(telegramUserId)) {
        throw new Error('invalid-member-source-id');
      }
      if (seen.has(telegramUserId)) throw new Error('duplicate-member-source-id');
      seen.add(telegramUserId);
      if ([
        row.telegram_username,
        row.display_name,
        row.occupation,
        row.industry,
        row.expertise,
        row.can_help_with,
        row.consent_policy_version,
      ].some((value) => typeof value !== 'string')
        || !(row.source_updated_at instanceof Date)
        || Number.isNaN(row.source_updated_at.getTime())
        || !Array.isArray(row.skills)
        || row.skills.some((skill) => typeof skill !== 'string')) {
        throw new Error('invalid-member-source-row');
      }
      return {
        telegramUserId,
        telegramUsername: row.telegram_username,
        displayName: row.display_name,
        occupation: row.occupation,
        industry: row.industry,
        expertise: row.expertise,
        canHelpWith: row.can_help_with,
        skills: row.skills,
        consentPolicyVersion: row.consent_policy_version,
        sourceUpdatedAt: row.source_updated_at.toISOString(),
      };
    });
  }
}
```

Do not catch SQL or structural errors in this repository. The sync service needs them to fail the entire snapshot.

- [ ] **Step 6: Run source boundary tests**

Run:

```bash
npm test -- src/member-profile-text.test.ts src/member-source.repository.test.ts
```

Expected: PASS; SQL/schema failures reject and never become `[]`.

- [ ] **Step 7: Commit the source adapter**

```bash
git add src/member-source.repository.ts src/member-source.repository.test.ts src/member-profile-text.ts src/member-profile-text.test.ts
git commit -m "feat: read consented site member profiles"
```

### Task 3: Atomically replace a complete web snapshot

**Files:**
- Modify: `src/members.repository.ts`
- Modify: `src/members.repository.test.ts`

**Interfaces:**
- Consumes: normalized `MemberSourceRecord[]` from Task 2.
- Produces: `replaceSourceSnapshot(input): Promise<MemberSourceStatus>`, `readSourceStatus('web')`, and atomic absence deactivation.

- [ ] **Step 1: Add failing repository tests for snapshot semantics**

Add these interfaces to the test imports and write these exact primary cases:

```ts
it('atomically replaces a complete web snapshot', async () => {
  const first = [
    member('1001', 'Имя: Первый', {
      source: 'web',
      telegramUserId: '1001',
      telegramUsername: 'first_user',
    }),
    member('1002', 'Имя: Второй', {
      source: 'web',
      telegramUserId: '1002',
      telegramUsername: 'second_user',
    }),
  ];
  await repo.replaceSourceSnapshot({
    source: 'web',
    records: first,
    fetchedCount: 2,
    rejectedCount: 0,
    completedAt: new Date('2026-08-26T10:00:00.000Z'),
  });

  const status = await repo.replaceSourceSnapshot({
    source: 'web',
    records: [first[0]!],
    fetchedCount: 1,
    rejectedCount: 0,
    completedAt: new Date('2026-08-26T10:05:00.000Z'),
  });
  expect(status).toMatchObject({
    generation: 2,
    fetchedCount: 1,
    activeCount: 1,
    rejectedCount: 0,
    deactivatedCount: 1,
  });
  expect(await repo.readSourceStatus('web')).toEqual(status);
});

it('accepts a successful empty snapshot', async () => {
  await repo.replaceSourceSnapshot({
    source: 'web',
    records: [member('1001', 'Имя: Первый', {
      source: 'web', telegramUserId: '1001', telegramUsername: 'first_user',
    })],
    fetchedCount: 1,
    rejectedCount: 0,
    completedAt: new Date('2026-08-26T10:00:00.000Z'),
  });
  const status = await repo.replaceSourceSnapshot({
    source: 'web',
    records: [],
    fetchedCount: 0,
    rejectedCount: 0,
    completedAt: new Date('2026-08-26T10:05:00.000Z'),
  });
  expect(status).toMatchObject({ activeCount: 0, deactivatedCount: 1 });
});
```

Add a transaction-failure test with a duplicate Telegram ID and assert both the active rows and previous `member_source_state` remain unchanged.

- [ ] **Step 2: Run the focused repository test**

Run:

```bash
npm test -- src/members.repository.test.ts
```

Expected: FAIL because the snapshot methods do not exist.

- [ ] **Step 3: Add exact repository interfaces**

In `src/members.repository.ts`, define:

```ts
export interface ReplaceMemberSourceSnapshotInput {
  source: 'web';
  records: readonly MemberSourceRecord[];
  fetchedCount: number;
  rejectedCount: number;
  completedAt: Date;
}

export interface MemberSourceStatus {
  provider: 'web';
  generation: number;
  lastSuccessAt: string;
  fetchedCount: number;
  activeCount: number;
  rejectedCount: number;
  deactivatedCount: number;
}
```

Extend `MemberRepository`:

```ts
replaceSourceSnapshot(
  input: ReplaceMemberSourceSnapshotInput,
): Promise<MemberSourceStatus>;
readSourceStatus(source: 'web'): Promise<MemberSourceStatus | null>;
```

- [ ] **Step 4: Include Telegram ID in all PostgreSQL card reads/writes**

Add `telegram_user_id` to `upsertCards`, `PendingMemberRow`, `readPending`, and record mapping. Use the nullable record value as a query parameter; do not cast it through `Number()`.

- [ ] **Step 5: Implement transactional full replacement**

Extract this shared helper above `PgMemberRepository` and call it from both `upsertCards()` and `replaceSourceSnapshot()`:

```ts
async function upsertMemberWithClient(
  client: PoolClient,
  record: MemberSourceRecord,
): Promise<number> {
  const result = await client.query(`
    INSERT INTO members (
      member_id, source, external_id, telegram_user_id, display_name,
      telegram_username, profile_text, content_hash, source_updated_at,
      active, updated_at
    ) VALUES ($1, $2, $3, $4::bigint, $5, $6, $7, $8, $9, $10, now())
    ON CONFLICT(member_id) DO UPDATE SET
      source = EXCLUDED.source,
      external_id = EXCLUDED.external_id,
      telegram_user_id = EXCLUDED.telegram_user_id,
      display_name = EXCLUDED.display_name,
      telegram_username = EXCLUDED.telegram_username,
      profile_text = EXCLUDED.profile_text,
      content_hash = EXCLUDED.content_hash,
      source_updated_at = EXCLUDED.source_updated_at,
      active = EXCLUDED.active,
      updated_at = now()
  `, [
    buildMemberId(record.source, record.externalId),
    record.source,
    record.externalId,
    record.telegramUserId,
    record.displayName,
    record.telegramUsername,
    record.profileText,
    memberContentHash(record),
    record.sourceUpdatedAt,
    record.active,
  ]);
  return result.rowCount ?? 0;
}
```

Inside `replaceSourceSnapshot()`:

```ts
return withTransaction(this.pool, async (client) => {
  await client.query('SELECT pg_advisory_xact_lock($1)', [620260823]);
  const ids = new Set<string>();
  const telegramIds = new Set<string>();
  for (const record of input.records) {
    if (record.source !== input.source || record.telegramUserId === null || !record.active) {
      throw new Error('invalid-web-snapshot-record');
    }
    const memberId = buildMemberId(record.source, record.externalId);
    if (ids.has(memberId) || telegramIds.has(record.telegramUserId)) {
      throw new Error('duplicate-web-snapshot-record');
    }
    ids.add(memberId);
    telegramIds.add(record.telegramUserId);
  }

  for (const record of input.records) {
    await upsertMemberWithClient(client, record);
  }

  const deactivated = await client.query(`
    UPDATE members
    SET active = false, updated_at = $3
    WHERE source = $1
      AND active = true
      AND NOT (member_id = ANY($2::text[]))
  `, [input.source, [...ids], input.completedAt]);

  const previous = await client.query<{ generation: string }>(`
    SELECT generation FROM member_source_state WHERE provider = $1
  `, [input.source]);
  const generation = Number(previous.rows[0]?.generation ?? 0) + 1;
  const deactivatedCount = deactivated.rowCount ?? 0;
  await client.query(`
    INSERT INTO member_source_state (
      provider, generation, last_success_at, fetched_count, active_count,
      rejected_count, deactivated_count
    ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT(provider) DO UPDATE SET
      generation = EXCLUDED.generation,
      last_success_at = EXCLUDED.last_success_at,
      fetched_count = EXCLUDED.fetched_count,
      active_count = EXCLUDED.active_count,
      rejected_count = EXCLUDED.rejected_count,
      deactivated_count = EXCLUDED.deactivated_count
  `, [
    input.source,
    generation,
    input.completedAt,
    input.fetchedCount,
    input.records.length,
    input.rejectedCount,
    deactivatedCount,
  ]);
  return {
    provider: input.source,
    generation,
    lastSuccessAt: input.completedAt.toISOString(),
    fetchedCount: input.fetchedCount,
    activeCount: input.records.length,
    rejectedCount: input.rejectedCount,
    deactivatedCount,
  };
});
```

Require `record.active === true` in the web snapshot validation condition. `upsertCards()` sums the numeric return value from `upsertMemberWithClient()` so the mock seed retains its current result contract.

- [ ] **Step 6: Implement `readSourceStatus()` and rerun tests**

Map PostgreSQL bigint generation through `Number()` only after reading it as an internal counter; Telegram IDs remain strings. Run:

```bash
npm test -- src/members.repository.test.ts
npm run typecheck
```

Expected: PASS for nonempty, empty, duplicate, rollback, pending-vector, and exact-search cases.

- [ ] **Step 7: Commit atomic snapshot persistence**

```bash
git add src/members.repository.ts src/members.repository.test.ts
git commit -m "feat: replace web member snapshots atomically"
```

### Task 4: Orchestrate single-flight snapshot and incremental indexing

**Files:**
- Create: `src/member-sync.service.ts`
- Create: `src/member-sync.service.test.ts`
- Modify: `src/member-directory.service.ts`
- Modify: `src/member-directory.service.test.ts`

**Interfaces:**
- Consumes: Task 2 `MemberSourceRepository` and projection; Task 3 snapshot persistence; existing `MemberDirectoryService.indexPending()`.
- Produces: `MemberSyncService.sync()`, `MemberSyncService.startupAttempt(timeoutMs)`, `MemberSyncService.hasSuccessfulSnapshot()`, safe count-only logs, and process-local single-flight.

- [ ] **Step 1: Write failing service tests for complete, rejected, failed, and concurrent snapshots**

Create fakes for source, members, and directory. Assert:

```ts
it('commits accepted rows, deactivates rejected rows, then indexes pending cards', async () => {
  const source = { readSnapshot: vi.fn().mockResolvedValue([
    sourceRow({ telegramUserId: '1001' }),
    sourceRow({ telegramUserId: '1002', consentPolicyVersion: 'member-matching-v2' }),
  ]) };
  const members = memberRepository();
  const directory = { indexPending: vi.fn().mockResolvedValue({ indexed: 1, failed: 0 }) };
  const service = new MemberSyncService({
    source,
    members,
    directory,
    supportedPolicies: new Set(['member-matching-v1']),
    now: () => new Date('2026-08-26T10:00:00.000Z'),
  });

  await expect(service.sync()).resolves.toMatchObject({
    fetched: 2,
    accepted: 1,
    rejected: 1,
    indexed: 1,
    failed: 0,
  });
  expect(members.replaceSourceSnapshot).toHaveBeenCalledWith(
    expect.objectContaining({ fetchedCount: 2, rejectedCount: 1 }),
  );
  expect(directory.indexPending).toHaveBeenCalledWith(1000);
});
```

Also assert: a rejected `readSnapshot()` never calls `replaceSourceSnapshot`; an empty successful read commits `records: []`; two simultaneous `sync()` calls share one source read; `startupAttempt(10)` returns `timed-out` while keeping the observed sync promise alive; `hasSuccessfulSnapshot()` is false before any state and true afterward; serialized logs do not contain a secret profile fixture.

- [ ] **Step 2: Run the service test and verify the module is missing**

Run:

```bash
npm test -- src/member-sync.service.test.ts
```

Expected: FAIL because the sync service does not exist.

- [ ] **Step 3: Implement the public sync result and single-flight**

Create `src/member-sync.service.ts` with:

```ts
export interface MemberSyncResult {
  fetched: number;
  accepted: number;
  rejected: number;
  deactivated: number;
  indexed: number;
  failed: number;
}

export type StartupSyncResult = 'completed' | 'failed' | 'timed-out';

export class MemberSyncService {
  private running: Promise<MemberSyncResult> | null = null;

  constructor(private readonly deps: {
    source: MemberSourceRepository;
    members: MemberRepository;
    directory: Pick<MemberDirectoryService, 'indexPending'>;
    supportedPolicies: ReadonlySet<string>;
    now?: () => Date;
  }) {}

  sync(): Promise<MemberSyncResult> {
    if (this.running) return this.running;
    this.running = this.runOnce().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async runOnce(): Promise<MemberSyncResult> {
    const startedAtMs = Date.now();
    logger.info({ event: 'member-sync-started' }, 'Member source sync started');
    const rows = await this.deps.source.readSnapshot();
    const records: MemberSourceRecord[] = [];
    let rejected = 0;
    for (const row of rows) {
      const projected = projectClubMember(row, this.deps.supportedPolicies);
      if (projected.accepted) records.push(projected.record);
      else rejected += 1;
    }
    const completedAt = (this.deps.now ?? (() => new Date()))();
    const sourceStatus = await this.deps.members.replaceSourceSnapshot({
      source: 'web',
      records,
      fetchedCount: rows.length,
      rejectedCount: rejected,
      completedAt,
    });
    const index = await this.deps.directory.indexPending(1000);
    const result = {
      fetched: rows.length,
      accepted: records.length,
      rejected,
      deactivated: sourceStatus.deactivatedCount,
      indexed: index.indexed,
      failed: index.failed,
    };
    logger.info(
      {
        event: 'member-sync-complete',
        ...result,
        durationMs: Date.now() - startedAtMs,
      },
      'Member source sync complete',
    );
    return result;
  }
}
```

Import `logger`, `projectClubMember`, `MemberDirectoryService`, `MemberRepository`, `MemberSourceRepository`, and `MemberSourceRecord` from their focused modules. Do not catch `readSnapshot()` or transaction errors here: the caller logs only their error class, and the repository transaction preserves the previous snapshot.

- [ ] **Step 4: Implement bounded startup observation and readiness**

Use an observed race so a timeout does not produce an unhandled rejection:

```ts
async startupAttempt(timeoutMs: number): Promise<StartupSyncResult> {
  const observed = this.sync().then(
    () => 'completed' as const,
    () => 'failed' as const,
  );
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<'timed-out'>((resolve) => {
    timeout = setTimeout(() => resolve('timed-out'), timeoutMs);
  });
  const result = await Promise.race([observed, timedOut]);
  if (timeout) clearTimeout(timeout);
  return result;
}

async hasSuccessfulSnapshot(): Promise<boolean> {
  return (await this.deps.members.readSourceStatus('web')) !== null;
}
```

- [ ] **Step 5: Keep per-card embedding failure isolation**

Retain the current 100-record embedding batches, per-vector write catches, and `recordIndexStatus('postgres', ...)` provider in `MemberDirectoryService`. Do not make a failed embedding roll back a successful source snapshot.

- [ ] **Step 6: Run service and directory tests**

Run:

```bash
npm test -- src/member-sync.service.test.ts src/member-directory.service.test.ts
npm run typecheck
```

Expected: PASS; structural fetch failure preserves the old snapshot, while individual projection/embedding failures do not block other cards.

- [ ] **Step 7: Commit sync orchestration**

```bash
git add src/member-sync.service.ts src/member-sync.service.test.ts src/member-directory.service.ts src/member-directory.service.test.ts
git commit -m "feat: synchronize and index site members"
```

### Task 5: Wire five-minute sync into runtime and application startup

**Files:**
- Modify: `src/runtime-defaults.ts`
- Modify: `src/types.ts`
- Modify: `src/config.ts`
- Modify: `src/config.request-matching.test.ts`
- Modify: `src/persistence.ts`
- Modify: `src/request.runtime.ts`
- Modify: `src/request.runtime.test.ts`
- Modify: `src/application.ts`
- Modify: `src/application.test.ts`
- Modify: `src/scheduler.ts`
- Modify: `src/scheduler.test.ts`

**Interfaces:**
- Consumes: Tasks 2–4 source reader and sync service.
- Produces: `RequestMatchingRuntime.memberSync`, runtime constants `memberSyncCron`, `memberSyncStartupTimeoutMs`, `supportedConsentPolicyVersions`, startup attempt before polling, and cron job `member-sync`.

- [ ] **Step 1: Write failing configuration tests for exact runtime constants**

Change request matching expectations to:

```ts
expect(config.requestMatching).toMatchObject({
  memberSyncCron: '*/5 * * * *',
  memberSyncStartupTimeoutMs: 60_000,
  supportedConsentPolicyVersions: ['member-matching-v1'],
});
```

Remove expectations for `memberIndexCron`.

- [ ] **Step 2: Add the runtime constants without new env variables**

In `RUNTIME_DEFAULTS`:

```ts
schedules: Object.freeze({
  digestCron: '0 6 * * *',
  threadSummaryCron: '30 6 * * *',
  retentionSweepCron: '0 1 * * *',
  memberSyncCron: '*/5 * * * *',
}),
```

Add inside `matching`:

```ts
memberSyncStartupTimeoutMs: 60_000,
supportedConsentPolicyVersions: Object.freeze(['member-matching-v1'] as const),
```

Propagate exact readonly/string types through `RequestMatchingConfig` and `readConfig()`.

- [ ] **Step 3: Construct the source repository and sync service in persistence/runtime**

Extend `Persistence` with:

```ts
memberSource: MemberSourceRepository;
```

and construct `new PgMemberSourceRepository(pool)` in `createPersistence()`.

Extend `RequestMatchingRuntime`:

```ts
memberSync: MemberSyncService;
```

Construct it in `createRequestMatchingRuntime()` using `persistence.memberSource`, `persistence.members`, the existing `memberDirectory`, and `new Set(feature.supportedConsentPolicyVersions)`. Set `handlerOptions.isMatchingReady` to `() => memberSync.hasSuccessfulSnapshot()`.

- [ ] **Step 4: Write application-order tests before changing startup**

Update the application fake runtime with `memberSync.startupAttempt`. Assert the successful event order includes `sync-members` after `create-persistence` and before `start-telegram-transport`. Add a failure case where `startupAttempt` resolves `failed`; startup must still reach polling and the failure must be logged without profile data.

- [ ] **Step 5: Await only the bounded startup attempt before polling**

In `startApplication()` immediately after creating request matching:

```ts
const startupSync = await requestMatching.memberSync.startupAttempt(
  deps.requestMatching.memberSyncStartupTimeoutMs,
);
if (startupSync === 'completed') {
  logger.info(
    { event: 'member-sync-startup', outcome: startupSync },
    'Initial member source sync attempt finished',
  );
} else {
  logger.warn(
    { event: 'member-sync-startup', outcome: startupSync },
    'Initial member source sync attempt finished',
  );
}
```

Remove the old fire-and-forget initial `memberDirectory.indexPending()` block.

- [ ] **Step 6: Replace the optional scheduler contract**

Rename `SchedulerOptions.memberIndex` to:

```ts
memberSync?: {
  cron: string;
  run: () => Promise<unknown>;
};
```

Register `member-sync`, and in `application.ts` pass:

```ts
memberSync: {
  cron: deps.requestMatching.memberSyncCron,
  run: () => requestMatching.memberSync.sync(),
},
```

Update scheduler tests to expect four jobs and the exact five-minute expression when matching is enabled.

- [ ] **Step 7: Run runtime/lifecycle tests**

Run:

```bash
npm test -- src/config.request-matching.test.ts src/request.runtime.test.ts src/application.test.ts src/scheduler.test.ts
npm run typecheck
```

Expected: PASS; sync is attempted before polling, failure is non-destructive/non-fatal, and cron is `*/5`.

- [ ] **Step 8: Commit runtime wiring**

```bash
git add src/runtime-defaults.ts src/types.ts src/config.ts src/config.request-matching.test.ts src/persistence.ts src/request.runtime.ts src/request.runtime.test.ts src/application.ts src/application.test.ts src/scheduler.ts src/scheduler.test.ts
git commit -m "feat: schedule site member synchronization"
```

### Task 6: Exclude request authors by Telegram ID and guard an uninitialized catalogue

**Files:**
- Modify: `src/members.repository.ts`
- Modify: `src/members.repository.test.ts`
- Modify: `src/request.matcher.ts`
- Modify: `src/request.matcher.test.ts`
- Modify: `src/requests.ts`
- Modify: `src/requests.test.ts`

**Interfaces:**
- Consumes: Task 1 stable ID and Task 5 `isMatchingReady()` handler dependency.
- Produces: `MemberRepository.search(..., requesterTelegramUserId?)`, `MemberMatcher.match(query, requesterTelegramUserId?)`, and safe `member-source-not-ready` terminal failures.

- [ ] **Step 1: Write failing exact-search test for username changes**

Replace the username-exclusion repository test with two web members:

```ts
const requester = member('1001', 'requester', {
  source: 'web',
  telegramUserId: '1001',
  telegramUsername: 'renamed_username',
});
const other = member('1002', 'other', {
  source: 'web',
  telegramUserId: '1002',
  telegramUsername: 'other_user',
});
```

Index both, call `repo.search(vector({ 0: 1 }), MODEL, 20, '1001')`, and assert only `web:1002` remains. This proves username changes cannot reintroduce the requester.

- [ ] **Step 2: Change repository search to BIGINT exclusion**

Rename the fourth parameter to `requesterTelegramUserId?: string`. Validate it with `/^[1-9]\d*$/` before SQL. Change the WHERE clause and parameters to:

```sql
WHERE m.active = true
  AND ($4::bigint IS NULL OR m.telegram_user_id IS DISTINCT FROM $4::bigint)
ORDER BY e.embedding <=> $1::vector, m.member_id
LIMIT $5
```

Do not use username in the exclusion query.

- [ ] **Step 3: Propagate the ID through matcher and request pipeline**

Change:

```ts
async match(query: string, requesterTelegramUserId?: string): Promise<PublicMemberMatch[]>
```

and pass it unchanged to `members.search`. In `processRequest()` call:

```ts
const requesterTelegramUserId = request.authorId === null
  ? undefined
  : String(request.authorId);
const matches = await options.matcher.match(request.query, requesterTelegramUserId);
```

Keep `authorUsername` in `member_requests` only as historical Telegram message metadata.

- [ ] **Step 4: Guard requests before query embedding when no snapshot has ever succeeded**

Extend `RequestHandlerOptions`:

```ts
isMatchingReady?: () => Promise<boolean>;
```

At the beginning of the nonempty request path:

```ts
if (options.isMatchingReady && !(await options.isMatchingReady())) {
  throw new MemberSourceNotReadyError();
}
```

Define a safe local error class and map it in the catch block to `member-source-not-ready`; all other failures remain `processing-failed`. The user-facing text remains the existing generic temporary-unavailable response.

- [ ] **Step 5: Update matcher/request tests**

Assert `members.search` receives Telegram ID, not username. In `requests.test.ts`, add a case where `isMatchingReady` resolves false: query embedding/matcher is not called, the generic failure reply is sent, and repository failure code is exactly `member-source-not-ready`. Keep extraction assertions proving Telegram `msg.from.id` is captured.

- [ ] **Step 6: Run matching tests**

Run:

```bash
npm test -- src/members.repository.test.ts src/request.matcher.test.ts src/requests.test.ts
npm run typecheck
```

Expected: PASS; no search path excludes by username, and a cold catalogue never returns a false `no_match`.

- [ ] **Step 7: Commit stable requester exclusion**

```bash
git add src/members.repository.ts src/members.repository.test.ts src/request.matcher.ts src/request.matcher.test.ts src/requests.ts src/requests.test.ts
git commit -m "fix: exclude member requesters by Telegram ID"
```

### Task 7: Expose safe status and document rollout/cutover

**Files:**
- Modify: `src/bot.ts`
- Modify: `src/bot.test.ts`
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/operations.md`
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: source status, index status, exact view contract, and existing `/status` admin flow.
- Produces: count-only operational visibility and an explicit no-LLM mock cutover/rollback runbook.

- [ ] **Step 1: Write failing status tests for source and index state**

Add a bot fixture whose `readSourceStatus('web')` returns:

```ts
{
  provider: 'web',
  generation: 4,
  lastSuccessAt: '2026-08-26T10:05:00.000Z',
  fetchedCount: 8,
  activeCount: 7,
  rejectedCount: 1,
  deactivatedCount: 2,
}
```

and whose existing index status returns `activeCount: 7`, `pendingCount: 0`. Assert `/status` contains safe counts and timestamps but not any profile fixture value. Add a null-source-state case that says the source has never synchronized.

- [ ] **Step 2: Implement count-only `/status` output**

Read both statuses inside a try/catch. Format the Russian status lines with the stored values:

```ts
const sourceInfo = sourceStatus
  ? `🗂 Источник анкет: ${String(sourceStatus.activeCount)} активных, ${String(sourceStatus.rejectedCount)} отклонена, поколение ${String(sourceStatus.generation)}, синхронизация ${new Date(sourceStatus.lastSuccessAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} МСК`
  : '🗂 Источник анкет: успешной синхронизации ещё не было';
const indexInfo = indexStatus
  ? `🧩 Индекс: ${String(indexStatus.activeCount)} активных, ${String(indexStatus.pendingCount)} ожидают индексации, ${indexStatus.embeddingModel}`
  : '🧩 Индекс: ещё не готов';
```

On a status query failure, log only `errorClass` and display `нет данных`; do not fail the whole admin command.

- [ ] **Step 3: Update architecture and README contracts**

Document:

```text
club.member_matching_source -> full snapshot -> transactional web projection
-> content-hash pending set -> 1536-dimensional embeddings
-> exact top-20 -> LLM rerank/evidence validation -> 3–5 mentions
```

State that all six site fields enter the canonical document, unsupported consent is deactivated, sync is startup + five minutes, requester exclusion uses Telegram ID, and active mock fallback is forbidden after cutover.

- [ ] **Step 4: Add an exact production cutover runbook without executing it**

In `docs/operations.md`, include the authorization gate and this order:

```text
1. Confirm shared PostgreSQL backup and tested restore path.
2. Confirm the site migration/view/grants are deployed.
3. Confirm at least three eligible real rows using count-only SQL.
4. Stop Telegram polling during the cutover window and verify the active mock count is exactly 20; abort the cutover if it differs.
5. Deploy bot migration/code and wait for web source generation >= 1.
6. Confirm active web count >= 3 and pending_count = 0.
7. In one explicit transaction, UPDATE members SET active = false,
   updated_at = now() WHERE source = 'mock' AND active = true; verify its
   affected-row count is exactly 20 before committing.
8. Verify active mock count = 0 and active web count matches source state.
9. Start one bot instance and run three representative #запрос checks.
10. Observe request states, sync counts, latency, and Telegram delivery.
```

The runbook must use this count guard so a changed mock population rolls the transaction back automatically:

```sql
BEGIN;
DO $$
DECLARE
  changed_count integer;
BEGIN
  UPDATE members
  SET active = false, updated_at = now()
  WHERE source = 'mock' AND active = true;
  GET DIAGNOSTICS changed_count = ROW_COUNT;
  IF changed_count <> 20 THEN
    RAISE EXCEPTION 'expected 20 active mock members, changed %', changed_count;
  END IF;
END $$;
SELECT
  COUNT(*) FILTER (WHERE source = 'mock' AND active)::integer AS active_mock,
  COUNT(*) FILTER (WHERE source = 'web' AND active)::integer AS active_web
FROM members;
COMMIT;
```

Add rollback: redeploy prior bot commit, leave web data/embeddings intact, keep mocks inactive, leave the additive site columns/view in place, and never reinterpret revoked consent or reactivate mock fallback automatically.

- [ ] **Step 5: Update `AGENTS.md` only with verified local behavior**

Before deploy, describe the feature as local/verified, not production. Preserve existing production commit/incident facts. Do not change the seven-variable production contract.

- [ ] **Step 6: Run full bot release gates**

Run:

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

Expected: every command exits 0; tests cover source read, projection, full snapshot safety, indexing, five-minute scheduling, startup failure, Telegram ID exclusion, status privacy, and unchanged top-20/evidence rules.

- [ ] **Step 7: Commit status and operations documentation**

```bash
git add src/bot.ts src/bot.test.ts README.md docs/architecture.md docs/operations.md AGENTS.md
git commit -m "docs: operate real member matching catalogue"
```

### Task 8: Run the cross-project local acceptance gate

**Files:**
- Verification only; do not modify production data.

**Interfaces:**
- Consumes: completed site plan and Tasks 1–7 above.
- Produces: evidence that both repositories agree on the live PostgreSQL view and embedding lifecycle.

- [ ] **Step 1: Start isolated local PostgreSQL services**

Run the site database and bot pgvector database according to each README. Choose one disposable `_test` database for the shared-contract check; never point these commands at production.

- [ ] **Step 2: Apply the site migration to the disposable shared database**

From `club-site`, set its test-safe `DATABASE_URL` to that database and run `npm run db:migrate`. Run the site source-view integration test and confirm it passes.

- [ ] **Step 3: Run the bot source/sync tests against the same contract**

From `club_bot`, set `TEST_DATABASE_URL` to the disposable shared database and run:

```bash
npm test -- src/member-source.repository.test.ts src/member-sync.service.test.ts src/members.repository.test.ts
```

Expected: PASS with no real profile output.

- [ ] **Step 4: Execute the approved lifecycle with fake embeddings**

In test code/fixtures only: save one profile without consent and observe zero rows; grant `member-matching-v1`; sync and index it with a deterministic 1536-value fake vector; edit expertise and observe exactly one pending/re-embedding cycle; revoke consent and observe web-card deactivation; verify a request from the same Telegram ID cannot return that author.

- [ ] **Step 5: Record gate results, but do not deploy**

Capture command names, commit hashes, pass/fail counts, and safe row counts in the implementation handoff. Do not record form values, prompts, database URLs, or credentials.

## Bot Plan Completion Gate

The bot phase is complete only when:

- source view failures preserve the previous web catalogue;
- successful empty snapshots deactivate all web cards;
- unsupported/invalid individual cards become inactive without exposing their contents;
- unchanged canonical hashes do not re-embed;
- changed hashes cannot use stale vectors;
- startup and five-minute sync are single-flight and safely observable;
- requester exclusion uses Telegram ID only;
- exact top-20, LLM grounding, and 3–5-result rules do not regress;
- full release gates and the cross-project local acceptance scenario pass;
- mocks remain active until a separately authorized production cutover, then become inactive without fallback.
