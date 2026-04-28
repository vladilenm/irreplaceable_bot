import type { Context } from 'grammy';
import { logger } from '../../utils/logger.js';
import type { CapturedMessage } from '../../types/index.js';

/**
 * Pure mapping: Telegram update Context → CapturedMessage row, OR null when
 * the message must be dropped (no text+caption, unrecognised author shape).
 *
 * No I/O, no side effects (apart from a single WARN log on dropped pathological
 * cases). Safe to unit-test with synthetic ctx fixtures.
 *
 * Preconditions (handler-level guards already passed):
 * - msg.is_topic_message === true
 * - msg.is_automatic_forward !== true
 * - msg.sender_chat?.type !== 'channel'
 * - msg.message_thread_id is in the whitelist
 *
 * Decisions:
 * - D-09: text = msg.text ?? msg.caption; no [photo]/[video] prefix
 * - D-04 / RESEARCH §1.8: sender_chat.id === ctx.chat.id → anon admin (authorId=null, isAnonymous=1)
 * - D-03: ISO-8601 UTC timestamps from Unix-seconds * 1000
 * - D-05: reply_to_message_id only (no recursive parent fetch)
 * - PITFALL-NEW-02: defensive throw if ctx.editedMessage.edit_date missing
 */
export function mapTelegramMessageToCaptured(ctx: Context): CapturedMessage | null {
  const msg = ctx.msg;
  if (!msg) return null;

  // D-09: text or caption, no prefix. Filter already guaranteed one is present
  // (Grammy filter `:text` / `:caption`), but defensively re-check for direct
  // mapper use (tests, future re-use).
  const text = msg.text ?? msg.caption ?? '';
  if (text === '') return null;

  // D-04 + RESEARCH §1.8: author detection.
  const senderChat = msg.sender_chat;
  const fromUser = msg.from;

  let authorId: number | null;
  let authorName: string;
  let isAnonymous: 0 | 1;

  if (senderChat && senderChat.id === ctx.chat?.id) {
    // Anonymous admin: sender_chat is the supergroup itself (verified
    // core.telegram.org/bots/api#message — "the supergroup itself for messages
    // sent by its anonymous administrators"). Supergroups always have a title
    // per Bot API; fallback covers Grammy's stricter optional typing.
    authorId = null;
    authorName = 'title' in senderChat && senderChat.title !== undefined
      ? senderChat.title
      : 'Anonymous Admin';
    isAnonymous = 1;
  } else if (senderChat && senderChat.type === 'channel') {
    // Linked-channel auto-forward — handler.ts should already have filtered.
    // Belt-and-suspenders: drop here too.
    return null;
  } else if (fromUser) {
    authorId = fromUser.id;
    authorName = formatDisplayName(fromUser);
    isAnonymous = 0;
  } else {
    logger.warn(
      { tg_message_id: msg.message_id },
      'Message with no recognised author — dropping',
    );
    return null;
  }

  // D-03: ISO-8601 UTC timestamps. msg.date is Unix seconds.
  const createdAt = new Date(msg.date * 1000).toISOString();

  // PITFALL-NEW-02: ctx.editedMessage may be present (edit branch) and
  // edit_date should be populated per Bot API spec. Grammy types may mark
  // optional — defensive throw catches any drift.
  let editedAt: string | null = null;
  if (ctx.editedMessage) {
    const ed = ctx.editedMessage.edit_date;
    if (ed === undefined) {
      throw new Error('edit_date missing on edited_message — Grammy/Telegram contract violation');
    }
    editedAt = new Date(ed * 1000).toISOString();
  }

  // Handler guarantees msg.message_thread_id is set (whitelist check). Defensive
  // narrowing for the mapper signature.
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
    createdAt,
    editedAt,
  };
}

interface UserLike {
  first_name: string;
  last_name?: string;
  username?: string;
}

function formatDisplayName(user: UserLike): string {
  const fn = user.first_name;
  const ln = user.last_name !== undefined ? ` ${user.last_name}` : '';
  const un = user.username !== undefined ? ` @${user.username}` : '';
  return `${fn}${ln}${un}`.trim();
}
