import { describe, it, expect, beforeEach, vi } from 'vitest';
import pino from 'pino';
import type {
  ThreadSummary,
  PipelineState,
  CapturedMessage,
  RunThreadSummaryOptions,
} from './types.js';
import type { JobStateRepository } from './job-state.repository.js';
import type { MessageRepository } from './messages.repository.js';
import { logger } from './logger.js';

// Mock factories — must be hoisted via vi.hoisted so the vi.mock factories
// (which vitest hoists above imports) can reference these without
// "Cannot access X before initialization" runtime errors.
const {
  mockState,
  mockReadState,
  mockSelectMessagesInWindow,
  mockSummarizeThread,
} = vi.hoisted(() => {
  const state: { current: PipelineState } = {
    current: {
      lastDigestDate: null,
      lastSkipped: false,
      lastItemCount: 0,
      lastThreadSummaryDate: null,
    },
  };
  return {
    mockState: state,
    mockReadState: vi.fn(async () => state.current),
    mockSelectMessagesInWindow: vi.fn(
      async (_chatId: number, _threadId: number, _sinceIso: string) => [] as CapturedMessage[],
    ),
    mockSummarizeThread: vi.fn(),
  };
});

vi.mock('./summarizer.js', () => ({
  summarizeThread: mockSummarizeThread,
}));
// Stub config so importing the orchestrator does not require live env vars.
vi.mock('./config.js', () => ({
  config: {
    targetChatId: -1003096173975,
    aiRadarThreadId: 0,
    digestImportEnabled: false,
    aiApiKey: 'k',
    aiModel: 'm',
    botToken: 't',
    logLevel: 'info',
    threadSummaryThreadId: 0,
    threadSummaryCron: '30 3 * * *',
    messageRetentionDays: 90,
    retentionSweepCron: '0 1 * * *',
    trackedThreadIds: [100, 200, 300],
  },
}));

import { runThreadSummaryPipeline } from './summary.js';

const jobs: JobStateRepository = {
  read: mockReadState,
  recordDigest: vi.fn(),
  recordThreadSummary: vi.fn(),
};
const messages: MessageRepository = {
  upsert: vi.fn(async () => undefined),
  selectWindow: mockSelectMessagesInWindow,
  runRetention: vi.fn(async () => ({ rowsDeleted: 0, durationMs: 0 })),
};
const runSummary = (options: RunThreadSummaryOptions = {}) =>
  runThreadSummaryPipeline(messages, jobs, options);

type CapturedLogCall = [Record<string, unknown>, string | undefined];
type PinoSerializer = (obj: Record<string, unknown>, msg: string | undefined, level: number, time: number) => string;

function renderPinoJson(call: CapturedLogCall | undefined): string {
  if (!call) throw new Error('Expected logger call');
  const serializer = (logger as unknown as { [pino.symbols.asJsonSym]: PinoSerializer })[
    pino.symbols.asJsonSym
  ];
  return serializer.call(logger, call[0], call[1], logger.levels.values.error!, 0);
}

// Single- and multi-topic fixtures used across the orchestration tests.
const okSummary = (
  threadId: number,
  mc = 10,
  links: Array<{ url: string; description: string }> = [],
): ThreadSummary => ({
  skipped: false,
  threadId,
  windowHours: 24,
  messageCount: mc,
  topics: [
    {
      emoji: '💻',
      title: 'topic',
      bullets: [{ summary: 'суть', msgId: 1000 + threadId }],
      links,
    },
  ],
});

const okSummaryMulti = (
  threadId: number,
  topics: Array<{
    msgId: number;
    summary?: string;
    title?: string;
    emoji?: string;
    links?: Array<{ url: string; description: string }>;
  }>,
): ThreadSummary => ({
  skipped: false,
  threadId,
  windowHours: 24,
  messageCount: topics.length * 4,
  topics: topics.map((t) => ({
    emoji: t.emoji ?? '💻',
    title: t.title ?? 'topic',
    bullets: [{ summary: t.summary ?? 'суть', msgId: t.msgId }],
    links: t.links ?? [],
  })),
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
  mockReadState.mockImplementation(async () => mockState.current);
  mockSelectMessagesInWindow.mockResolvedValue([]);
  mockSummarizeThread.mockReset();
});

describe('runThreadSummaryPipeline', () => {
  it('O1: idempotency — already-published-today returns alreadyPublished:true and skips work', async () => {
    mockState.current = { ...mockState.current, lastThreadSummaryDate: new Date().toISOString() };
    const r = await runSummary();
    expect(r.alreadyPublished).toBe(true);
    expect(r.threadsSummarised).toBe(0);
    expect(mockSummarizeThread).not.toHaveBeenCalled();
  });

  it('O1b: idempotency uses the state snapshot already loaded for this cycle', async () => {
    mockState.current = { ...mockState.current, lastThreadSummaryDate: new Date().toISOString() };
    await runSummary();
    expect(mockReadState).toHaveBeenCalledTimes(1);
  });

  it('O2: skipIdempotency:true bypasses idempotency gate', async () => {
    mockState.current = { ...mockState.current, lastThreadSummaryDate: new Date().toISOString() };
    mockSummarizeThread.mockImplementation((input: { threadId: number }) =>
      Promise.resolve(okSummary(input.threadId, 5)),
    );
    mockSelectMessagesInWindow.mockResolvedValue(Array.from({ length: 5 }, (_, i) => msg(i + 1)));
    const r = await runSummary({ skipIdempotency: true });
    expect(r.alreadyPublished).toBe(false);
    expect(mockSummarizeThread).toHaveBeenCalledTimes(3);
  });

  it('O3: zero tracked threads → returns 0 counts and no Telegram chunks', async () => {
    const r = await runSummary({ trackedThreadIds: [] });
    expect(r.threadsSummarised).toBe(0);
    expect(r.chunks).toEqual([]);
  });

  it('O4: one failed thread does not abort the remaining threads', async () => {
    mockSummarizeThread.mockImplementation(async (input: { threadId: number }) => {
      if (input.threadId === 100) throw new Error('LLM down');
      return okSummary(input.threadId, 5);
    });
    const r = await runSummary();
    expect(r.threadsSummarised).toBe(2);
    expect(r.threadsSkippedError).toBe(1);
  });

  it('redacts a per-thread failure while retaining safe error metadata', async () => {
    const sentinel = 'REQUEST_PROFILE_SENTINEL_pipeline_30adf0';
    const err = Object.assign(new Error(sentinel), { status: 502 });
    const errorSpy = vi.spyOn(logger, 'error');
    mockSummarizeThread.mockImplementation(async (input: { threadId: number }) => {
      if (input.threadId === 100) throw err;
      return okSummary(input.threadId, 5);
    });

    await runSummary();

    const call = errorSpy.mock.calls.find(
      ([bindings]) => (bindings as Record<string, unknown>).threadId === 100,
    );
    const rendered = renderPinoJson(call as CapturedLogCall | undefined);
    const record = JSON.parse(rendered) as Record<string, unknown>;
    expect(rendered).not.toContain(sentinel);
    expect(record).not.toHaveProperty('err');
    expect(record).toMatchObject({ errorClass: 'Error', status: 502, threadId: 100 });
  });

  it('O5: pipeline returns persistence intent without recording delivery itself', async () => {
    mockSummarizeThread.mockResolvedValue(okSummary(100, 5));
    const r = await runSummary();
    expect(r.persistState).toBe(true);
  });

  it('O5b: persistState:false propagates to the caller', async () => {
    mockSummarizeThread.mockResolvedValue(okSummary(100, 5));
    const r = await runSummary({ persistState: false });
    expect(r.persistState).toBe(false);
  });

  it('O5c: idempotency short-circuit preserves persistence intent', async () => {
    mockState.current = { ...mockState.current, lastThreadSummaryDate: new Date().toISOString() };
    mockState.current = {
      ...mockState.current,
      lastThreadSummaryDate: new Date().toISOString(),
    };
    const r = await runSummary();
    expect(r.alreadyPublished).toBe(true);
    expect(r.persistState).toBe(true);
  });

  it('O6: windowHours override propagates to summarizeThread input', async () => {
    mockSummarizeThread.mockResolvedValue(okSummary(100, 1));
    await runSummary({ windowHours: 48 });
    const call = mockSummarizeThread.mock.calls[0]?.[0];
    expect(call?.windowHours).toBe(48);
  });

  it('O7-CONTRACT: passes captured messages without preselecting a citation', async () => {
    mockSelectMessagesInWindow.mockResolvedValue([
      msg(7475),
      msg(7460),
      msg(7471),
      msg(7480),
      msg(7458),
    ]);
    mockSummarizeThread.mockImplementation(async (input: { threadId: number }) =>
      okSummary(input.threadId, 5),
    );
    await runSummary({ trackedThreadIds: [100] });
    expect(mockSummarizeThread).toHaveBeenCalled();
    const call = mockSummarizeThread.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call).toBeDefined();
    expect(call.firstMessageId).toBeUndefined();
    expect(call.threadId).toBe(100);
    expect(call.windowHours).toBe(24);
    expect(Array.isArray(call.messages)).toBe(true);
  });

  it('O7-MULTI: renders two topics with independent deep links', async () => {
    mockSelectMessagesInWindow.mockResolvedValue(
      Array.from({ length: 8 }, (_, i) => msg(7000 + i)),
    );
    mockSummarizeThread.mockResolvedValue(
      okSummaryMulti(100, [
        { msgId: 7001, title: 'multi-topic-A', summary: 'итог-A' },
        { msgId: 7005, title: 'multi-topic-B', summary: 'итог-B' },
      ]),
    );
    const r = await runSummary({ trackedThreadIds: [100] });
    const text = r.chunks.join('\n');
    // Both topic headers present.
    expect(text).toContain('<b>multi-topic-A</b>');
    expect(text).toContain('<b>multi-topic-B</b>');
    // Each bullet's summary is the deep-link text, pointing at its own msgId.
    expect(text).toContain('/100/7001">итог-A</a>');
    expect(text).toContain('/100/7005">итог-B</a>');
    // Topics keep INPUT order (grouped by thread, no messageCount sort).
    expect(text.indexOf('multi-topic-A')).toBeLessThan(text.indexOf('multi-topic-B'));
  });

  it('O8-AGG: aggregated links deduped case-insensitively across non-skipped summaries', async () => {
    mockSelectMessagesInWindow.mockResolvedValue(
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
    const r = await runSummary({ trackedThreadIds: [100, 200] });
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
    const r = await runSummary();
    expect(r.alreadyPublished).toBe(false);
    expect(r.threadsSummarised).toBe(0);
    expect(r.chunks.length).toBe(0);
    expect(mockSummarizeThread).not.toHaveBeenCalled();
  });
});

describe('runThreadSummaryPipeline LLM-outage detection', () => {
  it('B1: all threads skipped with llm-error produces no publishable chunks', async () => {
    mockSummarizeThread.mockImplementation((input: { threadId: number }) =>
      Promise.resolve({
        skipped: true,
        threadId: input.threadId,
        windowHours: 24,
        messageCount: 0,
        reason: 'llm-error' as const,
      }),
    );
    const r = await runSummary();
    expect(r.llmOutage).toBe(true);
    expect(r.chunks).toEqual([]);
    expect(r.threadsSkippedError).toBe(3);
  });

  it('B2: thrown errors inside per-thread try/catch ALSO count as llm-error → llmOutage:true', async () => {
    mockSummarizeThread.mockImplementation(async () => {
      throw new Error('LLM transport down');
    });
    const r = await runSummary();
    expect(r.llmOutage).toBe(true);
    expect(r.chunks).toEqual([]);
    expect(r.threadsSkippedError).toBe(3);
  });

  it('B3: mixed skip-reasons with no successful topic → llmOutage:false, chunks empty', async () => {
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
    const r = await runSummary();
    expect(r.llmOutage).toBe(false);
    expect(r.chunks).toEqual([]);
  });

  it('B4: all skipped → no chunks, while totalMessageCount reflects rows selected from the DB', async () => {
    mockSelectMessagesInWindow.mockImplementation(async (_chatId: number, threadId: number) => {
      if (threadId === 100) return [msg(1), msg(2)];
      if (threadId === 200) return [msg(3)];
      return [];
    });
    mockSummarizeThread.mockImplementation((input: { threadId: number; messages: CapturedMessage[] }) =>
      Promise.resolve({
        skipped: true as const,
        threadId: input.threadId,
        windowHours: 24,
        messageCount: input.messages.length,
        reason: 'low-volume' as const,
      }),
    );
    const r = await runSummary();
    expect(r.llmOutage).toBe(false);
    expect(r.totalMessageCount).toBe(3);
    expect(r.chunks).toEqual([]);
  });

  it('B5: zero tracked threads → llmOutage:false (vacuously not an outage)', async () => {
    const r = await runSummary({ trackedThreadIds: [] });
    expect(r.llmOutage).toBe(false);
    expect(r.chunks).toEqual([]);
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
    const r = await runSummary();
    expect(r.llmOutage).toBe(false);
    expect(r.threadsSummarised).toBe(1);
    expect(r.chunks.length).toBeGreaterThan(0);
  });
});
