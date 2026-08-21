import OpenAI from 'openai';
import type { EmbeddingProvider } from './members.js';

interface EmbeddingClient {
  embeddings: {
    create(input: {
      model: string;
      input: string[];
      encoding_format: 'float';
      dimensions: number;
    }): Promise<{
      model: string;
      data: Array<{ index: number; embedding: number[] }>;
    }>;
  };
}

export class OpenAiEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  private readonly dimensions: number;
  private readonly client: EmbeddingClient;

  constructor(options: {
    apiKey: string;
    baseUrl: string;
    model: string;
    dimensions: number;
    client?: EmbeddingClient;
  }) {
    this.model = options.model;
    this.dimensions = options.dimensions;
    this.client = options.client ?? new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseUrl,
      maxRetries: 1,
    });
  }

  async embed(texts: readonly string[]): Promise<readonly number[][]> {
    if (texts.length === 0) return [];

    const response = await this.client.embeddings.create({
      model: this.model,
      input: [...texts],
      encoding_format: 'float',
      dimensions: this.dimensions,
    });
    const ordered = [...response.data].sort((left, right) => left.index - right.index);
    if (ordered.length !== texts.length) {
      throw new Error('OpenAI returned invalid embedding count');
    }

    return ordered.map((row, index) => {
      if (
        row.index !== index ||
        row.embedding.some((value) => !Number.isFinite(value))
      ) {
        throw new Error(`OpenAI returned invalid embedding at index=${String(index)}`);
      }
      if (row.embedding.length !== this.dimensions) {
        throw new Error(
          `OpenAI returned invalid embedding at index=${String(index)}: expected ${String(this.dimensions)} dimensions, received ${String(row.embedding.length)}`,
        );
      }
      return row.embedding;
    });
  }
}
