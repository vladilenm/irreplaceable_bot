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
  mockSelectMessagesInWindow,
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
    mockSelectMessagesInWindow: vi.fn(() => [] as CapturedMessage[]),
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
vi.mock('../../stores/message-store.js', () => ({
  selectMessagesInWindow: mockSelectMessagesInWindow,
}));
vi.mock('../../services/summarizer.service.js', () => ({
  summarizeThread: mockSummarizeThread,
}));
// Stub config so importing the orchestrator does not require live env vars.
vi.mock('../../config.js', () => ({
  config: {
    targetChatId: '-1003096173975',
    aiRadarThreadId: '0',
    digestCron: '0 6 * * *',
    aiApiKey: 'k',
    aiModel: 'm',
    botToken: 't',
    logLevel: 'info',
    nodeEnv: 'test',
    threadSummaryThreadId: '0',
    threadSummaryCron: '30 3 * * *',
    messageRetentionDays: 90,
    retentionSweepCron: '0 1 * * *',
    dbPath: 'data/messages.db',
    initialTrackedThreadIds: [],
  },
}));

import {
  runThreadSummaryPipeline,
  markThreadSummaryPublished,
} from './thread-summary.service.js';

const okSummary = (
  threadId: number,
  mc = 10,
  links: Array<{ url: string; description: string }> = [],
): ThreadSummary => ({
  skipped: false,
  threadId,
  windowHours: 24,
  messageCount: mc,
  emoji: '💻',
  title: 'topic',
  links,
  firstMessageId: 1000 + threadId,
});

// Helper: synthesise a captured-message stub with a specific tgMessageId.
const msg = (tgMessageId: number): CapturedMessage => ({
  chatId: -1,
  threadId: 100,
  tgMessageId,
  authorId: 1,
  authorName: 'u',
  isAnonymous: 0,
  text: 'x',
  replyToMessageId: null,
  createdAt: '2026-05-07T03:00:00.000Z',
  editedAt: null,
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
    mockSelectMessagesInWindow.mockReturnValue(Array.from({ length: 5 }, (_, i) => msg(i + 1)));
    const r = await runThreadSummaryPipeline({ skipIdempotency: true });
    expect(r.alreadyPublished).toBe(false);
    expect(mockSummarizeThread).toHaveBeenCalledTimes(3);
  });

  it('O3: zero tracked threads → returns 0 counts but DOES build chunks (header-only)', async () => {
    mockListTrackedThreadIds.mockReturnValue([]);
    const r = await runThreadSummaryPipeline();
    expect(r.threadsSummarised).toBe(0);
    expect(r.chunks.length).toBe(1);
    // Header line of topic-style format.
    expect(r.chunks[0]).toContain('📆 Что обсуждалось вчера');
    expect(r.chunks[0]).toContain('#dailysummary');
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
    expect(mockWriteState).not.toHaveBeenCalled();
    expect(r.persistState).toBe(true);
    expect(r.prevState.lastDigestDate).toBe('2026-04-29T06:00:00.000Z');

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

  it('O7-NEW: firstMessageId is MIN(tgMessageId) of selectMessagesInWindow result', async () => {
    mockListTrackedThreadIds.mockReturnValue([100]);
    mockSelectMessagesInWindow.mockReturnValue([
      msg(7475),
      msg(7460),
      msg(7471),
      msg(7480),
      msg(7458),
    ]);
    mockSummarizeThread.mockImplementation(
      async (input: { firstMessageId: number; threadId: number }) => {
        expect(input.firstMessageId).toBe(7458);
        return okSummary(input.threadId, 5);
      },
    );
    await runThreadSummaryPipeline();
    expect(mockSummarizeThread).toHaveBeenCalled();
  });

  it('O8-AGG: aggregated links deduped case-insensitively across non-skipped summaries', async () => {
    mockListTrackedThreadIds.mockReturnValue([100, 200]);
    mockSelectMessagesInWindow.mockReturnValue(
      Array.from({ length: 5 }, (_, i) => msg(i + 1)),
    );
    mockSummarizeThread.mockImplementation(async (input: { threadId: number }) => {
      if (input.threadId === 100) {
        return okSummary(100, 7, [
          { url: 'https://example.com/a', description: 'a-ru' },
          { url: 'https://example.com/b', description: 'b-ru' },
        ]);
      }
      return okSummary(200, 6, [
        { url: '  HTTPS://Example.com/A  ', description: 'dup-of-a' },
        { url: 'https://example.com/c', description: 'c-ru' },
      ]);
    });
    const r = await runThreadSummaryPipeline();
    const text = r.chunks.join('\n');
    // Original "a-ru" description is preserved (first occurrence wins).
    expect(text).toContain('a-ru');
    expect(text).toContain('b-ru');
    expect(text).toContain('c-ru');
    // Duplicate description should NOT be rendered (collapsed by dedup).
    expect(text).not.toContain('dup-of-a');
    // Section header is present once.
    const headerMatches = text.match(/Интересные ссылки:/g) ?? [];
    expect(headerMatches.length).toBe(1);
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

  it('B4: genuine quiet day (all low-volume) → llmOutage:false, formatter publishes header + total + footer', async () => {
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
    // quick-260507-cni format: all-skipped → header + total-line + footer.
    expect(r.chunks[0]).toContain('📆 Что обсуждалось вчера');
    expect(r.chunks[0]).toContain('Всего было написано 0 сообщений');
    expect(r.chunks[0]).toContain('#dailysummary');
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
