import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { config } from './config.js';
import { logger } from './logger.js';
import { requestJson } from './llm.js';
import type { DigestItem, RawArticle } from './types.js';

const curatorPrompt = readFileSync(
  new URL('../prompts/curator.md', import.meta.url),
  'utf-8',
);

const CuratedDigestSchema = z.object({
  items: z
    .array(
      z.object({
        title: z.string().min(1).max(120),
        summary: z.string().min(1).max(500),
        url: z.string().url(),
        category: z.enum([
          'agents',
          'orchestration',
          'models',
          'tools',
          'technologies',
          'business',
        ]),
      }),
    )
    .max(7),
});

const CURATED_DIGEST_JSON_SCHEMA = {
  type: 'object' as const,
  properties: {
    items: {
      type: 'array' as const,
      maxItems: 7,
      items: {
        type: 'object' as const,
        properties: {
          title: { type: 'string' as const, minLength: 1, maxLength: 120 },
          summary: { type: 'string' as const, minLength: 1, maxLength: 500 },
          url: { type: 'string' as const, format: 'uri' },
          category: {
            type: 'string' as const,
            enum: [
              'agents',
              'orchestration',
              'models',
              'tools',
              'technologies',
              'business',
            ],
          },
        },
        required: ['title', 'summary', 'url', 'category'],
        additionalProperties: false as const,
      },
    },
  },
  required: ['items'],
  additionalProperties: false as const,
};

function truncateDescription(description: string): string {
  return description.length > 200 ? `${description.slice(0, 200)}…` : description;
}

function formatArticlesForLlm(articles: RawArticle[]): string {
  return articles
    .map(
      (article) =>
        `---\nИсточник: ${article.source}\nЗаголовок: ${article.title}\nОписание: ${truncateDescription(article.description)}\nСсылка: ${article.link}\nДата: ${article.pubDate.toISOString()}`,
    )
    .join('\n\n');
}

export async function filterArticles(articles: RawArticle[]): Promise<DigestItem[]> {
  const response = await requestJson<unknown>(
    {
      apiKey: config.aiApiKey,
      model: config.aiModel,
      baseUrl: config.aiBaseUrl,
    },
    {
      system: curatorPrompt,
      user: `Сегодняшняя дата: ${new Date().toLocaleDateString('ru-RU')}.\n\nСтатьи для анализа:\n\n${formatArticlesForLlm(articles)}`,
      maxTokens: 8000,
      schemaName: 'curated_digest',
      schema: CURATED_DIGEST_JSON_SCHEMA,
      anthropicTool: {
        name: 'submit_digest',
        description: 'Submit the curated digest items',
      },
    },
  );
  const curated = CuratedDigestSchema.parse(response);
  const articleByUrl = new Map(articles.map((article) => [article.link, article]));
  const seen = new Set<string>();
  const result: DigestItem[] = [];

  for (const item of curated.items) {
    const source = articleByUrl.get(item.url);
    if (!source || seen.has(item.url)) continue;
    seen.add(item.url);
    result.push(item);
  }

  logger.info(
    {
      model: config.aiModel,
      inputArticles: articles.length,
      outputItems: result.length,
      rejectedItems: curated.items.length - result.length,
    },
    'AI filtering complete',
  );
  return result;
}
