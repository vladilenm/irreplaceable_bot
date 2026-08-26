import type { Pool } from 'pg';

export interface PostgresMigration {
  version: number;
  description: string;
  sql: string;
}

const MIGRATION_LOCK_ID = 620260821;

export const POSTGRES_MIGRATIONS: readonly PostgresMigration[] = [
  {
    version: 1,
    description: 'Create PostgreSQL application schema and vector storage',
    sql: `
      CREATE EXTENSION IF NOT EXISTS vector;

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
      CREATE INDEX idx_messages_thread_created
        ON messages(chat_id, thread_id, created_at);
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
        status text NOT NULL CHECK (
          status IN ('processing', 'completed', 'no_match', 'failed')
        ),
        match_count integer NOT NULL DEFAULT 0 CHECK (
          match_count >= 0 AND match_count <= 5
        ),
        response_message_id bigint,
        error_code text,
        started_at timestamptz NOT NULL,
        completed_at timestamptz,
        PRIMARY KEY(chat_id, tg_message_id)
      );
      CREATE INDEX idx_member_requests_status_started
        ON member_requests(status, started_at);
    `,
  },
  {
    version: 2,
    description: 'Add durable outbox for scheduled Telegram publications',
    sql: `
      CREATE TABLE scheduled_publications (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        pipeline text NOT NULL CHECK (pipeline IN ('digest', 'thread-summary')),
        publication_date date NOT NULL,
        target_chat_id bigint NOT NULL,
        thread_id bigint NOT NULL,
        item_count integer NOT NULL DEFAULT 0 CHECK (item_count >= 0),
        status text NOT NULL CHECK (
          status IN ('ready', 'delivering', 'retrying', 'delivered', 'expired', 'failed')
        ),
        next_attempt_at timestamptz NOT NULL,
        expires_at timestamptz NOT NULL,
        attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        lease_until timestamptz,
        last_error_code text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        delivered_at timestamptz,
        UNIQUE(pipeline, publication_date),
        CHECK (expires_at > created_at),
        CHECK (status <> 'delivered' OR delivered_at IS NOT NULL)
      );
      CREATE INDEX idx_scheduled_publications_due
        ON scheduled_publications(next_attempt_at)
        WHERE status IN ('ready', 'retrying');
      CREATE INDEX idx_scheduled_publications_leases
        ON scheduled_publications(lease_until)
        WHERE status = 'delivering';

      CREATE TABLE scheduled_publication_chunks (
        publication_id bigint NOT NULL REFERENCES scheduled_publications(id) ON DELETE CASCADE,
        chunk_index integer NOT NULL CHECK (chunk_index >= 0),
        text text NOT NULL CHECK (length(text) > 0),
        telegram_message_id bigint,
        delivered_at timestamptz,
        PRIMARY KEY(publication_id, chunk_index),
        CHECK (
          (telegram_message_id IS NULL AND delivered_at IS NULL)
          OR (telegram_message_id IS NOT NULL AND delivered_at IS NOT NULL)
        )
      );
      CREATE INDEX idx_scheduled_publication_chunks_pending
        ON scheduled_publication_chunks(publication_id, chunk_index)
        WHERE delivered_at IS NULL;
    `,
  },
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
];

const CREATE_MIGRATION_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version integer PRIMARY KEY,
    description text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )
`;

export async function runMigrations(
  pool: Pool,
  migrations: readonly PostgresMigration[] = POSTGRES_MIGRATIONS,
): Promise<number> {
  let appliedCount = 0;
  for (const migration of migrations) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_ID]);
      await client.query(CREATE_MIGRATION_TABLE_SQL);
      const applied = await client.query<{ version: number }>(
        'SELECT version FROM schema_migrations WHERE version = $1',
        [migration.version],
      );
      if (applied.rowCount === 0) {
        await client.query(migration.sql);
        await client.query(
          `INSERT INTO schema_migrations(version, description)
           VALUES ($1, $2)`,
          [migration.version, migration.description],
        );
        appliedCount += 1;
      }
      await client.query('COMMIT');
    } catch (error: unknown) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  return appliedCount;
}
