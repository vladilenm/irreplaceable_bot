import fs from 'node:fs';
import RssParser from 'rss-parser';
import type { FeedConfig, RawArticle } from '../types/index.js';
import { logger } from '../utils/logger.js';

const feeds: FeedConfig[] = JSON.parse(
  fs.readFileSync(new URL('../../config/feeds.json', import.meta.url), 'utf-8'),
) as FeedConfig[];

const parser: RssParser<Record<string, unknown>, Record<string, unknown>> = new RssParser({
  timeout: 10_000,
  headers: { 'User-Agent': 'NezamenimyeBot/1.0' },
});

function isValidHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export async function fetchFeeds(hoursBack: number = 24): Promise<RawArticle[]> {
  const cutoff = new Date(Date.now() - hoursBack * 60 * 60 * 1000);
  const articles: RawArticle[] = [];
  let successCount = 0;
  let failCount = 0;

  for (const feed of feeds) {
    try {
      const parsed = await parser.parseURL(feed.url);
      successCount++;

      for (const item of parsed.items) {
        const dateStr = item.isoDate ?? item.pubDate;
        if (!dateStr) continue;

        const pubDate = new Date(dateStr);
        if (isNaN(pubDate.getTime()) || pubDate < cutoff) continue;

        const link = item.link ?? '';
        if (link && !isValidHttpUrl(link)) continue;

        articles.push({
          title: item.title ?? '',
          description: item.contentSnippet ?? item.content ?? '',
          link,
          source: feed.name,
          sourceKey: feed.sourceKey,
          pubDate,
        });
      }
    } catch (error: unknown) {
      failCount++;
      const message = error instanceof Error ? error.message : String(error);
      logger.warn({ feed: feed.name, error: message }, 'Failed to fetch RSS feed, skipping');
    }
  }

  logger.info(
    { totalArticles: articles.length, feedsProcessed: successCount, feedsFailed: failCount },
    'RSS fetch complete',
  );

  return articles.sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime());
}
