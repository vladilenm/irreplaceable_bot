import { expect, it, vi } from 'vitest';
import { OpenAiEmbeddingProvider } from './embeddings.js';

it('orders returned vectors by response index', async () => {
  const create = vi.fn().mockResolvedValue({
    model: 'text-embedding-3-small',
    data: [
      { index: 1, embedding: [0, 1] },
      { index: 0, embedding: [1, 0] },
    ],
  });
  const provider = new OpenAiEmbeddingProvider({
    apiKey: 'key',
    baseUrl: 'https://api.timeweb.ai/v1',
    model: 'text-embedding-3-small',
    dimensions: 2,
    client: { embeddings: { create } },
  });

  await expect(provider.embed(['first', 'second'])).resolves.toEqual([[1, 0], [0, 1]]);
  expect(create).toHaveBeenCalledWith({
    model: 'text-embedding-3-small',
    input: ['first', 'second'],
    encoding_format: 'float',
    dimensions: 2,
  });
});

it('rejects non-finite, mixed-dimension and incomplete vectors', async () => {
  const create = vi.fn()
    .mockResolvedValueOnce({
      model: 'text-embedding-3-small',
      data: [{ index: 0, embedding: [1, Number.NaN] }],
    })
    .mockResolvedValueOnce({
      model: 'text-embedding-3-small',
      data: [
        { index: 0, embedding: [1, 0] },
        { index: 1, embedding: [0, 1, 2] },
      ],
    })
    .mockResolvedValueOnce({
      model: 'text-embedding-3-small',
      data: [{ index: 0, embedding: [1, 0] }],
    });
  const provider = new OpenAiEmbeddingProvider({
    apiKey: 'key',
    baseUrl: 'https://api.timeweb.ai/v1',
    model: 'text-embedding-3-small',
    dimensions: 2,
    client: { embeddings: { create } },
  });

  await expect(provider.embed(['first'])).rejects.toThrow('invalid embedding');
  await expect(provider.embed(['first', 'second'])).rejects.toThrow('invalid embedding');
  await expect(provider.embed(['first', 'second'])).rejects.toThrow('invalid embedding count');
});

it('does not call OpenAI for an empty batch', async () => {
  const create = vi.fn();
  const provider = new OpenAiEmbeddingProvider({
    apiKey: 'key',
    baseUrl: 'https://api.timeweb.ai/v1',
    model: 'text-embedding-3-small',
    dimensions: 2,
    client: { embeddings: { create } },
  });

  await expect(provider.embed([])).resolves.toEqual([]);
  expect(create).not.toHaveBeenCalled();
});

it('sends Timeweb base configuration and requests exactly 1536 dimensions', async () => {
  const create = vi.fn().mockResolvedValue({
    model: 'openai/text-embedding-3-large',
    data: [{ index: 0, embedding: Array.from({ length: 1536 }, () => 0.1) }],
  });
  const provider = new OpenAiEmbeddingProvider({
    apiKey: 'gateway-token',
    baseUrl: 'https://api.timeweb.ai/v1',
    model: 'openai/text-embedding-3-large',
    dimensions: 1536,
    client: { embeddings: { create } },
  });

  await expect(provider.embed(['профиль'])).resolves.toHaveLength(1);
  expect(create).toHaveBeenCalledWith({
    model: 'openai/text-embedding-3-large',
    input: ['профиль'],
    encoding_format: 'float',
    dimensions: 1536,
  });
});

it('rejects a Gateway response with the wrong dimensions', async () => {
  const provider = new OpenAiEmbeddingProvider({
    apiKey: 'gateway-token',
    baseUrl: 'https://api.timeweb.ai/v1',
    model: 'openai/text-embedding-3-large',
    dimensions: 1536,
    client: {
      embeddings: {
        create: vi.fn().mockResolvedValue({
          model: 'openai/text-embedding-3-large',
          data: [{ index: 0, embedding: [0.1, 0.2] }],
        }),
      },
    },
  });

  await expect(provider.embed(['профиль']))
    .rejects.toThrow('expected 1536 dimensions, received 2');
});
