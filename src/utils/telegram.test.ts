import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Phase 8 fix C: contract tests for the neutral telegram log + pipeline tag.
// We mock bot.api.sendMessage to control success/failure and spy on the pino
// logger to assert the new log shape.

const { mockSendMessage } = vi.hoisted(() => ({
  mockSendMessage: vi.fn(),
}));

vi.mock('../bot.js', () => ({
  bot: {
    api: {
      sendMessage: mockSendMessage,
    },
  },
}));

import { sendMessageWithRetry } from './telegram.js';
import { logger } from './logger.js';

describe('sendMessageWithRetry log shape (Phase 8 fix C)', () => {
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
    await sendMessageWithRetry({
      chatId: '-100',
      threadId: '42',
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
    await sendMessageWithRetry({
      chatId: '-100',
      threadId: '42',
      text: 'hi',
      parseMode: 'HTML',
      pipeline: 'thread-summary',
    });

    const successCall = infoSpy.mock.calls.find((c) => c[1] === 'Telegram sendMessage ok');
    const binding = successCall?.[0] as { chatId: string; threadId: string; pipeline: string };
    expect(binding.chatId).toBe('-100');
    expect(binding.threadId).toBe('42');
    expect(binding.pipeline).toBe('thread-summary');
  });

  it('C3: failure-then-retry-success → first error log AND retry-success log both carry pipeline', async () => {
    const infoSpy = vi.spyOn(logger, 'info');
    const errorSpy = vi.spyOn(logger, 'error');
    vi.useFakeTimers();
    mockSendMessage
      .mockRejectedValueOnce(new Error('flaky'))
      .mockResolvedValueOnce({});

    const promise = sendMessageWithRetry({
      chatId: '-100',
      threadId: '42',
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
    // Diagnostic contract (prod-digest-delivery-conflict): error fields surface in msg.
    expect(errorCall?.[1] as string).toContain('error_code=');
    expect(errorCall?.[1] as string).toContain('chatId=-100');
    expect(errorCall?.[1] as string).toContain('threadId=42');

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

    const promise = sendMessageWithRetry({
      chatId: '-100',
      threadId: '42',
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
    // Diagnostic contract (prod-digest-delivery-conflict): error fields surface in msg.
    // Note: error from `new Error('flaky-2')` is a plain Error, so error_code falls back to 'no-code'.
    expect(fatalCall?.[1] as string).toContain('error_code=no-code');
    expect(fatalCall?.[1] as string).toContain('description=flaky-2');
  });

  it('C5: pipeline is optional — omitted call still works and binding has pipeline:undefined', async () => {
    const infoSpy = vi.spyOn(logger, 'info');
    mockSendMessage.mockResolvedValue({});
    await sendMessageWithRetry({
      chatId: '-100',
      threadId: '42',
      text: 'hi',
      parseMode: 'HTML',
    });

    const successCall = infoSpy.mock.calls.find((c) => c[1] === 'Telegram sendMessage ok');
    const binding = successCall?.[0] as { pipeline?: string };
    expect(binding.pipeline).toBeUndefined();
  });
});
