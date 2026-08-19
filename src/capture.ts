import type { Bot, Context } from 'grammy';
import { logger } from './logger.js';
import { upsertMessage } from './database.js';
import type { CapturedMessage } from './types.js';

/**
 * Register the capture handler on the bot. Must be called LAST — AFTER
 * bot.catch() and AFTER all command handlers (CODE-01: Grammy middleware order).
 * The handler is terminal (no next() call).
 *
 * Filter (RESEARCH §1.1, Pattern 3): single combined query array.
 *  - 'message:text'        — new text message
 *  - 'message:caption'     — new media message with caption
 *  - 'edited_message:text' — edit of a text message
 *  - 'edited_message:caption' — edit of a caption
 * Service messages (forum_topic_created, pinned_message, new_chat_members, ...)
 * have neither text nor caption — auto-filtered by the query.
 * Channel posts arrive as channel_post / edited_channel_post update types —
 * not covered by this filter, never fire.
 */
export interface CaptureOptions {
  targetChatId: number;
  trackedThreadIds: ReadonlySet<number>;
  mapMessage?: (ctx: Context) => CapturedMessage | null;
}

export function registerCaptureHandlers(bot: Bot, options: CaptureOptions): void {
  bot.on(
    ['message:text', 'message:caption', 'edited_message:text', 'edited_message:caption'],
    (ctx) => captureHandler(ctx, options),
  );
}

async function captureHandler(ctx: Context, options: CaptureOptions): Promise<void> {
  // REL-04: full body wrapped in try/catch — DB errors, mapper throws, schema
  // mismatches are logged and SWALLOWED so the long-polling loop survives.
  // Belt-and-suspenders: bot.catch() in src/bot.ts is the second safety net.
  try {
    const msg = ctx.msg;
    if (!msg) return;

    if (ctx.chat?.id !== options.targetChatId) return;

    // Forum-topic guard (RESEARCH §1.9, PITFALLS TG-03): is_topic_message
    // distinguishes forum-mode from reply-chain-mode where message_thread_id
    // also gets populated.
    if (msg.is_topic_message !== true) return;

    // Channel-forward guards (RESEARCH §1.10, PITFALLS TG-05): linked-channel
    // auto-forwards arrive as messages with sender_chat.type === 'channel'.
    if (msg.is_automatic_forward === true) return;
    if (msg.sender_chat?.type === 'channel') return;

    // Thread whitelist guard (D-01, hot path).
    const threadId = msg.message_thread_id;
    if (threadId === undefined || !options.trackedThreadIds.has(threadId)) return;

    // Pure mapping: Telegram update → row.
    const captured = (options.mapMessage ?? mapTelegramMessageToCaptured)(ctx);
    if (captured === null) return;

    // Idempotent UPSERT (MSG-02 + MSG-04, OPS-05 long-polling redelivery).
    upsertMessage(captured);

    // Per-message debug log (D-13, PRIV-05). PROD log level = 'info' → debug
    // is off; for verification, set LOG_LEVEL=debug. NEVER log message text body.
    logger.debug(
      {
        chat_id: captured.chatId,
        thread_id: captured.threadId,
        author_id: captured.authorId,
        message_length: captured.text.length,
        is_edit: captured.editedAt !== null,
        has_media: !!(
          msg.photo ||
          msg.video ||
          msg.document ||
          msg.voice ||
          msg.audio ||
          msg.animation ||
          msg.video_note ||
          msg.sticker
        ),
      },
      'Message captured',
    );
  } catch (err: unknown) {
    // REL-04: error path — log with metadata only, do NOT rethrow.
    logger.error(
      {
        err,
        update_id: ctx.update.update_id,
        chat_id: ctx.chat?.id,
        tg_message_id: ctx.msg?.message_id,
      },
      'Capture handler failed',
    );
  }
  // Terminal — no next() call. Capture is end of middleware chain.
}

export function mapTelegramMessageToCaptured(ctx: Context): CapturedMessage | null {
  const msg = ctx.msg;
  if (!msg) return null;

  const text = msg.text ?? msg.caption ?? '';
  if (text === '') return null;

  const senderChat = msg.sender_chat;
  const fromUser = msg.from;
  let authorId: number | null;
  let authorName: string;
  let isAnonymous: 0 | 1;

  if (senderChat && senderChat.id === ctx.chat?.id) {
    authorId = null;
    authorName =
      'title' in senderChat && senderChat.title !== undefined
        ? senderChat.title
        : 'Anonymous Admin';
    isAnonymous = 1;
  } else if (senderChat?.type === 'channel') {
    return null;
  } else if (fromUser) {
    authorId = fromUser.id;
    const lastName = fromUser.last_name ? ` ${fromUser.last_name}` : '';
    const username = fromUser.username ? ` @${fromUser.username}` : '';
    authorName = `${fromUser.first_name}${lastName}${username}`.trim();
    isAnonymous = 0;
  } else {
    logger.warn({ tg_message_id: msg.message_id }, 'Message with no recognised author');
    return null;
  }

  let editedAt: string | null = null;
  if (ctx.editedMessage) {
    const editDate = ctx.editedMessage.edit_date;
    if (editDate === undefined) {
      throw new Error('edit_date missing on edited_message');
    }
    editedAt = new Date(editDate * 1000).toISOString();
  }

  const threadId = msg.message_thread_id;
  if (threadId === undefined) return null;

  return {
    chatId: msg.chat.id,
    threadId,
    tgMessageId: msg.message_id,
    authorId,
    authorName,
    isAnonymous,
    text,
    replyToMessageId: msg.reply_to_message?.message_id ?? null,
    createdAt: new Date(msg.date * 1000).toISOString(),
    editedAt,
  };
}
