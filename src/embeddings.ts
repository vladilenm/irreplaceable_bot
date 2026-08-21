import OpenAI from 'openai';
import type { EmbeddingProvider } from './members.js';

interface EmbeddingClient {
  embeddings: {
    create(input: {
      model: string;
      input: string[];
      encoding_format: 'float';
    }): Promise<{
      model: string;
      data: Array<{ index: number; embedding: number[] }>;
    }>;
  };
}

export class OpenAiEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  private readonly client: EmbeddingClient;

  constructor(options: { apiKey: string; model: string; client?: EmbeddingClient }) {
    this.model = options.model;
    this.client = options.client ?? new OpenAI({ apiKey: options.apiKey, maxRetries: 1 });
  }

  async embed(texts: readonly string[]): Promise<readonly number[][]> {
    if (texts.length === 0) return [];

    const response = await this.client.embeddings.create({
      model: this.model,
      input: [...texts],
      encoding_format: 'float',
    });
    const ordered = [...response.data].sort((left, right) => left.index - right.index);
    const dimensions = ordered[0]?.embedding.length ?? 0;
    if (ordered.length !== texts.length || dimensions === 0) {
      throw new Error('OpenAI returned invalid embedding count');
    }

    return ordered.map((row, index) => {
      if (
        row.index !== index ||
        row.embedding.length !== dimensions ||
        row.embedding.some((value) => !Number.isFinite(value))
      ) {
        throw new Error(`OpenAI returned invalid embedding at index=${String(index)}`);
      }
      return row.embedding;
    });
  }
}
