import type { Bot, Context } from 'grammy';
import { logger } from '../../utils/logger.js';
import { isThreadTracked } from '../../services/tracking.service.js';
import { upsertMessage, isAuthorForgotten } from '../../stores/message-store.js';
import { mapTelegramMessageToCaptured } from './capture.mapper.js';

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
export function registerCaptureHandlers(bot: Bot): void {
  bot.on(
    ['message:text', 'message:caption', 'edited_message:text', 'edited_message:caption'],
    captureHandler,
  );
}

async function captureHandler(ctx: Context): Promise<void> {
  // REL-04: full body wrapped in try/catch — DB errors, mapper throws, schema
  // mismatches are logged and SWALLOWED so the long-polling loop survives.
  // Belt-and-suspenders: bot.catch() in src/bot.ts is the second safety net.
  try {
    const msg = ctx.msg;
    if (!msg) return;

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
    if (threadId === undefined || !isThreadTracked(threadId)) return;

    // Pure mapping: Telegram update → row.
    const captured = mapTelegramMessageToCaptured(ctx);
    if (captured === null) return;

    // Forgotten-user guard (D-12, closes PRIV-02 ahead of Phase 8 /forget-me).
    // Anon admins (authorId === null) skip this check — NULL never matches.
    if (captured.authorId !== null && isAuthorForgotten(captured.authorId)) {
      logger.debug({ author_id: captured.authorId }, 'Skipping message from forgotten user');
      return;
    }

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
