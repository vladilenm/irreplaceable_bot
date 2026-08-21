import { GrammyError, type Api } from 'grammy';
import { logger } from './logger.js';

export type SendMessagePipeline = 'digest' | 'thread-summary' | 'member-request';

export interface SendMessageParams {
  chatId: number;
  threadId: number;
  text: string;
  parseMode: 'HTML';
  replyToMessageId?: number;
  /** Optional: tags structured log entries with the originating pipeline. */
  pipeline?: SendMessagePipeline;
}

const RETRY_DELAY_MS = 3000;

// Keep core Telegram fields in the message for log viewers that hide bindings.
function describeSendError(err: unknown, chatId: number, threadId: number): string {
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

type SentMessage = Awaited<ReturnType<Api['sendMessage']>>;

async function attemptSend(api: Api, params: SendMessageParams): Promise<SentMessage> {
  return api.sendMessage(params.chatId, params.text, {
    message_thread_id: params.threadId,
    parse_mode: params.parseMode,
    link_preview_options: { is_disabled: true },
    ...(params.replyToMessageId === undefined ? {} : {
      reply_parameters: {
        message_id: params.replyToMessageId,
        allow_sending_without_reply: true,
      },
    }),
  });
}

export async function sendMessageWithRetry(api: Api, params: SendMessageParams): Promise<SentMessage> {
  const logBinding = {
    chatId: params.chatId,
    threadId: params.threadId,
    pipeline: params.pipeline,
  };
  try {
    const sent = await attemptSend(api, params);
    logger.info(logBinding, 'Telegram sendMessage ok');
    return sent;
  } catch (err: unknown) {
    logger.error(
      { ...logBinding, err },
      `Telegram sendMessage failed, retrying in 3s: ${describeSendError(err, params.chatId, params.threadId)}`,
    );
    await delay(RETRY_DELAY_MS);
    try {
      const sent = await attemptSend(api, params);
      logger.info(logBinding, 'Telegram sendMessage ok (after retry)');
      return sent;
    } catch (retryErr: unknown) {
      logger.fatal(
        { ...logBinding, err: retryErr },
        `Telegram sendMessage failed after retry: ${describeSendError(retryErr, params.chatId, params.threadId)}`,
      );
      throw retryErr;
    }
  }
}
