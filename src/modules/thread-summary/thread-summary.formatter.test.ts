// quick-260507-cni — formatter tests for the topic-style daily summary.
// quick-260511-fkn — adapted to the topics-array ThreadSummary contract.
// `ok()` helper now produces a non-skipped summary with a single Topic; new
// FT-T3b / FT-T5 cover the flat-sort-across-threads behaviour and the
// up-to-5-topics-per-thread rendering.
import { describe, it, expect } from 'vitest';
import { formatThreadSummaryPost, MAX_CHUNK_LENGTH } from './thread-summary.formatter.js';
import type { ThreadSummary, Topic } from '../../types/index.js';

const CHAT_ID = '-1003096173975';
const CHAT_ID_NOPREFIX = '3096173975';

interface OkOverrides {
  threadId?: number;
  windowHours?: number;
  messageCount?: number;
  /** Override the entire topics array (multi-topic test cases). */
  topics?: Topic[];
  /** Single-topic shortcuts (back-compat with pre-260511 tests). */
  emoji?: string;
  title?: string;
  firstMessageId?: number;
  links?: Array<{ url: string; description: string }>;
  /** Per-topic messageCount; defaults to top-level messageCount when topics is single. */
  topicMessageCount?: number;
}

/**
 * Build a non-skipped ThreadSummary. By default produces a single-topic
 * thread (so existing FT-* tests need only their old fields renamed).
 */
const ok = (over: OkOverrides = {}): ThreadSummary => {
  const threadId = over.threadId ?? 7457;
  const messageCount = over.messageCount ?? 12;
  const topics: Topic[] = over.topics ?? [
    {
      emoji: over.emoji ?? '💻',
      title: over.title ?? 'Запуск ИИ моделей на локальных устройствах',
      messageCount: over.topicMessageCount ?? messageCount,
      firstMessageId: over.firstMessageId ?? 7471,
      links: over.links ?? [],
    },
  ];
  return {
    skipped: false,
    threadId,
    windowHours: over.windowHours ?? 24,
    messageCount,
    topics,
  };
};

const skip = (
  reason: 'low-volume' | 'transcript-too-large' | 'llm-error' | 'schema-invalid',
  threadId = 200,
): ThreadSummary => ({
  skipped: true,
  threadId,
  windowHours: 24,
  messageCount: reason === 'low-volume' ? 2 : 0,
  reason,
});

const baseInput = (
  over: Partial<Parameters<typeof formatThreadSummaryPost>[0]> = {},
): Parameters<typeof formatThreadSummaryPost>[0] => ({
  summaries: [],
  date: new Date('2026-05-07T03:30:00Z'),
  totalMessageCount: 0,
  aggregatedLinks: [],
  chatId: CHAT_ID,
  ...over,
});

describe('formatThreadSummaryPost — topic-style layout (quick-260507-cni + quick-260511-fkn)', () => {
  it('FT-H1: first line is `📆 Что обсуждалось вчера DD.MM.YYYY` (MSK)', () => {
    const out = formatThreadSummaryPost(
      baseInput({
        summaries: [ok({})],
        totalMessageCount: 12,
      }),
    );
    expect(out[0]).toMatch(/^📆 Что обсуждалось вчера 07\.05\.2026/);
  });

  it('FT-H2: second line is `Всего было написано N сообщений`', () => {
    const out = formatThreadSummaryPost(
      baseInput({
        summaries: [ok({})],
        totalMessageCount: 42,
      }),
    );
    const lines = out[0]!.split('\n');
    expect(lines[1]).toBe('Всего было написано 42 сообщений');
  });

  it('FT-T1: each non-skipped thread renders one topic line with t.me/c link', () => {
    const out = formatThreadSummaryPost(
      baseInput({
        summaries: [
          ok({ threadId: 7457, firstMessageId: 7471, messageCount: 12, topicMessageCount: 12 }),
        ],
        totalMessageCount: 12,
      }),
    ).join('\n');
    expect(out).toMatch(
      new RegExp(
        `💻 .+ \\(<a href="https://t\\.me/c/${CHAT_ID_NOPREFIX}/7457/7471">12 сообщений</a>\\)`,
      ),
    );
  });

  it('FT-T2: chatIdNoPrefix correctly strips leading -100', () => {
    const out = formatThreadSummaryPost(
      baseInput({
        summaries: [
          ok({ threadId: 100, firstMessageId: 5, messageCount: 1, topicMessageCount: 1 }),
        ],
        totalMessageCount: 1,
        chatId: '-1003096173975',
      }),
    ).join('\n');
    expect(out).toContain(`https://t.me/c/${CHAT_ID_NOPREFIX}/100/5`);
    expect(out).not.toContain('https://t.me/c/-1003096173975');
  });

  it('FT-T3: topic lines sorted by messageCount DESC (one topic per thread)', () => {
    const out = formatThreadSummaryPost(
      baseInput({
        summaries: [
          ok({ threadId: 1, messageCount: 5, topicMessageCount: 5, title: 'low-thread' }),
          ok({ threadId: 2, messageCount: 50, topicMessageCount: 50, title: 'high-thread' }),
          ok({ threadId: 3, messageCount: 25, topicMessageCount: 25, title: 'mid-thread' }),
        ],
        totalMessageCount: 80,
      }),
    ).join('\n');
    const hi = out.indexOf('high-thread');
    const mid = out.indexOf('mid-thread');
    const lo = out.indexOf('low-thread');
    expect(hi).toBeGreaterThan(-1);
    expect(mid).toBeGreaterThan(hi);
    expect(lo).toBeGreaterThan(mid);
  });

  it('FT-T3b (quick-260511-fkn): flat sort across multi-topic threads — order is messageCount DESC across ALL topics', () => {
    // S1: [50, 5]; S2: [30, 10] → expected flat order 50, 30, 10, 5.
    const s1: ThreadSummary = {
      skipped: false,
      threadId: 1,
      windowHours: 24,
      messageCount: 55,
      topics: [
        { emoji: '🅰', title: 't-1a', messageCount: 50, firstMessageId: 101, links: [] },
        { emoji: '🅱', title: 't-1b', messageCount: 5, firstMessageId: 102, links: [] },
      ],
    };
    const s2: ThreadSummary = {
      skipped: false,
      threadId: 2,
      windowHours: 24,
      messageCount: 40,
      topics: [
        { emoji: '🅲', title: 't-2a', messageCount: 30, firstMessageId: 201, links: [] },
        { emoji: '🅳', title: 't-2b', messageCount: 10, firstMessageId: 202, links: [] },
      ],
    };
    const out = formatThreadSummaryPost(
      baseInput({ summaries: [s1, s2], totalMessageCount: 95 }),
    ).join('\n');

    const idxA = out.indexOf('t-1a'); // mc=50
    const idxC = out.indexOf('t-2a'); // mc=30
    const idxD = out.indexOf('t-2b'); // mc=10
    const idxB = out.indexOf('t-1b'); // mc=5
    expect(idxA).toBeGreaterThan(-1);
    expect(idxC).toBeGreaterThan(idxA);
    expect(idxD).toBeGreaterThan(idxC);
    expect(idxB).toBeGreaterThan(idxD);

    // Each topic line carries its OWN (threadId, firstMessageId) deep-link.
    expect(out).toContain(`/${CHAT_ID_NOPREFIX}/1/101`);
    expect(out).toContain(`/${CHAT_ID_NOPREFIX}/1/102`);
    expect(out).toContain(`/${CHAT_ID_NOPREFIX}/2/201`);
    expect(out).toContain(`/${CHAT_ID_NOPREFIX}/2/202`);
  });

  it('FT-T4: title with HTML special chars is escaped', () => {
    const out = formatThreadSummaryPost(
      baseInput({
        summaries: [ok({ title: '<script>alert(1)</script>' })],
        totalMessageCount: 1,
      }),
    ).join('\n');
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(out).not.toContain('<script>alert(1)</script>');
  });

  it('FT-T5 (quick-260511-fkn): one summary with 5 topics renders 5 separate topic lines with their own deep-links', () => {
    const summary: ThreadSummary = {
      skipped: false,
      threadId: 99,
      windowHours: 24,
      messageCount: 50,
      topics: Array.from({ length: 5 }, (_, i) => ({
        emoji: '💻',
        title: `sub-topic-${i}`,
        messageCount: 10 - i, // 10, 9, 8, 7, 6 — already DESC
        firstMessageId: 1000 + i,
        links: [],
      })),
    };
    const out = formatThreadSummaryPost(
      baseInput({ summaries: [summary], totalMessageCount: 50 }),
    ).join('\n');
    for (let i = 0; i < 5; i++) {
      expect(out).toContain(`sub-topic-${i}`);
      expect(out).toContain(`/${CHAT_ID_NOPREFIX}/99/${1000 + i}`);
    }
    // Order DESC by messageCount: sub-topic-0 (mc=10) before sub-topic-4 (mc=6).
    expect(out.indexOf('sub-topic-0')).toBeLessThan(out.indexOf('sub-topic-4'));
  });

  it('FT-L1: aggregatedLinks non-empty → renders Интересные ссылки + each link line', () => {
    const out = formatThreadSummaryPost(
      baseInput({
        summaries: [ok({})],
        totalMessageCount: 12,
        aggregatedLinks: [
          { url: 'https://example.com/a', description: 'статья A' },
          { url: 'https://example.com/b', description: 'статья B' },
        ],
      }),
    ).join('\n');
    expect(out).toContain('Интересные ссылки:');
    expect(out).toContain('<a href="https://example.com/a">статья A</a>');
    expect(out).toContain('<a href="https://example.com/b">статья B</a>');
  });

  it('FT-L2: aggregatedLinks empty → no Интересные ссылки section', () => {
    const out = formatThreadSummaryPost(
      baseInput({
        summaries: [ok({})],
        totalMessageCount: 12,
        aggregatedLinks: [],
      }),
    ).join('\n');
    expect(out).not.toContain('Интересные ссылки:');
  });

  it('FT-L3: link with url containing `"` is silently dropped (HTML attribute injection guard)', () => {
    const out = formatThreadSummaryPost(
      baseInput({
        summaries: [ok({})],
        totalMessageCount: 12,
        aggregatedLinks: [
          { url: 'https://safe.example.com', description: 'safe' },
          { url: 'https://evil.example.com" onclick="alert(1)', description: 'evil' },
        ],
      }),
    ).join('\n');
    expect(out).toContain('https://safe.example.com');
    expect(out).not.toContain('evil.example.com');
    expect(out).not.toContain('onclick=');
  });

  it('FT-L4: link description with `<` and `&` is escaped', () => {
    const out = formatThreadSummaryPost(
      baseInput({
        summaries: [ok({})],
        totalMessageCount: 12,
        aggregatedLinks: [{ url: 'https://example.com', description: 'A & <b>B</b>' }],
      }),
    ).join('\n');
    expect(out).toContain('A &amp; &lt;b&gt;B&lt;/b&gt;');
  });

  it('FT-FOOT: last non-empty line of last chunk is `#dailysummary`', () => {
    const chunks = formatThreadSummaryPost(
      baseInput({
        summaries: [ok({})],
        totalMessageCount: 12,
        aggregatedLinks: [{ url: 'https://example.com', description: 'd' }],
      }),
    );
    const last = chunks[chunks.length - 1]!;
    const lines = last.split('\n').filter((l) => l.trim().length > 0);
    expect(lines[lines.length - 1]).toBe('#dailysummary');
  });

  it('FT-EDGE-1: zero summaries → single chunk with header + #dailysummary only', () => {
    const out = formatThreadSummaryPost(
      baseInput({
        summaries: [],
        totalMessageCount: 0,
      }),
    );
    expect(out.length).toBe(1);
    const chunk = out[0]!;
    expect(chunk).toMatch(/^📆 Что обсуждалось вчера/);
    expect(chunk).toContain('#dailysummary');
    expect(chunk).not.toContain('Всего было написано');
    expect(chunk).not.toContain('Интересные ссылки:');
  });

  it('FT-EDGE-2: all skipped → header + total + footer (no topic lines, no Интересные section)', () => {
    const out = formatThreadSummaryPost(
      baseInput({
        summaries: [skip('low-volume', 1), skip('low-volume', 2), skip('low-volume', 3)],
        totalMessageCount: 0,
      }),
    );
    expect(out.length).toBe(1);
    const chunk = out[0]!;
    expect(chunk).toMatch(/^📆 Что обсуждалось вчера/);
    expect(chunk).toContain('Всего было написано 0 сообщений');
    expect(chunk).toContain('#dailysummary');
    expect(chunk).not.toContain('https://t.me/c/');
    expect(chunk).not.toContain('Интересные ссылки:');
  });

  it('FT-SPLIT: many threads with very long titles → multiple chunks each ≤ MAX_CHUNK_LENGTH; footer only on last', () => {
    // 30 threads, each title at the schema max (100 chars) → each topic line ≈
    // 160 chars; 30 lines + separators ≈ 5000 chars > 4096 → forces a split.
    const longTitle = 'я'.repeat(100); // schema max
    const summaries: ThreadSummary[] = Array.from({ length: 30 }, (_, i) =>
      ok({
        threadId: i + 1,
        firstMessageId: 1000 + i,
        messageCount: 100 - i,
        topicMessageCount: 100 - i,
        title: longTitle,
      }),
    );
    const chunks = formatThreadSummaryPost(
      baseInput({
        summaries,
        totalMessageCount: summaries.reduce(
          (acc, s) => acc + (s.skipped ? 0 : s.messageCount),
          0,
        ),
      }),
    );
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(MAX_CHUNK_LENGTH);
    }
    // Footer on last chunk only.
    const tail = chunks[chunks.length - 1]!.split('\n').filter((l) => l.trim().length > 0);
    expect(tail[tail.length - 1]).toBe('#dailysummary');
    for (let i = 0; i < chunks.length - 1; i++) {
      expect(chunks[i]).not.toContain('#dailysummary');
    }
    // All threads represented across chunks (no mid-line split).
    const all = chunks.join('\n');
    for (let i = 0; i < 30; i++) {
      expect(all).toContain(`/${1000 + i}">${100 - i} сообщений</a>`);
    }
  });
});
