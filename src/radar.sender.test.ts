import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DigestResult } from './radar.js';
import type { DigestItem } from './types.js';
import type { Api } from 'grammy';

const {
  mockSendMessageWithRetry,
  mockRecordDigestCompletion,
} = vi.hoisted(() => {
  return {
    mockSendMessageWithRetry: vi.fn(),
    mockRecordDigestCompletion: vi.fn(),
  };
});

vi.mock('./telegram.js', () => ({
  sendMessageWithRetry: mockSendMessageWithRetry,
}));
vi.mock('./database.js', () => ({
  readState: vi.fn(),
  isDigestPublishedTodayWithState: vi.fn(),
  recordDigestCompletion: mockRecordDigestCompletion,
}));

import { sendDigest } from './radar.js';

const api = {} as Api;

const item: DigestItem = {
  title: 'Новость',
  summary: 'Практический вывод',
  url: 'https://example.com',
  category: 'tools',
};

const okResult = (overrides: Partial<DigestResult> = {}): DigestResult => ({
  items: [item],
  itemCount: 1,
  skipped: false,
  date: new Date('2026-05-02T06:00:00.000Z'),
  alreadyPublished: false,
  persistState: true,
  ...overrides,
});

describe('sendDigest delivery state', () => {
  beforeEach(() => {
    mockSendMessageWithRetry.mockReset();
    mockRecordDigestCompletion.mockClear();
  });

  it('A1: records completion only after Telegram accepts the message', async () => {
    mockSendMessageWithRetry.mockResolvedValue(undefined);
    await sendDigest(api, okResult());
    expect(mockSendMessageWithRetry).toHaveBeenCalledTimes(1);
    expect(mockRecordDigestCompletion).toHaveBeenCalledTimes(1);
    const sendOrder = mockSendMessageWithRetry.mock.invocationCallOrder[0] ?? 0;
    const writeOrder = mockRecordDigestCompletion.mock.invocationCallOrder[0] ?? 0;
    expect(writeOrder).toBeGreaterThan(sendOrder);
  });

  it('A2: records the delivered item count', async () => {
    mockSendMessageWithRetry.mockResolvedValue(undefined);
    await sendDigest(api, okResult({ itemCount: 3 }));
    expect(mockRecordDigestCompletion).toHaveBeenCalledWith(expect.any(Date), false, 3);
  });

  it('A3: failed delivery leaves job state untouched', async () => {
    mockSendMessageWithRetry.mockRejectedValue(new Error('Telegram down'));
    await expect(sendDigest(api, okResult())).rejects.toThrow('Telegram down');
    expect(mockRecordDigestCompletion).not.toHaveBeenCalled();
  });

  it('A4: persistState:false does not record a successful development run', async () => {
    mockSendMessageWithRetry.mockResolvedValue(undefined);
    await sendDigest(api, okResult({ persistState: false }));
    expect(mockSendMessageWithRetry).toHaveBeenCalledTimes(1);
    expect(mockRecordDigestCompletion).not.toHaveBeenCalled();
  });

  it('A5: skipped result is neither sent nor recorded by the sender', async () => {
    await sendDigest(api, okResult({ skipped: true, items: [] }));
    expect(mockSendMessageWithRetry).not.toHaveBeenCalled();
    expect(mockRecordDigestCompletion).not.toHaveBeenCalled();
  });
});
