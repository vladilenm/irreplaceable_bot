// Phase 6 → quick-260507-cni topic-style formatter.
// Pure function: FormatThreadSummaryInput → string[] (HTML chunks ≤ MAX_CHUNK_LENGTH).
// Layout:
//   📆 Что обсуждалось вчера DD.MM.YYYY
//   Всего было написано N сообщений
//   <blank>
//   {emoji} {title} (<a href="https://t.me/c/{chatIdNoPrefix}/{threadId}/{firstMessageId}">{count} сообщений</a>)
//   ... more topic lines, sorted by messageCount DESC ...
//   <blank>
//   Интересные ссылки:                                    # only if aggregatedLinks non-empty
//   <a href="{url}">{description}</a>
//   ... more links ...
//   <blank>
//   #dailysummary
//
// Edge cases:
// - Zero summaries (no tracked threads): single chunk with header + footer only.
// - All skipped: single chunk with header + total + footer (no topic lines, no Интересные section).
// - Splitter: section-boundary, never splits mid-line; footer goes only on last chunk.
//
// Threat-model mitigations (260507-cni):
// - T-260507-01: drop links whose url contains `"` (HTML attribute injection guard).
// - T-260507-02: escapeHtml() over title and description (HTML body escapes).

import { logger } from '../../utils/logger.js';
import type { ThreadSummary } from '../../types/index.js';

export const MAX_CHUNK_LENGTH = 4096;
const FOOTER_TAG = '#dailysummary';
const SECTION_SEPARATOR = '\n\n';

function escapeHtml(input: string): string {
  return input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatHeaderDate(date: Date): string {
  // MSK calendar day, DD.MM.YYYY.
  return date.toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' });
}

function stripChatIdPrefix(chatId: string): string {
  // Telegram supergroup ids start with -100; the t.me/c/ link path uses the
  // numeric body without the -100 prefix.
  return chatId.startsWith('-100') ? chatId.slice(4) : chatId.replace(/^-/, '');
}

function buildTopicLine(
  s: Extract<ThreadSummary, { skipped: false }>,
  chatIdNoPrefix: string,
): string {
  const url = `https://t.me/c/${chatIdNoPrefix}/${s.threadId}/${s.firstMessageId}`;
  return `${s.emoji} ${escapeHtml(s.title)} (<a href="${url}">${s.messageCount} сообщений</a>)`;
}

function buildLinkLine(link: { url: string; description: string }): string | null {
  // Defence (T-260507-01): drop any url containing a double-quote — it would
  // break out of the href="..." attribute. We do NOT URI-encode otherwise
  // (Telegram accepts raw URLs in href).
  if (link.url.includes('"')) return null;
  return `<a href="${link.url}">${escapeHtml(link.description)}</a>`;
}

export interface FormatThreadSummaryInput {
  /** All ThreadSummary results from orchestrator (skipped + non-skipped, in any order). */
  summaries: ThreadSummary[];
  /** Cron-fire date (MSK day used in header). */
  date: Date;
  /** Sum of messageCount across non-skipped summaries (orchestrator-computed). */
  totalMessageCount: number;
  /** Deduped {url, description} array across non-skipped summaries (orchestrator-computed). */
  aggregatedLinks: Array<{ url: string; description: string }>;
  /** config.targetChatId, e.g. "-1003096173975". */
  chatId: string;
}

/**
 * Build HTML chunks for the daily thread-summary post.
 * Returns 1+ strings, each ≤ MAX_CHUNK_LENGTH. Splitter never splits mid-section.
 */
export function formatThreadSummaryPost(input: FormatThreadSummaryInput): string[] {
  const { summaries, date, totalMessageCount, aggregatedLinks, chatId } = input;
  const chatIdNoPrefix = stripChatIdPrefix(chatId);
  const headerLine = `📆 Что обсуждалось вчера ${formatHeaderDate(date)}`;

  // Edge case: zero tracked threads → header + footer only.
  if (summaries.length === 0) {
    return [`${headerLine}${SECTION_SEPARATOR}${FOOTER_TAG}`];
  }

  const totalLine = `Всего было написано ${totalMessageCount} сообщений`;

  const nonSkipped = summaries
    .filter((s): s is Extract<ThreadSummary, { skipped: false }> => s.skipped === false)
    .sort((a, b) => b.messageCount - a.messageCount);

  // Edge case: all skipped → header + total + footer only.
  if (nonSkipped.length === 0) {
    return [`${headerLine}\n${totalLine}${SECTION_SEPARATOR}${FOOTER_TAG}`];
  }

  const topicLines = nonSkipped.map((s) => buildTopicLine(s, chatIdNoPrefix));
  const linkLines = aggregatedLinks
    .map(buildLinkLine)
    .filter((l): l is string => l !== null);

  // Build the linear list of "sections" the splitter walks. Header + total
  // form a single bound prefix that is replayed at the start of each chunk.
  // Every other line is a candidate atomic unit that we never split.
  type Section = { kind: 'topic' | 'links-header' | 'link' | 'footer'; text: string };
  const sections: Section[] = [];
  for (const line of topicLines) sections.push({ kind: 'topic', text: line });
  if (linkLines.length > 0) {
    sections.push({ kind: 'links-header', text: 'Интересные ссылки:' });
    for (const line of linkLines) sections.push({ kind: 'link', text: line });
  }
  sections.push({ kind: 'footer', text: FOOTER_TAG });

  const prefix = `${headerLine}\n${totalLine}`;

  const chunks: string[] = [];
  let current = prefix;
  for (const section of sections) {
    const candidate = `${current}${SECTION_SEPARATOR}${section.text}`;
    if (candidate.length <= MAX_CHUNK_LENGTH) {
      current = candidate;
    } else {
      chunks.push(current);
      const fresh = `${prefix}${SECTION_SEPARATOR}${section.text}`;
      if (fresh.length > MAX_CHUNK_LENGTH) {
        // Edge case: a single section alone exceeds the limit. Schema caps
        // title ≤100 and description ≤80, so a single line cannot realistically
        // exceed ~250 chars — but log WARN if it ever happens.
        logger.warn(
          { sectionLength: section.text.length, limit: MAX_CHUNK_LENGTH },
          'Single thread-summary section exceeds MAX_CHUNK_LENGTH — Telegram may reject',
        );
      }
      current = fresh;
    }
  }
  chunks.push(current);
  return chunks;
}
