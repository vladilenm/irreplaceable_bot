import type Database from 'better-sqlite3';
import type { Pool, PoolClient } from 'pg';
import { registerTypes, toSql } from 'pgvector/pg';
import { withTransaction } from './db/pool.js';
import { buildMemberId, memberContentHash } from './members.js';
import type {
  IndexedMember,
  MemberSourceRecord,
  SimilarMember,
} from './members.js';

export interface MemberVersion {
  memberId: string;
  contentHash: string;
  embeddingModel: string | null;
  dimensions: number | null;
}

export interface MemberSyncStatus {
  provider: string;
  generation: number;
  lastSuccessAt: string;
  embeddingModel: string;
  dimensions: number;
  activeCount: number;
}

export interface MemberSnapshotCommit {
  provider: 'notion';
  model: string;
  completedAt: string;
  records: readonly MemberSourceRecord[];
  changedEmbeddings: ReadonlyMap<string, readonly number[]>;
}

export interface LegacyMemberRepository {
  readVersions(): Map<string, MemberVersion>;
  commitSnapshot(input: MemberSnapshotCommit): MemberSyncStatus;
  readActiveIndex(expectedModel: string): IndexedMember[];
  readStatus(): MemberSyncStatus | null;
}

interface VersionRow {
  member_id: string;
  content_hash: string;
  embedding_model: string | null;
  dimensions: number | null;
}

interface ActiveEmbeddingRow {
  member_id: string;
  display_name: string;
  telegram_username: string;
  profile_text: string;
  vector: Buffer;
  dimensions: number;
  model: string;
  sync_generation: number;
}

interface ActiveValidationRow {
  member_id: string;
  content_hash: string;
  embedding_model: string | null;
  embedding_content_hash: string | null;
  dimensions: number | null;
}

interface SyncStateRow {
  provider: string;
  generation: number;
  last_success_at: string;
  embedding_model: string;
  dimensions: number;
  active_count: number;
}

const encodeVector = (values: readonly number[]): Buffer => {
  if (values.length === 0 || values.some((value) => !Number.isFinite(value))) {
    throw new Error('invalid changed embedding');
  }
  return Buffer.from(new Float32Array(values).buffer);
};

const decodeVector = (blob: Buffer, dimensions: number): Float32Array => {
  if (blob.byteLength !== dimensions * Float32Array.BYTES_PER_ELEMENT) {
    throw new Error('Stored embedding dimensions mismatch');
  }
  const bytes = Uint8Array.from(blob);
  const vector = new Float32Array(bytes.buffer);
  if (vector.length !== dimensions || vector.some((value) => !Number.isFinite(value))) {
    throw new Error('Stored embedding dimensions mismatch');
  }
  return vector;
};

function toStatus(row: SyncStateRow): MemberSyncStatus {
  return {
    provider: row.provider,
    generation: row.generation,
    lastSuccessAt: row.last_success_at,
    embeddingModel: row.embedding_model,
    dimensions: row.dimensions,
    activeCount: row.active_count,
  };
}

export class SqliteMemberRepository implements LegacyMemberRepository {
  constructor(private readonly db: Database.Database) {}

  readVersions(): Map<string, MemberVersion> {
    const rows = this.db.prepare(`
      SELECT m.member_id, m.content_hash, e.model AS embedding_model, e.dimensions
      FROM members AS m
      LEFT JOIN member_embeddings AS e ON e.member_id = m.member_id
    `).all() as VersionRow[];
    return new Map(rows.map((row) => [row.member_id, {
      memberId: row.member_id,
      contentHash: row.content_hash,
      embeddingModel: row.embedding_model,
      dimensions: row.dimensions,
    }]));
  }

  commitSnapshot(input: MemberSnapshotCommit): MemberSyncStatus {
    const recordsById = new Map<string, MemberSourceRecord>();
    for (const record of input.records) {
      if (record.source !== input.provider) {
        throw new Error('snapshot record source does not match provider');
      }
      const memberId = buildMemberId(record.source, record.externalId);
      if (recordsById.has(memberId)) throw new Error('duplicate member in snapshot');
      recordsById.set(memberId, record);
    }

    for (const [memberId, vector] of input.changedEmbeddings) {
      const record = recordsById.get(memberId);
      if (!record || !record.active) throw new Error('embedding does not belong to an active snapshot member');
      encodeVector(vector);
    }

    const transaction = this.db.transaction((snapshot: MemberSnapshotCommit): MemberSyncStatus => {
      const previous = this.db.prepare(
        'SELECT generation FROM member_sync_state WHERE provider = ?',
      ).get(snapshot.provider) as Pick<SyncStateRow, 'generation'> | undefined;
      const generation = (previous?.generation ?? 0) + 1;

      this.db.prepare(`
        UPDATE members
        SET active = 0, sync_generation = ?, updated_at = ?
        WHERE source = ?
      `).run(generation, snapshot.completedAt, snapshot.provider);

      const upsertMember = this.db.prepare(`
        INSERT INTO members (
          member_id, source, external_id, display_name, telegram_username, profile_text,
          content_hash, source_updated_at, active, sync_generation, updated_at
        ) VALUES (
          @memberId, @source, @externalId, @displayName, @telegramUsername, @profileText,
          @contentHash, @sourceUpdatedAt, @active, @generation, @updatedAt
        )
        ON CONFLICT(member_id) DO UPDATE SET
          source = excluded.source,
          external_id = excluded.external_id,
          display_name = excluded.display_name,
          telegram_username = excluded.telegram_username,
          profile_text = excluded.profile_text,
          content_hash = excluded.content_hash,
          source_updated_at = excluded.source_updated_at,
          active = excluded.active,
          sync_generation = excluded.sync_generation,
          updated_at = excluded.updated_at
      `);
      for (const record of snapshot.records) {
        upsertMember.run({
          ...record,
          memberId: buildMemberId(record.source, record.externalId),
          contentHash: memberContentHash(record),
          active: record.active ? 1 : 0,
          generation,
          updatedAt: snapshot.completedAt,
        });
      }

      const upsertEmbedding = this.db.prepare(`
        INSERT INTO member_embeddings (member_id, model, dimensions, content_hash, vector)
        VALUES (@memberId, @model, @dimensions, @contentHash, @vector)
        ON CONFLICT(member_id) DO UPDATE SET
          model = excluded.model,
          dimensions = excluded.dimensions,
          content_hash = excluded.content_hash,
          vector = excluded.vector
      `);
      for (const [memberId, values] of snapshot.changedEmbeddings) {
        const record = recordsById.get(memberId);
        if (!record) throw new Error('embedding does not belong to a snapshot member');
        upsertEmbedding.run({
          memberId,
          model: snapshot.model,
          dimensions: values.length,
          contentHash: memberContentHash(record),
          vector: encodeVector(values),
        });
      }

      this.db.prepare(`
        DELETE FROM member_embeddings
        WHERE member_id IN (
          SELECT member_id FROM members WHERE source = ? AND active = 0
        )
      `).run(snapshot.provider);

      const activeRows = this.db.prepare(`
        SELECT m.member_id, m.content_hash, e.model AS embedding_model,
          e.content_hash AS embedding_content_hash, e.dimensions
        FROM members AS m
        LEFT JOIN member_embeddings AS e ON e.member_id = m.member_id
        WHERE m.source = ? AND m.active = 1
        ORDER BY m.member_id
      `).all(snapshot.provider) as ActiveValidationRow[];
      let dimensions: number | null = null;
      for (const row of activeRows) {
        if (
          row.embedding_model !== snapshot.model ||
          row.embedding_content_hash !== row.content_hash ||
          row.dimensions === null
        ) {
          throw new Error('active member missing embedding');
        }
        if (dimensions !== null && dimensions !== row.dimensions) {
          throw new Error('active member embedding dimensions mismatch');
        }
        dimensions = row.dimensions;
      }

      const status: MemberSyncStatus = {
        provider: snapshot.provider,
        generation,
        lastSuccessAt: snapshot.completedAt,
        embeddingModel: snapshot.model,
        dimensions: dimensions ?? 0,
        activeCount: activeRows.length,
      };
      this.db.prepare(`
        INSERT INTO member_sync_state (
          provider, generation, last_success_at, embedding_model, dimensions, active_count
        ) VALUES (@provider, @generation, @lastSuccessAt, @embeddingModel, @dimensions, @activeCount)
        ON CONFLICT(provider) DO UPDATE SET
          generation = excluded.generation,
          last_success_at = excluded.last_success_at,
          embedding_model = excluded.embedding_model,
          dimensions = excluded.dimensions,
          active_count = excluded.active_count
      `).run(status);
      return status;
    });

    return transaction(input);
  }

  readActiveIndex(expectedModel: string): IndexedMember[] {
    const rows = this.db.prepare(`
      SELECT m.member_id, m.display_name, m.telegram_username, m.profile_text,
        e.vector, e.dimensions, e.model, m.sync_generation
      FROM members AS m
      INNER JOIN member_embeddings AS e ON e.member_id = m.member_id
      WHERE m.active = 1 AND e.model = ?
      ORDER BY m.member_id
    `).all(expectedModel) as ActiveEmbeddingRow[];
    const dimensions = rows[0]?.dimensions;
    if (dimensions !== undefined && rows.some((row) => row.dimensions !== dimensions)) {
      throw new Error('Stored embedding dimensions mismatch');
    }
    return rows.map((row) => ({
      memberId: row.member_id,
      displayName: row.display_name,
      telegramUsername: row.telegram_username,
      profileText: row.profile_text,
      embedding: decodeVector(row.vector, row.dimensions),
      embeddingModel: row.model,
      generation: row.sync_generation,
    }));
  }

  readStatus(): MemberSyncStatus | null {
    const row = this.db.prepare(`
      SELECT provider, generation, last_success_at, embedding_model, dimensions, active_count
      FROM member_sync_state
      ORDER BY provider
      LIMIT 1
    `).get() as SyncStateRow | undefined;
    return row ? toStatus(row) : null;
  }
}

export interface MemberIndexStatus {
  provider: string;
  generation: number;
  lastSuccessAt: string;
  embeddingModel: string;
  dimensions: 1536;
  activeCount: number;
  pendingCount: number;
}

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

export interface MemberRepository {
  upsertCards(records: readonly MemberSourceRecord[]): Promise<number>;
  replaceSourceSnapshot(
    input: ReplaceMemberSourceSnapshotInput,
  ): Promise<MemberSourceStatus>;
  readSourceStatus(source: 'web'): Promise<MemberSourceStatus | null>;
  readPending(model: string, limit: number): Promise<MemberSourceRecord[]>;
  upsertEmbedding(
    memberId: string,
    model: string,
    contentHash: string,
    vector: readonly number[],
  ): Promise<void>;
  search(
    vector: readonly number[],
    model: string,
    limit: number,
    requesterTelegramUserId?: string,
  ): Promise<SimilarMember[]>;
  recordIndexStatus(
    provider: string,
    model: string,
    completedAt: Date,
  ): Promise<MemberIndexStatus>;
  readIndexStatus(provider: string): Promise<MemberIndexStatus | null>;
  countBySource(source: MemberSourceRecord['source']): Promise<number>;
}

interface PendingMemberRow {
  source: MemberSourceRecord['source'];
  external_id: string;
  telegram_user_id: string | null;
  display_name: string;
  telegram_username: string;
  profile_text: string;
  source_updated_at: Date;
  active: boolean;
}

interface SimilarMemberRow {
  member_id: string;
  display_name: string;
  telegram_username: string;
  profile_text: string;
  similarity: number | string;
}

interface IndexStatusRow {
  provider: string;
  generation: string;
  last_success_at: Date;
  embedding_model: string;
  dimensions: number;
  active_count: number;
  pending_count: number;
}

interface SourceStatusRow {
  provider: 'web';
  generation: string;
  last_success_at: Date;
  fetched_count: number;
  active_count: number;
  rejected_count: number;
  deactivated_count: number;
}

const VECTOR_DIMENSIONS = 1536;
const registeredClients = new WeakSet<PoolClient>();

function validateVector(values: readonly number[]): number[] {
  if (
    values.length !== VECTOR_DIMENSIONS ||
    values.some((value) => !Number.isFinite(value))
  ) {
    throw new Error('embedding must contain exactly 1536 finite values');
  }
  return [...values];
}

function validateLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error('limit must be an integer between 1 and 1000');
  }
}

function validateRequesterTelegramUserId(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error('requester Telegram user ID must be a positive decimal string');
  }
  return value;
}

function mapIndexStatus(row: IndexStatusRow): MemberIndexStatus {
  if (row.dimensions !== VECTOR_DIMENSIONS) {
    throw new Error('Stored embedding dimensions mismatch');
  }
  return {
    provider: row.provider,
    generation: Number(row.generation),
    lastSuccessAt: row.last_success_at.toISOString(),
    embeddingModel: row.embedding_model,
    dimensions: VECTOR_DIMENSIONS,
    activeCount: row.active_count,
    pendingCount: row.pending_count,
  };
}

function mapSourceStatus(row: SourceStatusRow): MemberSourceStatus {
  return {
    provider: row.provider,
    generation: Number(row.generation),
    lastSuccessAt: row.last_success_at.toISOString(),
    fetchedCount: row.fetched_count,
    activeCount: row.active_count,
    rejectedCount: row.rejected_count,
    deactivatedCount: row.deactivated_count,
  };
}

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

export class PgMemberRepository implements MemberRepository {
  constructor(private readonly pool: Pool) {}

  private async withVectorClient<T>(
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      if (!registeredClients.has(client)) {
        await registerTypes(client);
        registeredClients.add(client);
      }
      return await work(client);
    } finally {
      client.release();
    }
  }

  async upsertCards(records: readonly MemberSourceRecord[]): Promise<number> {
    const ids = new Set<string>();
    for (const record of records) {
      const memberId = buildMemberId(record.source, record.externalId);
      if (ids.has(memberId)) throw new Error('duplicate member card');
      ids.add(memberId);
    }
    return withTransaction(this.pool, async (client) => {
      let upserted = 0;
      for (const record of records) {
        upserted += await upsertMemberWithClient(client, record);
      }
      return upserted;
    });
  }

  async replaceSourceSnapshot(
    input: ReplaceMemberSourceSnapshotInput,
  ): Promise<MemberSourceStatus> {
    return withTransaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [620260823]);
      const ids = new Set<string>();
      const telegramIds = new Set<string>();
      for (const record of input.records) {
        if (
          record.source !== input.source ||
          record.telegramUserId === null ||
          record.active !== true
        ) {
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
  }

  async readSourceStatus(source: 'web'): Promise<MemberSourceStatus | null> {
    const result = await this.pool.query<SourceStatusRow>(`
      SELECT provider, generation, last_success_at, fetched_count, active_count,
        rejected_count, deactivated_count
      FROM member_source_state
      WHERE provider = $1
    `, [source]);
    const row = result.rows[0];
    return row ? mapSourceStatus(row) : null;
  }

  async readPending(model: string, limit: number): Promise<MemberSourceRecord[]> {
    validateLimit(limit);
    const result = await this.pool.query<PendingMemberRow>(`
      SELECT m.source, m.external_id, m.telegram_user_id, m.display_name,
        m.telegram_username, m.profile_text, m.source_updated_at, m.active
      FROM members AS m
      LEFT JOIN member_embeddings AS e ON e.member_id = m.member_id
      WHERE m.active = true AND (
        e.member_id IS NULL OR
        e.model <> $1 OR
        e.content_hash <> m.content_hash OR
        e.dimensions <> $2
      )
      ORDER BY m.member_id
      LIMIT $3
    `, [model, VECTOR_DIMENSIONS, limit]);
    return result.rows.map((row) => ({
      source: row.source,
      externalId: row.external_id,
      telegramUserId: row.telegram_user_id,
      displayName: row.display_name,
      telegramUsername: row.telegram_username,
      profileText: row.profile_text,
      sourceUpdatedAt: row.source_updated_at.toISOString(),
      active: row.active,
    }));
  }

  async upsertEmbedding(
    memberId: string,
    model: string,
    contentHash: string,
    values: readonly number[],
  ): Promise<void> {
    const vector = validateVector(values);
    await this.withVectorClient(async (client) => {
      await client.query(`
        INSERT INTO member_embeddings (
          member_id, model, dimensions, content_hash, embedding, updated_at
        ) VALUES ($1, $2, $3, $4, $5::vector, now())
        ON CONFLICT(member_id) DO UPDATE SET
          model = EXCLUDED.model,
          dimensions = EXCLUDED.dimensions,
          content_hash = EXCLUDED.content_hash,
          embedding = EXCLUDED.embedding,
          updated_at = EXCLUDED.updated_at
      `, [memberId, model, VECTOR_DIMENSIONS, contentHash, toSql(vector)]);
    });
  }

  async search(
    values: readonly number[],
    model: string,
    limit: number,
    requesterTelegramUserId?: string,
  ): Promise<SimilarMember[]> {
    const vector = validateVector(values);
    validateLimit(limit);
    const excluded = validateRequesterTelegramUserId(requesterTelegramUserId);
    const result = await this.withVectorClient((client) =>
      client.query<SimilarMemberRow>(`
        SELECT m.member_id, m.display_name, m.telegram_username, m.profile_text,
          1 - (e.embedding <=> $1::vector) AS similarity
        FROM members AS m
        INNER JOIN member_embeddings AS e
          ON e.member_id = m.member_id
         AND e.content_hash = m.content_hash
         AND e.model = $2
         AND e.dimensions = $3
        WHERE m.active = true
          AND ($4::bigint IS NULL OR m.telegram_user_id IS DISTINCT FROM $4::bigint)
        ORDER BY e.embedding <=> $1::vector, m.member_id
        LIMIT $5
      `, [toSql(vector), model, VECTOR_DIMENSIONS, excluded, limit]));
    return result.rows.map((row) => ({
      member: {
        memberId: row.member_id,
        displayName: row.display_name,
        telegramUsername: row.telegram_username,
        profileText: row.profile_text,
      },
      similarity: Number(row.similarity),
    }));
  }

  async recordIndexStatus(
    provider: string,
    model: string,
    completedAt: Date,
  ): Promise<MemberIndexStatus> {
    return withTransaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [620260822]);
      const counts = await client.query<{
        active_count: number;
        pending_count: number;
      }>(`
        SELECT
          COUNT(*) FILTER (WHERE m.active)::integer AS active_count,
          COUNT(*) FILTER (WHERE m.active AND (
            e.member_id IS NULL OR e.model <> $1 OR
            e.content_hash <> m.content_hash OR e.dimensions <> $2
          ))::integer AS pending_count
        FROM members AS m
        LEFT JOIN member_embeddings AS e ON e.member_id = m.member_id
      `, [model, VECTOR_DIMENSIONS]);
      const previous = await client.query<{ generation: string }>(`
        SELECT generation FROM member_index_state WHERE provider = $1
      `, [provider]);
      const generation = Number(previous.rows[0]?.generation ?? 0) + 1;
      const activeCount = counts.rows[0]?.active_count ?? 0;
      const pendingCount = counts.rows[0]?.pending_count ?? 0;
      await client.query(`
        INSERT INTO member_index_state (
          provider, generation, last_success_at, embedding_model,
          dimensions, active_count, pending_count
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT(provider) DO UPDATE SET
          generation = EXCLUDED.generation,
          last_success_at = EXCLUDED.last_success_at,
          embedding_model = EXCLUDED.embedding_model,
          dimensions = EXCLUDED.dimensions,
          active_count = EXCLUDED.active_count,
          pending_count = EXCLUDED.pending_count
      `, [
        provider,
        generation,
        completedAt,
        model,
        VECTOR_DIMENSIONS,
        activeCount,
        pendingCount,
      ]);
      return {
        provider,
        generation,
        lastSuccessAt: completedAt.toISOString(),
        embeddingModel: model,
        dimensions: VECTOR_DIMENSIONS,
        activeCount,
        pendingCount,
      };
    });
  }

  async readIndexStatus(provider: string): Promise<MemberIndexStatus | null> {
    const result = await this.pool.query<IndexStatusRow>(`
      SELECT provider, generation, last_success_at, embedding_model,
        dimensions, active_count, pending_count
      FROM member_index_state
      WHERE provider = $1
    `, [provider]);
    const row = result.rows[0];
    return row ? mapIndexStatus(row) : null;
  }

  async countBySource(source: MemberSourceRecord['source']): Promise<number> {
    const result = await this.pool.query<{ count: string }>(`
      SELECT COUNT(*)::text AS count FROM members WHERE source = $1
    `, [source]);
    return Number(result.rows[0]?.count ?? 0);
  }
}
