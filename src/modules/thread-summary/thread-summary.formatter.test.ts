import { describe, it, expect } from 'vitest';
import { formatThreadSummaryPost, MAX_CHUNK_LENGTH } from './thread-summary.formatter.js';
import type { ThreadSummary } from '../../types/index.js';

const ok = (over: Partial<Extract<ThreadSummary, { skipped: false }>>): ThreadSummary => ({
  skipped: false,
  threadId: 100,
  windowHours: 24,
  messageCount: 10,
  headline: 'Обсуждали оркестратор',
  bullets: ['обсуждали A', 'обсуждали B'],
  participants: [{ displayName: 'Маша', messageCount: 5 }],
  openQuestions: [],
  ...over,
});

const skip = (
  reason: 'low-volume' | 'transcript-too-large' | 'llm-error' | 'schema-invalid',
  threadId = 100,
): ThreadSummary => ({
  skipped: true,
  threadId,
  windowHours: 24,
  messageCount: reason === 'low-volume' ? 2 : 0,
  reason,
});

describe('formatThreadSummaryPost layout (D-01..D-04, D-36)', () => {
  it('F1: header contains MSK calendar day DD.MM.YYYY', () => {
    const out = formatThreadSummaryPost({
      summaries: [],
      titles: new Map(),
      date: new Date('2026-04-29T03:30:00Z'),
    });
    expect(out[0]).toContain('🧵 Сводки тредов · 29.04.2026');
    expect(out[0]).toMatch(/^<b>🧵 Сводки тредов · 29\.04\.2026<\/b>/);
  });

  it('F2: threads sorted by messageCount DESC', () => {
    const summaries: ThreadSummary[] = [
      ok({ threadId: 1, messageCount: 10, headline: 'low' }),
      ok({ threadId: 2, messageCount: 50, headline: 'high' }),
    ];
    const titles = new Map([
      [1, 'LowThread'],
      [2, 'HighThread'],
    ]);
    const out = formatThreadSummaryPost({
      summaries,
      titles,
      date: new Date('2026-04-29T03:30:00Z'),
    });
    const text = out.join('\n');
    expect(text.indexOf('HighThread')).toBeLessThan(text.indexOf('LowThread'));
  });

  it('F3: compact layout — title, italic headline, bullets, participants line, no labels', () => {
    const summaries = [
      ok({
        headline: 'Обсуждали X',
        bullets: ['а', 'б'],
        participants: [{ displayName: 'М', messageCount: 5 }],
        messageCount: 5,
      }),
    ];
    const titles = new Map([[100, 'Тестовый']]);
    const out = formatThreadSummaryPost({ summaries, titles, date: new Date() }).join('\n');
    expect(out).toContain('<b>📄 Тестовый</b>');
    expect(out).toContain('<i>Обсуждали X</i>');
    expect(out).toContain('• а');
    expect(out).toContain('• б');
    expect(out).toContain('👥 М · 💬 5');
    expect(out).not.toContain('Главное:');
    expect(out).not.toContain('Пункты:');
  });

  it('F4: title with HTML special chars is escaped', () => {
    const summaries = [ok({})];
    const titles = new Map([[100, '<script>alert(1)</script>']]);
    const out = formatThreadSummaryPost({ summaries, titles, date: new Date() }).join('\n');
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(out).not.toContain('<script>alert(1)</script>');
  });

  it('F5: bullet with & and < is escaped', () => {
    const summaries = [ok({ bullets: ['Маша & Петя <kek>'] })];
    const out = formatThreadSummaryPost({
      summaries,
      titles: new Map([[100, 'T']]),
      date: new Date(),
    }).join('\n');
    expect(out).toContain('Маша &amp; Петя &lt;kek&gt;');
  });

  it('F6: participants render with middle-dot separator', () => {
    const summaries = [
      ok({
        participants: [
          { displayName: 'Маша', messageCount: 10 },
          { displayName: 'Петя', messageCount: 5 },
          { displayName: 'Аня', messageCount: 3 },
        ],
        messageCount: 18,
      }),
    ];
    const out = formatThreadSummaryPost({
      summaries,
      titles: new Map([[100, 'T']]),
      date: new Date(),
    }).join('\n');
    expect(out).toContain('👥 Маша·Петя·Аня · 💬 18');
  });

  it('F7: participant displayName Unicode-normalised before render', () => {
    const summaries = [
      ok({ participants: [{ displayName: 'Ма​ша', messageCount: 1 }], messageCount: 1 }),
    ];
    const out = formatThreadSummaryPost({
      summaries,
      titles: new Map([[100, 'T']]),
      date: new Date(),
    }).join('\n');
    expect(out).toContain('Маша');
    expect(out).not.toContain('Ма​ша');
  });

  it('F8: footer with mixed skipped — `тихо: N тредов`', () => {
    const summaries: ThreadSummary[] = [
      ok({ threadId: 1, messageCount: 10 }),
      ok({ threadId: 2, messageCount: 8 }),
      skip('low-volume', 3),
      skip('low-volume', 4),
      skip('llm-error', 5),
    ];
    const titles = new Map([
      [1, 'T1'],
      [2, 'T2'],
    ]);
    const out = formatThreadSummaryPost({ summaries, titles, date: new Date() }).join('\n');
    expect(out).toContain('тихо: 3 тредов');
  });

  it('F9: empty-digest — all skipped → `тихо: N из N` (D-35)', () => {
    const summaries = [
      skip('low-volume', 1),
      skip('low-volume', 2),
      skip('low-volume', 3),
      skip('low-volume', 4),
    ];
    const out = formatThreadSummaryPost({ summaries, titles: new Map(), date: new Date() });
    expect(out.length).toBe(1);
    expect(out[0]).toContain('тихо: 4 из 4');
  });

  it('F10: zero tracked threads → header only', () => {
    const out = formatThreadSummaryPost({ summaries: [], titles: new Map(), date: new Date() });
    expect(out.length).toBe(1);
    expect(out[0]).toMatch(/^<b>🧵 Сводки тредов/);
    expect(out[0]).not.toContain('тихо:');
  });

  it('F11: splitter — multi-chunk, each ≤ MAX_CHUNK_LENGTH, no mid-section split', () => {
    const longBullet = 'а'.repeat(120);
    const summaries: ThreadSummary[] = Array.from({ length: 6 }, (_, i) =>
      ok({
        threadId: i + 1,
        messageCount: 100 - i,
        headline: 'Обсуждали тему '.repeat(3).trim(),
        bullets: [longBullet, longBullet, longBullet, longBullet, longBullet, longBullet],
        participants: [{ displayName: `User${i}`, messageCount: 5 }],
      }),
    );
    const titles = new Map(
      Array.from({ length: 6 }, (_, i) => [i + 1, `Thread${i + 1}`] as const),
    );
    const chunks = formatThreadSummaryPost({ summaries, titles, date: new Date() });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(MAX_CHUNK_LENGTH);
    }
    const all = chunks.join('\n');
    for (let i = 1; i <= 6; i++) {
      expect(all).toContain(`Thread${i}`);
    }
  });

  it('F13: open questions block conditional', () => {
    const withOQ = [ok({ openQuestions: ['кто решает?'] })];
    const withoutOQ = [ok({ openQuestions: [] })];
    const titles = new Map([[100, 'T']]);
    const date = new Date();
    const oOut = formatThreadSummaryPost({ summaries: withOQ, titles, date }).join('\n');
    const noOut = formatThreadSummaryPost({ summaries: withoutOQ, titles, date }).join('\n');
    expect(oOut).toContain('Открытые вопросы:');
    expect(oOut).toContain('— кто решает?');
    expect(noOut).not.toContain('Открытые вопросы:');
  });

  it('F14: missing title in titles Map → fallback "Тред #N"', () => {
    const summaries = [ok({ threadId: 999 })];
    const titles = new Map<number, string>();
    const out = formatThreadSummaryPost({ summaries, titles, date: new Date() }).join('\n');
    expect(out).toContain('Тред #999');
  });
});
