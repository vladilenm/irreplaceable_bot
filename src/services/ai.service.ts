import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { readFileSync } from 'node:fs';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import type { RawArticle } from '../types/index.js';

const curatorPrompt = readFileSync(
  new URL('../../prompts/curator.md', import.meta.url),
  'utf-8',
);

function formatArticlesForLLM(articles: RawArticle[]): string {
  return articles
    .map(
      (article) =>
        `---\nИсточник: ${article.source}\nЗаголовок: ${article.title}\nОписание: ${article.description}\nСсылка: ${article.link}\nДата: ${article.pubDate.toISOString()}`,
    )
    .join('\n\n');
}

function isClaude(model: string): boolean {
  return model.startsWith('claude');
}

export async function filterArticles(
  articles: RawArticle[],
): Promise<string> {
  const formattedArticles = formatArticlesForLLM(articles);
  const userMessage = `Сегодняшняя дата: ${new Date().toLocaleDateString('ru-RU')}.\n\nСтатьи для анализа:\n\n${formattedArticles}`;

  let result: string;
  let finishReason: string | null | undefined;
  let refusal: string | null | undefined;

  if (isClaude(config.aiModel)) {
    const client = new Anthropic({ apiKey: config.aiApiKey });
    const response = await client.messages.create({
      model: config.aiModel,
      max_tokens: 2000,
      system: curatorPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });

    const firstBlock = response.content[0];
    if (!firstBlock || firstBlock.type !== 'text') {
      throw new Error('Unexpected Anthropic response: no text block');
    }
    result = firstBlock.text;
    finishReason = response.stop_reason ?? null;
    refusal = response.stop_sequence ?? null;
  } else {
    const client = new OpenAI({
      apiKey: config.aiApiKey,
      ...(config.aiBaseUrl ? { baseURL: config.aiBaseUrl } : {}),
    });
    const response = await client.chat.completions.create({
      model: config.aiModel,
      max_tokens: 2000,
      messages: [
        { role: 'system', content: curatorPrompt },
        { role: 'user', content: userMessage },
      ],
    });

    const firstChoice = response.choices[0];
    result = firstChoice?.message?.content ?? '';
    finishReason = firstChoice?.finish_reason ?? null;
    refusal =
      (firstChoice?.message as { refusal?: string | null } | undefined)
        ?.refusal ?? null;
  }

  logger.info(
    {
      rawResponseHead: result.slice(0, 800),
      rawResponseLength: result.length,
      finishReason,
      refusal,
      model: config.aiModel,
    },
    'AI raw response (debug)',
  );

  logger.info(
    { model: config.aiModel, inputArticles: articles.length },
    'AI filtering complete',
  );

  return result;
}
