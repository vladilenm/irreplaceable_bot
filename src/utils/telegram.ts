// Telegram API helpers: sendMessage with one retry (per plan 03-01, D-06/D-08/D-11/D-12)
import { bot } from '../bot.js';
import { logger } from './logger.js';

export interface SendMessageParams {
  chatId: string;
  threadId: string;
  text: string;
  parseMode: 'HTML';
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
  try {
    await attemptSend(params);
    logger.info(
      { chatId: params.chatId, threadId: params.threadId },
      'Digest message sent to Telegram',
    );
    return;
  } catch (err: unknown) {
    logger.error({ err }, 'Telegram sendMessage failed, retrying in 3s');
    await delay(RETRY_DELAY_MS);
    try {
      await attemptSend(params);
      logger.info(
        { chatId: params.chatId, threadId: params.threadId },
        'Digest message sent to Telegram (after retry)',
      );
    } catch (retryErr: unknown) {
      logger.fatal({ err: retryErr }, 'Telegram sendMessage failed after retry');
      throw retryErr;
    }
  }
}
