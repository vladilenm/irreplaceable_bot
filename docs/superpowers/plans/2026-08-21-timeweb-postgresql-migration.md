# Timeweb Managed PostgreSQL Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every runtime SQLite dependency with Timeweb Managed PostgreSQL, add exact `pgvector` member search, and provide an explicit 20-member mock seed for development.

**Architecture:** A `pg` connection pool is injected into focused asynchronous repositories for messages, job state, members, and member requests. PostgreSQL is the only durable runtime store; migrations use an advisory lock, member search uses exact cosine distance over `vector(1536)`, and future web writes pass through a member directory service that keeps stale embeddings out of search.

**Tech Stack:** Node.js 20, TypeScript 6, `pg`, `pgvector`, PostgreSQL 16, pgvector, Vitest, Docker Compose, grammY, OpenAI embeddings.

## Global Constraints

- Production data lives in Timeweb Managed PostgreSQL in a Russian region with TLS enabled.
- `DATABASE_URL` is the restricted runtime connection; `DATABASE_MIGRATION_URL` is used only by migrations.
- `text-embedding-3-small` uses exactly 1,536 dimensions.
- Exact cosine top-20 is sufficient for at most 1,000 active members; do not add HNSW or IVFFlat yet.
- No browser receives PostgreSQL credentials or direct database access.
- Mock data never seeds automatically and requires `ALLOW_MOCK_MEMBER_SEED=true` when `NODE_ENV=production`.
- Message text, profile text, request text, usernames, vectors, and secrets never appear in logs.
- Existing SQLite files are read-only migration inputs and are never modified or deleted.
- Every behavior change follows red-green TDD and ends in a focused commit.
- PostgreSQL contract tests require a running Docker daemon and the local pgvector service.

---

## File Structure

- `src/db/pool.ts`: pool construction, TLS, connection checks, transaction helper, graceful close.
- `src/db/migrations.ts`: forward-only PostgreSQL migration definitions and advisory-locked runner.
- `src/db/migrate.ts`: deployment migration CLI.
- `src/db/types.ts`: `Queryable` and transaction types shared by repositories.
- `src/messages.repository.ts`: captured-message persistence and retention.
- `src/job-state.repository.ts`: digest and thread-summary state.
- `src/members.repository.ts`: PostgreSQL cards, pending embeddings, index status, and exact vector search.
- `src/request.repository.ts`: PostgreSQL idempotency and request transitions.
- `src/member-directory.service.ts`: normalized member writes and embedding refresh.
- `src/member.seed.ts`: guarded deterministic 20-member seed CLI.
- `src/migrate-sqlite.ts`: read-only SQLite-to-PostgreSQL importer.
- `src/persistence.ts`: explicit repository bundle constructed by `index.ts`.
- `tests/postgres.ts`: PostgreSQL contract-test reset and readiness helpers.
- `docker-compose.test.yml`: local pgvector service for contract tests.

### Task 1: PostgreSQL Configuration and Local Test Service

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/config.ts`
- Modify: `src/types.ts`
- Modify: `src/config.request-matching.test.ts`
- Modify: `tests/setup.ts`
- Create: `docker-compose.test.yml`

**Interfaces:**
- Produces: `DatabaseConfig { runtimeUrl: string; migrationUrl: string; ssl: boolean; poolMax: number; statementTimeoutMs: number }`
- Produces: `config.database: DatabaseConfig`
- Produces: local PostgreSQL at `postgresql://club_bot:club_bot@127.0.0.1:55432/club_bot_test`

- [ ] **Step 1: Write failing configuration tests**

```ts
it('requires PostgreSQL URLs and parses bounded pool settings', () => {
  const database = readDatabaseConfig({
    DATABASE_URL: 'postgresql://runtime@db/club',
    DATABASE_MIGRATION_URL: 'postgresql://owner@db/club',
    DATABASE_SSL: 'true',
    DATABASE_POOL_MAX: '5',
    DATABASE_STATEMENT_TIMEOUT_MS: '10000',
  });
  expect(database).toEqual({
    runtimeUrl: 'postgresql://runtime@db/club',
    migrationUrl: 'postgresql://owner@db/club',
    ssl: true,
    poolMax: 5,
    statementTimeoutMs: 10_000,
  });
});
```

- [ ] **Step 2: Run the test and verify red**

Run: `npm test -- src/config.request-matching.test.ts`

Expected: FAIL because `readDatabaseConfig` and `config.database` do not exist.

- [ ] **Step 3: Add dependencies and configuration**

Run: `npm install pg pgvector`

Run: `npm install --save-dev @types/pg`

Add this exact shape to `src/types.ts` and parser to `src/config.ts`:

```ts
export interface DatabaseConfig {
  runtimeUrl: string;
  migrationUrl: string;
  ssl: boolean;
  poolMax: number;
  statementTimeoutMs: number;
}

export function readDatabaseConfig(env: NodeJS.ProcessEnv): DatabaseConfig {
  const required = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`Missing required environment variable: ${name}`);
    return value;
  };
  const positive = (name: string, fallback: number): number => {
    const raw = env[name];
    const value = raw === undefined || raw === '' ? fallback : Number(raw);
    if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be >= 1`);
    return value;
  };
  const sslRaw = env['DATABASE_SSL'] ?? 'true';
  if (sslRaw !== 'true' && sslRaw !== 'false') {
    throw new Error('DATABASE_SSL must be true or false');
  }
  return {
    runtimeUrl: required('DATABASE_URL'),
    migrationUrl: required('DATABASE_MIGRATION_URL'),
    ssl: sslRaw === 'true',
    poolMax: positive('DATABASE_POOL_MAX', 5),
    statementTimeoutMs: positive('DATABASE_STATEMENT_TIMEOUT_MS', 10_000),
  };
}
```

Create `docker-compose.test.yml` with a named health-checked pgvector service:

```yaml
services:
  postgres-test:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_DB: club_bot_test
      POSTGRES_USER: club_bot
      POSTGRES_PASSWORD: club_bot
    ports:
      - "55432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U club_bot -d club_bot_test"]
      interval: 2s
      timeout: 3s
      retries: 20
    volumes:
      - club_bot_postgres_test:/var/lib/postgresql/data
volumes:
  club_bot_postgres_test:
```

- [ ] **Step 4: Verify green**

Run: `npm test -- src/config.request-matching.test.ts`

Expected: PASS with strict validation for missing URLs, booleans, zero, negative, and non-integer limits.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/config.ts src/types.ts src/config.request-matching.test.ts tests/setup.ts docker-compose.test.yml
git commit -m "feat: configure PostgreSQL runtime"
```

### Task 2: Pool, Transactions, and Advisory-Locked Migrations

**Files:**
- Create: `src/db/types.ts`
- Create: `src/db/pool.ts`
- Create: `src/db/migrations.ts`
- Create: `src/db/migrate.ts`
- Create: `src/db/migrations.test.ts`
- Create: `tests/postgres.ts`

**Interfaces:**
- Produces: `createPool(config: DatabaseConfig, url?: string): Pool`
- Produces: `withTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T>`
- Produces: `runMigrations(pool: Pool): Promise<number>`
- Produces: `resetPostgres(pool: Pool): Promise<void>`

- [ ] **Step 1: Write migration contract tests**

```ts
it('creates pgvector and the complete schema exactly once', async () => {
  const first = await runMigrations(pool);
  const second = await runMigrations(pool);
  expect(first).toBeGreaterThan(0);
  expect(second).toBe(0);
  const tables = await pool.query<{ table_name: string }>(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' ORDER BY table_name
  `);
  expect(tables.rows.map((row) => row.table_name)).toEqual([
    'job_state', 'member_embeddings', 'member_index_state', 'member_requests',
    'members', 'messages', 'schema_migrations',
  ]);
});
```

- [ ] **Step 2: Start PostgreSQL and verify red**

Run: `docker compose -f docker-compose.test.yml up -d --wait`

Run: `npm test -- src/db/migrations.test.ts`

Expected: FAIL because the pool and migration runner do not exist.

- [ ] **Step 3: Implement pool and migrations**

Define the shared query boundary:

```ts
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<R>>;
}
```

Create the pool with TLS and statement timeout:

```ts
export function createPool(config: DatabaseConfig, url = config.runtimeUrl): Pool {
  return new Pool({
    connectionString: url,
    max: config.poolMax,
    ssl: config.ssl ? { rejectUnauthorized: true } : false,
    options: `-c statement_timeout=${String(config.statementTimeoutMs)}`,
  });
}
```

The first PostgreSQL migration must execute this schema:

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE schema_migrations (
  version integer PRIMARY KEY,
  description text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE messages (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  chat_id bigint NOT NULL,
  thread_id bigint NOT NULL,
  tg_message_id bigint NOT NULL,
  author_id bigint,
  author_name text NOT NULL,
  is_anonymous boolean NOT NULL DEFAULT false,
  text text NOT NULL,
  reply_to_message_id bigint,
  created_at timestamptz NOT NULL,
  edited_at timestamptz,
  UNIQUE(chat_id, tg_message_id)
);
CREATE INDEX idx_messages_thread_created ON messages(chat_id, thread_id, created_at);
CREATE INDEX idx_messages_created ON messages(created_at);

CREATE TABLE job_state (
  job_name text PRIMARY KEY CHECK (job_name IN ('digest', 'thread-summary')),
  last_completed_at timestamptz,
  last_outcome text NOT NULL CHECK (last_outcome IN ('success', 'skipped')),
  item_count integer NOT NULL DEFAULT 0 CHECK (item_count >= 0)
);

CREATE TABLE members (
  member_id text PRIMARY KEY,
  source text NOT NULL CHECK (source IN ('mock', 'web', 'notion')),
  external_id text NOT NULL,
  display_name text NOT NULL,
  telegram_username text NOT NULL,
  profile_text text NOT NULL,
  content_hash text NOT NULL,
  source_updated_at timestamptz NOT NULL,
  active boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(source, external_id)
);
CREATE INDEX idx_members_active ON members(active);

CREATE TABLE member_embeddings (
  member_id text PRIMARY KEY REFERENCES members(member_id) ON DELETE CASCADE,
  model text NOT NULL,
  dimensions integer NOT NULL CHECK (dimensions = 1536),
  content_hash text NOT NULL,
  embedding vector(1536) NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE member_index_state (
  provider text PRIMARY KEY,
  generation bigint NOT NULL CHECK (generation >= 0),
  last_success_at timestamptz NOT NULL,
  embedding_model text NOT NULL,
  dimensions integer NOT NULL CHECK (dimensions = 1536),
  active_count integer NOT NULL CHECK (active_count >= 0),
  pending_count integer NOT NULL CHECK (pending_count >= 0)
);

CREATE TABLE member_requests (
  chat_id bigint NOT NULL,
  tg_message_id bigint NOT NULL,
  thread_id bigint NOT NULL,
  author_id bigint,
  author_username text,
  query_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('processing', 'completed', 'no_match', 'failed')),
  match_count integer NOT NULL DEFAULT 0 CHECK (match_count >= 0 AND match_count <= 5),
  response_message_id bigint,
  error_code text,
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  PRIMARY KEY(chat_id, tg_message_id)
);
CREATE INDEX idx_member_requests_status_started ON member_requests(status, started_at);
```

Protect migration enumeration and inserts with `SELECT pg_advisory_xact_lock(620260821)` inside one transaction per migration.

- [ ] **Step 4: Verify migration behavior**

Run: `npm test -- src/db/migrations.test.ts`

Expected: PASS for empty database, repeat run, vector extension, constraints, and rollback of a deliberately invalid test migration.

- [ ] **Step 5: Commit**

```bash
git add src/db tests/postgres.ts
git commit -m "feat: add PostgreSQL migrations"
```

### Task 3: Job-State Repository

**Files:**
- Create: `src/job-state.repository.ts`
- Create: `src/job-state.repository.test.ts`
- Modify: `src/types.ts`

**Interfaces:**
- Produces: `JobStateRepository.read(): Promise<PipelineState>`
- Produces: `JobStateRepository.recordDigest(completedAt: Date, skipped: boolean, itemCount: number): Promise<void>`
- Produces: `JobStateRepository.recordThreadSummary(completedAt: Date): Promise<void>`
- Produces: `PgJobStateRepository`

- [ ] **Step 1: Write failing repository tests**

```ts
it('keeps digest and summary state independently', async () => {
  await repo.recordThreadSummary(new Date('2026-08-20T03:30:00Z'));
  await repo.recordDigest(new Date('2026-08-21T06:00:00Z'), true, 0);
  expect(await repo.read()).toEqual({
    lastDigestDate: '2026-08-21T06:00:00.000Z',
    lastSkipped: true,
    lastItemCount: 0,
    lastThreadSummaryDate: '2026-08-20T03:30:00.000Z',
  });
});
```

- [ ] **Step 2: Verify red**

Run: `npm test -- src/job-state.repository.test.ts`

Expected: FAIL because `PgJobStateRepository` does not exist.

- [ ] **Step 3: Implement async UPSERTs**

```ts
await this.db.query(`
  INSERT INTO job_state(job_name, last_completed_at, last_outcome, item_count)
  VALUES ($1, $2, $3, $4)
  ON CONFLICT(job_name) DO UPDATE SET
    last_completed_at = EXCLUDED.last_completed_at,
    last_outcome = EXCLUDED.last_outcome,
    item_count = EXCLUDED.item_count
`, ['digest', completedAt, skipped ? 'skipped' : 'success', itemCount]);
```

- [ ] **Step 4: Verify green**

Run: `npm test -- src/job-state.repository.test.ts`

Expected: PASS for empty state, independent updates, skipped digest, and ISO timestamp mapping.

- [ ] **Step 5: Commit**

```bash
git add src/job-state.repository.ts src/job-state.repository.test.ts src/types.ts
git commit -m "feat: persist job state in PostgreSQL"
```

### Task 4: Message Repository and Retention

**Files:**
- Create: `src/messages.repository.ts`
- Create: `src/messages.repository.test.ts`
- Delete: `src/database.messages.test.ts`
- Delete: `src/database.retention.test.ts`

**Interfaces:**
- Produces: `MessageRepository.upsert(message: CapturedMessage): Promise<void>`
- Produces: `MessageRepository.selectWindow(chatId: number, threadId: number, sinceIso: string): Promise<CapturedMessage[]>`
- Produces: `MessageRepository.runRetention(days: number): Promise<RetentionSweepResult>`
- Produces: `PgMessageRepository`

- [ ] **Step 1: Port failing message and retention contracts**

```ts
it('updates editable fields without duplicating a Telegram message', async () => {
  await repo.upsert(baseMessage({ text: 'before', editedAt: null }));
  await repo.upsert(baseMessage({ text: 'after', editedAt: '2026-08-21T10:00:00Z' }));
  const rows = await repo.selectWindow(-1001, 100, '2026-08-20T00:00:00Z');
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ text: 'after', editedAt: '2026-08-21T10:00:00.000Z' });
});
```

- [ ] **Step 2: Verify red**

Run: `npm test -- src/messages.repository.test.ts`

Expected: FAIL because `PgMessageRepository` does not exist.

- [ ] **Step 3: Implement PostgreSQL queries**

Use this parameterized upsert and implement bounded retention with a CTE:

```sql
INSERT INTO messages (
  chat_id, thread_id, tg_message_id, author_id, author_name,
  is_anonymous, text, reply_to_message_id, created_at, edited_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
ON CONFLICT(chat_id, tg_message_id) DO UPDATE SET
  text = EXCLUDED.text,
  author_name = EXCLUDED.author_name,
  edited_at = EXCLUDED.edited_at
```

```sql
WITH doomed AS (
  SELECT id FROM messages
  WHERE created_at < $1
  ORDER BY created_at
  LIMIT 1000
)
DELETE FROM messages
WHERE id IN (SELECT id FROM doomed)
```

Map `bigint` Telegram columns through one `parseSafeTelegramId(value: string): number` helper that rejects unsafe integers.

- [ ] **Step 4: Verify green**

Run: `npm test -- src/messages.repository.test.ts`

Expected: PASS for insert, edit, thread/date filtering, ordering, 2,500-row multi-batch deletion, and empty retention.

- [ ] **Step 5: Commit**

```bash
git add src/messages.repository.ts src/messages.repository.test.ts src/database.messages.test.ts src/database.retention.test.ts
git commit -m "feat: persist captured messages in PostgreSQL"
```

### Task 5: Inject Async Persistence into Existing Pipelines

**Files:**
- Create: `src/persistence.ts`
- Modify: `src/capture.ts`
- Modify: `src/capture.test.ts`
- Modify: `src/radar.ts`
- Modify: `src/radar.test.ts`
- Modify: `src/radar.sender.test.ts`
- Modify: `src/summary.ts`
- Modify: `src/summary.test.ts`
- Modify: `src/bot.ts`
- Modify: `src/bot.test.ts`

**Interfaces:**
- Produces: `Persistence { messages: MessageRepository; jobs: JobStateRepository; members: MemberRepository; requests: RequestRepository }`
- Changes: `CaptureOptions.messages: MessageRepository`
- Changes: `runDigestPipeline(jobs: JobStateRepository, opts?: RunPipelineOptions)`
- Changes: `sendDigest(api: Api, result: DigestResult, jobs: JobStateRepository)`
- Changes: `runThreadSummaryPipeline(messages: MessageRepository, jobs: JobStateRepository, opts?: RunThreadSummaryOptions)`

- [ ] **Step 1: Change tests to require explicit repositories**

```ts
const jobs: JobStateRepository = {
  read: vi.fn().mockResolvedValue(emptyPipelineState),
  recordDigest: vi.fn().mockResolvedValue(undefined),
  recordThreadSummary: vi.fn().mockResolvedValue(undefined),
};
await runDigestPipeline(jobs);
expect(jobs.read).toHaveBeenCalledOnce();
```

- [ ] **Step 2: Verify red**

Run: `npm test -- src/capture.test.ts src/radar.test.ts src/summary.test.ts src/bot.test.ts`

Expected: FAIL because current functions import synchronous SQLite globals.

- [ ] **Step 3: Inject and await persistence**

Replace `upsertMessage(captured)` with:

```ts
await options.messages.upsert(captured);
```

Replace every direct state call with awaited repository methods. Preserve the rule that Telegram delivery completes before job state advances:

```ts
await sendMessageWithRetry(api, payload);
if (result.persistState) {
  await jobs.recordDigest(new Date(), false, result.itemCount);
}
```

- [ ] **Step 4: Verify green and failure isolation**

Run: `npm test -- src/capture.test.ts src/radar.test.ts src/radar.sender.test.ts src/summary.test.ts src/bot.test.ts`

Expected: PASS, including capture DB error swallowing, summary DB-read publish blocking, and no state advance after Telegram failure.

- [ ] **Step 5: Commit**

```bash
git add src/persistence.ts src/capture.ts src/capture.test.ts src/radar.ts src/radar.test.ts src/radar.sender.test.ts src/summary.ts src/summary.test.ts src/bot.ts src/bot.test.ts
git commit -m "refactor: inject asynchronous persistence"
```

### Task 6: PostgreSQL Member-Request Repository

**Files:**
- Modify: `src/request.repository.ts`
- Modify: `src/request.repository.test.ts`
- Modify: `src/requests.ts`
- Modify: `src/requests.test.ts`

**Interfaces:**
- Produces: `PgRequestRepository`
- Changes: `reserve(input: RequestReservationInput): Promise<boolean>`
- Changes: `complete(chatId: number, messageId: number, result: { responseMessageId: number; matchCount: number; completedAt: string }): Promise<void>`
- Changes: `noMatch(chatId: number, messageId: number, result: { responseMessageId: number; completedAt: string }): Promise<void>`
- Changes: `fail(chatId: number, messageId: number, errorCode: string, completedAt: string): Promise<void>`
- Changes: `failStale(cutoffIso: string): Promise<number>`
- Changes: `read(chatId: number, messageId: number): Promise<{ status: MemberRequestStatus; matchCount: number; responseMessageId: number | null; errorCode: string | null } | null>`

- [ ] **Step 1: Port request repository tests to PostgreSQL**

```ts
expect(await repo.reserve(input)).toBe(true);
expect(await repo.reserve(input)).toBe(false);
await repo.complete(-1001, 42, {
  responseMessageId: 99,
  matchCount: 3,
  completedAt: '2026-08-21T10:00:00Z',
});
expect(await repo.read(-1001, 42)).toMatchObject({ status: 'completed', matchCount: 3 });
```

- [ ] **Step 2: Verify red**

Run: `npm test -- src/request.repository.test.ts src/requests.test.ts`

Expected: FAIL because the existing repository is synchronous and SQLite-specific.

- [ ] **Step 3: Implement atomic PostgreSQL transitions**

Reservation must use:

```sql
INSERT INTO member_requests (
  chat_id, tg_message_id, thread_id, author_id, author_username,
  query_hash, status, started_at
)
VALUES ($1, $2, $3, $4, $5, $6, 'processing', $7)
ON CONFLICT(chat_id, tg_message_id) DO NOTHING
RETURNING chat_id
```

Terminal updates retain `WHERE status = 'processing'`. Await reserve before queue admission and await terminal persistence after Telegram delivery.

- [ ] **Step 4: Verify green**

Run: `npm test -- src/request.repository.test.ts src/requests.test.ts`

Expected: PASS for duplicate delivery, completed/no-match/failed transitions, timeout recovery, and queue behavior.

- [ ] **Step 5: Commit**

```bash
git add src/request.repository.ts src/request.repository.test.ts src/requests.ts src/requests.test.ts
git commit -m "feat: persist member requests in PostgreSQL"
```

### Task 7: PostgreSQL Member Directory and Exact Vector Search

**Files:**
- Modify: `src/members.repository.ts`
- Modify: `src/members.repository.test.ts`
- Modify: `src/members.ts`
- Modify: `src/members.test.ts`

**Interfaces:**
- Changes: `MemberSourceRecord.source: 'mock' | 'web' | 'notion'`
- Produces: `MemberCandidate { memberId: string; displayName: string; telegramUsername: string; profileText: string }`
- Produces: `SimilarMember { member: MemberCandidate; similarity: number }`
- Produces: `MemberIndexStatus { provider: string; generation: number; lastSuccessAt: string; embeddingModel: string; dimensions: 1536; activeCount: number; pendingCount: number }`
- Produces: `MemberRepository.upsertCards(records: readonly MemberSourceRecord[]): Promise<number>`
- Produces: `MemberRepository.readPending(model: string, limit: number): Promise<MemberSourceRecord[]>`
- Produces: `MemberRepository.upsertEmbedding(memberId: string, model: string, contentHash: string, vector: readonly number[]): Promise<void>`
- Produces: `MemberRepository.search(vector: readonly number[], model: string, limit: number, requesterUsername?: string): Promise<SimilarMember[]>`
- Produces: `MemberRepository.recordIndexStatus(provider: string, model: string, completedAt: Date): Promise<MemberIndexStatus>`
- Produces: `MemberRepository.readIndexStatus(provider: string): Promise<MemberIndexStatus | null>`
- Produces: `MemberRepository.countBySource(source: MemberSourceRecord['source']): Promise<number>`
- Produces: `PgMemberRepository`

- [ ] **Step 1: Write vector repository contract tests**

```ts
it('excludes stale vectors and returns exact cosine order', async () => {
  await repo.upsertCards([member('a', 'alpha'), member('b', 'beta'), member('c', 'gamma')]);
  await repo.upsertEmbedding('postgres:a', MODEL, hash(member('a', 'alpha')), unit(0));
  await repo.upsertEmbedding('postgres:b', MODEL, hash(member('b', 'beta')), unit(1));
  await repo.upsertCards([member('a', 'changed profile')]);
  const result = await repo.search(unit(0), MODEL, 20);
  expect(result.map((row) => row.memberId)).not.toContain('postgres:a');
});
```

- [ ] **Step 2: Verify red**

Run: `npm test -- src/members.repository.test.ts src/members.test.ts`

Expected: FAIL because `PgMemberRepository` and SQL vector search do not exist.

- [ ] **Step 3: Implement card, pending, embedding, and search queries**

Register pgvector types once per pool and serialize parameters with `pgvector.toSql(vector)`. Search uses:

```sql
SELECT m.member_id, m.display_name, m.telegram_username, m.profile_text,
       1 - (e.embedding <=> $1::vector) AS similarity
FROM members m
JOIN member_embeddings e
  ON e.member_id = m.member_id
 AND e.content_hash = m.content_hash
 AND e.model = $2
WHERE m.active = true
  AND ($3::text IS NULL OR m.telegram_username <> $3)
ORDER BY e.embedding <=> $1::vector, m.member_id
LIMIT $4
```

Validate every vector has 1,536 finite values before a query or write.

- [ ] **Step 4: Verify green**

Run: `npm test -- src/members.repository.test.ts src/members.test.ts`

Expected: PASS for normalization, idempotent cards, pending selection, stale exclusion, requester exclusion, dimensions, and deterministic top-20 order.

- [ ] **Step 5: Commit**

```bash
git add src/members.repository.ts src/members.repository.test.ts src/members.ts src/members.test.ts
git commit -m "feat: search member embeddings in PostgreSQL"
```

### Task 8: Member Directory Service and 20-Member Mock Seed

**Files:**
- Create: `src/member-directory.service.ts`
- Create: `src/member-directory.service.test.ts`
- Create: `src/member.seed.ts`
- Create: `src/member.seed.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `MemberDirectoryService.upsert(records): Promise<number>`
- Produces: `MemberDirectoryService.indexPending(limit?: number): Promise<{ indexed: number; failed: number }>`
- Produces: `seedMockMembers(service, env): Promise<{ upserted: number; indexed: number }>`

- [ ] **Step 1: Write failing service and seed tests**

```ts
it('seeds exactly 20 deterministic mock members twice without duplicates', async () => {
  await seedMockMembers(service, { NODE_ENV: 'development' });
  await seedMockMembers(service, { NODE_ENV: 'development' });
  expect(await repository.countBySource('mock')).toBe(20);
});

it('blocks production seed without the explicit guard', async () => {
  await expect(seedMockMembers(service, { NODE_ENV: 'production' }))
    .rejects.toThrow('ALLOW_MOCK_MEMBER_SEED=true is required');
});
```

- [ ] **Step 2: Verify red**

Run: `npm test -- src/member-directory.service.test.ts src/member.seed.test.ts`

Expected: FAIL because the service and seed do not exist.

- [ ] **Step 3: Implement service and deterministic seed**

Use IDs `mock-01` through `mock-20`, usernames `club_demo_member_01` through `club_demo_member_20`, and Russian profiles spanning product, B2B sales, recruiting, finance, legal, marketing, design, development, data, AI, operations, investment, education, events, media, export, e-commerce, manufacturing, community, and partnerships.

Index pending cards in batches of 100 and continue after individual OpenAI batch failures without marking stale cards searchable. After each completed run, call `recordIndexStatus('postgres', embeddings.model, now)` so `/status` reports active and pending counts from committed database state.

- [ ] **Step 4: Verify green**

Run: `npm test -- src/member-directory.service.test.ts src/member.seed.test.ts`

Expected: PASS for 20 rows, second-run idempotency, normalization, production guard, pending retry, and no raw profile logging.

- [ ] **Step 5: Commit**

```bash
git add src/member-directory.service.ts src/member-directory.service.test.ts src/member.seed.ts src/member.seed.test.ts package.json package-lock.json
git commit -m "feat: seed mock member directory"
```

### Task 9: Matcher and Runtime Use PostgreSQL Search

**Files:**
- Modify: `src/request.matcher.ts`
- Modify: `src/request.matcher.test.ts`
- Modify: `src/request.runtime.ts`
- Modify: `src/request.runtime.test.ts`
- Delete: `src/members.notion.ts`
- Delete: `src/members.notion.test.ts`

**Interfaces:**
- Changes: `MemberMatcher` consumes `MemberRepository.search` instead of an in-memory `MemberIndex`
- Produces: `createRequestMatchingRuntime(feature, persistence, overrides?)`
- Produces: background member indexing job through `MemberDirectoryService.indexPending`

- [ ] **Step 1: Change matcher tests to assert repository top-20 input**

```ts
const members = {
  search: vi.fn().mockResolvedValue(shortlist),
};
await matcher.match('Ищу B2B sales партнёра', 'requester');
expect(members.search).toHaveBeenCalledWith(expect.any(Array), MODEL, 20, 'requester');
```

- [ ] **Step 2: Verify red**

Run: `npm test -- src/request.matcher.test.ts src/request.runtime.test.ts`

Expected: FAIL because the matcher still uses `MemberIndex` and runtime constructs Notion sync.

- [ ] **Step 3: Replace in-memory and Notion runtime**

Generate one query embedding, request exact top-20 from PostgreSQL, and keep the existing grounded LLM validation unchanged. If fewer than three rows return, skip the reranker and return no matches.

Construct runtime only from injected repositories, `OpenAiEmbeddingProvider`, `MemberDirectoryService`, and the existing JSON LLM requester. Remove Notion credentials from feature configuration.

- [ ] **Step 4: Verify green**

Run: `npm test -- src/request.matcher.test.ts src/request.runtime.test.ts src/requests.test.ts`

Expected: PASS for top-20, fewer-than-three gate, grounded evidence, unknown IDs, duplicate IDs, requester exclusion, and provider failures.

- [ ] **Step 5: Commit**

```bash
git add src/request.matcher.ts src/request.matcher.test.ts src/request.runtime.ts src/request.runtime.test.ts src/members.notion.ts src/members.notion.test.ts
git commit -m "refactor: match members through PostgreSQL"
```

### Task 10: Read-Only SQLite Importer

**Files:**
- Create: `src/migrate-sqlite.ts`
- Create: `src/migrate-sqlite.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Produces: `importSqlite(path: string, pool: Pool): Promise<ImportReport>`
- Produces: CLI `npm run migrate:sqlite -- /absolute/path/messages.db`

- [ ] **Step 1: Write failing import and rollback tests**

```ts
it('imports all tables and preserves the source file', async () => {
  const before = readFileSync(path);
  const report = await importSqlite(path, pool);
  expect(report).toMatchObject({ messages: 2, jobState: 2, members: 3, requests: 1 });
  expect(readFileSync(path)).toEqual(before);
});

it('rolls back PostgreSQL on an invalid embedding blob', async () => {
  await expect(importSqlite(invalidPath, pool)).rejects.toThrow('embedding');
  expect(await countApplicationRows(pool)).toBe(0);
});
```

- [ ] **Step 2: Verify red**

Run: `npm test -- src/migrate-sqlite.test.ts`

Expected: FAIL because the importer does not exist.

- [ ] **Step 3: Implement validated transactional import**

Move `better-sqlite3` and `@types/better-sqlite3` to dev dependencies. Open the source with:

```ts
const sqlite = new Database(path, { readonly: true, fileMustExist: true });
```

Require schema version 6, require empty application tables, copy in dependency order, decode Float32 blobs, validate 1,536 dimensions, reset the `messages_id_seq`, compare source/destination counts, then commit. Close SQLite in `finally`.

- [ ] **Step 4: Verify green**

Run: `npm test -- src/migrate-sqlite.test.ts`

Expected: PASS for full import, empty-source import, non-empty target rejection, bad schema rejection, bad vector rollback, and byte-identical source preservation.

- [ ] **Step 5: Commit**

```bash
git add src/migrate-sqlite.ts src/migrate-sqlite.test.ts package.json package-lock.json
git commit -m "feat: import SQLite state into PostgreSQL"
```

### Task 11: Production Runtime, Scheduler, Status, and SQLite Removal

**Files:**
- Create: `src/application.ts`
- Create: `src/application.test.ts`
- Modify: `src/index.ts`
- Modify: `src/scheduler.ts`
- Modify: `src/scheduler.test.ts`
- Modify: `src/bot.ts`
- Modify: `src/bot.test.ts`
- Modify: `src/evaluate-member-matching.ts`
- Modify: `src/evaluate-member-matching.test.ts`
- Delete: `src/database.ts`
- Delete: `src/database.schema.test.ts`
- Delete: `src/database.state.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Produces: `createPersistence(pool): Persistence`
- Produces: `startApplication(deps: ApplicationDependencies): Promise<RunningApplication>`
- Changes: `startScheduler(api, persistence, options)`
- Startup order: migration pool → migrations → runtime pool readiness → repositories → bot → polling → scheduler/indexing

- [ ] **Step 1: Write failing startup and status tests**

```ts
it('does not construct or start the bot before migrations and PostgreSQL readiness', async () => {
  await startApplication(deps);
  expect(deps.events).toEqual(['migrate', 'connect', 'create-persistence', 'create-bot', 'start-bot']);
});
```

- [ ] **Step 2: Verify red**

Run: `npm test -- src/application.test.ts src/bot.test.ts src/scheduler.test.ts src/startup.test.ts src/evaluate-member-matching.test.ts`

Expected: FAIL because startup still calls synchronous `initDb` and SQLite globals.

- [ ] **Step 3: Wire PostgreSQL and remove SQLite runtime**

The production startup core must follow:

```ts
const migrationPool = createPool(config.database, config.database.migrationUrl);
await runMigrations(migrationPool);
await migrationPool.end();
const pool = createPool(config.database);
await assertDatabaseReady(pool);
const persistence = createPersistence(pool);
const requestMatching = createRequestMatchingRuntime(config.requestMatching, persistence);
const bot = createBot({ persistence, requestMatching });
```

Await scheduler persistence, report PostgreSQL member index status in `/status`, and close the pool only after Telegram and scheduler shutdown. Delete SQLite globals and remove `better-sqlite3` from production dependencies.

- [ ] **Step 4: Verify green**

Run: `npm test -- src/application.test.ts src/bot.test.ts src/scheduler.test.ts src/startup.test.ts src/evaluate-member-matching.test.ts`

Expected: PASS for startup order, unavailable-DB failure, shutdown order, scheduler persistence, status output, and evaluation runner.

- [ ] **Step 5: Commit**

```bash
git add src/application.ts src/application.test.ts src/index.ts src/scheduler.ts src/scheduler.test.ts src/bot.ts src/bot.test.ts src/evaluate-member-matching.ts src/evaluate-member-matching.test.ts src/database.ts src/database.schema.test.ts src/database.state.test.ts package.json package-lock.json
git commit -m "feat: run bot on PostgreSQL"
```

### Task 12: Docker, Timeweb Configuration, Documentation, and Final Verification

**Files:**
- Modify: `Dockerfile`
- Modify: `docker-compose.yml`
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/operations.md`

**Interfaces:**
- Produces: production image without SQLite native toolchain or writable `/app/data`
- Produces: documented Timeweb DB creation, pgvector, TLS, migration, seed, import, backup, rollout, and rollback commands

- [ ] **Step 1: Write static deployment assertions**

Add a test that reads deployment files and asserts:

```ts
expect(compose).toContain('DATABASE_URL:');
expect(compose).toContain('DATABASE_MIGRATION_URL:');
expect(compose).not.toContain('DB_PATH:');
expect(dockerfile).not.toContain('better-sqlite3');
expect(dockerfile).not.toContain('/app/data');
```

- [ ] **Step 2: Verify red**

Run: `npm test -- src/startup.test.ts`

Expected: FAIL because deployment files still describe SQLite.

- [ ] **Step 3: Update deployment and operations**

Production Compose must pass the database URLs, TLS, pool, statement timeout, and mock-seed guard. The image command runs migrations before the bot:

```dockerfile
CMD ["sh", "-c", "node dist/db/migrate.js && node dist/index.js"]
```

Document these operational checks:

```sql
SELECT extversion FROM pg_extension WHERE extname = 'vector';
SELECT COUNT(*) FROM members WHERE source = 'mock' AND active = true;
SELECT provider, embedding_model, active_count, last_success_at FROM member_index_state;
SELECT status, COUNT(*) FROM member_requests GROUP BY status ORDER BY status;
```

- [ ] **Step 4: Run fresh complete verification**

Run: `docker compose -f docker-compose.test.yml up -d --wait`

Run: `npm test`

Expected: all test files and tests PASS with zero failures.

Run: `npm run typecheck`

Expected: exit 0.

Run: `npm run build`

Expected: exit 0.

Run: `git diff --check`

Expected: no output.

Run: `docker compose -f docker-compose.test.yml down`

Expected: test containers stop without deleting the named volume.

- [ ] **Step 5: Commit**

```bash
git add Dockerfile docker-compose.yml docker-compose.test.yml .env.example README.md docs/architecture.md docs/operations.md src/startup.test.ts
git commit -m "docs: complete PostgreSQL rollout"
```

## Completion Gate

- `git status --short` is empty.
- `npm test`, `npm run typecheck`, and `npm run build` have fresh exit code 0 evidence.
- Contract tests ran against PostgreSQL 16 with pgvector, not a SQL mock.
- Exactly 20 mock members exist after two seed runs.
- A deliberately stale member embedding cannot appear in search.
- A Timeweb redeploy has no dependency on local container files.
- The SQLite importer leaves its input byte-identical.
