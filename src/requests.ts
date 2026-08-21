import { createHash } from 'node:crypto';
import type { Api, Bot, Context } from 'grammy';
import { logger } from './logger.js';
import type { PublicMemberMatch, MemberMatcher } from './request.matcher.js';
import type { RequestRepository } from './request.repository.js';
import { sendMessageWithRetry } from './telegram.js';

export interface IncomingMemberRequest {
  chatId: number;
  threadId: number;
  messageId: number;
  authorId: number | null;
  authorUsername: string | null;
  query: string;
}

export function extractMemberRequest(
  ctx: Context,
  targetChatId: number,
): IncomingMemberRequest | null {
  const msg = ctx.msg;
  if (
    !msg ||
    ctx.chat?.id !== targetChatId ||
    msg.is_topic_message !== true ||
    msg.message_thread_id === undefined
  ) {
    return null;
  }
  const text = msg.text ?? msg.caption ?? '';
  const entities = msg.entities ?? msg.caption_entities ?? [];
  const tags = entities.filter((entity) =>
    entity.type === 'hashtag' &&
    text.slice(entity.offset, entity.offset + entity.length).toLocaleLowerCase('ru-RU') === '#запрос');
  if (tags.length === 0) return null;

  let query = text;
  for (const tag of [...tags].sort((left, right) => right.offset - left.offset)) {
    query = `${query.slice(0, tag.offset)} ${query.slice(tag.offset + tag.length)}`;
  }
  return {
    chatId: msg.chat.id,
    threadId: msg.message_thread_id,
    messageId: msg.message_id,
    authorId: msg.from?.id ?? null,
    authorUsername: msg.from?.username?.toLowerCase() ?? null,
    query: query.replace(/\s+/g, ' ').trim(),
  };
}

const escapeHtml = (value: string): string => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

export function formatMemberMatches(matches: readonly PublicMemberMatch[]): string {
  return [
    '🔎 <b>Могут подойти:</b>',
    '',
    ...matches.map((match, index) =>
      `${String(index + 1)}. @${match.telegramUsername} — ${escapeHtml(match.reason)}`),
  ].join('\n');
}

type Task = () => Promise<void>;

export class BoundedTaskQueue {
  private readonly tasks: Task[] = [];
  private running = 0;

  constructor(
    private readonly concurrency: number,
    private readonly queueLimit: number,
  ) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error('concurrency must be >= 1');
    }
    if (!Number.isInteger(queueLimit) || queueLimit < 0) {
      throw new Error('queueLimit must be >= 0');
    }
  }

  get pending(): number {
    return this.tasks.length;
  }

  submit(task: Task): boolean {
    if (this.running < this.concurrency) {
      this.start(task);
      return true;
    }
    if (this.tasks.length >= this.queueLimit) return false;
    this.tasks.push(task);
    return true;
  }

  private start(task: Task): void {
    this.running++;
    void Promise.resolve()
      .then(task)
      .catch((error: unknown) => {
        logger.error({ errorClass: error instanceof Error ? error.name : 'unknown' }, 'Member request task failed');
      })
      .finally(() => {
        this.running--;
        const next = this.tasks.shift();
        if (next) this.start(next);
      });
  }
}

export interface RequestHandlerOptions {
  targetChatId: number;
  matcher: MemberMatcher;
  repository: RequestRepository;
  concurrency: number;
  queueLimit: number;
  send?: typeof sendMessageWithRetry;
  now?: () => Date;
}

const emptyRequestText = 'Опишите запрос после #запрос.';
const noMatchText = 'Не удалось найти минимум трёх надёжно подходящих участников.';
const failedText = 'Подбор участников временно недоступен. Попробуйте отправить новый запрос позже.';

function nowIso(options: RequestHandlerOptions): string {
  return (options.now ?? (() => new Date()))().toISOString();
}

async function sendReply(
  api: Api,
  request: IncomingMemberRequest,
  text: string,
  options: RequestHandlerOptions,
) {
  return (options.send ?? sendMessageWithRetry)(api, {
    chatId: request.chatId,
    threadId: request.threadId,
    replyToMessageId: request.messageId,
    text,
    parseMode: 'HTML',
    pipeline: 'member-request',
  });
}

async function failRequest(
  api: Api,
  request: IncomingMemberRequest,
  options: RequestHandlerOptions,
  errorCode: string,
): Promise<void> {
  try {
    await sendReply(api, request, failedText, options);
  } catch (error: unknown) {
    logger.error({
      chatId: request.chatId,
      threadId: request.threadId,
      messageId: request.messageId,
      errorClass: error instanceof Error ? error.name : 'unknown',
    }, 'Member request failure reply was not delivered');
  }
  options.repository.fail(request.chatId, request.messageId, errorCode, nowIso(options));
}

async function processRequest(
  api: Api,
  request: IncomingMemberRequest,
  options: RequestHandlerOptions,
): Promise<void> {
  try {
    if (request.query === '') {
      const sent = await sendReply(api, request, emptyRequestText, options);
      options.repository.noMatch(request.chatId, request.messageId, {
        responseMessageId: sent.message_id,
        completedAt: nowIso(options),
      });
      return;
    }

    const matches = await options.matcher.match(request.query, request.authorUsername ?? undefined);
    if (matches.length < 3) {
      const sent = await sendReply(api, request, noMatchText, options);
      options.repository.noMatch(request.chatId, request.messageId, {
        responseMessageId: sent.message_id,
        completedAt: nowIso(options),
      });
      return;
    }

    const sent = await sendReply(api, request, formatMemberMatches(matches.slice(0, 5)), options);
    options.repository.complete(request.chatId, request.messageId, {
      responseMessageId: sent.message_id,
      matchCount: matches.length,
      completedAt: nowIso(options),
    });
  } catch (error: unknown) {
    logger.error({
      chatId: request.chatId,
      threadId: request.threadId,
      messageId: request.messageId,
      errorClass: error instanceof Error ? error.name : 'unknown',
    }, 'Member request matching failed');
    await failRequest(api, request, options, 'processing-failed');
  }
}

function reserveAndQueue(
  api: Api,
  request: IncomingMemberRequest,
  queue: BoundedTaskQueue,
  options: RequestHandlerOptions,
): void {
  const reserved = options.repository.reserve({
    chatId: request.chatId,
    messageId: request.messageId,
    threadId: request.threadId,
    authorId: request.authorId,
    authorUsername: request.authorUsername,
    queryHash: createHash('sha256').update(request.query).digest('hex'),
    startedAt: nowIso(options),
  });
  if (!reserved) return;

  if (!queue.submit(() => processRequest(api, request, options))) {
    logger.warn({
      chatId: request.chatId,
      threadId: request.threadId,
      messageId: request.messageId,
    }, 'Member request queue is full');
    void failRequest(api, request, options, 'queue-full');
  }
}

export function registerRequestHandlers(bot: Bot, options: RequestHandlerOptions): void {
  const queue = new BoundedTaskQueue(options.concurrency, options.queueLimit);
  bot.on(
    ['message:text', 'message:caption', 'edited_message:text', 'edited_message:caption'],
    async (ctx, next) => {
      const request = extractMemberRequest(ctx, options.targetChatId);
      if (request) reserveAndQueue(ctx.api, request, queue, options);
      await next();
    },
  );
}
