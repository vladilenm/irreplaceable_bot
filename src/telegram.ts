import { GrammyError, HttpError, type Api } from 'grammy';
import { logger, safeErrorMetadata } from './logger.js';

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

export interface TelegramErrorMetadata {
  errorClass: string;
  causeClass?: string;
  status?: number;
  code?: string;
}

const RETRY_DELAY_MS = 3000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type SentMessage = Awaited<ReturnType<Api['sendMessage']>>;

export type SendMessageOnceResult =
  | { ok: true; message: SentMessage; durationMs: number }
  | {
      ok: false;
      errorCode: string;
      retryable: boolean;
      retryAfterMs: number | null;
      errorMetadata: TelegramErrorMetadata;
      durationMs: number;
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

function metadataFor(err: unknown): TelegramErrorMetadata {
  if (err instanceof GrammyError) {
    return { errorClass: 'GrammyError', status: err.error_code };
  }
  if (err instanceof HttpError) {
    const cause = safeErrorMetadata(err.error);
    return {
      errorClass: 'HttpError',
      causeClass: cause.errorClass,
      ...(cause.status === undefined ? {} : { status: cause.status }),
      ...(cause.code === undefined ? {} : { code: cause.code }),
    };
  }
  return safeErrorMetadata(err);
}

function classifySendError(
  err: unknown,
): Omit<Extract<SendMessageOnceResult, { ok: false }>, 'ok' | 'durationMs'> {
  const errorMetadata = metadataFor(err);
  if (err instanceof GrammyError) {
    const errorCode = err.error_code;
    const retryAfter = err.parameters?.retry_after;
    if (errorCode === 429) {
      return {
        errorCode: 'telegram-429',
        retryable: true,
        retryAfterMs: typeof retryAfter === 'number' ? retryAfter * 1000 : null,
        errorMetadata,
      };
    }
    if (errorCode >= 400 && errorCode < 500) {
      return {
        errorCode: `telegram-${String(errorCode)}`,
        retryable: false,
        retryAfterMs: null,
        errorMetadata,
      };
    }
    return {
      errorCode: `telegram-${String(errorCode)}`,
      retryable: true,
      retryAfterMs: null,
      errorMetadata,
    };
  }
  return {
    errorCode: 'telegram-network',
    retryable: true,
    retryAfterMs: null,
    errorMetadata,
  };
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
  const startedAt = Date.now();
  try {
    return {
      result: {
        ok: true,
        message: await attemptSend(api, params),
        durationMs: Date.now() - startedAt,
      },
      cause: null,
    };
  } catch (cause: unknown) {
    return {
      result: {
        ok: false,
        ...classifySendError(cause),
        durationMs: Date.now() - startedAt,
      },
      cause,
    };
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
    logger.info({ ...logBinding, durationMs: first.durationMs }, 'Telegram sendMessage ok');
    return first.message;
  }
  if (!first.retryable) {
    logger.fatal(
      {
        ...logBinding,
        ...first.errorMetadata,
        durationMs: first.durationMs,
        errorCode: first.errorCode,
      },
      'Telegram sendMessage failed without retry',
    );
    throw firstAttempt.cause;
  }
  logger.error(
    {
      ...logBinding,
      ...first.errorMetadata,
      durationMs: first.durationMs,
      errorCode: first.errorCode,
    },
    'Telegram sendMessage failed, retrying in 3s',
  );
  await delay(RETRY_DELAY_MS);
  const secondAttempt = await sendMessageOnceWithCause(api, params);
  const second = secondAttempt.result;
  if (second.ok) {
    logger.info({ ...logBinding, durationMs: second.durationMs }, 'Telegram sendMessage ok (after retry)');
    return second.message;
  }
  logger.fatal(
    {
      ...logBinding,
      ...second.errorMetadata,
      durationMs: second.durationMs,
      errorCode: second.errorCode,
    },
    'Telegram sendMessage failed after retry',
  );
  throw secondAttempt.cause;
}
