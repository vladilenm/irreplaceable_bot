// Phase 6 thread-summary formatter (D-01..D-04, D-35..D-37, DLV-07..09).
// Pure function: ThreadSummary[] + Date → string[] (HTML chunks ≤ MAX_CHUNK_LENGTH).
//
// Layout (D-01 Compact):
//   <b>🧵 Сводки тредов · DD.MM.YYYY</b>
//
//   <b>📄 {threadTitle}</b>
//   <i>{headline}</i>
//   • bullet1
//   • bullet2
//   👥 Маша·Петя·Аня · 💬 23
//   Открытые вопросы:
//   — q1
//   — q2
//
//   <b>📄 {nextThreadTitle}</b>
//   ...
//
//   тихо: N тредов
//
// Sort: by messageCount DESC (D-02). Threads that summarised non-skipped go in body;
// skipped threads (any reason) increment the footer "тихо" counter.
// Empty-digest case (all skipped): publish header + "тихо: N из N" footer (D-35).
// Zero tracked threads: publish header only (no footer — distinct trust signal).

import { normalizeDisplayName } from '../../utils/display-name.js';
import { logger } from '../../utils/logger.js';
import type { ThreadSummary } from '../../types/index.js';

export const MAX_CHUNK_LENGTH = 4096;

// Defence-in-depth HTML escape — Telegram MessageEntity rules require escape on
// any user-controlled text inside an HTML message. Title, headline, bullets,
// participant names, open questions ALL pass through this.
function escapeHtml(input: string): string {
  return input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatHeaderDate(date: Date): string {
  // MSK calendar day, DD.MM.YYYY
  // toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' }) → '29.04.2026'
  return date.toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' });
}

function formatHeader(date: Date): string {
  return `<b>🧵 Сводки тредов · ${formatHeaderDate(date)}</b>`;
}

interface SectionInput {
  title: string; // pre-resolved by orchestrator (real title or fallback "Тред #N")
  summary: Extract<ThreadSummary, { skipped: false }>;
}

function formatSection(input: SectionInput): string {
  const { title, summary } = input;
  const lines: string[] = [];

  // 1. Title line: <b>📄 {threadTitle}</b>
  lines.push(`<b>📄 ${escapeHtml(title)}</b>`);

  // 2. Headline (italics, one line): <i>{headline}</i>
  lines.push(`<i>${escapeHtml(summary.headline)}</i>`);

  // 3. Bullets: • text  (one per line, escape each)
  for (const b of summary.bullets) {
    lines.push(`• ${escapeHtml(b)}`);
  }

  // 4. Participants line: 👥 Name1·Name2·Name3 · 💬 totalMessageCount
  const participantNames = summary.participants
    .slice(0, 3)
    .map((p) => escapeHtml(normalizeDisplayName(p.displayName)))
    .join('·');
  lines.push(`👥 ${participantNames} · 💬 ${summary.messageCount}`);

  // 5. Open questions block (only when non-empty)
  if (summary.openQuestions.length > 0) {
    lines.push('Открытые вопросы:');
    for (const q of summary.openQuestions) {
      lines.push(`— ${escapeHtml(q)}`);
    }
  }

  return lines.join('\n');
}

function formatFooter(skippedCount: number, totalThreads: number): string {
  if (totalThreads === 0) return '';
  // D-35 empty-digest: "тихо: N из N" when ALL threads quiet.
  if (skippedCount === totalThreads) {
    return `тихо: ${skippedCount} из ${totalThreads}`;
  }
  if (skippedCount > 0) {
    // D-08 fixed-form: "тихо: N тредов" — mil-tech idiom, intentional invariable plural.
    // Russian grammar would expect "3 треда" / "5 тредов" — locked verbatim by user (D-08 in CONTEXT.md)
    // because the bot tone is «штурман→пилот, прямой» where fixed military-style telegraphic
    // forms are preferred over grammatical agreement. Do NOT "correct" this to plural-aware
    // wording — that would violate the locked decision.
    return `тихо: ${skippedCount} тредов`;
  }
  return ''; // no skipped → no footer line
}

export interface FormatThreadSummaryInput {
  /** All ThreadSummary results from orchestrator (skipped + non-skipped, in any order). */
  summaries: ThreadSummary[];
  /** Map of threadId → resolved title (orchestrator-built; falls back to "Тред #N"). */
  titles: Map<number, string>;
  /** Cron-fire date (MSK day used in header). */
  date: Date;
}

/**
 * Build HTML chunks for the daily thread-summary post.
 * Returns 1+ strings, each ≤ MAX_CHUNK_LENGTH. Splitter never splits mid-section.
 *
 * Special cases:
 * - Empty summaries[] (no tracked threads): single chunk with header only.
 * - All skipped: single chunk with header + "тихо: N из N" footer.
 * - Mixed: sections sorted by messageCount DESC + footer "тихо: N тредов" if any skipped.
 */
export function formatThreadSummaryPost(input: FormatThreadSummaryInput): string[] {
  const { summaries, titles, date } = input;
  const header = formatHeader(date);

  // Zero tracked threads — header only (D-35-edge: orchestrator may also choose to skip).
  if (summaries.length === 0) {
    return [header];
  }

  // Partition + sort non-skipped by messageCount DESC (D-02).
  const nonSkipped = summaries
    .filter((s): s is Extract<ThreadSummary, { skipped: false }> => s.skipped === false)
    .sort((a, b) => b.messageCount - a.messageCount);
  const skippedCount = summaries.length - nonSkipped.length;

  // Empty-digest D-35: all threads quiet → header + footer only.
  if (nonSkipped.length === 0) {
    const footer = formatFooter(skippedCount, summaries.length);
    return [`${header}\n\n${footer}`];
  }

  // Build per-thread sections.
  const sections: string[] = nonSkipped.map((s) =>
    formatSection({
      title: titles.get(s.threadId) ?? `Тред #${s.threadId}`,
      summary: s,
    }),
  );

  const footer = formatFooter(skippedCount, summaries.length);

  // Greedy section-boundary splitter (D-37).
  // Footer goes into LAST chunk only.
  const chunks: string[] = [];
  let currentChunk = header;
  const SECTION_SEPARATOR = '\n\n';

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i] ?? '';
    const candidate = `${currentChunk}${SECTION_SEPARATOR}${section}`;
    if (candidate.length <= MAX_CHUNK_LENGTH) {
      currentChunk = candidate;
    } else {
      // Emit current chunk, start a new one with this section.
      chunks.push(currentChunk);
      const fresh = `${header}${SECTION_SEPARATOR}${section}`;
      if (fresh.length > MAX_CHUNK_LENGTH) {
        // Edge case: a single section alone exceeds the limit (D-37: log WARN, accept overflow).
        logger.warn(
          { sectionLength: section.length, limit: MAX_CHUNK_LENGTH },
          'Single thread section exceeds MAX_CHUNK_LENGTH — Telegram may reject',
        );
      }
      currentChunk = fresh;
    }
  }

  // Append footer to the LAST chunk (or as its own chunk if appending overflows).
  if (footer !== '') {
    const withFooter = `${currentChunk}${SECTION_SEPARATOR}${footer}`;
    if (withFooter.length <= MAX_CHUNK_LENGTH) {
      currentChunk = withFooter;
    } else {
      chunks.push(currentChunk);
      currentChunk = `${header}${SECTION_SEPARATOR}${footer}`;
    }
  }

  chunks.push(currentChunk);
  return chunks;
}
