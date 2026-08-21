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
    model: 'text-embedding-3-small',
    client: { embeddings: { create } },
  });

  await expect(provider.embed(['first', 'second'])).resolves.toEqual([[1, 0], [0, 1]]);
  expect(create).toHaveBeenCalledWith({
    model: 'text-embedding-3-small',
    input: ['first', 'second'],
    encoding_format: 'float',
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
    model: 'text-embedding-3-small',
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
    model: 'text-embedding-3-small',
    client: { embeddings: { create } },
  });

  await expect(provider.embed([])).resolves.toEqual([]);
  expect(create).not.toHaveBeenCalled();
});
