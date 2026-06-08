// Phase 6 → quick-260507-cni → summary-doc-260607 bullet-substance formatter.
// Pure function: FormatThreadSummaryInput → string[] (HTML chunks ≤ MAX_CHUNK_LENGTH).
// Layout:
//   📆 Что обсуждалось вчера DD.MM.YYYY
//   Всего было написано N сообщений
//   <blank>
//   {emoji} <b>{title}</b>
//   • <a href="https://t.me/c/{chatIdNoPrefix}/{threadId}/{msgId}">{summary}</a>
//   • <a href="...">{summary}</a>
//   <blank>
//   {emoji} <b>{title}</b>                                 # next topic (grouped by thread)
//   • <a href="...">{summary}</a>
//   <blank>
//   Интересные ссылки:                                    # only if aggregatedLinks non-empty
//   <a href="{url}">{description}</a>
//   ... more links ...
//   <blank>
//   #dailysummary
//
// summary-doc-260607 contract change:
// - The clickable text is now the BULLET SUMMARY (the substance), not a
//   "N сообщений" statistic. Each bullet deep-links to its own key message.
// - Topics are kept GROUPED BY THREAD (input order), no cross-thread sort.
//
// Edge cases:
// - Zero summaries (no tracked threads): single chunk with header + footer only.
// - All skipped: single chunk with header + total + footer (no topic blocks).
// - Splitter: block-boundary (a topic block = header + its bullets is atomic);
//   never splits mid-line; footer goes only on last chunk.
//
// Threat-model mitigations (260507-cni, carried forward):
// - T-260507-01: drop links whose url contains `"` (HTML attribute injection guard).
// - T-260507-02: escapeHtml() over title, summary and description (HTML body escapes).

import { logger } from '../../utils/logger.js';
import type { ThreadSummary, Topic } from '../../types/index.js';

type TopicWithThread = Topic & { threadId: number };

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

function msgLink(chatIdNoPrefix: string, threadId: number, msgId: number): string {
  return `https://t.me/c/${chatIdNoPrefix}/${threadId}/${msgId}`;
}

/**
 * Render one topic as a multi-line block: a bold {emoji} {title} header
 * followed by one bullet line per substance point. Each bullet's summary is
 * the clickable deep-link to its key message (code builds the URL — the LLM
 * never emits message links).
 */
function buildTopicBlock(t: TopicWithThread, chatIdNoPrefix: string): string {
  const header = `${t.emoji} <b>${escapeHtml(t.title)}</b>`;
  const bulletLines = t.bullets.map((b) => {
    const url = msgLink(chatIdNoPrefix, t.threadId, b.msgId);
    return `• <a href="${url}">${escapeHtml(b.summary)}</a>`;
  });
  return [header, ...bulletLines].join('\n');
}

function buildLinkLine(link: { url: string; description: string }): string | null {
  // Defence (T-260507-01): drop any url containing a double-quote — it would
  // break out of the href="..." attribute. We do NOT URI-encode otherwise
  // (Telegram accepts raw URLs in href).
  if (link.url.includes('"')) return null;
  return `<a href="${link.url}">${escapeHtml(link.description)}</a>`;
}

export interface FormatThreadSummaryInput {
  /** All ThreadSummary results from orchestrator (skipped + non-skipped, in thread order). */
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
 * Returns 1+ strings, each ≤ MAX_CHUNK_LENGTH. Splitter never splits mid-block.
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

  // summary-doc-260607: flatten summaries → topics PRESERVING thread order.
  // Topics stay grouped by their thread (no cross-thread sort): all of a
  // thread's sub-topics appear consecutively, in the order the LLM returned
  // them.
  const allTopics: TopicWithThread[] = summaries.flatMap(
    (s): TopicWithThread[] =>
      s.skipped ? [] : s.topics.map((t) => ({ ...t, threadId: s.threadId })),
  );

  // Edge case: all skipped (or zero topics, defensive) → header + total + footer only.
  if (allTopics.length === 0) {
    return [`${headerLine}\n${totalLine}${SECTION_SEPARATOR}${FOOTER_TAG}`];
  }

  const topicBlocks = allTopics.map((t) => buildTopicBlock(t, chatIdNoPrefix));
  const linkLines = aggregatedLinks
    .map(buildLinkLine)
    .filter((l): l is string => l !== null);

  // Build the linear list of "sections" the splitter walks. Header + total
  // form a single bound prefix that is replayed at the start of each chunk.
  // Every topic block (header + its bullets) is an atomic unit we never split.
  type Section = { kind: 'topic' | 'links-header' | 'link' | 'footer'; text: string };
  const sections: Section[] = [];
  for (const block of topicBlocks) sections.push({ kind: 'topic', text: block });
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
        // Edge case: a single block alone exceeds the limit. A topic block is
        // ≤100-char title + up to 5 ≤160-char bullets ≈ ≤1.2k chars, so this
        // is not realistically reachable — but log WARN if it ever happens.
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
