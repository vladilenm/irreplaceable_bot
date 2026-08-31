import { describe, expect, it } from 'vitest';
import { PublishedDigestSchema } from './published-digest.js';

const publishedEvent = {
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
  sources: [
    {
      url: 'https://openai.com/index/agents/',
      label: 'OpenAI',
      role: 'primary',
    },
  ],
  publishedAt: '2026-08-31T06:00:00.000Z',
} as const;

const publishedDigestV3 = {
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
  sections: { main: [publishedEvent], radar: [], focus: [] },
} as const;

describe('PublishedDigest v3', () => {
  it('accepts the exact canonical fixture', () => {
    expect(PublishedDigestSchema.parse(publishedDigestV3)).toEqual(publishedDigestV3);
  });

  it('rejects unknown public fields at every boundary', () => {
    expect(() => PublishedDigestSchema.parse({ ...publishedDigestV3, score: 99 })).toThrow();
    expect(() => PublishedDigestSchema.parse({
      ...publishedDigestV3,
      sections: {
        ...publishedDigestV3.sections,
        main: [{ ...publishedEvent, prompt: 'hidden' }],
      },
    })).toThrow();
  });

  it.each([
    ['unsupported schema version', { schemaVersion: 2 }],
    ['non-UUID digest id', { digestId: 'digest-1' }],
    ['non-calendar date', { publicationDate: '2026-02-30' }],
    ['non-UTC generated timestamp', { generatedAt: '2026-08-31T09:30:00+03:00' }],
  ])('rejects %s', (_name, override) => {
    expect(() => PublishedDigestSchema.parse({ ...publishedDigestV3, ...override })).toThrow();
  });

  it.each([
    'ftp://example.com/report',
    'http://localhost/report',
    'http://127.0.0.1/report',
    'http://192.168.1.10/report',
  ])('rejects a non-public source URL: %s', (url) => {
    expect(() => PublishedDigestSchema.parse({
      ...publishedDigestV3,
      sections: {
        ...publishedDigestV3.sections,
        main: [{
          ...publishedEvent,
          keyQuote: { ...publishedEvent.keyQuote, url },
          sources: [{ ...publishedEvent.sources[0], url }],
        }],
      },
    })).toThrow();
  });

  it('requires standard issues to have main or radar and no focus events', () => {
    expect(() => PublishedDigestSchema.parse({
      ...publishedDigestV3,
      sections: { main: [], radar: [], focus: [] },
    })).toThrow();
    expect(() => PublishedDigestSchema.parse({
      ...publishedDigestV3,
      sections: { main: [publishedEvent], radar: [], focus: [publishedEvent] },
    })).toThrow();
  });

  it('requires focus issues to contain one to three focus events only', () => {
    for (const focus of [[], Array.from({ length: 4 }, () => publishedEvent)]) {
      expect(() => PublishedDigestSchema.parse({
        ...publishedDigestV3,
        selectionMode: 'focus',
        sections: { main: [], radar: [], focus },
      })).toThrow();
    }
    expect(PublishedDigestSchema.parse({
      ...publishedDigestV3,
      selectionMode: 'focus',
      sections: { main: [], radar: [], focus: [publishedEvent] },
    }).selectionMode).toBe('focus');
  });
});
