// quick-260507-cni → summary-doc-260607 — formatter tests for the
// bullet-substance daily summary. Each topic renders a bold {emoji} {title}
// header plus one `• <a>summary</a>` line per bullet; topics stay grouped by
// thread (input order, no cross-thread sort).
import { describe, it, expect } from 'vitest';
import { formatThreadSummaryPost, MAX_CHUNK_LENGTH } from './thread-summary.formatter.js';
import type { ThreadSummary, Topic, TopicBullet } from '../../types/index.js';

const CHAT_ID = '-1003096173975';
const CHAT_ID_NOPREFIX = '3096173975';

interface OkOverrides {
  threadId?: number;
  windowHours?: number;
  messageCount?: number;
  /** Override the entire topics array (multi-topic test cases). */
  topics?: Topic[];
  /** Single-topic shortcuts. */
  emoji?: string;
  title?: string;
  bullets?: TopicBullet[];
  links?: Array<{ url: string; description: string }>;
}

/**
 * Build a non-skipped ThreadSummary. By default produces a single-topic,
 * single-bullet thread.
 */
const ok = (over: OkOverrides = {}): ThreadSummary => {
  const threadId = over.threadId ?? 7457;
  const messageCount = over.messageCount ?? 12;
  const topics: Topic[] = over.topics ?? [
    {
      emoji: over.emoji ?? '💻',
      title: over.title ?? 'Запуск ИИ моделей на локальных устройствах',
      bullets: over.bullets ?? [{ summary: 'Ollama работает на M2', msgId: 7471 }],
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

describe('formatThreadSummaryPost — bullet-substance layout (summary-doc-260607)', () => {
  it('FT-H1: first line is `📆 Что обсуждалось вчера DD.MM.YYYY` (MSK)', () => {
    const out = formatThreadSummaryPost(
      baseInput({ summaries: [ok({})], totalMessageCount: 12 }),
    );
    expect(out[0]).toMatch(/^📆 Что обсуждалось вчера 07\.05\.2026/);
  });

  it('FT-H2: second line is `Всего было написано N сообщений`', () => {
    const out = formatThreadSummaryPost(
      baseInput({ summaries: [ok({})], totalMessageCount: 42 }),
    );
    const lines = out[0]!.split('\n');
    expect(lines[1]).toBe('Всего было написано 42 сообщений');
  });

  it('FT-T1: a topic renders a bold header + a bullet line whose summary is the deep-link', () => {
    const out = formatThreadSummaryPost(
      baseInput({
        summaries: [
          ok({
            threadId: 7457,
            emoji: '💻',
            title: 'Локальные модели',
            bullets: [{ summary: 'Ollama работает на M2', msgId: 7471 }],
          }),
        ],
        totalMessageCount: 12,
      }),
    ).join('\n');
    expect(out).toContain('💻 <b>Локальные модели</b>');
    expect(out).toContain(
      `• <a href="https://t.me/c/${CHAT_ID_NOPREFIX}/7457/7471">Ollama работает на M2</a>`,
    );
    // The forbidden "N сообщений" statistic link is gone.
    expect(out).not.toContain('сообщений</a>');
  });

  it('FT-T2: chatIdNoPrefix correctly strips leading -100', () => {
    const out = formatThreadSummaryPost(
      baseInput({
        summaries: [ok({ threadId: 100, bullets: [{ summary: 's', msgId: 5 }] })],
        totalMessageCount: 1,
        chatId: '-1003096173975',
      }),
    ).join('\n');
    expect(out).toContain(`https://t.me/c/${CHAT_ID_NOPREFIX}/100/5`);
    expect(out).not.toContain('https://t.me/c/-1003096173975');
  });

  it('FT-T3 (summary-doc-260607): topics stay grouped by thread in INPUT order (no messageCount sort)', () => {
    // Three threads in input order a → b → c, regardless of message volume.
    const out = formatThreadSummaryPost(
      baseInput({
        summaries: [
          ok({ threadId: 1, messageCount: 5, title: 'thread-a' }),
          ok({ threadId: 2, messageCount: 50, title: 'thread-b' }),
          ok({ threadId: 3, messageCount: 25, title: 'thread-c' }),
        ],
        totalMessageCount: 80,
      }),
    ).join('\n');
    const a = out.indexOf('thread-a');
    const b = out.indexOf('thread-b');
    const c = out.indexOf('thread-c');
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });

  it('FT-T3b: a thread\'s sub-topics render consecutively, each with its own bullets', () => {
    const s1: ThreadSummary = {
      skipped: false,
      threadId: 1,
      windowHours: 24,
      messageCount: 55,
      topics: [
        { emoji: '🅰', title: 't-1a', bullets: [{ summary: 'b-1a', msgId: 101 }], links: [] },
        { emoji: '🅱', title: 't-1b', bullets: [{ summary: 'b-1b', msgId: 102 }], links: [] },
      ],
    };
    const s2: ThreadSummary = {
      skipped: false,
      threadId: 2,
      windowHours: 24,
      messageCount: 40,
      topics: [
        { emoji: '🅲', title: 't-2a', bullets: [{ summary: 'b-2a', msgId: 201 }], links: [] },
      ],
    };
    const out = formatThreadSummaryPost(
      baseInput({ summaries: [s1, s2], totalMessageCount: 95 }),
    ).join('\n');

    // Thread-1 topics appear before thread-2's, in input order.
    expect(out.indexOf('t-1a')).toBeGreaterThan(-1);
    expect(out.indexOf('t-1b')).toBeGreaterThan(out.indexOf('t-1a'));
    expect(out.indexOf('t-2a')).toBeGreaterThan(out.indexOf('t-1b'));

    // Each bullet carries its OWN (threadId, msgId) deep-link.
    expect(out).toContain(`/${CHAT_ID_NOPREFIX}/1/101`);
    expect(out).toContain(`/${CHAT_ID_NOPREFIX}/1/102`);
    expect(out).toContain(`/${CHAT_ID_NOPREFIX}/2/201`);
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

  it('FT-T4b: bullet summary with HTML special chars is escaped', () => {
    const out = formatThreadSummaryPost(
      baseInput({
        summaries: [ok({ bullets: [{ summary: 'A & <b>B</b>', msgId: 7471 }] })],
        totalMessageCount: 1,
      }),
    ).join('\n');
    expect(out).toContain('A &amp; &lt;b&gt;B&lt;/b&gt;');
  });

  it('FT-T5: one topic with 5 bullets renders 5 bullet lines, each with its own deep-link', () => {
    const summary: ThreadSummary = {
      skipped: false,
      threadId: 99,
      windowHours: 24,
      messageCount: 50,
      topics: [
        {
          emoji: '💻',
          title: 'big-topic',
          bullets: Array.from({ length: 5 }, (_, i) => ({
            summary: `point-${i}`,
            msgId: 1000 + i,
          })),
          links: [],
        },
      ],
    };
    const out = formatThreadSummaryPost(
      baseInput({ summaries: [summary], totalMessageCount: 50 }),
    ).join('\n');
    for (let i = 0; i < 5; i++) {
      expect(out).toContain(`• <a href="https://t.me/c/${CHAT_ID_NOPREFIX}/99/${1000 + i}">point-${i}</a>`);
    }
    // Bullets keep LLM order.
    expect(out.indexOf('point-0')).toBeLessThan(out.indexOf('point-4'));
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
      baseInput({ summaries: [ok({})], totalMessageCount: 12, aggregatedLinks: [] }),
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
      baseInput({ summaries: [], totalMessageCount: 0 }),
    );
    expect(out.length).toBe(1);
    const chunk = out[0]!;
    expect(chunk).toMatch(/^📆 Что обсуждалось вчера/);
    expect(chunk).toContain('#dailysummary');
    expect(chunk).not.toContain('Всего было написано');
    expect(chunk).not.toContain('Интересные ссылки:');
  });

  it('FT-EDGE-2: all skipped → header + total + footer (no topic blocks, no Интересные section)', () => {
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

  it('FT-SPLIT: many threads with long titles + bullets → multiple chunks each ≤ MAX_CHUNK_LENGTH; footer only on last', () => {
    const longTitle = 'я'.repeat(100); // schema max
    const summaries: ThreadSummary[] = Array.from({ length: 30 }, (_, i) =>
      ok({
        threadId: i + 1,
        title: longTitle,
        bullets: [{ summary: 'и'.repeat(150), msgId: 1000 + i }],
        messageCount: 100 - i,
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
    // All threads represented across chunks (each bullet deep-link present).
    const all = chunks.join('\n');
    for (let i = 0; i < 30; i++) {
      expect(all).toContain(`/${i + 1}/${1000 + i}">`);
    }
  });
});
