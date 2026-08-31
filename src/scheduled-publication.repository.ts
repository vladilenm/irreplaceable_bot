import type { Pool } from 'pg';
import { withTransaction } from './db/pool.js';

export type ScheduledPublicationPipeline = 'digest' | 'thread-summary';
export type ScheduledPublicationMessageFormat = 'regular-html' | 'rich-html';
export type ScheduledPublicationStatus =
  | 'ready'
  | 'delivering'
  | 'retrying'
  | 'delivered'
  | 'expired'
  | 'failed';

export interface ScheduledPublicationInput {
  pipeline: ScheduledPublicationPipeline;
  messageFormat: ScheduledPublicationMessageFormat;
  originDigestId: string | null;
  publicationDate: string;
  targetChatId: number;
  threadId: number;
  chunks: readonly string[];
  itemCount: number;
  nextAttemptAt: Date;
  expiresAt: Date;
}

export interface ClaimedPublication {
  id: string;
  pipeline: ScheduledPublicationPipeline;
  messageFormat: ScheduledPublicationMessageFormat;
  originDigestId: string | null;
  publicationDate: string;
  targetChatId: number;
  threadId: number;
  itemCount: number;
  attemptCount: number;
  expiresAt: Date;
  chunk: { chunkIndex: number; text: string };
}

export interface CompletedPublication {
  id: string;
  pipeline: ScheduledPublicationPipeline;
  itemCount: number;
  deliveredAt: Date;
}

export interface ScheduledPublicationRecord {
  id: string;
  pipeline: ScheduledPublicationPipeline;
  messageFormat: ScheduledPublicationMessageFormat;
  originDigestId: string | null;
  publicationDate: string;
  status: ScheduledPublicationStatus;
  targetChatId: number;
  threadId: number;
  itemCount: number;
  attemptCount: number;
  nextAttemptAt: Date;
  expiresAt: Date;
  leaseUntil: Date | null;
  lastErrorCode: string | null;
  deliveredAt: Date | null;
}

export interface PublicationStatusCount {
  pipeline: ScheduledPublicationPipeline;
  status: ScheduledPublicationStatus;
  count: number;
  lastDeliveredAt: Date | null;
}

interface PublicationRow {
  id: string;
  pipeline: ScheduledPublicationPipeline;
  message_format: ScheduledPublicationMessageFormat;
  origin_digest_id: string | null;
  publication_date: string;
  status: ScheduledPublicationStatus;
  target_chat_id: string;
  thread_id: string;
  item_count: number;
  attempt_count: number;
  next_attempt_at: Date;
  expires_at: Date;
  lease_until: Date | null;
  last_error_code: string | null;
  delivered_at: Date | null;
}

function toSafeInteger(value: string, name: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`unsafe ${name}`);
  return number;
}

function asRecord(row: PublicationRow): ScheduledPublicationRecord {
  return {
    id: row.id,
    pipeline: row.pipeline,
    messageFormat: row.message_format,
    originDigestId: row.origin_digest_id,
    publicationDate: row.publication_date,
    status: row.status,
    targetChatId: toSafeInteger(row.target_chat_id, 'target chat id'),
    threadId: toSafeInteger(row.thread_id, 'thread id'),
    itemCount: row.item_count,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    expiresAt: row.expires_at,
    leaseUntil: row.lease_until,
    lastErrorCode: row.last_error_code,
    deliveredAt: row.delivered_at,
  };
}

export interface ScheduledPublicationRepository {
  enqueue(input: ScheduledPublicationInput): Promise<{ id: string; created: boolean }>;
  claimDue(now: Date, leaseMs: number): Promise<ClaimedPublication | null>;
  recordChunkDelivered(
    publicationId: string,
    chunkIndex: number,
    telegramMessageId: number,
    deliveredAt: Date,
  ): Promise<CompletedPublication | null>;
  scheduleRetry(publicationId: string, nextAttemptAt: Date, errorCode: string): Promise<void>;
  markFailed(publicationId: string, errorCode: string): Promise<void>;
  markExpired(publicationId: string): Promise<void>;
  expireDue(now: Date): Promise<number>;
  recover(
    pipeline: ScheduledPublicationPipeline | null,
    now: Date,
    expiresAt: Date,
  ): Promise<number>;
  read(publicationId: string): Promise<ScheduledPublicationRecord | null>;
  getStatusCounts(): Promise<PublicationStatusCount[]>;
  deleteExpiredPublications(cutoff: Date): Promise<number>;
}

export class PgScheduledPublicationRepository implements ScheduledPublicationRepository {
  constructor(private readonly pool: Pool) {}

  async enqueue(input: ScheduledPublicationInput): Promise<{ id: string; created: boolean }> {
    if (input.chunks.length === 0 || input.chunks.some((chunk) => chunk.length === 0)) {
      throw new Error('scheduled publication requires nonempty chunks');
    }
    return withTransaction(this.pool, async (client) => {
      const inserted = await client.query<{ id: string }>(`
        INSERT INTO scheduled_publications (
          pipeline, publication_date, target_chat_id, thread_id, item_count, status,
          next_attempt_at, expires_at, message_format, origin_digest_id
        ) VALUES ($1, $2, $3, $4, $5, 'ready', $6, $7, $8, $9)
        ON CONFLICT DO NOTHING
        RETURNING id
      `, [
        input.pipeline,
        input.publicationDate,
        input.targetChatId,
        input.threadId,
        input.itemCount,
        input.nextAttemptAt,
        input.expiresAt,
        input.messageFormat,
        input.originDigestId,
      ]);
      const row = inserted.rows[0];
      if (!row) {
        const byOrigin = input.originDigestId === null
          ? null
          : await client.query<{ id: string }>(`
            SELECT id FROM scheduled_publications
            WHERE origin_digest_id = $1
          `, [input.originDigestId]);
        const byDate = byOrigin?.rows[0]
          ? null
          : await client.query<{ id: string }>(`
            SELECT id FROM scheduled_publications
            WHERE pipeline = $1 AND publication_date = $2
          `, [input.pipeline, input.publicationDate]);
        const existingRow = byOrigin?.rows[0] ?? byDate?.rows[0];
        if (!existingRow) throw new Error('scheduled publication enqueue lost conflict row');
        return { id: existingRow.id, created: false };
      }
      for (const [chunkIndex, text] of input.chunks.entries()) {
        await client.query(`
          INSERT INTO scheduled_publication_chunks(publication_id, chunk_index, text)
          VALUES ($1, $2, $3)
        `, [row.id, chunkIndex, text]);
      }
      return { id: row.id, created: true };
    });
  }

  async claimDue(now: Date, leaseMs: number): Promise<ClaimedPublication | null> {
    const leaseUntil = new Date(now.getTime() + leaseMs);
    return withTransaction(this.pool, async (client) => {
      const claimed = await client.query<PublicationRow>(`
        WITH candidate AS (
          SELECT id
          FROM scheduled_publications
          WHERE expires_at > $1
            AND (
              (status IN ('ready', 'retrying') AND next_attempt_at <= $1)
              OR (status = 'delivering' AND lease_until <= $1)
            )
          ORDER BY next_attempt_at, id
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        UPDATE scheduled_publications publication
        SET status = 'delivering',
            attempt_count = publication.attempt_count + 1,
            lease_until = $2,
            updated_at = now()
        FROM candidate
        WHERE publication.id = candidate.id
        RETURNING publication.*
      `, [now, leaseUntil]);
      const publication = claimed.rows[0];
      if (!publication) return null;
      const chunkResult = await client.query<{ chunk_index: number; text: string }>(`
        SELECT chunk_index, text
        FROM scheduled_publication_chunks
        WHERE publication_id = $1 AND delivered_at IS NULL
        ORDER BY chunk_index
        LIMIT 1
      `, [publication.id]);
      const chunk = chunkResult.rows[0];
      if (!chunk) throw new Error('scheduled publication has no pending chunk');
      const record = asRecord(publication);
      return {
        id: record.id,
        pipeline: record.pipeline,
        messageFormat: record.messageFormat,
        originDigestId: record.originDigestId,
        publicationDate: record.publicationDate,
        targetChatId: record.targetChatId,
        threadId: record.threadId,
        itemCount: record.itemCount,
        attemptCount: record.attemptCount,
        expiresAt: record.expiresAt,
        chunk: { chunkIndex: chunk.chunk_index, text: chunk.text },
      };
    });
  }

  async recordChunkDelivered(
    publicationId: string,
    chunkIndex: number,
    telegramMessageId: number,
    deliveredAt: Date,
  ): Promise<CompletedPublication | null> {
    return withTransaction(this.pool, async (client) => {
      await client.query(`
        UPDATE scheduled_publication_chunks
        SET telegram_message_id = $3, delivered_at = $4
        WHERE publication_id = $1 AND chunk_index = $2 AND delivered_at IS NULL
      `, [publicationId, chunkIndex, telegramMessageId, deliveredAt]);
      const pending = await client.query<{ count: string }>(`
        SELECT COUNT(*)::text AS count
        FROM scheduled_publication_chunks
        WHERE publication_id = $1 AND delivered_at IS NULL
      `, [publicationId]);
      if (pending.rows[0]?.count !== '0') {
        await client.query(`
          UPDATE scheduled_publications
          SET status = 'ready', next_attempt_at = $2, lease_until = NULL, updated_at = now()
          WHERE id = $1 AND status = 'delivering'
        `, [publicationId, deliveredAt]);
        return null;
      }
      const completed = await client.query<{
        id: string;
        pipeline: ScheduledPublicationPipeline;
        item_count: number;
        delivered_at: Date;
      }>(`
        UPDATE scheduled_publications
        SET status = 'delivered', lease_until = NULL, last_error_code = NULL,
            delivered_at = $2, updated_at = now()
        WHERE id = $1 AND status = 'delivering'
        RETURNING id, pipeline, item_count, delivered_at
      `, [publicationId, deliveredAt]);
      const row = completed.rows[0];
      return row
        ? { id: row.id, pipeline: row.pipeline, itemCount: row.item_count, deliveredAt: row.delivered_at }
        : null;
    });
  }

  async scheduleRetry(publicationId: string, nextAttemptAt: Date, errorCode: string): Promise<void> {
    await this.pool.query(`
      UPDATE scheduled_publications
      SET status = 'retrying', next_attempt_at = $2, lease_until = NULL,
          last_error_code = $3, updated_at = now()
      WHERE id = $1 AND status = 'delivering'
    `, [publicationId, nextAttemptAt, errorCode]);
  }

  async markFailed(publicationId: string, errorCode: string): Promise<void> {
    await this.pool.query(`
      UPDATE scheduled_publications
      SET status = 'failed', lease_until = NULL, last_error_code = $2, updated_at = now()
      WHERE id = $1 AND status = 'delivering'
    `, [publicationId, errorCode]);
  }

  async markExpired(publicationId: string): Promise<void> {
    await this.pool.query(`
      UPDATE scheduled_publications
      SET status = 'expired', lease_until = NULL, last_error_code = 'delivery-expired', updated_at = now()
      WHERE id = $1 AND status = 'delivering'
    `, [publicationId]);
  }

  async expireDue(now: Date): Promise<number> {
    const result = await this.pool.query(`
      UPDATE scheduled_publications
      SET status = 'expired', lease_until = NULL, last_error_code = 'delivery-expired', updated_at = now()
      WHERE status IN ('ready', 'retrying', 'delivering') AND expires_at <= $1
    `, [now]);
    return result.rowCount ?? 0;
  }

  async recover(
    pipeline: ScheduledPublicationPipeline | null,
    now: Date,
    expiresAt: Date,
  ): Promise<number> {
    const result = await this.pool.query(`
      UPDATE scheduled_publications
      SET status = 'ready', next_attempt_at = $2, expires_at = $3,
          lease_until = NULL, last_error_code = NULL, updated_at = now()
      WHERE status IN ('expired', 'failed')
        AND ($1::text IS NULL OR pipeline = $1)
    `, [pipeline, now, expiresAt]);
    return result.rowCount ?? 0;
  }

  async read(publicationId: string): Promise<ScheduledPublicationRecord | null> {
    const result = await this.pool.query<PublicationRow>(`
      SELECT * FROM scheduled_publications WHERE id = $1
    `, [publicationId]);
    const row = result.rows[0];
    return row ? asRecord(row) : null;
  }

  async getStatusCounts(): Promise<PublicationStatusCount[]> {
    const result = await this.pool.query<{
      pipeline: ScheduledPublicationPipeline;
      status: ScheduledPublicationStatus;
      count: string;
      last_delivered_at: Date | null;
    }>(`
      SELECT pipeline, status, COUNT(*)::text AS count, MAX(delivered_at) AS last_delivered_at
      FROM scheduled_publications
      GROUP BY pipeline, status
      ORDER BY pipeline, status
    `);
    return result.rows.map((row) => ({
      pipeline: row.pipeline,
      status: row.status,
      count: Number(row.count),
      lastDeliveredAt: row.last_delivered_at,
    }));
  }

  async deleteExpiredPublications(cutoff: Date): Promise<number> {
    const result = await this.pool.query(`
      DELETE FROM scheduled_publications
      WHERE status IN ('delivered', 'expired', 'failed')
        AND COALESCE(delivered_at, updated_at) < $1
    `, [cutoff]);
    return result.rowCount ?? 0;
  }
}
