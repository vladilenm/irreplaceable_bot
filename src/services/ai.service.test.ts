import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawArticle } from '../types/index.js';

const { mockRequestJson } = vi.hoisted(() => ({
  mockRequestJson: vi.fn(),
}));

vi.mock('./llm.service.js', () => ({ requestJson: mockRequestJson }));

import { filterArticles } from './ai.service.js';

const article: RawArticle = {
  title: 'Original',
  description: 'Description',
  link: 'https://example.com/original',
  source: 'Example',
  sourceKey: 'example',
  pubDate: new Date('2026-05-02T05:00:00.000Z'),
};

beforeEach(() => mockRequestJson.mockReset());

describe('filterArticles structured boundary', () => {
  it('accepts valid items and restores source metadata from the input article', async () => {
    mockRequestJson.mockResolvedValue({
      items: [
        {
          title: 'Русский заголовок',
          summary: 'Почему это полезно.',
          url: article.link,
          category: 'tools',
        },
      ],
    });

    const result = await filterArticles([article]);

    expect(result).toEqual([
      {
        title: 'Русский заголовок',
        summary: 'Почему это полезно.',
        url: article.link,
        category: 'tools',
        source: article.source,
        publishedAt: article.pubDate,
      },
    ]);
  });

  it('drops URLs that were not present in the input instead of publishing hallucinations', async () => {
    mockRequestJson.mockResolvedValue({
      items: [
        {
          title: 'Выдумка',
          summary: 'Нет такого источника.',
          url: 'https://hallucinated.example/news',
          category: 'models',
        },
      ],
    });

    await expect(filterArticles([article])).resolves.toEqual([]);
  });
});
