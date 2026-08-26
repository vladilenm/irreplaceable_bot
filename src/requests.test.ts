import { expect, it, vi } from 'vitest';
import type { Api, Bot, Context } from 'grammy';
import type { MemberMatcher, PublicMemberMatch } from './request.matcher.js';
import type { RequestRepository } from './request.repository.js';
import { type SendMessageParams, sendMessageWithRetry } from './telegram.js';
import {
  BoundedTaskQueue,
  extractMemberRequest,
  formatMemberMatches,
  registerRequestHandlers,
} from './requests.js';

function context(overrides: Record<string, unknown> = {}): Context {
  const chatId = (overrides['chatId'] as number | undefined) ?? -1001;
  const text = overrides['text'] as string | undefined;
  const caption = overrides['caption'] as string | undefined;
  return {
    chat: { id: chatId },
    msg: {
      chat: { id: chatId },
      message_id: (overrides['messageId'] as number | undefined) ?? 77,
      message_thread_id: Object.hasOwn(overrides, 'threadId')
        ? overrides['threadId'] as number | undefined
        : 10,
      is_topic_message: (overrides['isTopic'] as boolean | undefined) ?? true,
      text,
      caption,
      entities: overrides['entities'],
      caption_entities: overrides['captionEntities'],
      from: { id: 5, username: 'author' },
    },
    update: { update_id: 1 },
    api: {},
  } as Context;
}

const matches: PublicMemberMatch[] = [
  { memberId: 'anna', displayName: 'Анна', telegramUsername: 'anna_product', reason: 'B2B SaaS', similarity: 1 },
  { memberId: 'mikhail', displayName: 'Михаил', telegramUsername: 'mikhail_saas', reason: 'Enterprise sales', similarity: 0.9 },
  { memberId: 'olga', displayName: 'Ольга', telegramUsername: 'olga_pilots', reason: 'Проводила пилоты', similarity: 0.8 },
];

function requestRepository(reserve = true) {
  return {
    reserve: vi.fn(async () => reserve),
    complete: vi.fn(async () => undefined),
    noMatch: vi.fn(async () => undefined),
    fail: vi.fn(async () => undefined),
    failStale: vi.fn(async () => 0),
    read: vi.fn(async () => null),
  };
}

function register(options: {
  repository?: RequestRepository;
  matcher?: Pick<MemberMatcher, 'match'>;
  concurrency?: number;
  queueLimit?: number;
  isMatchingReady?: () => Promise<boolean>;
  send?: typeof sendMessageWithRetry;
}) {
  let handler: ((ctx: Context, next: () => Promise<void>) => Promise<void>) | undefined;
  const bot = {
    on: vi.fn((_query, next) => {
      handler = next as typeof handler;
    }),
  } as unknown as Bot;
  registerRequestHandlers(bot, {
    targetChatId: -1001,
    repository: options.repository ?? requestRepository(),
    matcher: (options.matcher ?? { match: vi.fn().mockResolvedValue(matches) }) as MemberMatcher,
    concurrency: options.concurrency ?? 2,
    queueLimit: options.queueLimit ?? 50,
    isMatchingReady: options.isMatchingReady,
    send: options.send,
    now: () => new Date('2026-08-21T10:00:00.000Z'),
  });
  if (!handler) throw new Error('request handler was not registered');
  return handler;
}

it('extracts exact hashtag entities and removes every request marker', () => {
  const result = extractMemberRequest(context({
    text: '#запрос Ищу B2B SaaS эксперта #ЗАПРОС',
    entities: [
      { type: 'hashtag', offset: 0, length: 7 },
      { type: 'hashtag', offset: 30, length: 7 },
    ],
  }), -1001);

  expect(result).toMatchObject({
    chatId: -1001,
    threadId: 10,
    messageId: 77,
    authorId: 5,
    authorUsername: 'author',
    query: 'Ищу B2B SaaS эксперта',
  });
});

it('ignores missing entity, lookalike hashtag and another chat', () => {
  expect(extractMemberRequest(context({ text: '#запрос x' }), -1001)).toBeNull();
  expect(extractMemberRequest(context({
    text: '#запросы',
    entities: [{ type: 'hashtag', offset: 0, length: 8 }],
  }), -1001)).toBeNull();
  expect(extractMemberRequest(context({
    chatId: -2002,
    text: '#запрос x',
    entities: [{ type: 'hashtag', offset: 0, length: 7 }],
  }), -1001)).toBeNull();
});

it('supports captions, uppercase hashtags, edits and UTF-16 offsets', () => {
  const result = extractMemberRequest(context({
    caption: '🚀 #ЗАПРОС Нужен партнёр',
    captionEntities: [{ type: 'hashtag', offset: 3, length: 7 }],
  }), -1001);

  expect(result?.query).toBe('🚀 Нужен партнёр');
  expect(extractMemberRequest(context({
    text: '#запрос x',
    entities: [{ type: 'hashtag', offset: 0, length: 7 }],
    threadId: undefined,
  }), -1001)).toBeNull();
});

it('formats code-owned usernames and escapes LLM reasons', () => {
  expect(formatMemberMatches([{ ...matches[0]!, reason: '<b>опасный</b> & текст' }]))
    .toContain('@anna_product — &lt;b&gt;опасный&lt;/b&gt; &amp; текст');
});

it('always continues to the next middleware and ignores duplicate reservations', async () => {
  const repository = requestRepository(false);
  const matcher = { match: vi.fn() } as Pick<MemberMatcher, 'match'>;
  const handler = register({ repository, matcher });
  const next = vi.fn().mockResolvedValue(undefined);

  await handler(context({
    text: '#запрос Ищу эксперта',
    entities: [{ type: 'hashtag', offset: 0, length: 7 }],
  }), next);

  expect(next).toHaveBeenCalledTimes(1);
  expect(matcher.match).not.toHaveBeenCalled();
});

it('replies to empty requests and records a no-match terminal state', async () => {
  const repository = requestRepository();
  const matcher = { match: vi.fn() } as Pick<MemberMatcher, 'match'>;
  const send = vi.fn().mockResolvedValue({ message_id: 88 }) as unknown as typeof sendMessageWithRetry;
  const handler = register({ repository, matcher, send });

  await handler(context({
    text: '#запрос',
    entities: [{ type: 'hashtag', offset: 0, length: 7 }],
  }), vi.fn().mockResolvedValue(undefined));

  await vi.waitFor(() => expect(repository.noMatch).toHaveBeenCalledTimes(1));
  expect(matcher.match).not.toHaveBeenCalled();
  expect(send).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
    text: 'Опишите запрос после #запрос.',
    replyToMessageId: 77,
  }));
});

it('sends three matches in the source topic and records completion', async () => {
  const repository = requestRepository();
  const matcher = { match: vi.fn().mockResolvedValue(matches) } as Pick<MemberMatcher, 'match'>;
  const send = vi.fn().mockResolvedValue({ message_id: 88 }) as unknown as typeof sendMessageWithRetry;
  const handler = register({ repository, matcher, send });

  await handler(context({
    text: '#запрос Ищу эксперта',
    entities: [{ type: 'hashtag', offset: 0, length: 7 }],
  }), vi.fn().mockResolvedValue(undefined));

  await vi.waitFor(() => expect(repository.complete).toHaveBeenCalledTimes(1));
  expect(send).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
    chatId: -1001,
    threadId: 10,
    replyToMessageId: 77,
    pipeline: 'member-request',
    text: expect.stringContaining('@anna_product'),
  }));
  expect(repository.complete).toHaveBeenCalledWith(-1001, 77, expect.objectContaining({
    responseMessageId: 88,
    matchCount: 3,
  }));
  expect(matcher.match).toHaveBeenCalledWith('Ищу эксперта', '5');
});

it('fails safely without embedding or matching before the first member snapshot', async () => {
  const repository = requestRepository();
  const matcher = { match: vi.fn() } as Pick<MemberMatcher, 'match'>;
  const isMatchingReady = vi.fn().mockResolvedValue(false);
  const send = vi.fn().mockResolvedValue({ message_id: 88 }) as unknown as typeof sendMessageWithRetry;
  const handler = register({ repository, matcher, isMatchingReady, send });

  await handler(context({
    text: '#запрос Ищу эксперта',
    entities: [{ type: 'hashtag', offset: 0, length: 7 }],
  }), vi.fn().mockResolvedValue(undefined));

  await vi.waitFor(() => expect(repository.fail).toHaveBeenCalledWith(
    -1001,
    77,
    'member-source-not-ready',
    expect.any(String),
  ));
  expect(isMatchingReady).toHaveBeenCalledTimes(1);
  expect(matcher.match).not.toHaveBeenCalled();
  expect(send).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
    text: 'Подбор участников временно недоступен. Попробуйте отправить новый запрос позже.',
  }));
});

it('publishes and persists at most five matches', async () => {
  const repository = requestRepository();
  const sixMatches = [...matches, ...matches.map((match, index) => ({
    ...match,
    memberId: `${match.memberId}-${String(index)}`,
    telegramUsername: `${match.telegramUsername}_${String(index)}`,
  }))];
  const matcher = { match: vi.fn().mockResolvedValue(sixMatches) } as Pick<MemberMatcher, 'match'>;
  const send = vi.fn().mockResolvedValue({ message_id: 88 }) as unknown as typeof sendMessageWithRetry;
  const handler = register({ repository, matcher, send });

  await handler(context({
    text: '#запрос Ищу эксперта',
    entities: [{ type: 'hashtag', offset: 0, length: 7 }],
  }), vi.fn().mockResolvedValue(undefined));

  await vi.waitFor(() => expect(repository.complete).toHaveBeenCalledTimes(1));
  expect(repository.complete).toHaveBeenCalledWith(-1001, 77, expect.objectContaining({
    matchCount: 5,
  }));
  const params = (send as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as SendMessageParams;
  expect((params.text.match(/^\d+\./gm) ?? [])).toHaveLength(5);
});

it('returns a no-match reply without mentions for fewer than three matches', async () => {
  const repository = requestRepository();
  const matcher = { match: vi.fn().mockResolvedValue(matches.slice(0, 2)) } as Pick<MemberMatcher, 'match'>;
  const send = vi.fn().mockResolvedValue({ message_id: 88 }) as unknown as typeof sendMessageWithRetry;
  const handler = register({ repository, matcher, send });

  await handler(context({
    text: '#запрос Ищу эксперта',
    entities: [{ type: 'hashtag', offset: 0, length: 7 }],
  }), vi.fn().mockResolvedValue(undefined));

  await vi.waitFor(() => expect(repository.noMatch).toHaveBeenCalledTimes(1));
  const params = (send as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as SendMessageParams;
  expect(params.text).toBe('Не удалось найти минимум трёх надёжно подходящих участников.');
  expect(params.text).not.toContain('@');
});

it('reports matcher failures and persists a failed terminal state', async () => {
  const repository = requestRepository();
  const matcher = { match: vi.fn().mockRejectedValue(new Error('matcher unavailable')) } as Pick<MemberMatcher, 'match'>;
  const send = vi.fn().mockResolvedValue({ message_id: 88 }) as unknown as typeof sendMessageWithRetry;
  const handler = register({ repository, matcher, send });

  await handler(context({
    text: '#запрос Ищу эксперта',
    entities: [{ type: 'hashtag', offset: 0, length: 7 }],
  }), vi.fn().mockResolvedValue(undefined));

  await vi.waitFor(() => expect(repository.fail).toHaveBeenCalledWith(
    -1001,
    77,
    'processing-failed',
    expect.any(String),
  ));
  expect(send).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
    text: 'Подбор участников временно недоступен. Попробуйте отправить новый запрос позже.',
  }));
});

it('marks failures and keeps a full queue from starting another matcher', async () => {
  let resolveFirst: (() => void) | undefined;
  const pending = new Promise<PublicMemberMatch[]>((resolve) => {
    resolveFirst = () => resolve(matches);
  });
  const repository = requestRepository();
  const matcher = { match: vi.fn(() => pending) } as Pick<MemberMatcher, 'match'>;
  const send = vi.fn().mockResolvedValue({ message_id: 88 }) as unknown as typeof sendMessageWithRetry;
  const handler = register({ repository, matcher, send, concurrency: 1, queueLimit: 0 });
  const request = (messageId: number) => context({
    messageId,
    text: '#запрос Ищу эксперта',
    entities: [{ type: 'hashtag', offset: 0, length: 7 }],
  });

  await handler(request(77), vi.fn().mockResolvedValue(undefined));
  await vi.waitFor(() => expect(matcher.match).toHaveBeenCalledTimes(1));
  await handler(request(78), vi.fn().mockResolvedValue(undefined));

  await vi.waitFor(() => expect(repository.fail).toHaveBeenCalledWith(
    -1001,
    78,
    'queue-full',
    expect.any(String),
  ));
  expect(matcher.match).toHaveBeenCalledTimes(1);
  resolveFirst?.();
});

it('contains task exceptions inside BoundedTaskQueue', async () => {
  const queue = new BoundedTaskQueue(1, 1);
  expect(queue.submit(async () => { throw new Error('boom'); })).toBe(true);
  expect(queue.submit(async () => undefined)).toBe(true);
  await vi.waitFor(() => expect(queue.pending).toBe(0));
});
