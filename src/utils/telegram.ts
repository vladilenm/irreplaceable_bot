// Telegram API helpers: sendMessage with one retry (per plan 03-01, D-06/D-08/D-11/D-12)
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
    logger.error({ ...logBinding, err }, 'Telegram sendMessage failed, retrying in 3s');
    await delay(RETRY_DELAY_MS);
    try {
      await attemptSend(params);
      logger.info(logBinding, 'Telegram sendMessage ok (after retry)');
    } catch (retryErr: unknown) {
      logger.fatal({ ...logBinding, err: retryErr }, 'Telegram sendMessage failed after retry');
      throw retryErr;
    }
  }
}
