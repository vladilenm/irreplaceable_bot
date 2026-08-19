import { describe, expect, it } from 'vitest';
import type { DigestItem } from './types.js';
import { formatDigestHtml } from './radar.js';

const item = (overrides: Partial<DigestItem> = {}): DigestItem => ({
  title: 'Новый <агент>',
  summary: 'Работает быстрее & дешевле.',
  url: 'https://example.com/news?a=1&b=2',
  category: 'agents',
  ...overrides,
});

describe('formatDigestHtml', () => {
  it('renders structured items and escapes all visible LLM text', () => {
    const html = formatDigestHtml(
      [item()],
      new Date('2026-05-02T06:00:00.000Z'),
    );

    expect(html).toContain('<b>📡 AI-радар | 02.05.2026</b>');
    expect(html).toContain(
      '<b><a href="https://example.com/news?a=1&amp;b=2">🤖 Новый &lt;агент&gt;</a></b>',
    );
    expect(html).toContain('Работает быстрее &amp; дешевле.');
    expect(html).not.toContain('→ https://');
  });

  it('maps every category to a stable emoji', () => {
    const categories: DigestItem['category'][] = [
      'agents',
      'orchestration',
      'models',
      'tools',
      'technologies',
      'business',
    ];
    const html = formatDigestHtml(
      categories.map((category) => item({ category, title: category })),
      new Date('2026-05-02T06:00:00.000Z'),
    );
    for (const emoji of ['🤖', '🔗', '🧠', '🛠', '⚡', '💰']) {
      expect(html).toContain(emoji);
    }
  });
});
