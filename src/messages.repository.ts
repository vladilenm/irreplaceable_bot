import type { Queryable } from './db/types.js';
import { logger } from './logger.js';
import type { CapturedMessage } from './types.js';

export interface RetentionSweepResult {
  rowsDeleted: number;
  durationMs: number;
}

export interface MessageRepository {
  upsert(message: CapturedMessage): Promise<void>;
  selectWindow(chatId: number, threadId: number, sinceIso: string): Promise<CapturedMessage[]>;
  runRetention(days: number): Promise<RetentionSweepResult>;
}

interface MessageRow {
  chat_id: string;
  thread_id: string;
  tg_message_id: string;
  author_id: string | null;
  author_name: string;
  is_anonymous: boolean;
  text: string;
  reply_to_message_id: string | null;
  created_at: Date;
  edited_at: Date | null;
}

const RETENTION_BATCH_SIZE = 1000;

function parseSafeTelegramId(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error('unsafe Telegram bigint');
  }
  return parsed;
}

const nullableTelegramId = (value: string | null): number | null =>
  value === null ? null : parseSafeTelegramId(value);

export class PgMessageRepository implements MessageRepository {
  constructor(private readonly db: Queryable) {}

  async upsert(message: CapturedMessage): Promise<void> {
    await this.db.query(`
      INSERT INTO messages (
        chat_id, thread_id, tg_message_id, author_id, author_name,
        is_anonymous, text, reply_to_message_id, created_at, edited_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT(chat_id, tg_message_id) DO UPDATE SET
        text = EXCLUDED.text,
        author_name = EXCLUDED.author_name,
        edited_at = EXCLUDED.edited_at
    `, [
      message.chatId,
      message.threadId,
      message.tgMessageId,
      message.authorId,
      message.authorName,
      message.isAnonymous === 1,
      message.text,
      message.replyToMessageId,
      message.createdAt,
      message.editedAt,
    ]);
  }

  async selectWindow(
    chatId: number,
    threadId: number,
    sinceIso: string,
  ): Promise<CapturedMessage[]> {
    const result = await this.db.query<MessageRow>(`
      SELECT chat_id, thread_id, tg_message_id, author_id, author_name,
        is_anonymous, text, reply_to_message_id, created_at, edited_at
      FROM messages
      WHERE chat_id = $1 AND thread_id = $2 AND created_at >= $3
      ORDER BY created_at ASC, id ASC
    `, [chatId, threadId, sinceIso]);
    return result.rows.map((row) => ({
      chatId: parseSafeTelegramId(row.chat_id),
      threadId: parseSafeTelegramId(row.thread_id),
      tgMessageId: parseSafeTelegramId(row.tg_message_id),
      authorId: nullableTelegramId(row.author_id),
      authorName: row.author_name,
      isAnonymous: row.is_anonymous ? 1 : 0,
      text: row.text,
      replyToMessageId: nullableTelegramId(row.reply_to_message_id),
      createdAt: row.created_at.toISOString(),
      editedAt: row.edited_at?.toISOString() ?? null,
    }));
  }

  async runRetention(days: number): Promise<RetentionSweepResult> {
    const startedAt = Date.now();
    const cutoff = new Date(startedAt - days * 86_400_000);
    let rowsDeleted = 0;
    for (let iteration = 0; iteration < 10_000; iteration++) {
      const result = await this.db.query(`
        WITH doomed AS (
          SELECT id
          FROM messages
          WHERE created_at < $1
          ORDER BY created_at ASC, id ASC
          LIMIT ${String(RETENTION_BATCH_SIZE)}
        )
        DELETE FROM messages
        WHERE id IN (SELECT id FROM doomed)
      `, [cutoff]);
      const deleted = result.rowCount ?? 0;
      rowsDeleted += deleted;
      if (deleted === 0) {
        const durationMs = Date.now() - startedAt;
        logger.info(
          { event: 'retention-sweep', rows_deleted: rowsDeleted, duration_ms: durationMs },
          'Retention sweep complete',
        );
        return { rowsDeleted, durationMs };
      }
    }
    throw new Error('Retention sweep exceeded 10000 batches');
  }
}
