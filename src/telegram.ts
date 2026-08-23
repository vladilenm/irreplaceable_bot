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

export type SendMessageOnceResult =
  | { ok: true; message: SentMessage }
  | {
      ok: false;
      errorCode: string;
      retryable: boolean;
      retryAfterMs: number | null;
    };

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

function classifySendError(err: unknown): Omit<Extract<SendMessageOnceResult, { ok: false }>, 'ok'> {
  if (err instanceof GrammyError) {
    const errorCode = err.error_code;
    const retryAfter = err.parameters?.retry_after;
    if (errorCode === 429) {
      return {
        errorCode: 'telegram-429',
        retryable: true,
        retryAfterMs: typeof retryAfter === 'number' ? retryAfter * 1000 : null,
      };
    }
    if (errorCode >= 400 && errorCode < 500) {
      return { errorCode: `telegram-${String(errorCode)}`, retryable: false, retryAfterMs: null };
    }
    return { errorCode: `telegram-${String(errorCode)}`, retryable: true, retryAfterMs: null };
  }
  return { errorCode: 'telegram-network', retryable: true, retryAfterMs: null };
}

/**
 * Sends one Telegram request without an in-memory retry. Durable publication
 * delivery persists this result before deciding whether to retry.
 */
export async function sendMessageOnce(api: Api, params: SendMessageParams): Promise<SendMessageOnceResult> {
  return (await sendMessageOnceWithCause(api, params)).result;
}

async function sendMessageOnceWithCause(
  api: Api,
  params: SendMessageParams,
): Promise<{ result: SendMessageOnceResult; cause: unknown | null }> {
  try {
    return { result: { ok: true, message: await attemptSend(api, params) }, cause: null };
  } catch (cause: unknown) {
    return { result: { ok: false, ...classifySendError(cause) }, cause };
  }
}

export async function sendMessageWithRetry(api: Api, params: SendMessageParams): Promise<SentMessage> {
  const logBinding = {
    chatId: params.chatId,
    threadId: params.threadId,
    pipeline: params.pipeline,
  };
  const firstAttempt = await sendMessageOnceWithCause(api, params);
  const first = firstAttempt.result;
  if (first.ok) {
    logger.info(logBinding, 'Telegram sendMessage ok');
    return first.message;
  }
  if (!first.retryable) {
    logger.fatal(
      { ...logBinding, err: firstAttempt.cause },
      `Telegram sendMessage failed without retry: ${describeSendError(firstAttempt.cause, params.chatId, params.threadId)}`,
    );
    throw firstAttempt.cause;
  }
  logger.error(
    { ...logBinding, err: firstAttempt.cause },
    `Telegram sendMessage failed, retrying in 3s: ${describeSendError(firstAttempt.cause, params.chatId, params.threadId)}`,
  );
  await delay(RETRY_DELAY_MS);
  const secondAttempt = await sendMessageOnceWithCause(api, params);
  const second = secondAttempt.result;
  if (second.ok) {
    logger.info(logBinding, 'Telegram sendMessage ok (after retry)');
    return second.message;
  }
  logger.fatal(
    { ...logBinding, err: secondAttempt.cause },
    `Telegram sendMessage failed after retry: ${describeSendError(secondAttempt.cause, params.chatId, params.threadId)}`,
  );
  throw secondAttempt.cause;
}
