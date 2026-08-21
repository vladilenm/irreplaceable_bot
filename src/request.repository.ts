import type Database from 'better-sqlite3';
import type { Queryable } from './db/types.js';

export type MemberRequestStatus = 'processing' | 'completed' | 'no_match' | 'failed';

export interface RequestReservationInput {
  chatId: number;
  messageId: number;
  threadId: number;
  authorId: number | null;
  authorUsername: string | null;
  queryHash: string;
  startedAt: string;
}

export interface RequestRepository {
  reserve(input: RequestReservationInput): Promise<boolean>;
  complete(chatId: number, messageId: number, result: {
    responseMessageId: number;
    matchCount: number;
    completedAt: string;
  }): Promise<void>;
  noMatch(chatId: number, messageId: number, result: {
    responseMessageId: number;
    completedAt: string;
  }): Promise<void>;
  fail(chatId: number, messageId: number, errorCode: string, completedAt: string): Promise<void>;
  failStale(cutoffIso: string): Promise<number>;
  read(chatId: number, messageId: number): Promise<{
    status: MemberRequestStatus;
    matchCount: number;
    responseMessageId: number | null;
    errorCode: string | null;
  } | null>;
}

interface RequestRow {
  status: MemberRequestStatus;
  match_count: number;
  response_message_id: string | null;
  error_code: string | null;
}

export class SqliteRequestRepository implements RequestRepository {
  constructor(private readonly db: Database.Database) {}

  async reserve(input: RequestReservationInput): Promise<boolean> {
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO member_requests (
        chat_id, tg_message_id, thread_id, author_id, author_username, query_hash,
        status, started_at
      ) VALUES (
        @chatId, @messageId, @threadId, @authorId, @authorUsername, @queryHash,
        'processing', @startedAt
      )
    `).run(input);
    return result.changes === 1;
  }

  async complete(
    chatId: number,
    messageId: number,
    result: { responseMessageId: number; matchCount: number; completedAt: string },
  ): Promise<void> {
    this.db.prepare(`
      UPDATE member_requests
      SET status = 'completed', match_count = @matchCount,
        response_message_id = @responseMessageId, completed_at = @completedAt,
        error_code = NULL
      WHERE chat_id = @chatId AND tg_message_id = @messageId AND status = 'processing'
    `).run({ chatId, messageId, ...result });
  }

  async noMatch(
    chatId: number,
    messageId: number,
    result: { responseMessageId: number; completedAt: string },
  ): Promise<void> {
    this.db.prepare(`
      UPDATE member_requests
      SET status = 'no_match', match_count = 0,
        response_message_id = @responseMessageId, completed_at = @completedAt,
        error_code = NULL
      WHERE chat_id = @chatId AND tg_message_id = @messageId AND status = 'processing'
    `).run({ chatId, messageId, ...result });
  }

  async fail(
    chatId: number,
    messageId: number,
    errorCode: string,
    completedAt: string,
  ): Promise<void> {
    this.db.prepare(`
      UPDATE member_requests
      SET status = 'failed', error_code = @errorCode, completed_at = @completedAt
      WHERE chat_id = @chatId AND tg_message_id = @messageId AND status = 'processing'
    `).run({ chatId, messageId, errorCode, completedAt });
  }

  async failStale(cutoffIso: string): Promise<number> {
    const result = this.db.prepare(`
      UPDATE member_requests
      SET status = 'failed', error_code = 'processing-timeout', completed_at = @cutoffIso
      WHERE status = 'processing' AND started_at < @cutoffIso
    `).run({ cutoffIso });
    return result.changes;
  }

  async read(chatId: number, messageId: number): Promise<{
    status: MemberRequestStatus;
    matchCount: number;
    responseMessageId: number | null;
    errorCode: string | null;
  } | null> {
    const row = this.db.prepare(`
      SELECT status, match_count, response_message_id, error_code
      FROM member_requests
      WHERE chat_id = ? AND tg_message_id = ?
    `).get(chatId, messageId) as RequestRow | undefined;
    if (!row) return null;
    return {
      status: row.status,
      matchCount: row.match_count,
      responseMessageId: row.response_message_id === null
        ? null
        : Number(row.response_message_id),
      errorCode: row.error_code,
    };
  }
}

export class PgRequestRepository implements RequestRepository {
  constructor(private readonly db: Queryable) {}

  async reserve(input: RequestReservationInput): Promise<boolean> {
    const result = await this.db.query(`
      INSERT INTO member_requests (
        chat_id, tg_message_id, thread_id, author_id, author_username,
        query_hash, status, started_at
      ) VALUES ($1, $2, $3, $4, $5, $6, 'processing', $7)
      ON CONFLICT(chat_id, tg_message_id) DO NOTHING
      RETURNING chat_id
    `, [
      input.chatId,
      input.messageId,
      input.threadId,
      input.authorId,
      input.authorUsername,
      input.queryHash,
      input.startedAt,
    ]);
    return result.rowCount === 1;
  }

  async complete(
    chatId: number,
    messageId: number,
    result: { responseMessageId: number; matchCount: number; completedAt: string },
  ): Promise<void> {
    await this.db.query(`
      UPDATE member_requests
      SET status = 'completed', match_count = $3,
        response_message_id = $4, completed_at = $5, error_code = NULL
      WHERE chat_id = $1 AND tg_message_id = $2 AND status = 'processing'
    `, [chatId, messageId, result.matchCount, result.responseMessageId, result.completedAt]);
  }

  async noMatch(
    chatId: number,
    messageId: number,
    result: { responseMessageId: number; completedAt: string },
  ): Promise<void> {
    await this.db.query(`
      UPDATE member_requests
      SET status = 'no_match', match_count = 0,
        response_message_id = $3, completed_at = $4, error_code = NULL
      WHERE chat_id = $1 AND tg_message_id = $2 AND status = 'processing'
    `, [chatId, messageId, result.responseMessageId, result.completedAt]);
  }

  async fail(
    chatId: number,
    messageId: number,
    errorCode: string,
    completedAt: string,
  ): Promise<void> {
    await this.db.query(`
      UPDATE member_requests
      SET status = 'failed', error_code = $3, completed_at = $4
      WHERE chat_id = $1 AND tg_message_id = $2 AND status = 'processing'
    `, [chatId, messageId, errorCode, completedAt]);
  }

  async failStale(cutoffIso: string): Promise<number> {
    const result = await this.db.query(`
      UPDATE member_requests
      SET status = 'failed', error_code = 'processing-timeout', completed_at = $1
      WHERE status = 'processing' AND started_at < $1
    `, [cutoffIso]);
    return result.rowCount ?? 0;
  }

  async read(chatId: number, messageId: number): Promise<{
    status: MemberRequestStatus;
    matchCount: number;
    responseMessageId: number | null;
    errorCode: string | null;
  } | null> {
    const result = await this.db.query<RequestRow>(`
      SELECT status, match_count, response_message_id, error_code
      FROM member_requests
      WHERE chat_id = $1 AND tg_message_id = $2
    `, [chatId, messageId]);
    const row = result.rows[0];
    if (!row) return null;
    const responseMessageId = row.response_message_id === null
      ? null
      : Number(row.response_message_id);
    if (responseMessageId !== null && !Number.isSafeInteger(responseMessageId)) {
      throw new Error('unsafe Telegram bigint');
    }
    return {
      status: row.status,
      matchCount: row.match_count,
      responseMessageId,
      errorCode: row.error_code,
    };
  }
}
