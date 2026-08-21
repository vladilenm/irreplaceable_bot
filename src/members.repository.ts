import type Database from 'better-sqlite3';
import { buildMemberId, memberContentHash } from './members.js';
import type { IndexedMember, MemberSourceRecord } from './members.js';

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

export interface MemberRepository {
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

export class SqliteMemberRepository implements MemberRepository {
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
