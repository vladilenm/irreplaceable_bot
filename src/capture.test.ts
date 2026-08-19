import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bot, Context } from 'grammy';
import type { CapturedMessage } from './types.js';

const { mockUpsertMessage, mockMapMessage } = vi.hoisted(() => ({
  mockUpsertMessage: vi.fn(),
  mockMapMessage: vi.fn(),
}));

vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), error: vi.fn() },
}));
vi.mock('./database.js', () => ({
  upsertMessage: mockUpsertMessage,
}));
import { registerCaptureHandlers } from './capture.js';

const captured: CapturedMessage = {
  chatId: -2002,
  threadId: 10,
  tgMessageId: 1,
  authorId: 1,
  authorName: 'Test',
  isAnonymous: 0,
  text: 'message',
  replyToMessageId: null,
  createdAt: '2026-08-19T10:00:00.000Z',
  editedAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockMapMessage.mockReturnValue(captured);
});

describe('capture chat boundary', () => {
  it('ignores a tracked thread id from a different chat', async () => {
    let handler: ((ctx: Context) => Promise<void>) | undefined;
    const bot = {
      on: vi.fn((_query, next) => {
        handler = next as (ctx: Context) => Promise<void>;
      }),
    } as unknown as Bot;

    registerCaptureHandlers(bot, {
      targetChatId: -1001,
      trackedThreadIds: new Set([10]),
      mapMessage: mockMapMessage,
    });
    await handler?.({
      chat: { id: -2002 },
      msg: {
        is_topic_message: true,
        message_thread_id: 10,
      },
      update: { update_id: 1 },
    } as Context);

    expect(mockUpsertMessage).not.toHaveBeenCalled();
  });

  it('captures only thread ids passed in options', async () => {
    let handler: ((ctx: Context) => Promise<void>) | undefined;
    const bot = {
      on: vi.fn((_query, next) => {
        handler = next as (ctx: Context) => Promise<void>;
      }),
    } as unknown as Bot;

    registerCaptureHandlers(bot, {
      targetChatId: -2002,
      trackedThreadIds: new Set([10]),
      mapMessage: mockMapMessage,
    });
    const context = (threadId: number) => ({
      chat: { id: -2002 },
      msg: { is_topic_message: true, message_thread_id: threadId },
      update: { update_id: threadId },
    } as Context);

    await handler?.(context(99));
    expect(mockUpsertMessage).not.toHaveBeenCalled();

    await handler?.(context(10));
    expect(mockUpsertMessage).toHaveBeenCalledTimes(1);
  });
});
