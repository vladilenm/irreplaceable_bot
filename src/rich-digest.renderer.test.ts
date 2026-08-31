import { describe, expect, it } from 'vitest';
import type { PublishedDigestV3, PublishedEvent } from './published-digest.js';
import {
  countRichBlocks,
  renderDigestRichHtml,
  RICH_MESSAGE_LIMIT_BLOCKS,
  RICH_MESSAGE_LIMIT_CHARACTERS,
} from './rich-digest.renderer.js';

function makeEvent(overrides: Partial<PublishedEvent> = {}): PublishedEvent {
  return {
    eventId: 'event-openai-agents',
    title: 'OpenAI представила платформу AI-агентов',
    claimKind: 'fact',
    confidence: 'confirmed',
    summary: 'Платформа объединяет инструменты для сборки и запуска агентов.',
    whyImportant: 'Команды смогут быстрее переносить агентные сценарии в production.',
    affected: 'Продуктовые и инженерные команды',
    keyQuote: {
      text: 'Agents can now use verified tools.',
      url: 'https://openai.com/index/agents/',
      sourceLabel: 'OpenAI',
    },
    tags: [{ id: 'agents', label: 'AI-агенты' }],
    entities: [{ id: 'openai', label: 'OpenAI' }],
    sources: [{
      url: 'https://openai.com/index/agents/',
      label: 'OpenAI',
      role: 'primary',
    }],
    publishedAt: '2026-08-31T06:00:00.000Z',
    ...overrides,
  };
}

function makeDigest(overrides: Partial<PublishedDigestV3> = {}): PublishedDigestV3 {
  return {
    schemaVersion: 3,
    digestId: '11111111-1111-4111-8111-111111111111',
    topic: {
      id: 'ai',
      title: 'AI Radar',
      language: 'ru',
      timezone: 'Europe/Moscow',
    },
    publicationDate: '2026-08-31',
    generatedAt: '2026-08-31T06:30:00.000Z',
    status: 'complete',
    selectionMode: 'standard',
    sourceStats: {
      telegram: { total: 10, succeeded: 9, skipped: 1 },
      web: { total: 5, succeeded: 5, skipped: 0 },
    },
    sections: { main: [makeEvent()], radar: [], focus: [] },
    ...overrides,
  };
}

function maxHtmlNestingDepth(html: string): number {
  const voidElements = new Set(['br', 'hr']);
  const stack: string[] = [];
  let maximum = 0;
  for (const match of html.matchAll(/<\/?([a-z][a-z0-9]*)\b[^>]*>/gi)) {
    const tag = match[1]!.toLowerCase();
    if (voidElements.has(tag)) continue;
    if (match[0].startsWith('</')) {
      expect(stack.pop()).toBe(tag);
      continue;
    }
    stack.push(tag);
    maximum = Math.max(maximum, stack.length);
  }
  expect(stack).toEqual([]);
  return maximum;
}

describe('renderDigestRichHtml', () => {
  it('renders canonical Main and Radar sections in stored event order', () => {
    const digest = makeDigest({
      sections: {
        main: [makeEvent({ title: 'Первое событие' }), makeEvent({ title: 'Второе событие' })],
        radar: [makeEvent({ title: 'Третье событие', confidence: 'corroborated' })],
        focus: [],
      },
    });

    const html = renderDigestRichHtml(digest);

    expect(html).toContain('<h1>🗞 AI Radar</h1>');
    expect(html).toContain('<h2>🔥 Главное · 2</h2>');
    expect(html).toContain('<h2>📡 На радаре · 1</h2>');
    expect(html.indexOf('Первое событие')).toBeLessThan(html.indexOf('Второе событие'));
    expect(html.indexOf('Второе событие')).toBeLessThan(html.indexOf('Третье событие'));
    expect(html).toContain('AI-агенты');
    expect([...html].length).toBeLessThanOrEqual(RICH_MESSAGE_LIMIT_CHARACTERS);
    expect(countRichBlocks(html)).toBeLessThanOrEqual(RICH_MESSAGE_LIMIT_BLOCKS);
    expect(maxHtmlNestingDepth(html)).toBeLessThan(16);
  });

  it('renders partial source state without exposing internal diagnostics', () => {
    const html = renderDigestRichHtml(makeDigest({ status: 'partial' }));

    expect(html).toContain('⚠️ Неполные данные');
    expect(html).toContain('источники 14/15');
    expect(html).not.toContain('error');
  });

  it('renders Focus as its own detailed section with a calm fallback note', () => {
    const html = renderDigestRichHtml(makeDigest({
      selectionMode: 'focus',
      sections: {
        main: [],
        radar: [],
        focus: [
          makeEvent({ title: 'Фокус 1' }),
          makeEvent({ title: 'Фокус 2' }),
          makeEvent({ title: 'Фокус 3' }),
        ],
      },
    }));

    expect(html).toContain('<h2>🎯 В фокусе · 3</h2>');
    expect(html).toContain('информационный сигнал сегодня слабее обычного');
    expect(html).not.toContain('🔥 Главное');
    expect(html).not.toContain('📡 На радаре');
    expect(html).toContain('<b>Суть:</b>');
  });

  it('escapes every public text field and URL attribute', () => {
    const unsafe = `<script>&"'`;
    const url = 'https://example.com/report?a=1&b=%22x%22';
    const event = makeEvent({
      title: unsafe,
      summary: unsafe,
      whyImportant: unsafe,
      affected: unsafe,
      keyQuote: { text: unsafe, url, sourceLabel: unsafe },
      tags: [{ id: 'unsafe', label: unsafe }],
      entities: [{ id: 'unsafe-entity', label: unsafe }],
      sources: [{ url, label: unsafe, role: 'primary' }],
    });
    const html = renderDigestRichHtml(makeDigest({
      topic: { id: 'ai', title: unsafe, language: 'ru', timezone: 'Europe/Moscow' },
      sections: { main: [event], radar: [], focus: [] },
    }));

    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;&amp;&quot;&#39;');
    expect(html).toContain('href="https://example.com/report?a=1&amp;b=%22x%22"');
  });

  it('removes duplicate source URLs and preserves the first public label', () => {
    const url = 'https://example.com/report';
    const html = renderDigestRichHtml(makeDigest({
      sections: {
        main: [makeEvent({
          sources: [
            { url, label: 'Первоисточник', role: 'primary' },
            { url: `${url}/../report`, label: 'Дубликат', role: 'analysis' },
          ],
        })],
        radar: [],
        focus: [],
      },
    }));

    expect(html.match(/href=/g)).toHaveLength(1);
    expect(html).toContain('Первоисточник');
    expect(html).not.toContain('Дубликат');
  });

  it('truncates by Unicode code point without splitting surrogate pairs', () => {
    const html = renderDigestRichHtml(makeDigest({
      sections: {
        main: [makeEvent({ title: '😀'.repeat(200) })],
        radar: [],
        focus: [],
      },
    }));

    expect(html).toContain('😀'.repeat(139) + '…');
    expect(html).not.toContain('�');
  });

  it('deterministically compacts details until both Rich Message limits fit', () => {
    const long = 'Длинное проверенное описание '.repeat(80);
    const main = Array.from({ length: 20 }, (_, index) => makeEvent({
      eventId: `main-${String(index)}`,
      title: `Main ${String(index)} ${long}`,
      summary: long,
      whyImportant: long,
      affected: long,
      keyQuote: { ...makeEvent().keyQuote, text: long },
    }));
    const radar = Array.from({ length: 20 }, (_, index) => makeEvent({
      eventId: `radar-${String(index)}`,
      title: `Radar ${String(index)} ${long}`,
      whyImportant: long,
    }));
    const digest = makeDigest({ sections: { main, radar, focus: [] } });

    const first = renderDigestRichHtml(digest);
    const second = renderDigestRichHtml(digest);

    expect(first).toBe(second);
    expect(first).toContain('Часть деталей сокращена по лимиту Telegram');
    expect([...first].length).toBeLessThanOrEqual(RICH_MESSAGE_LIMIT_CHARACTERS);
    expect(countRichBlocks(first)).toBeLessThanOrEqual(RICH_MESSAGE_LIMIT_BLOCKS);
  });

  it('throws only when every render profile still exceeds a Rich Message limit', () => {
    const invalidOversizedDigest = makeDigest({
      topic: {
        id: 'ai',
        title: 'x'.repeat(RICH_MESSAGE_LIMIT_CHARACTERS),
        language: 'ru',
        timezone: 'Europe/Moscow',
      },
    });

    expect(() => renderDigestRichHtml(invalidOversizedDigest)).toThrow(
      /exceeds Rich Message limits after compaction/,
    );
  });
});
