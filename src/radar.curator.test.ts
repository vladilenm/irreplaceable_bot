import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawArticle } from './types.js';

const { mockRequestJson } = vi.hoisted(() => ({
  mockRequestJson: vi.fn(),
}));

vi.mock('./llm.js', () => ({
  requestJson: mockRequestJson,
  LlmSchemaError: class LlmSchemaError extends Error {},
}));

import { filterArticles } from './radar.curator.js';

const article: RawArticle = {
  title: 'Original',
  description: 'Description',
  link: 'https://example.com/original',
  source: 'Example',
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
      },
    ]);
  });

  it('regenerates when every proposed URL is absent from the input', async () => {
    mockRequestJson
      .mockResolvedValueOnce({
        items: [{
          title: 'Выдумка', summary: 'Нет такого источника.',
          url: 'https://hallucinated.example/news', category: 'models',
        }],
      })
      .mockResolvedValueOnce({ items: [] });

    await expect(filterArticles([article])).resolves.toEqual([]);
    expect(mockRequestJson).toHaveBeenCalledTimes(2);
  });

  it('regenerates once when the first structured result is invalid', async () => {
    mockRequestJson
      .mockResolvedValueOnce({ items: 'not-an-array' })
      .mockResolvedValueOnce({
        items: [{
          title: 'Recovered', summary: 'Valid after retry.', url: article.link, category: 'tools',
        }],
      });

    await expect(filterArticles([article])).resolves.toMatchObject([{ title: 'Recovered' }]);
    expect(mockRequestJson).toHaveBeenCalledTimes(2);
    expect(mockRequestJson.mock.calls[1]?.[1]).toMatchObject({
      retryInstruction: expect.stringContaining('valid JSON'),
    });
  });

  it('does not regenerate a valid empty digest', async () => {
    mockRequestJson.mockResolvedValueOnce({ items: [] });

    await expect(filterArticles([article])).resolves.toEqual([]);
    expect(mockRequestJson).toHaveBeenCalledOnce();
  });
});
