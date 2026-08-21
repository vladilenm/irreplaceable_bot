# Timeweb Managed PostgreSQL migration design

Date: 2026-08-21

## Outcome

The bot will use one Timeweb Managed PostgreSQL cluster as its only durable database. SQLite will no longer be used at runtime. The cluster will store captured Telegram messages, scheduled-job state, member cards, OpenAI embeddings, member-sync state, and idempotency records for `#запрос`.

The first usable member directory will contain 20 explicit mock records. A future web application will manage real member cards through its own backend while reusing the same PostgreSQL schema and database service.

## Why this design

Timeweb App Platform recreates the application container during deployment, so files inside the container are not a durable state boundary. Keeping any runtime state in SQLite would leave message history, cron state, or member matching vulnerable to a redeploy. Timeweb Managed PostgreSQL provides a Russian deployment region, TLS, managed backups, and the `pgvector` extension.

Supabase is not used. Its managed regions are outside Russia, while the member directory contains personal data such as names, Telegram usernames, and professional profiles. The PostgreSQL design also avoids introducing Supabase Auth, Realtime, Storage, or PostgREST when the bot does not need them.

## Alternatives considered

### PostgreSQL only — selected

All durable bot state moves to PostgreSQL. This creates one operational model, supports App Platform redeploys, and gives the future web application a stable data boundary.

### Hybrid PostgreSQL and SQLite — rejected

Moving only member matching to PostgreSQL would be a smaller initial diff, but captured messages and cron state would remain ephemeral on App Platform. It would also require operating and testing two persistence models.

### Timeweb VDS with persistent SQLite — rejected

A VDS bind mount would make SQLite durable and would be sufficient for the current load. It does not serve the planned web application well and merely postpones the PostgreSQL migration.

## Deployment architecture

- The bot remains a single Node.js process on Timeweb App Platform.
- PostgreSQL is provisioned in a Russian Timeweb region, preferably the same region as the application.
- The `pgvector` extension is enabled before application migrations run.
- The bot connects through `DATABASE_URL` using TLS. `DB_PATH` is removed from runtime configuration.
- Production Compose contains only the bot and points it at the managed database.
- Local Compose adds a PostgreSQL 16 image with `pgvector`, a health check, and a named development volume.
- The deployment entrypoint runs forward-only migrations before starting the application. Telegram polling starts only after both migration and runtime connection checks succeed.
- Shutdown stops Telegram polling and the scheduler before closing the PostgreSQL pool.

The database must not be exposed to browser code. The future web application will use a backend API and a separate PostgreSQL role. `DATABASE_MIGRATION_URL` belongs to a schema-owner role used only by the migration command; `DATABASE_URL` belongs to a restricted runtime role with DML access to application tables.

## Database access layer

The synchronous `better-sqlite3` dependency is replaced by the `pg` driver and a bounded connection pool. Every database operation becomes asynchronous. Callers in capture, scheduler, summaries, retention, member sync, request matching, startup, and shutdown will explicitly await persistence.

Persistence is divided into focused repositories:

- `MessageRepository`: message upsert, time-window reads, and retention deletion.
- `JobStateRepository`: digest and thread-summary state.
- `MemberRepository`: cards, embeddings, sync generation, and similarity search.
- `RequestRepository`: request reservation and terminal status transitions.
- `MigrationRunner`: forward-only schema migrations protected by a PostgreSQL advisory lock.

Repositories accept a pool or transaction client explicitly. No module may issue SQL through a global service locator. Multi-statement updates run on one checked-out client with `BEGIN`, `COMMIT`, and `ROLLBACK`.

## PostgreSQL schema

The PostgreSQL schema preserves the current logical tables and constraints:

- `schema_migrations`
- `messages`
- `job_state`
- `members`
- `member_embeddings`
- `member_index_state`
- `member_requests`

SQLite-specific representations are replaced as follows:

- IDs and Telegram identifiers use `bigint`; application mapping validates conversion to JavaScript numbers where Telegram requires numbers.
- Timestamps use `timestamptz` and are converted to ISO strings at repository boundaries.
- Flags use `boolean` rather than integer `0`/`1`.
- `messages.id` uses `bigint generated always as identity`.
- Embeddings use `vector(1536)`, matching `text-embedding-3-small`.
- The embedding model, dimensions, and card content hash remain recorded so a card or model change can trigger controlled re-embedding.

At the expected scale of at most 1,000 active members, semantic search uses an exact cosine-distance query:

```sql
ORDER BY embedding <=> $1::vector
LIMIT 20
```

No approximate HNSW or IVFFlat index is created initially. Exact search keeps ranking deterministic and is inexpensive at this size. An HNSW index is a later operational change if measured query latency requires it.

Member writes and OpenAI calls cannot share one database transaction. Instead, similarity search joins only embeddings whose `content_hash` and model match the current active card. A new or edited card is temporarily excluded from matching until the background embedding worker successfully upserts its current vector. A failed OpenAI request therefore cannot pair new profile text with a stale vector.

## Member source and mock data

PostgreSQL becomes the authoritative member directory. Notion and the snapshot-provider flow are removed from the active production data path. All card writes go through a `MemberDirectoryService`, which normalizes fields and calculates the canonical content hash before committing the card. The seed command, one-time importers, and future web backend use this same service contract.

An explicit command creates the initial dataset:

```text
npm run seed:members
```

The seed has these properties:

- exactly 20 diverse Russian-language professional profiles;
- deterministic external IDs and idempotent upserts;
- `source = 'mock'` so the dataset is distinguishable and removable;
- syntactically valid but clearly synthetic Telegram usernames;
- embeddings generated through the configured OpenAI model after card upsert; rows remain pending and unsearchable if generation fails;
- no automatic execution during application startup;
- blocked in production unless `ALLOW_MOCK_MEMBER_SEED=true` is explicitly set.

Mock mentions must only be tested in a dedicated Telegram test group. Before enabling matching in the real club, mock rows are deactivated or deleted and replaced by real cards.

The future browser will call its backend API. That backend will use a dedicated database role and the same member write rules; it will never write embeddings directly. A background indexing job detects missing or stale content hashes, requests new embeddings, and upserts the matching vector. Search eligibility is derived from hash and model equality rather than a mutable UI flag.

## Existing SQLite data migration

A one-time CLI command imports a current SQLite file into PostgreSQL:

```text
npm run migrate:sqlite -- /absolute/path/messages.db
```

The importer:

1. requires an empty PostgreSQL application schema;
2. validates the SQLite schema version;
3. copies tables in dependency order inside a PostgreSQL transaction;
4. converts timestamps, booleans, IDs, and Float32 embedding blobs;
5. validates row counts and foreign-key relationships;
6. rolls back the entire import on any mismatch;
7. never deletes or modifies the source SQLite file.

The command prints counts and technical identifiers only. Message text, profile text, usernames, vectors, and secrets are not logged.

## Concurrency and reliability

- The PostgreSQL pool has a small configurable maximum suitable for one bot process.
- Startup migrations use an advisory lock so two accidental instances cannot migrate concurrently.
- `member_requests` continues to reserve `(chat_id, tg_message_id)` atomically with `INSERT ... ON CONFLICT DO NOTHING`.
- Terminal request transitions update only rows still in `processing`.
- Member card writes are transactional; search excludes missing or stale embeddings until the indexing job finishes.
- Retention deletes bounded batches using a PostgreSQL-compatible CTE.
- Transient connection failures do not advance job state or mark member sync successful.
- The bot fails startup if PostgreSQL is unreachable; it does not run with partial in-memory state.
- Database queries have statement timeouts, and the pool reports technical error classes without logging personal content.

## Configuration and secrets

New runtime settings:

- `DATABASE_URL`
- `DATABASE_MIGRATION_URL`
- `DATABASE_SSL=true`
- `DATABASE_POOL_MAX=5`
- `DATABASE_STATEMENT_TIMEOUT_MS=10000`
- `ALLOW_MOCK_MEMBER_SEED=false`

Removed runtime setting:

- `DB_PATH`

Existing AI and Telegram secrets remain unchanged. The PostgreSQL URL, OpenAI key, bot token, Notion token from earlier experiments, profile text, request text, and embeddings must never be committed or logged.

Russian database residency does not by itself eliminate cross-border processing: profile and request text are still sent to OpenAI and the configured reranking LLM. Production rollout therefore requires an appropriate participant consent and legal review, or a later migration to Russian AI providers. This migration does not change the already approved OpenAI provider.

## Testing

Repository contract tests run against a real local PostgreSQL with `pgvector`, not mocks of SQL strings. Unit tests continue to isolate Telegram, AI providers, formatting, and validation.

Required verification includes:

- forward-only migrations on an empty database;
- migrations are idempotent and advisory-lock safe;
- message capture, edit upsert, summary reads, and retention;
- job-state idempotency;
- stale-vector exclusion and model-change re-embedding;
- exact cosine top-20 ordering;
- request reservation and stale-request recovery;
- mock seed creates exactly 20 rows and is idempotent;
- production seed guard;
- complete SQLite import and rollback on invalid data;
- bot startup failure when PostgreSQL is unavailable;
- full existing test suite, TypeScript typecheck, and production build.

## Rollout and rollback

1. Create Timeweb Managed PostgreSQL in a Russian region.
2. Enable `pgvector`, TLS, automatic backups, and network restrictions.
3. Create the bot database and least-privilege runtime credentials.
4. Deploy the new build with matching disabled and run migrations.
5. Import the existing SQLite database if it contains state worth retaining.
6. Run the 20-member seed only in the isolated test environment.
7. Verify database counts, `/status`, message capture, cron state, and test-group matching.
8. Enable `REQUEST_MATCHING_ENABLED=true` in the test environment.
9. Replace mock cards before enabling the feature in the real club.

Rollback deploys the previous SQLite build and points it at the untouched SQLite file. The PostgreSQL migration and importer are additive and never modify that source file, so rollback remains possible until PostgreSQL becomes the only accepted production writer.

## Acceptance criteria

- A fresh local Docker environment starts the bot and PostgreSQL with one documented command.
- A fresh Timeweb database migrates without manual SQL other than enabling `pgvector` and creating credentials.
- The bot contains no runtime dependency on `better-sqlite3` or `DB_PATH`.
- All existing durable state is stored in PostgreSQL.
- Twenty mock members can be seeded explicitly and repeatedly without duplicates.
- `#запрос` returns grounded top matches using PostgreSQL vector search.
- App Platform redeploys do not lose messages, job state, members, embeddings, or request idempotency.
- The future web backend can manage `members` through an explicit contract without receiving embedding-write privileges.
