import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GrammyError, HttpError, type Api } from 'grammy';

// Mock Telegram delivery and assert the structured log context.

const { mockSendMessage } = vi.hoisted(() => ({
  mockSendMessage: vi.fn(),
}));

import { sendMessageOnce, sendMessageWithRetry } from './telegram.js';
import { logger } from './logger.js';

const api = { sendMessage: mockSendMessage } as unknown as Api;

describe('sendMessageWithRetry log shape', () => {
  beforeEach(() => {
    mockSendMessage.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('C1: success path → logs neutral "Telegram sendMessage ok" (NOT "Digest message sent to Telegram")', async () => {
    const infoSpy = vi.spyOn(logger, 'info');
    mockSendMessage.mockResolvedValue({});
    await sendMessageWithRetry(api, {
      chatId: -100,
      threadId: 42,
      text: 'hi',
      parseMode: 'HTML',
      pipeline: 'digest',
    });

    const successCall = infoSpy.mock.calls.find((c) => c[1] === 'Telegram sendMessage ok');
    expect(successCall).toBeDefined();
    // Belt-and-braces: ensure NO log used the misleading old wording.
    const oldCall = infoSpy.mock.calls.find(
      (c) => typeof c[1] === 'string' && c[1].includes('Digest message sent to Telegram'),
    );
    expect(oldCall).toBeUndefined();
  });

  it('C2: success log binding includes pipeline + chatId + threadId', async () => {
    const infoSpy = vi.spyOn(logger, 'info');
    mockSendMessage.mockResolvedValue({});
    await sendMessageWithRetry(api, {
      chatId: -100,
      threadId: 42,
      text: 'hi',
      parseMode: 'HTML',
      pipeline: 'thread-summary',
    });

    const successCall = infoSpy.mock.calls.find((c) => c[1] === 'Telegram sendMessage ok');
    const binding = successCall?.[0] as { chatId: number; threadId: number; pipeline: string };
    expect(binding.chatId).toBe(-100);
    expect(binding.threadId).toBe(42);
    expect(binding.pipeline).toBe('thread-summary');
  });

  it('C3: failure-then-retry-success → first error log AND retry-success log both carry pipeline', async () => {
    const infoSpy = vi.spyOn(logger, 'info');
    const errorSpy = vi.spyOn(logger, 'error');
    vi.useFakeTimers();
    mockSendMessage
      .mockRejectedValueOnce(new Error('flaky'))
      .mockResolvedValueOnce({});

    const promise = sendMessageWithRetry(api, {
      chatId: -100,
      threadId: 42,
      text: 'hi',
      parseMode: 'HTML',
      pipeline: 'digest',
    });
    await vi.advanceTimersByTimeAsync(3500);
    await promise;

    const errorCall = errorSpy.mock.calls.find(
      (c) =>
        typeof c[1] === 'string' &&
        c[1].startsWith('Telegram sendMessage failed, retrying in 3s'),
    );
    expect(errorCall).toBeDefined();
    expect((errorCall?.[0] as { pipeline: string }).pipeline).toBe('digest');
    expect(errorCall?.[1]).toBe('Telegram sendMessage failed, retrying in 3s');
    expect(JSON.stringify(errorCall)).not.toContain('flaky');

    const retrySuccess = infoSpy.mock.calls.find(
      (c) => c[1] === 'Telegram sendMessage ok (after retry)',
    );
    expect(retrySuccess).toBeDefined();
    expect((retrySuccess?.[0] as { pipeline: string }).pipeline).toBe('digest');
  });

  it('C4: total failure → fatal log carries pipeline and message "Telegram sendMessage failed after retry"', async () => {
    const fatalSpy = vi.spyOn(logger, 'fatal');
    vi.useFakeTimers();
    mockSendMessage
      .mockRejectedValueOnce(new Error('flaky-1'))
      .mockRejectedValueOnce(new Error('flaky-2'));

    const promise = sendMessageWithRetry(api, {
      chatId: -100,
      threadId: 42,
      text: 'hi',
      parseMode: 'HTML',
      pipeline: 'thread-summary',
    });
    // Attach .rejects before timers fire so the rejection has a handler.
    const expectation = expect(promise).rejects.toThrow('flaky-2');
    await vi.advanceTimersByTimeAsync(3500);
    await expectation;

    const fatalCall = fatalSpy.mock.calls.find(
      (c) =>
        typeof c[1] === 'string' &&
        c[1].startsWith('Telegram sendMessage failed after retry'),
    );
    expect(fatalCall).toBeDefined();
    expect((fatalCall?.[0] as { pipeline: string }).pipeline).toBe('thread-summary');
    expect(fatalCall?.[1]).toBe('Telegram sendMessage failed after retry');
    expect(JSON.stringify(fatalCall)).not.toContain('flaky-2');
  });

  it('C5: pipeline is optional — omitted call still works and binding has pipeline:undefined', async () => {
    const infoSpy = vi.spyOn(logger, 'info');
    mockSendMessage.mockResolvedValue({});
    await sendMessageWithRetry(api, {
      chatId: -100,
      threadId: 42,
      text: 'hi',
      parseMode: 'HTML',
    });

    const successCall = infoSpy.mock.calls.find((c) => c[1] === 'Telegram sendMessage ok');
    const binding = successCall?.[0] as { pipeline?: string };
    expect(binding.pipeline).toBeUndefined();
  });

  it('returns sent message and attaches reply_parameters', async () => {
    mockSendMessage.mockResolvedValue({ message_id: 99 });

    const sent = await sendMessageWithRetry(api, {
      chatId: -100,
      threadId: 42,
      replyToMessageId: 77,
      text: 'hi',
      parseMode: 'HTML',
      pipeline: 'member-request',
    });

    expect(sent.message_id).toBe(99);
    expect(mockSendMessage).toHaveBeenCalledWith(-100, 'hi', expect.objectContaining({
      reply_parameters: { message_id: 77, allow_sending_without_reply: true },
    }));
  });
});

describe('sendMessageOnce', () => {
  beforeEach(() => {
    mockSendMessage.mockReset();
  });

  it('returns a retryable Telegram flood-control result including retry_after', async () => {
    mockSendMessage.mockRejectedValue(new GrammyError(
      'Too Many Requests',
      {
        ok: false,
        error_code: 429,
        description: 'Too Many Requests',
        parameters: { retry_after: 17 },
      },
      'sendMessage',
      {},
    ));

    await expect(sendMessageOnce(api, {
      chatId: -100,
      threadId: 42,
      text: 'hi',
      parseMode: 'HTML',
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'telegram-429',
      retryable: true,
      retryAfterMs: 17_000,
      errorMetadata: { errorClass: 'GrammyError', status: 429 },
      durationMs: expect.any(Number),
    });
  });

  it('classifies transport errors as retryable without exposing their text', async () => {
    mockSendMessage.mockRejectedValue(new Error('socket reset with private details'));

    await expect(sendMessageOnce(api, {
      chatId: -100,
      threadId: 42,
      text: 'hi',
      parseMode: 'HTML',
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'telegram-network',
      retryable: true,
      retryAfterMs: null,
      errorMetadata: { errorClass: 'Error' },
      durationMs: expect.any(Number),
    });
  });

  it('extracts only a safe system code from nested HttpError cause', async () => {
    const nested = Object.assign(new Error('connect to secret proxy URI failed'), {
      code: 'ETIMEDOUT',
    });
    mockSendMessage.mockRejectedValue(new HttpError('network failed', nested));

    await expect(sendMessageOnce(api, {
      chatId: -100,
      threadId: 42,
      text: 'hi',
      parseMode: 'HTML',
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'telegram-network',
      retryable: true,
      retryAfterMs: null,
      errorMetadata: {
        errorClass: 'HttpError',
        causeClass: 'Error',
        code: 'ETIMEDOUT',
      },
      durationMs: expect.any(Number),
    });
  });

  it('never puts provider error text into retry logs', async () => {
    const errorSpy = vi.spyOn(logger, 'error');
    vi.useFakeTimers();
    mockSendMessage.mockRejectedValueOnce(
      new HttpError('network failed', new Error('vless' + '://secret-value')),
    ).mockResolvedValueOnce({ message_id: 1 });
    const sent = sendMessageWithRetry(api, {
      chatId: -100,
      threadId: 42,
      text: 'hi',
      parseMode: 'HTML',
    });
    await vi.advanceTimersByTimeAsync(3_100);
    await sent;
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('vless' + '://secret-value');
  });
});
