// Telegram API helpers: sendMessage with one retry (per plan 03-01, D-06/D-08/D-11/D-12)
import { GrammyError } from 'grammy';
import { bot } from '../bot.js';
import { logger } from './logger.js';

/**
 * Phase 8 fix C: pipeline tag distinguishes digest sends from thread-summary
 * sends in structured logs. Without it, a successful thread-summary chunk
 * shipped immediately after a failed digest send looked like a delayed digest
 * success in the log stream — see prod-digest-delivery-conflict Соп-баг 1.
 */
export type SendMessagePipeline = 'digest' | 'thread-summary';

export interface SendMessageParams {
  chatId: string;
  threadId: string;
  text: string;
  parseMode: 'HTML';
  /** Optional: tags structured log entries with the originating pipeline. */
  pipeline?: SendMessagePipeline;
}

const RETRY_DELAY_MS = 3000;

// TODO(prod-digest-delivery-conflict): revert once root cause identified.
// Diagnostic helper — Timeweb dashboard renders only pino `msg`, hiding
// the structured `err` binding. Inlining the key Telegram error fields
// into the msg string makes the failure visible in the dashboard while
// we hunt the root cause of "Telegram sendMessage failed after retry".
function describeSendError(err: unknown, chatId: string, threadId: string): string {
  let errorCode: string;
  let description: string;
  if (err instanceof GrammyError) {
    errorCode = String(err.error_code);
    description = err.description;
  } else if (err instanceof Error) {
    errorCode = 'no-code';
    description = err.message;
  } else {
    errorCode = 'no-code';
    description = String(err);
  }
  return `error_code=${errorCode} description=${description} chatId=${chatId} threadId=${threadId}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function attemptSend(params: SendMessageParams): Promise<void> {
  await bot.api.sendMessage(params.chatId, params.text, {
    message_thread_id: Number(params.threadId),
    parse_mode: params.parseMode,
    link_preview_options: { is_disabled: true },
  });
}

export async function sendMessageWithRetry(params: SendMessageParams): Promise<void> {
  const logBinding = {
    chatId: params.chatId,
    threadId: params.threadId,
    pipeline: params.pipeline,
  };
  try {
    await attemptSend(params);
    logger.info(logBinding, 'Telegram sendMessage ok');
    return;
  } catch (err: unknown) {
    logger.error(
      { ...logBinding, err },
      `Telegram sendMessage failed, retrying in 3s: ${describeSendError(err, params.chatId, params.threadId)}`,
    );
    await delay(RETRY_DELAY_MS);
    try {
      await attemptSend(params);
      logger.info(logBinding, 'Telegram sendMessage ok (after retry)');
    } catch (retryErr: unknown) {
      logger.fatal(
        { ...logBinding, err: retryErr },
        `Telegram sendMessage failed after retry: ${describeSendError(retryErr, params.chatId, params.threadId)}`,
      );
      throw retryErr;
    }
  }
}
