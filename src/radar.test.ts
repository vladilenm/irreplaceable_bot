import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DigestItem, PipelineState, RawArticle } from './types.js';

const {
  mockState,
  mockReadState,
  mockRecordDigestCompletion,
  mockIsDigestPublishedTodayWithState,
  mockFetchFeeds,
  mockFilterArticles,
} = vi.hoisted(() => {
  const state: { current: PipelineState } = {
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
    mockRecordDigestCompletion: vi.fn(),
    mockIsDigestPublishedTodayWithState: vi.fn(() => false),
    mockFetchFeeds: vi.fn(),
    mockFilterArticles: vi.fn(),
  };
});

vi.mock('./database.js', () => ({
  readState: mockReadState,
  recordDigestCompletion: mockRecordDigestCompletion,
  isDigestPublishedTodayWithState: mockIsDigestPublishedTodayWithState,
}));
vi.mock('./radar.sources.js', () => ({
  fetchFeeds: mockFetchFeeds,
}));
vi.mock('./radar.curator.js', () => ({
  filterArticles: mockFilterArticles,
}));

import { runDigestPipeline } from './radar.js';

const fakeArticle: RawArticle = {
  title: 't',
  description: 'd',
  link: 'https://example.com/a',
  source: 'src',
  pubDate: new Date(),
};

const fakeDigestItem: DigestItem = {
  title: 'Новость',
  summary: 'Практический вывод',
  url: fakeArticle.link,
  category: 'tools',
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
  mockRecordDigestCompletion.mockClear();
  mockIsDigestPublishedTodayWithState.mockClear();
  mockIsDigestPublishedTodayWithState.mockReturnValue(false);
  mockFetchFeeds.mockReset();
  mockFilterArticles.mockReset();
});

describe('runDigestPipeline state recording', () => {
  it('D1: successful pipeline waits for the sender to record delivery', async () => {
    mockFetchFeeds.mockResolvedValue([fakeArticle, fakeArticle]);
    mockFilterArticles.mockResolvedValue([fakeDigestItem]);
    const r = await runDigestPipeline();
    expect(r.skipped).toBe(false);
    expect(r.itemCount).toBe(1);
    expect(r.persistState).toBe(true);
    expect(mockRecordDigestCompletion).not.toHaveBeenCalled();
  });

  it('D2: no articles records a skipped cycle immediately', async () => {
    mockFetchFeeds.mockResolvedValue([]);
    const r = await runDigestPipeline();
    expect(r.skipped).toBe(true);
    expect(r.persistState).toBe(true);
    expect(mockRecordDigestCompletion).toHaveBeenCalledTimes(1);
    expect(mockRecordDigestCompletion).toHaveBeenCalledWith(expect.any(Date), true, 0);
  });

  it('D3: an empty curated result records a skipped cycle', async () => {
    mockFetchFeeds.mockResolvedValue([fakeArticle]);
    mockFilterArticles.mockResolvedValue([]);
    const r = await runDigestPipeline();
    expect(r.skipped).toBe(true);
    expect(r.itemCount).toBe(0);
    expect(mockRecordDigestCompletion).toHaveBeenCalledTimes(1);
    expect(mockRecordDigestCompletion).toHaveBeenCalledWith(expect.any(Date), true, 0);
  });

  it('D4: persistState:false does not record a skipped development run', async () => {
    mockFetchFeeds.mockResolvedValue([]);
    const r = await runDigestPipeline({ persistState: false });
    expect(r.skipped).toBe(true);
    expect(r.persistState).toBe(false);
    expect(mockRecordDigestCompletion).not.toHaveBeenCalled();
  });

  it('D5: persistState:false on success → result.persistState propagates as false', async () => {
    mockFetchFeeds.mockResolvedValue([fakeArticle]);
    mockFilterArticles.mockResolvedValue([fakeDigestItem]);
    const r = await runDigestPipeline({ persistState: false });
    expect(r.persistState).toBe(false);
    expect(mockRecordDigestCompletion).not.toHaveBeenCalled();
  });

  it('D6: idempotency short-circuit → persistState propagates on emptyResult', async () => {
    mockIsDigestPublishedTodayWithState.mockReturnValue(true);
    mockState.current = {
      ...mockState.current,
      lastDigestDate: new Date().toISOString(),
      lastSkipped: false,
    };
    const r = await runDigestPipeline();
    expect(r.alreadyPublished).toBe(true);
    expect(r.persistState).toBe(true);
    expect(mockRecordDigestCompletion).not.toHaveBeenCalled();
  });
});
