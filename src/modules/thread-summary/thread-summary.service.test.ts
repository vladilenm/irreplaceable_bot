import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ThreadSummary, PipelineStateV2, CapturedMessage } from '../../types/index.js';

// Mock factories — must be hoisted via vi.hoisted so the vi.mock factories
// (which vitest hoists above imports) can reference these without
// "Cannot access X before initialization" runtime errors.
const {
  mockState,
  mockReadState,
  mockWriteState,
  mockIsThreadSummaryPublishedTodayWithState,
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
    mockIsThreadSummaryPublishedTodayWithState: vi.fn(() => false),
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
  isThreadSummaryPublishedTodayWithState: mockIsThreadSummaryPublishedTodayWithState,
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

import {
  runThreadSummaryPipeline,
  markThreadSummaryPublished,
} from './thread-summary.service.js';

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
  mockIsThreadSummaryPublishedTodayWithState.mockClear();
  mockIsThreadSummaryPublishedTodayWithState.mockReturnValue(false);
  mockListTrackedThreadIds.mockReturnValue([100, 200, 300]);
  mockSelectMessagesInWindow.mockReturnValue([]);
  mockSelectTopParticipants.mockReturnValue([]);
  mockSummarizeThread.mockReset();
});

describe('runThreadSummaryPipeline (DLV-06, DLV-10, D-32..D-35)', () => {
  it('O1: idempotency — already-published-today returns alreadyPublished:true and skips work', async () => {
    mockIsThreadSummaryPublishedTodayWithState.mockReturnValue(true);
    mockState.current = { ...mockState.current, lastThreadSummaryDate: new Date().toISOString() };
    const r = await runThreadSummaryPipeline();
    expect(r.alreadyPublished).toBe(true);
    expect(r.threadsSummarised).toBe(0);
    expect(mockSummarizeThread).not.toHaveBeenCalled();
  });

  it('O1b: WR-03 — idempotency check is invoked with the already-loaded prevState (no second readState)', async () => {
    mockIsThreadSummaryPublishedTodayWithState.mockReturnValue(true);
    mockState.current = { ...mockState.current, lastThreadSummaryDate: new Date().toISOString() };
    await runThreadSummaryPipeline();
    expect(mockReadState).toHaveBeenCalledTimes(1);
    expect(mockIsThreadSummaryPublishedTodayWithState).toHaveBeenCalledTimes(1);
    expect(mockIsThreadSummaryPublishedTodayWithState).toHaveBeenCalledWith(mockState.current);
  });

  it('O2: skipIdempotency:true bypasses idempotency gate', async () => {
    mockIsThreadSummaryPublishedTodayWithState.mockReturnValue(true);
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

  it('O5 (Phase 8 fix A): pipeline NO LONGER writes state; markThreadSummaryPublished merge-write preserves lastDigestDate', async () => {
    mockState.current = {
      lastDigestDate: '2026-04-29T06:00:00.000Z',
      lastSkipped: false,
      lastItemCount: 5,
      lastThreadSummaryDate: null,
    };
    mockSummarizeThread.mockResolvedValue(okSummary(100, 5));
    const r = await runThreadSummaryPipeline();
    // Phase 8 fix A: pipeline returns prevState + persistState and does NOT
    // mutate state.json itself — the cron handler is responsible for the
    // post-send write.
    expect(mockWriteState).not.toHaveBeenCalled();
    expect(r.persistState).toBe(true);
    expect(r.prevState.lastDigestDate).toBe('2026-04-29T06:00:00.000Z');

    // Simulate cron handler's post-send write contract.
    markThreadSummaryPublished(r.prevState, r.date);
    expect(mockWriteState).toHaveBeenCalledTimes(1);
    const written = mockWriteState.mock.calls[0]?.[0];
    expect(written?.lastDigestDate).toBe('2026-04-29T06:00:00.000Z');
    expect(written?.lastThreadSummaryDate).not.toBeNull();
  });

  it('O5b (Phase 8 fix A): persistState:false → result flag is false and helper is never called by cron contract', async () => {
    mockSummarizeThread.mockResolvedValue(okSummary(100, 5));
    const r = await runThreadSummaryPipeline({ persistState: false });
    expect(r.persistState).toBe(false);
    expect(mockWriteState).not.toHaveBeenCalled();
  });

  it('O5c (Phase 8 fix A): on idempotency short-circuit result still carries persistState + prevState', async () => {
    mockIsThreadSummaryPublishedTodayWithState.mockReturnValue(true);
    mockState.current = {
      ...mockState.current,
      lastThreadSummaryDate: new Date().toISOString(),
    };
    const r = await runThreadSummaryPipeline();
    expect(r.alreadyPublished).toBe(true);
    expect(r.persistState).toBe(true);
    expect(r.prevState.lastThreadSummaryDate).not.toBeNull();
    expect(mockWriteState).not.toHaveBeenCalled();
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

describe('runThreadSummaryPipeline LLM-outage detection (Phase 8 fix B)', () => {
  it('B1: ALL threads skipped with reason:llm-error → llmOutage:true, chunks=[]; pipeline writes NO state', async () => {
    mockSummarizeThread.mockImplementation((input: { threadId: number }) =>
      Promise.resolve({
        skipped: true,
        threadId: input.threadId,
        windowHours: 24,
        messageCount: 0,
        reason: 'llm-error' as const,
      }),
    );
    const r = await runThreadSummaryPipeline();
    expect(r.llmOutage).toBe(true);
    expect(r.chunks).toEqual([]);
    expect(r.threadsSkippedError).toBe(3);
    // Pipeline never writes state on its own (Phase 8 fix A) and the cron
    // handler must skip the post-send write when llmOutage is set, so we
    // assert the helper-via-pipeline path stayed put.
    expect(mockWriteState).not.toHaveBeenCalled();
  });

  it('B2: thrown errors inside per-thread try/catch ALSO count as llm-error → llmOutage:true', async () => {
    mockSummarizeThread.mockImplementation(async () => {
      throw new Error('LLM transport down');
    });
    const r = await runThreadSummaryPipeline();
    expect(r.llmOutage).toBe(true);
    expect(r.chunks).toEqual([]);
    expect(r.threadsSkippedError).toBe(3);
  });

  it('B3: mixed skip-reasons (one low-volume, rest llm-error) → llmOutage:false, chunks NOT empty', async () => {
    mockSummarizeThread.mockImplementation((input: { threadId: number }) => {
      if (input.threadId === 100) {
        return Promise.resolve({
          skipped: true as const,
          threadId: 100,
          windowHours: 24,
          messageCount: 2,
          reason: 'low-volume' as const,
        });
      }
      return Promise.resolve({
        skipped: true as const,
        threadId: input.threadId,
        windowHours: 24,
        messageCount: 0,
        reason: 'llm-error' as const,
      });
    });
    const r = await runThreadSummaryPipeline();
    expect(r.llmOutage).toBe(false);
    expect(r.chunks.length).toBeGreaterThan(0);
  });

  it('B4: genuine quiet day (all low-volume) → llmOutage:false, formatter publishes «тихо: N из N»', async () => {
    mockSummarizeThread.mockImplementation((input: { threadId: number }) =>
      Promise.resolve({
        skipped: true as const,
        threadId: input.threadId,
        windowHours: 24,
        messageCount: 1,
        reason: 'low-volume' as const,
      }),
    );
    const r = await runThreadSummaryPipeline();
    expect(r.llmOutage).toBe(false);
    expect(r.chunks.length).toBe(1);
    expect(r.chunks[0]).toContain('тихо: 3 из 3');
  });

  it('B5: zero tracked threads → llmOutage:false (vacuously not an outage)', async () => {
    mockListTrackedThreadIds.mockReturnValue([]);
    const r = await runThreadSummaryPipeline();
    expect(r.llmOutage).toBe(false);
  });

  it('B6: at least one thread succeeded → llmOutage:false even if others llm-error', async () => {
    mockSummarizeThread.mockImplementation((input: { threadId: number }) => {
      if (input.threadId === 100) return Promise.resolve(okSummary(100, 7));
      return Promise.resolve({
        skipped: true as const,
        threadId: input.threadId,
        windowHours: 24,
        messageCount: 0,
        reason: 'llm-error' as const,
      });
    });
    const r = await runThreadSummaryPipeline();
    expect(r.llmOutage).toBe(false);
    expect(r.threadsSummarised).toBe(1);
    expect(r.chunks.length).toBeGreaterThan(0);
  });
});
