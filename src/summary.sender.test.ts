import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Api } from 'grammy';

// vi.hoisted: factory variables must be hoisted with vi.mock to avoid
// "Cannot access X before initialization" — vitest hoists vi.mock above imports.
const { mockSendMessageWithRetry } = vi.hoisted(() => ({
  mockSendMessageWithRetry: vi.fn(),
}));

vi.mock('./telegram.js', () => ({
  sendMessageWithRetry: mockSendMessageWithRetry,
}));

// Static import — the vi.mock factory above runs BEFORE this resolves (vitest hoists).
import { sendThreadSummary } from './summary.js';

const api = {} as Api;

describe('sendThreadSummary chunks loop (DLV-09, D-38)', () => {
  beforeEach(() => {
    mockSendMessageWithRetry.mockReset();
  });

  it('S1: iterates chunks and calls sendMessageWithRetry per chunk', async () => {
    await sendThreadSummary(api, ['c1', 'c2']);
    expect(mockSendMessageWithRetry).toHaveBeenCalledTimes(2);
    const firstCall = mockSendMessageWithRetry.mock.calls[0]?.[1];
    expect(firstCall?.text).toBe('c1');
    expect(firstCall?.parseMode).toBe('HTML');
  });

  it('S2: empty array no-op', async () => {
    await sendThreadSummary(api, []);
    expect(mockSendMessageWithRetry).not.toHaveBeenCalled();
  });

  it('S2b: empty-string chunks are skipped (defensive)', async () => {
    await sendThreadSummary(api, ['c1', '', 'c3']);
    expect(mockSendMessageWithRetry).toHaveBeenCalledTimes(2);
  });
});
