import type Database from 'better-sqlite3';

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
  reserve(input: RequestReservationInput): boolean;
  complete(chatId: number, messageId: number, result: {
    responseMessageId: number;
    matchCount: number;
    completedAt: string;
  }): void;
  noMatch(chatId: number, messageId: number, result: {
    responseMessageId: number;
    completedAt: string;
  }): void;
  fail(chatId: number, messageId: number, errorCode: string, completedAt: string): void;
  failStale(cutoffIso: string): number;
  read(chatId: number, messageId: number): {
    status: MemberRequestStatus;
    matchCount: number;
    responseMessageId: number | null;
    errorCode: string | null;
  } | null;
}

interface RequestRow {
  status: MemberRequestStatus;
  match_count: number;
  response_message_id: number | null;
  error_code: string | null;
}

export class SqliteRequestRepository implements RequestRepository {
  constructor(private readonly db: Database.Database) {}

  reserve(input: RequestReservationInput): boolean {
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

  complete(
    chatId: number,
    messageId: number,
    result: { responseMessageId: number; matchCount: number; completedAt: string },
  ): void {
    this.db.prepare(`
      UPDATE member_requests
      SET status = 'completed', match_count = @matchCount,
        response_message_id = @responseMessageId, completed_at = @completedAt,
        error_code = NULL
      WHERE chat_id = @chatId AND tg_message_id = @messageId AND status = 'processing'
    `).run({ chatId, messageId, ...result });
  }

  noMatch(
    chatId: number,
    messageId: number,
    result: { responseMessageId: number; completedAt: string },
  ): void {
    this.db.prepare(`
      UPDATE member_requests
      SET status = 'no_match', match_count = 0,
        response_message_id = @responseMessageId, completed_at = @completedAt,
        error_code = NULL
      WHERE chat_id = @chatId AND tg_message_id = @messageId AND status = 'processing'
    `).run({ chatId, messageId, ...result });
  }

  fail(chatId: number, messageId: number, errorCode: string, completedAt: string): void {
    this.db.prepare(`
      UPDATE member_requests
      SET status = 'failed', error_code = @errorCode, completed_at = @completedAt
      WHERE chat_id = @chatId AND tg_message_id = @messageId AND status = 'processing'
    `).run({ chatId, messageId, errorCode, completedAt });
  }

  failStale(cutoffIso: string): number {
    const result = this.db.prepare(`
      UPDATE member_requests
      SET status = 'failed', error_code = 'processing-timeout', completed_at = @cutoffIso
      WHERE status = 'processing' AND started_at < @cutoffIso
    `).run({ cutoffIso });
    return result.changes;
  }

  read(chatId: number, messageId: number): {
    status: MemberRequestStatus;
    matchCount: number;
    responseMessageId: number | null;
    errorCode: string | null;
  } | null {
    const row = this.db.prepare(`
      SELECT status, match_count, response_message_id, error_code
      FROM member_requests
      WHERE chat_id = ? AND tg_message_id = ?
    `).get(chatId, messageId) as RequestRow | undefined;
    if (!row) return null;
    return {
      status: row.status,
      matchCount: row.match_count,
      responseMessageId: row.response_message_id,
      errorCode: row.error_code,
    };
  }
}
