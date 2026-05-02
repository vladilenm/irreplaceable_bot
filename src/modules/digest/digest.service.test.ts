import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PipelineStateV2, RawArticle } from '../../types/index.js';

// Phase 8 fix A: contract tests for the digest pipeline's split state-write.
// Pipeline writes state ONLY on the skip path (no-articles, itemCount<1) where
// there is nothing to send. Success-path writes were moved to sendDigest.

const {
  mockState,
  mockReadState,
  mockWriteState,
  mockIsDigestPublishedToday,
  mockFetchFeeds,
  mockFilterArticles,
} = vi.hoisted(() => {
  const state: { current: PipelineStateV2 } = {
    current: {
      lastDigestDate: null,
      lastSkipped: false,
      lastItemCount: 0,
      lastThreadSummaryDate: '2026-04-30T03:30:00.000Z',
    },
  };
  return {
    mockState: state,
    mockReadState: vi.fn(() => state.current),
    mockWriteState: vi.fn((s: PipelineStateV2) => {
      state.current = s;
    }),
    mockIsDigestPublishedToday: vi.fn(() => false),
    mockFetchFeeds: vi.fn(),
    mockFilterArticles: vi.fn(),
  };
});

vi.mock('../../services/state.service.js', () => ({
  readState: mockReadState,
  writeState: mockWriteState,
  isDigestPublishedToday: mockIsDigestPublishedToday,
}));
vi.mock('../../services/rss.service.js', () => ({
  fetchFeeds: mockFetchFeeds,
}));
vi.mock('../../services/ai.service.js', () => ({
  filterArticles: mockFilterArticles,
}));

import { runDigestPipeline } from './digest.service.js';

const fakeArticle: RawArticle = {
  title: 't',
  description: 'd',
  link: 'https://example.com/a',
  source: 'src',
  sourceKey: 'src',
  pubDate: new Date(),
};

beforeEach(() => {
  mockState.current = {
    lastDigestDate: null,
    lastSkipped: false,
    lastItemCount: 0,
    lastThreadSummaryDate: '2026-04-30T03:30:00.000Z',
  };
  mockReadState.mockClear();
  mockReadState.mockImplementation(() => mockState.current);
  mockWriteState.mockClear();
  mockIsDigestPublishedToday.mockClear();
  mockIsDigestPublishedToday.mockReturnValue(false);
  mockFetchFeeds.mockReset();
  mockFilterArticles.mockReset();
});

describe('runDigestPipeline state-write split (Phase 8 fix A)', () => {
  it('D1: success path → result.persistState:true, writeState NOT called by pipeline', async () => {
    mockFetchFeeds.mockResolvedValue([fakeArticle, fakeArticle]);
    mockFilterArticles.mockResolvedValue('item → https://example.com/x');
    const r = await runDigestPipeline();
    expect(r.skipped).toBe(false);
    expect(r.itemCount).toBe(1);
    expect(r.persistState).toBe(true);
    expect(mockWriteState).not.toHaveBeenCalled();
  });

  it('D2: skip path (no articles) → writeState IS called by pipeline (nothing to send)', async () => {
    mockFetchFeeds.mockResolvedValue([]);
    const r = await runDigestPipeline();
    expect(r.skipped).toBe(true);
    expect(r.persistState).toBe(true);
    expect(mockWriteState).toHaveBeenCalledTimes(1);
    const written = mockWriteState.mock.calls[0]?.[0];
    expect(written?.lastSkipped).toBe(true);
    expect(written?.lastItemCount).toBe(0);
    expect(written?.lastThreadSummaryDate).toBe('2026-04-30T03:30:00.000Z');
  });

  it('D3: skip path (AI filter returns 0 items) → writeState IS called by pipeline', async () => {
    mockFetchFeeds.mockResolvedValue([fakeArticle]);
    mockFilterArticles.mockResolvedValue('no items here, just text');
    const r = await runDigestPipeline();
    expect(r.skipped).toBe(true);
    expect(r.itemCount).toBe(0);
    expect(mockWriteState).toHaveBeenCalledTimes(1);
    const written = mockWriteState.mock.calls[0]?.[0];
    expect(written?.lastSkipped).toBe(true);
    expect(written?.lastItemCount).toBe(0);
  });

  it('D4: persistState:false on dev-run → no writeState even on skip path', async () => {
    mockFetchFeeds.mockResolvedValue([]);
    const r = await runDigestPipeline({ persistState: false });
    expect(r.skipped).toBe(true);
    expect(r.persistState).toBe(false);
    expect(mockWriteState).not.toHaveBeenCalled();
  });

  it('D5: persistState:false on success → result.persistState propagates as false', async () => {
    mockFetchFeeds.mockResolvedValue([fakeArticle]);
    mockFilterArticles.mockResolvedValue('item → https://example.com/x');
    const r = await runDigestPipeline({ persistState: false });
    expect(r.persistState).toBe(false);
    expect(mockWriteState).not.toHaveBeenCalled();
  });

  it('D6: idempotency short-circuit → persistState propagates on emptyResult', async () => {
    mockIsDigestPublishedToday.mockReturnValue(true);
    mockState.current = {
      ...mockState.current,
      lastDigestDate: new Date().toISOString(),
      lastSkipped: false,
    };
    const r = await runDigestPipeline();
    expect(r.alreadyPublished).toBe(true);
    expect(r.persistState).toBe(true);
    expect(mockWriteState).not.toHaveBeenCalled();
  });
});
