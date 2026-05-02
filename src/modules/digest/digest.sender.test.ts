import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DigestResult } from './digest.service.js';
import type { PipelineStateV2 } from '../../types/index.js';

// Phase 8 fix A: contract tests for the post-send state-write split.
// Hoisted mocks per vitest convention so vi.mock() factories can reference
// the spy fns without "Cannot access X before initialization".
const {
  mockSendMessageWithRetry,
  mockReadState,
  mockWriteState,
  mockState,
} = vi.hoisted(() => {
  const state: { current: PipelineStateV2 } = {
    current: {
      lastDigestDate: '2026-04-29T06:00:00.000Z', // pre-existing — must be preserved on merge-write
      lastSkipped: false,
      lastItemCount: 0,
      lastThreadSummaryDate: '2026-04-30T03:30:00.000Z',
    },
  };
  return {
    mockState: state,
    mockSendMessageWithRetry: vi.fn(),
    mockReadState: vi.fn(() => state.current),
    mockWriteState: vi.fn((s: PipelineStateV2) => {
      state.current = s;
    }),
  };
});

vi.mock('../../utils/telegram.js', () => ({
  sendMessageWithRetry: mockSendMessageWithRetry,
}));
vi.mock('../../services/state.service.js', () => ({
  readState: mockReadState,
  writeState: mockWriteState,
}));
// config.js is loaded for real — tests/setup.ts sets the required env vars.
// Avoiding a mock for config keeps us aligned with thread-summary.sender.test.ts
// and dodges a vitest module-resolution corner case that prevented test
// collection in this file.

import { sendDigest } from './digest.sender.js';

const okResult = (overrides: Partial<DigestResult> = {}): DigestResult => ({
  text: 'header → https://example.com',
  itemCount: 1,
  skipped: false,
  date: new Date('2026-05-02T06:00:00.000Z'),
  alreadyPublished: false,
  persistState: true,
  ...overrides,
});

describe('sendDigest post-send state-write contract (Phase 8 fix A)', () => {
  beforeEach(() => {
    mockSendMessageWithRetry.mockReset();
    mockReadState.mockClear();
    mockWriteState.mockClear();
    mockState.current = {
      lastDigestDate: '2026-04-29T06:00:00.000Z',
      lastSkipped: false,
      lastItemCount: 0,
      lastThreadSummaryDate: '2026-04-30T03:30:00.000Z',
    };
    mockReadState.mockImplementation(() => mockState.current);
  });

  it('A1: success path → sendMessageWithRetry called THEN writeState called', async () => {
    mockSendMessageWithRetry.mockResolvedValue(undefined);
    await sendDigest(okResult());
    expect(mockSendMessageWithRetry).toHaveBeenCalledTimes(1);
    expect(mockWriteState).toHaveBeenCalledTimes(1);
    const sendOrder = mockSendMessageWithRetry.mock.invocationCallOrder[0] ?? 0;
    const writeOrder = mockWriteState.mock.invocationCallOrder[0] ?? 0;
    expect(writeOrder).toBeGreaterThan(sendOrder);
  });

  it('A2: success path → writeState merge-write preserves lastThreadSummaryDate', async () => {
    mockSendMessageWithRetry.mockResolvedValue(undefined);
    await sendDigest(okResult({ itemCount: 3 }));
    const written = mockWriteState.mock.calls[0]?.[0];
    expect(written?.lastThreadSummaryDate).toBe('2026-04-30T03:30:00.000Z');
    expect(written?.lastSkipped).toBe(false);
    expect(written?.lastItemCount).toBe(3);
    expect(written?.lastDigestDate).not.toBe('2026-04-29T06:00:00.000Z');
  });

  it('A3: failed send → sendMessageWithRetry throws → writeState NOT called → lastDigestDate untouched', async () => {
    mockSendMessageWithRetry.mockRejectedValue(new Error('Telegram down'));
    await expect(sendDigest(okResult())).rejects.toThrow('Telegram down');
    expect(mockWriteState).not.toHaveBeenCalled();
    expect(mockState.current.lastDigestDate).toBe('2026-04-29T06:00:00.000Z');
  });

  it('A4: persistState:false → writeState NOT called even on success', async () => {
    mockSendMessageWithRetry.mockResolvedValue(undefined);
    await sendDigest(okResult({ persistState: false }));
    expect(mockSendMessageWithRetry).toHaveBeenCalledTimes(1);
    expect(mockWriteState).not.toHaveBeenCalled();
  });

  it('A5: skipped:true → no send, no writeState (skip-path state-write is the pipeline\'s job, not the sender\'s)', async () => {
    await sendDigest(okResult({ skipped: true, text: '' }));
    expect(mockSendMessageWithRetry).not.toHaveBeenCalled();
    expect(mockWriteState).not.toHaveBeenCalled();
  });
});
