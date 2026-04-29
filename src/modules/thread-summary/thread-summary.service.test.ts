import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ThreadSummary, PipelineStateV2, CapturedMessage } from '../../types/index.js';

// Mock factories — must be hoisted via vi.hoisted so the vi.mock factories
// (which vitest hoists above imports) can reference these without
// "Cannot access X before initialization" runtime errors.
const {
  mockState,
  mockReadState,
  mockWriteState,
  mockIsThreadSummaryPublishedToday,
  mockListTrackedThreadIds,
  mockListTracked,
  mockSelectMessagesInWindow,
  mockSelectTopParticipants,
  mockSummarizeThread,
} = vi.hoisted(() => {
  const state: { current: PipelineStateV2 } = {
    current: {
      lastDigestDate: null,
      lastSkipped: false,
      lastItemCount: 0,
      lastThreadSummaryDate: null,
    },
  };
  return {
    mockState: state,
    mockReadState: vi.fn(() => state.current),
    mockWriteState: vi.fn((s: PipelineStateV2) => {
      state.current = s;
    }),
    mockIsThreadSummaryPublishedToday: vi.fn(() => false),
    mockListTrackedThreadIds: vi.fn(() => [100, 200, 300]),
    mockListTracked: vi.fn(() => [
      { threadId: 100, chatId: -1, addedBy: null, addedAt: '', title: 'Cached100' },
      { threadId: 200, chatId: -1, addedBy: null, addedAt: '', title: null },
      { threadId: 300, chatId: -1, addedBy: null, addedAt: '', title: null },
    ]),
    mockSelectMessagesInWindow: vi.fn(() => [] as CapturedMessage[]),
    mockSelectTopParticipants: vi.fn(
      () => [] as Array<{ authorName: string; messageCount: number }>,
    ),
    mockSummarizeThread: vi.fn(),
  };
});

vi.mock('../../services/state.service.js', () => ({
  readState: mockReadState,
  writeState: mockWriteState,
  isThreadSummaryPublishedToday: mockIsThreadSummaryPublishedToday,
}));
vi.mock('../../services/tracking.service.js', () => ({
  listTrackedThreadIds: mockListTrackedThreadIds,
}));
vi.mock('../../stores/tracked-threads-store.js', () => ({
  listTracked: mockListTracked,
}));
vi.mock('../../stores/message-store.js', () => ({
  selectMessagesInWindow: mockSelectMessagesInWindow,
  selectTopParticipants: mockSelectTopParticipants,
}));
vi.mock('../../services/summarizer.service.js', () => ({
  summarizeThread: mockSummarizeThread,
}));

import { runThreadSummaryPipeline } from './thread-summary.service.js';

const okSummary = (threadId: number, mc = 10): ThreadSummary => ({
  skipped: false,
  threadId,
  windowHours: 24,
  messageCount: mc,
  headline: 'h',
  bullets: ['b'],
  participants: [],
  openQuestions: [],
});

beforeEach(() => {
  mockState.current = {
    lastDigestDate: null,
    lastSkipped: false,
    lastItemCount: 0,
    lastThreadSummaryDate: null,
  };
  mockReadState.mockClear();
  mockReadState.mockImplementation(() => mockState.current);
  mockWriteState.mockClear();
  mockIsThreadSummaryPublishedToday.mockClear();
  mockIsThreadSummaryPublishedToday.mockReturnValue(false);
  mockListTrackedThreadIds.mockReturnValue([100, 200, 300]);
  mockSelectMessagesInWindow.mockReturnValue([]);
  mockSelectTopParticipants.mockReturnValue([]);
  mockSummarizeThread.mockReset();
});

describe('runThreadSummaryPipeline (DLV-06, DLV-10, D-32..D-35)', () => {
  it('O1: idempotency — already-published-today returns alreadyPublished:true and skips work', async () => {
    mockIsThreadSummaryPublishedToday.mockReturnValue(true);
    mockState.current = { ...mockState.current, lastThreadSummaryDate: new Date().toISOString() };
    const r = await runThreadSummaryPipeline();
    expect(r.alreadyPublished).toBe(true);
    expect(r.threadsSummarised).toBe(0);
    expect(mockSummarizeThread).not.toHaveBeenCalled();
  });

  it('O2: skipIdempotency:true bypasses idempotency gate', async () => {
    mockIsThreadSummaryPublishedToday.mockReturnValue(true);
    mockSummarizeThread.mockImplementation((input: { threadId: number }) =>
      Promise.resolve(okSummary(input.threadId, 5)),
    );
    mockSelectMessagesInWindow.mockReturnValue(Array(5).fill({}) as CapturedMessage[]);
    const r = await runThreadSummaryPipeline({ skipIdempotency: true });
    expect(r.alreadyPublished).toBe(false);
    expect(mockSummarizeThread).toHaveBeenCalledTimes(3);
  });

  it('O3: zero tracked threads → returns 0 counts but DOES build chunks (header-only)', async () => {
    mockListTrackedThreadIds.mockReturnValue([]);
    const r = await runThreadSummaryPipeline();
    expect(r.threadsSummarised).toBe(0);
    expect(r.chunks.length).toBe(1);
    expect(r.chunks[0]).toContain('🧵 Сводки тредов');
  });

  it('O4: per-thread error isolation (D-34) — one fail does not abort', async () => {
    mockSummarizeThread.mockImplementation(async (input: { threadId: number }) => {
      if (input.threadId === 100) throw new Error('LLM down');
      return okSummary(input.threadId, 5);
    });
    const r = await runThreadSummaryPipeline();
    expect(r.threadsSummarised).toBe(2);
    expect(r.threadsSkippedError).toBe(1);
  });

  it('O5: state merge-write preserves lastDigestDate', async () => {
    mockState.current = {
      lastDigestDate: '2026-04-29T06:00:00.000Z',
      lastSkipped: false,
      lastItemCount: 5,
      lastThreadSummaryDate: null,
    };
    mockSummarizeThread.mockResolvedValue(okSummary(100, 5));
    await runThreadSummaryPipeline();
    expect(mockWriteState).toHaveBeenCalledTimes(1);
    const written = mockWriteState.mock.calls[0]?.[0];
    expect(written?.lastDigestDate).toBe('2026-04-29T06:00:00.000Z');
    expect(written?.lastThreadSummaryDate).not.toBeNull();
  });

  it('O6: windowHours override propagates to summarizeThread input', async () => {
    mockSummarizeThread.mockResolvedValue(okSummary(100, 1));
    await runThreadSummaryPipeline({ windowHours: 48 });
    const call = mockSummarizeThread.mock.calls[0]?.[0];
    expect(call?.windowHours).toBe(48);
  });

  it('O7: WR-01 — refreshThreadTitle is cached-only (no Bot API call); pipeline succeeds', async () => {
    // Phase 6 WR-01 fix: bot.api.getForumTopic does not exist on Telegram Bot
    // API 7.x. The pipeline now resolves titles purely from listTracked()
    // cache — no Telegram round-trip is attempted, so there is no failure
    // path to test for the API call. We assert that listTracked() is consulted
    // and that the pipeline proceeds end-to-end.
    mockSummarizeThread.mockResolvedValue(okSummary(100, 5));
    const r = await runThreadSummaryPipeline();
    expect(r.threadsSummarised).toBe(3);
    expect(mockListTracked).toHaveBeenCalled();
  });

  it('S3: corrupt state read → returns empty result, blocks publish', async () => {
    mockReadState.mockImplementation(() => {
      throw new Error('State file corrupted at /x: bad');
    });
    const r = await runThreadSummaryPipeline();
    expect(r.alreadyPublished).toBe(false);
    expect(r.threadsSummarised).toBe(0);
    expect(r.chunks.length).toBe(0);
    expect(mockSummarizeThread).not.toHaveBeenCalled();
  });
});
