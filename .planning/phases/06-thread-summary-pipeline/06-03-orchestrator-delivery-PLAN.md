---
phase: 06-thread-summary-pipeline
plan: 03
type: execute
wave: 2
depends_on: [01, 02]
files_modified:
  - src/modules/thread-summary/thread-summary.service.ts
  - src/modules/thread-summary/thread-summary.formatter.ts
  - src/modules/thread-summary/thread-summary.sender.ts
  - src/scheduler/cron.ts
  - src/modules/thread-summary/thread-summary.formatter.test.ts
  - src/modules/thread-summary/thread-summary.service.test.ts
  - src/modules/thread-summary/thread-summary.sender.test.ts
autonomous: true
requirements:
  - DLV-06
  - DLV-07
  - DLV-08
  - DLV-09
  - DLV-10
tags: [orchestrator, formatter, delivery, telegram, idempotency]
must_haves:
  truths:
    - "06:30 MSK fire publishes ОДИН consolidated HTML post в THREAD_SUMMARY_THREAD_ID, покрывающий все tracked threads с ≥5 messages в 24h окне; threads без активности или low-volume skip оказываются в footer'е `тихо: N тредов` БЕЗ пустых per-thread секций в body (DLV-07, DLV-08)"
    - "Post >4096 chars splits на section boundaries — proven by formatter test с 6 длинными threads, каждый chunk ≤4096, нет сplit mid-section (DLV-09)"
    - "Каждый chunk отправляется через существующий sendMessageWithRetry (НЕ модифицируется; src/utils/telegram.ts unchanged) с single retry on 429"
    - "Double cron fire на одной MSK day → ОДИН post — verified by integration test, который вызывает runThreadSummaryPipeline дважды и проверяет что второй вызов возвращает {alreadyPublished:true} (DLV-10)"
    - "Empty-digest case (все треды low-volume) PUBLISH'ит post с одним footer'ом `тихо: N из N` — proven by formatter test (D-35)"
    - "06:00 MSK digest job ПРОДОЛЖАЕТ работать без regression — verified by passing all existing digest tests AFTER cron.ts стал Map-registry с обоими handlers (success criterion #12)"
    - "Per-thread error isolation: один LLM-fail НЕ обрывает cycle — другой тред summarises, footer counter инкрементируется (D-34)"
    - "thread-summary handler в cron.ts больше НЕ stub — содержит вызов runThreadSummaryPipeline + sendThreadSummary"
    - "Header `🧵 Сводки тредов · DD.MM.YYYY` на MSK calendar day от cron-fire (D-03)"
    - "Sort threads by messageCount DESC (D-02) — самый активный сверху → если split, важное в первом chunk"
    - "Top-3 participants render как `👥 Маша·Петя·Аня · 💬 23` (D-04) — middle-dot separator, БЕЗ @-mentions, escapeHtml на каждом имени"
  artifacts:
    - path: "src/modules/thread-summary/thread-summary.formatter.ts"
      provides: "Pure formatThreadSummaryPost(summaries, date) → string[] — HTML build, sort, escape, footer, splitter"
      exports: ["formatThreadSummaryPost", "MAX_CHUNK_LENGTH"]
      min_lines: 100
    - path: "src/modules/thread-summary/thread-summary.sender.ts"
      provides: "sendThreadSummary(chunks) — iterates chunks, calls existing sendMessageWithRetry per chunk"
      exports: ["sendThreadSummary"]
    - path: "src/modules/thread-summary/thread-summary.service.ts"
      provides: "runThreadSummaryPipeline(opts) — orchestrator"
      exports: ["runThreadSummaryPipeline"]
      min_lines: 150
    - path: "src/scheduler/cron.ts"
      provides: "thread-summary stub REPLACED with real handler"
      contains: "runThreadSummaryPipeline"
  key_links:
    - from: "src/modules/thread-summary/thread-summary.service.ts"
      to: "src/services/summarizer.service.ts (Plan 01)"
      via: "import { summarizeThread }"
      pattern: "from.*summarizer\\.service"
    - from: "src/modules/thread-summary/thread-summary.service.ts"
      to: "src/services/state.service.ts (Plan 02)"
      via: "import isThreadSummaryPublishedToday + readState + writeState"
      pattern: "from.*state\\.service"
    - from: "src/modules/thread-summary/thread-summary.service.ts"
      to: "src/stores/message-store.ts (Plan 02)"
      via: "import selectMessagesInWindow + selectTopParticipants"
      pattern: "from.*message-store"
    - from: "src/modules/thread-summary/thread-summary.service.ts"
      to: "src/stores/tracked-threads-store.ts (Plan 02)"
      via: "import upsertThreadTitle + listTracked"
      pattern: "upsertThreadTitle"
    - from: "src/modules/thread-summary/thread-summary.sender.ts"
      to: "src/utils/telegram.ts"
      via: "sendMessageWithRetry chunk loop — telegram.ts UNCHANGED"
      pattern: "sendMessageWithRetry"
    - from: "src/scheduler/cron.ts"
      to: "src/modules/thread-summary/thread-summary.service.ts"
      via: "thread-summary handler now imports + calls runThreadSummaryPipeline"
      pattern: "runThreadSummaryPipeline"
---

<objective>
Final vertical slice: orchestrator + formatter + sender + cron wiring. Depends on Plan 01 (`summarizeThread`, `normalizeDisplayName`, types) and Plan 02 (`state.service`, `selectMessagesInWindow`, `selectTopParticipants`, `upsertThreadTitle`, `listTracked`, cron registry with thread-summary stub handler ready to swap).

Three deliverables:
1. **thread-summary.formatter.ts** — pure function `formatThreadSummaryPost(summaries, date) → string[]` returning HTML chunks ≤4096 chars each. Sorts by messageCount DESC (D-02), renders compact per-thread sections (D-01), escapes all dynamic fields (D-04, T-06-12 HTML injection guard), prepends header `🧵 Сводки тредов · DD.MM.YYYY` (D-03), appends footer `тихо: N тредов` (DLV-08), greedy section-boundary splitter (DLV-09, D-37). Empty-digest publishes `тихо: N из N` (D-35).
2. **thread-summary.sender.ts** — chunk loop calling existing `sendMessageWithRetry` (D-38). One retry on 429 inherited.
3. **thread-summary.service.ts** — orchestrator `runThreadSummaryPipeline(opts: RunThreadSummaryOptions)`. Idempotency check (D-33 step 1), iterate listTracked, refresh title via getForumTopic with per-thread try/catch (D-06), select messages in window + top participants, call summarizeThread, format, send, update state with merge-write (D-33 step 7).
4. **cron.ts thread-summary handler** — replace stub body with `await sendThreadSummary(await runThreadSummaryPipeline())`. SCHED-04 try/catch already wraps it from Plan 02.

Output: 4 production files (3 new module files + cron.ts handler swap). 3 test files. ~400 LOC net.

**This plan does NOT touch:** `src/services/ai.service.ts`, `src/services/summarizer.service.ts` (Plan 01 sealed), `src/services/state.service.ts` (Plan 02 sealed except for adding `lastThreadSummaryDate` MERGE-write — Plan 02 already wired the field), `src/services/db.service.ts`, any store body (Plan 02 sealed), `src/utils/telegram.ts` (REUSE only), `src/index.ts main()` (already wired in Phase 4).
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/REQUIREMENTS.md
@.planning/STATE.md
@.planning/phases/06-thread-summary-pipeline/06-CONTEXT.md
@.planning/phases/06-thread-summary-pipeline/06-01-summarizer-core-PLAN.md
@.planning/phases/06-thread-summary-pipeline/06-02-state-cron-persistence-PLAN.md
@src/services/summarizer.service.ts
@src/services/state.service.ts
@src/stores/message-store.ts
@src/stores/tracked-threads-store.ts
@src/services/tracking.service.ts
@src/modules/digest/digest.formatter.ts
@src/modules/digest/digest.sender.ts
@src/utils/telegram.ts
@src/utils/display-name.ts
@src/scheduler/cron.ts
@src/types/index.ts
@src/config.ts
@src/bot.ts
@CLAUDE.md

<interfaces>
<!-- All interfaces consumed by this plan are sealed by Plans 01 + 02. Executor uses these directly. -->

From Plan 01 — src/services/summarizer.service.ts:
```ts
export const LOW_VOLUME_THRESHOLD = 5;
export interface SummarizeThreadInput {
  threadId: number;
  windowHours: number;
  messages: CapturedMessage[];
  participants: Array<{ displayName: string; messageCount: number }>;
}
export async function summarizeThread(input: SummarizeThreadInput): Promise<ThreadSummary>;
```

From Plan 01 — src/types/index.ts:
```ts
export type ThreadSummary =
  | { skipped: false; threadId; windowHours; messageCount; headline; bullets; participants; openQuestions }
  | { skipped: true; threadId; windowHours; messageCount; reason: 'low-volume' | 'transcript-too-large' | 'llm-error' | 'schema-invalid' };
export interface RunThreadSummaryOptions { skipIdempotency?: boolean; persistState?: boolean; windowHours?: number }
export interface ThreadSummaryResult { alreadyPublished; threadsSummarised; threadsSkippedLowVolume; threadsSkippedError; totalMessageCount; date; chunks: string[] }
export interface PipelineStateV2 { lastDigestDate; lastSkipped; lastItemCount; lastThreadSummaryDate }
```

From Plan 01 — src/utils/display-name.ts:
```ts
export function normalizeDisplayName(name: string): string;
```

From Plan 02 — src/services/state.service.ts:
```ts
export function readState(): PipelineStateV2;
export function writeState(state: PipelineStateV2): void;
export function isDigestPublishedToday(): boolean;
export function isThreadSummaryPublishedToday(): boolean;
```

From Plan 02 — src/stores/message-store.ts:
```ts
export function selectMessagesInWindow(threadId: number, sinceIso: string): CapturedMessage[];
export interface ParticipantStat { authorName: string; messageCount: number }
export function selectTopParticipants(threadId: number, sinceIso: string, limit?: number): ParticipantStat[];
```

From Plan 02 — src/stores/tracked-threads-store.ts:
```ts
export function listTracked(): TrackedThread[];   // includes title field
export function upsertThreadTitle(threadId: number, title: string): void;
```

From Phase 4 — src/services/tracking.service.ts:
```ts
export function listTrackedThreadIds(): number[];
```

From Phase 4 — src/utils/telegram.ts (DO NOT MODIFY):
```ts
export interface SendMessageParams {
  chatId: string;
  threadId: string;
  text: string;
  parseMode: 'HTML';
}
export async function sendMessageWithRetry(params: SendMessageParams): Promise<void>;
```

From Phase 1 — src/bot.ts:
```ts
export const bot: Bot<Context>;   // grammy bot — has bot.api.getForumTopic
```

From config:
```ts
config.targetChatId           // string (chat where bot lives)
config.threadSummaryThreadId  // string (target thread for summary post)
config.threadSummaryCron      // '30 3 * * *' (06:30 MSK)
```

From Plan 02 — src/scheduler/cron.ts (current stub to REPLACE):
```ts
async function threadSummaryHandler(): Promise<void> {
  logger.warn('thread-summary stub — Plan 06-03 wires real handler');
}
```

From src/modules/digest/digest.formatter.ts (escapeHtml pattern — duplicate inline OR import; CONTEXT D-discretion says either is fine):
```ts
function escapeHtml(input: string): string {
  return input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
```

From src/modules/digest/digest.sender.ts (sender pattern to mirror):
```ts
await sendMessageWithRetry({
  chatId: config.targetChatId,
  threadId: config.aiRadarThreadId,
  text: html,
  parseMode: 'HTML',
});
```

Telegram Bot API — bot.api.getForumTopic signature:
```ts
bot.api.getForumTopic(chatId: number | string, messageThreadId: number): Promise<ForumTopic>;
// ForumTopic = { message_thread_id, name, icon_color, icon_custom_emoji_id? }
```
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: thread-summary.formatter.ts — HTML build, sort, escape, splitter, footer (D-01..D-04, D-36, D-37, DLV-08, DLV-09)</name>
  <files>src/modules/thread-summary/thread-summary.formatter.ts, src/modules/thread-summary/thread-summary.formatter.test.ts</files>
  <read_first>
    - src/modules/digest/digest.formatter.ts (escapeHtml pattern lines 20-22 — duplicate inline; per CONTEXT D-discretion extraction is optional)
    - src/utils/display-name.ts (Plan 01) — normalizeDisplayName for participant names BEFORE HTML render (D-24 SUM-07 second application site)
    - .planning/phases/06-thread-summary-pipeline/06-CONTEXT.md §D-01..D-04, §D-35, §D-36, §D-37 (layout, sort, splitter)
    - src/types/index.ts — ThreadSummary discriminated union (Plan 01)
  </read_first>
  <behavior>
    - Test F1 (header + date): formatThreadSummaryPost([], new Date('2026-04-29T03:30:00Z')) — output[0] starts with '<b>🧵 Сводки тредов · 29.04.2026</b>' (MSK day = 29 Apr; cron-fire UTC 03:30 = MSK 06:30 same day)
    - Test F2 (sort by messageCount DESC): two threads with msgCount 10 and 50 — section for msgCount=50 appears BEFORE section for msgCount=10
    - Test F3 (compact layout): non-skipped section contains in order: `<b>📄 {title}</b>`, `<i>{headline}</i>`, bullets each `• {bullet}`, participants line `👥 {names} · 💬 {N}`, optional `Открытые вопросы:` block. NO labels "Главное:" / "Пункты:".
    - Test F4 (HTML escape — title): summary with title='<script>alert(1)</script>' renders `&lt;script&gt;alert(1)&lt;/script&gt;` in output, NEVER raw `<script>`
    - Test F5 (HTML escape — bullet): summary with bullet='Маша & Петя <kek>' renders `Маша &amp; Петя &lt;kek&gt;`
    - Test F6 (participant render): participants=[{displayName:'Маша', messageCount:10}, {displayName:'Петя', messageCount:5}, {displayName:'Аня', messageCount:3}] + total messageCount=18 renders `👥 Маша·Петя·Аня · 💬 18`
    - Test F7 (Unicode normalisation in participants): displayName='Ма​ша' (zero-width inside) → renders as 'Маша'
    - Test F8 (footer counts): 5 summaries — 2 with skipped:true reason 'low-volume', 1 with skipped:true reason 'llm-error', 2 non-skipped → footer reads `тихо: 3 тредов` (low-volume + llm-error both count as quiet per CONTEXT-d-default; OR can be split — test enforces ONE counter `тихо: 3` per current spec)
    - Test F9 (empty-digest D-35): all 4 summaries skipped (4 low-volume) → output has 1 chunk with header + footer `тихо: 4 из 4`
    - Test F10 (zero tracked threads): formatThreadSummaryPost([], date) — output has 1 chunk with just header (no body, no footer counter — special-case empty array distinct from "all skipped")
    - Test F11 (splitter — long output): 6 threads each with 6 long bullets totalling >4096 chars → output is multiple chunks; EACH chunk ≤4096; concatenating chunks contains all sections; NO mid-section split
    - Test F12 (splitter — single oversized section): one summary with 6 bullets each 1500 chars (section ~9000 chars alone) → output has 1 chunk that contains the entire section (overflow accepted with WARN log per D-37 edge case); Telegram will reject — but formatter does its best
    - Test F13 (open questions optional): summary with openQuestions=[] → output does NOT contain 'Открытые вопросы:' block; summary with openQuestions=['кто решает?'] → output contains 'Открытые вопросы:' AND `— кто решает?`
    - Test F14 (idempotent escape on title fallback): when summary has no title resolved (orchestrator fell back), formatter receives `Тред #100` — renders without escape error
  </behavior>
  <action>
1. **src/modules/thread-summary/thread-summary.formatter.ts** (NEW FILE) — paste exactly:

```ts
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
  title: string;             // pre-resolved by orchestrator (real title or fallback "Тред #N")
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
```

2. **src/modules/thread-summary/thread-summary.formatter.test.ts** (NEW FILE) — write tests F1-F14:

```ts
import { describe, it, expect } from 'vitest';
import { formatThreadSummaryPost, MAX_CHUNK_LENGTH } from './thread-summary.formatter.js';
import type { ThreadSummary } from '../../types/index.js';

const ok = (over: Partial<Extract<ThreadSummary, { skipped: false }>>): ThreadSummary => ({
  skipped: false,
  threadId: 100,
  windowHours: 24,
  messageCount: 10,
  headline: 'Обсуждали оркестратор',
  bullets: ['обсуждали A', 'обсуждали B'],
  participants: [{ displayName: 'Маша', messageCount: 5 }],
  openQuestions: [],
  ...over,
});

const skip = (reason: 'low-volume' | 'transcript-too-large' | 'llm-error' | 'schema-invalid', threadId = 100): ThreadSummary => ({
  skipped: true, threadId, windowHours: 24, messageCount: reason === 'low-volume' ? 2 : 0, reason,
});

describe('formatThreadSummaryPost layout (D-01..D-04, D-36)', () => {
  it('F1: header contains MSK calendar day DD.MM.YYYY', () => {
    const out = formatThreadSummaryPost({ summaries: [], titles: new Map(), date: new Date('2026-04-29T03:30:00Z') });
    expect(out[0]).toContain('🧵 Сводки тредов · 29.04.2026');
    expect(out[0]).toMatch(/^<b>🧵 Сводки тредов · 29\.04\.2026<\/b>/);
  });

  it('F2: threads sorted by messageCount DESC', () => {
    const summaries: ThreadSummary[] = [
      ok({ threadId: 1, messageCount: 10, headline: 'low' }),
      ok({ threadId: 2, messageCount: 50, headline: 'high' }),
    ];
    const titles = new Map([[1, 'LowThread'], [2, 'HighThread']]);
    const out = formatThreadSummaryPost({ summaries, titles, date: new Date('2026-04-29T03:30:00Z') });
    const text = out.join('\n');
    expect(text.indexOf('HighThread')).toBeLessThan(text.indexOf('LowThread'));
  });

  it('F3: compact layout — title, italic headline, bullets, participants line, no labels', () => {
    const summaries = [ok({ headline: 'Обсуждали X', bullets: ['а', 'б'], participants: [{ displayName: 'М', messageCount: 5 }], messageCount: 5 })];
    const titles = new Map([[100, 'Тестовый']]);
    const out = formatThreadSummaryPost({ summaries, titles, date: new Date() }).join('\n');
    expect(out).toContain('<b>📄 Тестовый</b>');
    expect(out).toContain('<i>Обсуждали X</i>');
    expect(out).toContain('• а');
    expect(out).toContain('• б');
    expect(out).toContain('👥 М · 💬 5');
    expect(out).not.toContain('Главное:');
    expect(out).not.toContain('Пункты:');
  });

  it('F4: title with HTML special chars is escaped', () => {
    const summaries = [ok({})];
    const titles = new Map([[100, '<script>alert(1)</script>']]);
    const out = formatThreadSummaryPost({ summaries, titles, date: new Date() }).join('\n');
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(out).not.toContain('<script>alert(1)</script>');
  });

  it('F5: bullet with & and < is escaped', () => {
    const summaries = [ok({ bullets: ['Маша & Петя <kek>'] })];
    const out = formatThreadSummaryPost({ summaries, titles: new Map([[100, 'T']]), date: new Date() }).join('\n');
    expect(out).toContain('Маша &amp; Петя &lt;kek&gt;');
  });

  it('F6: participants render with middle-dot separator', () => {
    const summaries = [ok({
      participants: [
        { displayName: 'Маша', messageCount: 10 },
        { displayName: 'Петя', messageCount: 5 },
        { displayName: 'Аня', messageCount: 3 },
      ],
      messageCount: 18,
    })];
    const out = formatThreadSummaryPost({ summaries, titles: new Map([[100, 'T']]), date: new Date() }).join('\n');
    expect(out).toContain('👥 Маша·Петя·Аня · 💬 18');
  });

  it('F7: participant displayName Unicode-normalised before render', () => {
    const summaries = [ok({ participants: [{ displayName: 'Ма​ша', messageCount: 1 }], messageCount: 1 })];
    const out = formatThreadSummaryPost({ summaries, titles: new Map([[100, 'T']]), date: new Date() }).join('\n');
    expect(out).toContain('Маша');
    expect(out).not.toContain('Ма​ша');
  });

  it('F8: footer with mixed skipped — `тихо: N тредов`', () => {
    const summaries: ThreadSummary[] = [
      ok({ threadId: 1, messageCount: 10 }),
      ok({ threadId: 2, messageCount: 8 }),
      skip('low-volume', 3),
      skip('low-volume', 4),
      skip('llm-error', 5),
    ];
    const titles = new Map([[1, 'T1'], [2, 'T2']]);
    const out = formatThreadSummaryPost({ summaries, titles, date: new Date() }).join('\n');
    expect(out).toContain('тихо: 3 тредов');
  });

  it('F9: empty-digest — all skipped → `тихо: N из N` (D-35)', () => {
    const summaries = [skip('low-volume', 1), skip('low-volume', 2), skip('low-volume', 3), skip('low-volume', 4)];
    const out = formatThreadSummaryPost({ summaries, titles: new Map(), date: new Date() });
    expect(out.length).toBe(1);
    expect(out[0]).toContain('тихо: 4 из 4');
  });

  it('F10: zero tracked threads → header only', () => {
    const out = formatThreadSummaryPost({ summaries: [], titles: new Map(), date: new Date() });
    expect(out.length).toBe(1);
    expect(out[0]).toMatch(/^<b>🧵 Сводки тредов/);
    expect(out[0]).not.toContain('тихо:');
  });

  it('F11: splitter — multi-chunk, each ≤ MAX_CHUNK_LENGTH, no mid-section split', () => {
    // Build 6 sections each ~800 chars → header + 6*~810 = ~4900 → must split into 2 chunks.
    const longBullet = 'а'.repeat(120);
    const summaries: ThreadSummary[] = Array.from({ length: 6 }, (_, i) => ok({
      threadId: i + 1,
      messageCount: 100 - i,  // ensures sort order matches creation order
      headline: 'Обсуждали тему '.repeat(3).trim(),
      bullets: [longBullet, longBullet, longBullet, longBullet, longBullet, longBullet],
      participants: [{ displayName: `User${i}`, messageCount: 5 }],
    }));
    const titles = new Map(Array.from({ length: 6 }, (_, i) => [i + 1, `Thread${i + 1}`] as const));
    const chunks = formatThreadSummaryPost({ summaries, titles, date: new Date() });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(MAX_CHUNK_LENGTH);
    }
    // Concatenated chunks contain all 6 thread titles.
    const all = chunks.join('\n');
    for (let i = 1; i <= 6; i++) {
      expect(all).toContain(`Thread${i}`);
    }
  });

  it('F13: open questions block conditional', () => {
    const withOQ = [ok({ openQuestions: ['кто решает?'] })];
    const withoutOQ = [ok({ openQuestions: [] })];
    const titles = new Map([[100, 'T']]);
    const date = new Date();
    const oOut = formatThreadSummaryPost({ summaries: withOQ, titles, date }).join('\n');
    const noOut = formatThreadSummaryPost({ summaries: withoutOQ, titles, date }).join('\n');
    expect(oOut).toContain('Открытые вопросы:');
    expect(oOut).toContain('— кто решает?');
    expect(noOut).not.toContain('Открытые вопросы:');
  });

  it('F14: missing title in titles Map → fallback "Тред #N"', () => {
    const summaries = [ok({ threadId: 999 })];
    const titles = new Map<number, string>(); // empty
    const out = formatThreadSummaryPost({ summaries, titles, date: new Date() }).join('\n');
    expect(out).toContain('Тред #999');
  });
});
```
  </action>
  <verify>
    <automated>npm run typecheck 2>&1 | tail -5 && npm test -- thread-summary.formatter 2>&1 | tail -30</automated>
  </verify>
  <acceptance_criteria>
    - `test -d src/modules/thread-summary` (directory created)
    - `test -f src/modules/thread-summary/thread-summary.formatter.ts`
    - `grep -q "MAX_CHUNK_LENGTH = 4096" src/modules/thread-summary/thread-summary.formatter.ts`
    - `grep -q "export function formatThreadSummaryPost" src/modules/thread-summary/thread-summary.formatter.ts`
    - `grep -q "🧵 Сводки тредов" src/modules/thread-summary/thread-summary.formatter.ts` (header — D-03)
    - `grep -q "📄" src/modules/thread-summary/thread-summary.formatter.ts` (per-thread title prefix — D-01)
    - `grep -q "тихо:" src/modules/thread-summary/thread-summary.formatter.ts` (footer — DLV-08)
    - `grep -q "тихо: \\${skippedCount} из" src/modules/thread-summary/thread-summary.formatter.ts` OR `grep -q "из \\${totalThreads}" src/modules/thread-summary/thread-summary.formatter.ts` (D-35 empty-digest)
    - `grep -q "messageCount.*-.*messageCount\\|b.messageCount - a.messageCount" src/modules/thread-summary/thread-summary.formatter.ts` (sort by msg count DESC — D-02)
    - `grep -q "escapeHtml" src/modules/thread-summary/thread-summary.formatter.ts` (HTML escape — DLV-08)
    - `grep -q "normalizeDisplayName" src/modules/thread-summary/thread-summary.formatter.ts` (D-24 second application site)
    - `grep -q "Открытые вопросы:" src/modules/thread-summary/thread-summary.formatter.ts` (D-11)
    - `grep -q "Тред #" src/modules/thread-summary/thread-summary.formatter.ts` (title fallback — D-06)
    - `grep -q "fixed-form" src/modules/thread-summary/thread-summary.formatter.ts` (Issue 6: D-08 invariable plural "тихо: N тредов" is intentional, source-commented to prevent well-meaning grammatical "fixes" by future executors/reviewers)
    - `npm run typecheck` exits 0
    - `npm test -- thread-summary.formatter` exits 0 with all 13+ formatter tests passing
  </acceptance_criteria>
  <done>Formatter pure-function builds compact layout with sort, escape, header, footer, splitter; empty-digest publishes header + "тихо: N из N"; zero tracked threads publishes header only; chunks ≤4096 split on section boundary.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: thread-summary.sender.ts (chunk loop) + thread-summary.service.ts orchestrator</name>
  <files>src/modules/thread-summary/thread-summary.sender.ts, src/modules/thread-summary/thread-summary.service.ts, src/modules/thread-summary/thread-summary.service.test.ts, src/modules/thread-summary/thread-summary.sender.test.ts</files>
  <read_first>
    - src/modules/digest/digest.sender.ts (one-shot pattern — sender mirrors with chunk loop)
    - src/utils/telegram.ts (sendMessageWithRetry signature — REUSE only, do not modify)
    - src/modules/thread-summary/thread-summary.formatter.ts (just-built — orchestrator imports formatThreadSummaryPost)
    - src/services/summarizer.service.ts (Plan 01 — orchestrator imports summarizeThread + LOW_VOLUME_THRESHOLD)
    - src/services/state.service.ts (Plan 02 — readState + writeState + isThreadSummaryPublishedToday)
    - src/stores/message-store.ts (Plan 02 — selectMessagesInWindow + selectTopParticipants)
    - src/stores/tracked-threads-store.ts (Plan 02 — listTracked + upsertThreadTitle)
    - src/services/tracking.service.ts (Phase 4 — listTrackedThreadIds)
    - src/bot.ts (bot.api.getForumTopic available)
    - .planning/phases/06-thread-summary-pipeline/06-CONTEXT.md §D-32, §D-33, §D-34, §D-35, §D-38 (orchestrator algorithm)
  </read_first>
  <behavior>
    - Test O1 (idempotency): runThreadSummaryPipeline() called when isThreadSummaryPublishedToday()=true → returns {alreadyPublished:true, threadsSummarised:0, ...}, NO summarizeThread call, NO send
    - Test O2 (skipIdempotency): runThreadSummaryPipeline({skipIdempotency:true}) when published-today=true → still runs full pipeline (Phase 7 /dev-summary precondition)
    - Test O3 (zero tracked threads): listTrackedThreadIds returns [] → orchestrator returns result with threadsSummarised:0, but DOES publish header-only post (D-35-edge)
    - Test O4 (per-thread error isolation D-34): 3 threads — thread 1 LLM throws, thread 2 succeeds, thread 3 succeeds → result has threadsSummarised:2, threadsSkippedError:1, no abort, threads 2+3 still in body
    - Test O5 (state merge-write D-33 step 7): runThreadSummaryPipeline() with persistState:true does NOT clobber existing lastDigestDate field — verified by reading state before+after
    - Test O6 (windowHours override): runThreadSummaryPipeline({windowHours:48}) passes 48 to selectMessagesInWindow + summarizeThread
    - Test O7 (getForumTopic refresh D-06): orchestrator calls bot.api.getForumTopic per tracked thread, upserts title, AND falls back to cached/default on API failure (does NOT throw)
    - Test S1 (sender): sendThreadSummary(['chunk1', 'chunk2']) calls sendMessageWithRetry exactly twice with config.targetChatId + config.threadSummaryThreadId
    - Test S2 (sender empty): sendThreadSummary([]) does NOT call sendMessageWithRetry (no-op)
    - Test S3 (corrupt state): readState throws (corrupt JSON) → orchestrator catches, returns {alreadyPublished:false, threadsSummarised:0, ...} with ERROR log; does NOT publish
  </behavior>
  <action>
1. **src/modules/thread-summary/thread-summary.sender.ts** (NEW FILE):

```ts
// Phase 6 thread-summary sender (D-38, DLV-09).
// Iterates chunks; each chunk shipped via existing sendMessageWithRetry
// (single retry on 429 inherited; src/utils/telegram.ts UNCHANGED).
import { sendMessageWithRetry } from '../../utils/telegram.js';
import { config } from '../../config.js';
import { logger } from '../../utils/logger.js';

/**
 * Send thread-summary HTML chunks to THREAD_SUMMARY_THREAD_ID.
 * No-op for empty array. Per-chunk send is sequential (avoids burst rate-limit).
 */
export async function sendThreadSummary(chunks: string[]): Promise<void> {
  if (chunks.length === 0) {
    logger.debug('sendThreadSummary: zero chunks, skipping');
    return;
  }
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (chunk === undefined || chunk === '') continue;
    await sendMessageWithRetry({
      chatId: config.targetChatId,
      threadId: config.threadSummaryThreadId,
      text: chunk,
      parseMode: 'HTML',
    });
    logger.info(
      { chunkIndex: i + 1, chunkCount: chunks.length, chunkLength: chunk.length },
      'Thread-summary chunk sent',
    );
  }
}
```

2. **src/modules/thread-summary/thread-summary.service.ts** (NEW FILE):

```ts
// Phase 6 orchestrator (D-32..D-35, DLV-06, DLV-07, DLV-10).
// Pulls together: tracking whitelist + DB queries + summarizer + formatter + state.
// Per-thread try/catch (D-34) — one LLM error doesn't abort cycle.
// Title-refresh via getForumTopic with per-thread try/catch (D-06).
// Sliding 24h window from cron-fire (CONTEXT "Window semantics" Claude's Discretion).

import { bot } from '../../bot.js';
import { logger } from '../../utils/logger.js';
import { listTrackedThreadIds } from '../../services/tracking.service.js';
import { listTracked, upsertThreadTitle } from '../../stores/tracked-threads-store.js';
import {
  selectMessagesInWindow,
  selectTopParticipants,
} from '../../stores/message-store.js';
import { summarizeThread } from '../../services/summarizer.service.js';
import {
  readState,
  writeState,
  isThreadSummaryPublishedToday,
} from '../../services/state.service.js';
import { formatThreadSummaryPost } from './thread-summary.formatter.js';
import { config } from '../../config.js';
import type {
  RunThreadSummaryOptions,
  ThreadSummary,
  ThreadSummaryResult,
} from '../../types/index.js';

const DEFAULT_WINDOW_HOURS = 24;

function nowMinusHoursIso(hours: number): string {
  return new Date(Date.now() - hours * 3600 * 1000).toISOString();
}

async function refreshThreadTitle(threadId: number): Promise<string> {
  // D-06: 1 API call per thread per day. Per-thread try/catch — never blocks cycle.
  // On failure: read cached title from listTracked() snapshot or fall back to "Тред #N".
  try {
    const topic = await bot.api.getForumTopic(config.targetChatId, threadId);
    if (topic.name) {
      upsertThreadTitle(threadId, topic.name);
      return topic.name;
    }
  } catch (err: unknown) {
    logger.warn({ err, threadId }, 'getForumTopic failed, falling back to cached title');
  }
  // Fallback: cached title from DB or generic.
  const cached = listTracked().find((t) => t.threadId === threadId)?.title;
  return cached ?? `Тред #${threadId}`;
}

function emptyResult(alreadyPublished: boolean): ThreadSummaryResult {
  return {
    alreadyPublished,
    threadsSummarised: 0,
    threadsSkippedLowVolume: 0,
    threadsSkippedError: 0,
    totalMessageCount: 0,
    date: new Date(),
    chunks: [],
  };
}

export async function runThreadSummaryPipeline(
  opts: RunThreadSummaryOptions = {},
): Promise<ThreadSummaryResult> {
  const skipIdempotency = opts.skipIdempotency ?? false;
  const persistState = opts.persistState ?? true;
  const windowHours = opts.windowHours ?? DEFAULT_WINDOW_HOURS;

  // D-33 step 1: idempotency. State read may throw (STATE-02 — corrupt JSON);
  // outer cron-handler try/catch from Plan 02 logs ERROR and skips publish.
  // We catch here too so the pipeline returns a meaningful result instead of throwing.
  let prevState;
  try {
    prevState = readState();
  } catch (err: unknown) {
    logger.error({ err }, 'runThreadSummaryPipeline: state read failed (corrupt state.json), publish blocked');
    return emptyResult(false);
  }

  if (!skipIdempotency && isThreadSummaryPublishedToday()) {
    logger.warn(
      { lastThreadSummaryDate: prevState.lastThreadSummaryDate },
      'Thread-summary already published today (MSK), skipping',
    );
    return emptyResult(true);
  }

  const sinceIso = nowMinusHoursIso(windowHours);
  const threadIds = listTrackedThreadIds();
  logger.info(
    { threadCount: threadIds.length, windowHours, sinceIso, skipIdempotency, persistState },
    'Starting thread-summary pipeline',
  );

  const summaries: ThreadSummary[] = [];
  const titles = new Map<number, string>();
  let threadsSummarised = 0;
  let threadsSkippedLowVolume = 0;
  let threadsSkippedError = 0;
  let totalMessageCount = 0;

  for (const threadId of threadIds) {
    // Per-thread try/catch (D-34) — one fail doesn't abort cycle.
    try {
      const title = await refreshThreadTitle(threadId);
      titles.set(threadId, title);

      const messages = selectMessagesInWindow(threadId, sinceIso);
      const participants = selectTopParticipants(threadId, sinceIso, 3).map((p) => ({
        displayName: p.authorName,
        messageCount: p.messageCount,
      }));

      const summary = await summarizeThread({ threadId, windowHours, messages, participants });
      summaries.push(summary);

      if (summary.skipped) {
        if (summary.reason === 'low-volume') {
          threadsSkippedLowVolume++;
        } else {
          threadsSkippedError++;
        }
      } else {
        threadsSummarised++;
        totalMessageCount += summary.messageCount;
      }
    } catch (err: unknown) {
      logger.error({ err, threadId }, 'Per-thread summary failed, isolating');
      summaries.push({
        skipped: true,
        threadId,
        windowHours,
        messageCount: 0,
        reason: 'llm-error',
      });
      threadsSkippedError++;
    }
  }

  const date = new Date();
  const chunks = formatThreadSummaryPost({ summaries, titles, date });

  // D-33 step 7: merge-write — preserve digest fields.
  if (persistState) {
    writeState({
      ...prevState,
      lastThreadSummaryDate: date.toISOString(),
    });
  }

  logger.info(
    {
      event: 'thread-summary-pipeline-complete',
      threadsSummarised,
      threadsSkippedLowVolume,
      threadsSkippedError,
      totalMessageCount,
      chunkCount: chunks.length,
    },
    'Thread-summary pipeline complete',
  );

  return {
    alreadyPublished: false,
    threadsSummarised,
    threadsSkippedLowVolume,
    threadsSkippedError,
    totalMessageCount,
    date,
    chunks,
  };
}
```

3. **src/modules/thread-summary/thread-summary.service.test.ts** (NEW FILE) — orchestrator tests with mocked dependencies. Use `vi.mock` to stub state, summarizer, stores, and bot.api.getForumTopic. Cover O1-O7, S1-S3:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ThreadSummary, PipelineStateV2, CapturedMessage } from '../../types/index.js';

// Mock factories — must be set BEFORE the SUT is imported.
const mockState: { current: PipelineStateV2 } = {
  current: { lastDigestDate: null, lastSkipped: false, lastItemCount: 0, lastThreadSummaryDate: null },
};
const mockReadState = vi.fn(() => mockState.current);
const mockWriteState = vi.fn((s: PipelineStateV2) => { mockState.current = s; });
const mockIsThreadSummaryPublishedToday = vi.fn(() => false);
const mockListTrackedThreadIds = vi.fn(() => [100, 200, 300]);
const mockListTracked = vi.fn(() => [
  { threadId: 100, chatId: -1, addedBy: null, addedAt: '', title: 'Cached100' },
  { threadId: 200, chatId: -1, addedBy: null, addedAt: '', title: null },
  { threadId: 300, chatId: -1, addedBy: null, addedAt: '', title: null },
]);
const mockUpsertThreadTitle = vi.fn();
const mockSelectMessagesInWindow = vi.fn(() => [] as CapturedMessage[]);
const mockSelectTopParticipants = vi.fn(() => [] as Array<{ authorName: string; messageCount: number }>);
const mockSummarizeThread = vi.fn();
const mockGetForumTopic = vi.fn();

vi.mock('../../services/state.service.js', () => ({
  readState: mockReadState,
  writeState: mockWriteState,
  isThreadSummaryPublishedToday: mockIsThreadSummaryPublishedToday,
}));
vi.mock('../../services/tracking.service.js', () => ({
  listTrackedThreadIds: mockListTrackedThreadIds,
}));
vi.mock('../../stores/tracked-threads-store.js', () => ({
  listTracked: mockListTracked,
  upsertThreadTitle: mockUpsertThreadTitle,
}));
vi.mock('../../stores/message-store.js', () => ({
  selectMessagesInWindow: mockSelectMessagesInWindow,
  selectTopParticipants: mockSelectTopParticipants,
}));
vi.mock('../../services/summarizer.service.js', () => ({
  summarizeThread: mockSummarizeThread,
}));
vi.mock('../../bot.js', () => ({
  bot: {
    api: { getForumTopic: mockGetForumTopic },
  },
}));

import { runThreadSummaryPipeline } from './thread-summary.service.js';

const okSummary = (threadId: number, mc = 10): ThreadSummary => ({
  skipped: false, threadId, windowHours: 24, messageCount: mc,
  headline: 'h', bullets: ['b'], participants: [], openQuestions: [],
});

beforeEach(() => {
  mockState.current = { lastDigestDate: null, lastSkipped: false, lastItemCount: 0, lastThreadSummaryDate: null };
  mockReadState.mockClear();
  mockWriteState.mockClear();
  mockIsThreadSummaryPublishedToday.mockReturnValue(false);
  mockListTrackedThreadIds.mockReturnValue([100, 200, 300]);
  mockUpsertThreadTitle.mockClear();
  mockSelectMessagesInWindow.mockReturnValue([]);
  mockSelectTopParticipants.mockReturnValue([]);
  mockSummarizeThread.mockReset();
  mockGetForumTopic.mockReset();
  mockGetForumTopic.mockResolvedValue({ message_thread_id: 100, name: 'Topic' });
});

describe('runThreadSummaryPipeline (DLV-06, DLV-10, D-32..D-35)', () => {
  it('O1: idempotency — already-published-today returns alreadyPublished:true and skips work', async () => {
    mockIsThreadSummaryPublishedToday.mockReturnValue(true);
    mockState.current = { ...mockState.current, lastThreadSummaryDate: new Date().toISOString() };
    const r = await runThreadSummaryPipeline();
    expect(r.alreadyPublished).toBe(true);
    expect(r.threadsSummarised).toBe(0);
    expect(mockSummarizeThread).not.toHaveBeenCalled();
  });

  it('O2: skipIdempotency:true bypasses idempotency gate', async () => {
    mockIsThreadSummaryPublishedToday.mockReturnValue(true);
    mockSummarizeThread.mockImplementation((input: { threadId: number }) => Promise.resolve(okSummary(input.threadId, 5)));
    mockSelectMessagesInWindow.mockReturnValue(Array(5).fill({}) as CapturedMessage[]);
    const r = await runThreadSummaryPipeline({ skipIdempotency: true });
    expect(r.alreadyPublished).toBe(false);
    expect(mockSummarizeThread).toHaveBeenCalledTimes(3);
  });

  it('O3: zero tracked threads → returns 0 counts but DOES build chunks (header-only)', async () => {
    mockListTrackedThreadIds.mockReturnValue([]);
    const r = await runThreadSummaryPipeline();
    expect(r.threadsSummarised).toBe(0);
    expect(r.chunks.length).toBe(1); // header-only
    expect(r.chunks[0]).toContain('🧵 Сводки тредов');
  });

  it('O4: per-thread error isolation (D-34) — one fail does not abort', async () => {
    mockSummarizeThread.mockImplementation(async (input: { threadId: number }) => {
      if (input.threadId === 100) throw new Error('LLM down');
      return okSummary(input.threadId, 5);
    });
    const r = await runThreadSummaryPipeline();
    expect(r.threadsSummarised).toBe(2);
    expect(r.threadsSkippedError).toBe(1);
  });

  it('O5: state merge-write preserves lastDigestDate', async () => {
    mockState.current = { lastDigestDate: '2026-04-29T06:00:00.000Z', lastSkipped: false, lastItemCount: 5, lastThreadSummaryDate: null };
    mockSummarizeThread.mockResolvedValue(okSummary(100, 5));
    await runThreadSummaryPipeline();
    expect(mockWriteState).toHaveBeenCalledTimes(1);
    const written = mockWriteState.mock.calls[0]?.[0];
    expect(written?.lastDigestDate).toBe('2026-04-29T06:00:00.000Z');
    expect(written?.lastThreadSummaryDate).not.toBeNull();
  });

  it('O6: windowHours override propagates to summarizeThread input', async () => {
    mockSummarizeThread.mockResolvedValue(okSummary(100, 1));
    await runThreadSummaryPipeline({ windowHours: 48 });
    const call = mockSummarizeThread.mock.calls[0]?.[0];
    expect(call?.windowHours).toBe(48);
  });

  it('O7: getForumTopic failure does NOT throw — fallback used', async () => {
    mockGetForumTopic.mockRejectedValue(new Error('Telegram API down'));
    mockSummarizeThread.mockResolvedValue(okSummary(100, 5));
    const r = await runThreadSummaryPipeline();
    expect(r.threadsSummarised).toBe(3); // not aborted
  });

  it('S3: corrupt state read → returns empty result, blocks publish', async () => {
    mockReadState.mockImplementation(() => { throw new Error('State file corrupted at /x: bad'); });
    const r = await runThreadSummaryPipeline();
    expect(r.alreadyPublished).toBe(false);
    expect(r.threadsSummarised).toBe(0);
    expect(r.chunks.length).toBe(0);
    expect(mockSummarizeThread).not.toHaveBeenCalled();
  });
});

// NOTE: sendThreadSummary tests S1/S2 live in their OWN file
// `src/modules/thread-summary/thread-summary.sender.test.ts` (created in this same task).
// Issue 5 from plan-checker: a per-file `vi.mock('../../utils/telegram.js', ...)` factory
// is scoped to the importing test file ONLY — using top-level vi.mock here AND in the
// service test file would cause cross-file factory pollution. Separating them makes the
// mock factory explicit per file, with no dynamic import + no flakiness.
```

3. **src/modules/thread-summary/thread-summary.sender.test.ts** (NEW FILE) — sender chunk-loop tests S1, S2 in their own file with a top-level static `vi.mock('../../utils/telegram.js', ...)`. No dynamic imports, no `vi.doMock`/`vi.doUnmock` dance.

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSendMessageWithRetry = vi.fn();

vi.mock('../../utils/telegram.js', () => ({
  sendMessageWithRetry: mockSendMessageWithRetry,
}));

// Static import — the vi.mock factory above runs BEFORE this resolves (vitest hoists).
import { sendThreadSummary } from './thread-summary.sender.js';

describe('sendThreadSummary chunks loop (DLV-09, D-38)', () => {
  beforeEach(() => {
    mockSendMessageWithRetry.mockReset();
  });

  it('S1: iterates chunks and calls sendMessageWithRetry per chunk', async () => {
    await sendThreadSummary(['c1', 'c2']);
    expect(mockSendMessageWithRetry).toHaveBeenCalledTimes(2);
    // First call payload — chunk c1 → threadSummaryThreadId
    const firstCall = mockSendMessageWithRetry.mock.calls[0]?.[0];
    expect(firstCall?.text).toBe('c1');
    expect(firstCall?.parseMode).toBe('HTML');
  });

  it('S2: empty array no-op', async () => {
    await sendThreadSummary([]);
    expect(mockSendMessageWithRetry).not.toHaveBeenCalled();
  });

  it('S2b: empty-string chunks are skipped (defensive)', async () => {
    await sendThreadSummary(['c1', '', 'c3']);
    expect(mockSendMessageWithRetry).toHaveBeenCalledTimes(2);
  });
});
```
  </action>
  <verify>
    <automated>npm run typecheck 2>&1 | tail -5 && npm test -- thread-summary 2>&1 | tail -30</automated>
  </verify>
  <acceptance_criteria>
    - `test -f src/modules/thread-summary/thread-summary.sender.ts`
    - `grep -q "sendMessageWithRetry" src/modules/thread-summary/thread-summary.sender.ts` (reuse — DLV-09)
    - `grep -q "config.threadSummaryThreadId" src/modules/thread-summary/thread-summary.sender.ts` (target thread)
    - `! grep -q "function sendMessageWithRetry" src/modules/thread-summary/thread-summary.sender.ts` (NOT redefined — telegram.ts unchanged)
    - `test -f src/modules/thread-summary/thread-summary.service.ts`
    - `grep -q "export.*runThreadSummaryPipeline" src/modules/thread-summary/thread-summary.service.ts`
    - `grep -q "isThreadSummaryPublishedToday" src/modules/thread-summary/thread-summary.service.ts` (DLV-10 idempotency)
    - `grep -q "summarizeThread" src/modules/thread-summary/thread-summary.service.ts` (Plan 01 dependency)
    - `grep -q "selectMessagesInWindow\\|selectTopParticipants" src/modules/thread-summary/thread-summary.service.ts` (Plan 02 stores)
    - `grep -q "upsertThreadTitle\\|getForumTopic" src/modules/thread-summary/thread-summary.service.ts` (D-06 title refresh)
    - `grep -q "for (const threadId of threadIds)" src/modules/thread-summary/thread-summary.service.ts` (whitelist iteration)
    - `grep -q "try {" src/modules/thread-summary/thread-summary.service.ts` AND `grep -q "Per-thread summary failed" src/modules/thread-summary/thread-summary.service.ts` (D-34 per-thread isolation)
    - `grep -q "...prevState" src/modules/thread-summary/thread-summary.service.ts` OR `grep -q "...prev" src/modules/thread-summary/thread-summary.service.ts` (state merge-write D-33 step 7)
    - `grep -q "Date.now() - .* 3600 \\* 1000" src/modules/thread-summary/thread-summary.service.ts` OR `grep -q "windowHours \\* 3600" src/modules/thread-summary/thread-summary.service.ts` (sliding 24h window)
    - `! grep -q "AI_API_KEY\\|filterArticles" src/modules/thread-summary/thread-summary.service.ts` (does NOT touch AI service)
    - `npm run typecheck` exits 0
    - `test -f src/modules/thread-summary/thread-summary.sender.test.ts` (Issue 5: dedicated sender test file with file-scoped vi.mock factory — no dynamic-import flakiness)
    - `grep -q "vi.mock('../../utils/telegram.js'" src/modules/thread-summary/thread-summary.sender.test.ts` (top-level static vi.mock — hoisted before import)
    - `! grep -q "vi.doMock\|vi.doUnmock" src/modules/thread-summary/thread-summary.sender.test.ts` (Issue 5: dynamic-mock dance EXPLICITLY removed; top-level vi.mock only)
    - `npm test -- thread-summary.sender` exits 0 (S1, S2, S2b all pass)
    - `npm test -- thread-summary` exits 0 (formatter + sender + service tests all pass)
  </acceptance_criteria>
  <done>Orchestrator implements all 7 D-33 algorithm steps; per-thread try/catch isolates failures; state merge-write preserves digest fields; getForumTopic refresh per-thread try/catch isolated; windowHours configurable for /dev-summary Phase 7; sender reuses telegram.ts unchanged.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 3: Wire orchestrator into cron.ts thread-summary handler (replace stub from Plan 02)</name>
  <files>src/scheduler/cron.ts</files>
  <read_first>
    - src/scheduler/cron.ts (current — Plan 02 left a stub `threadSummaryHandler` that logs warn; replace its body only)
    - src/modules/thread-summary/thread-summary.service.ts (just-built — runThreadSummaryPipeline)
    - src/modules/thread-summary/thread-summary.sender.ts (just-built — sendThreadSummary)
  </read_first>
  <behavior>
    - Test C7: thread-summary handler now calls runThreadSummaryPipeline and sendThreadSummary in sequence
    - Test C8: when alreadyPublished=true, sender is NOT called (idempotency double-fire test — DLV-10)
    - Test C9: digest handler in cron.ts STILL fires unchanged — no v1.0 regression (success criterion #12)
  </behavior>
  <action>
1. **src/scheduler/cron.ts** — modify only the `threadSummaryHandler` function. Replace its body. Keep all other code untouched (registerJob, startScheduler, stopScheduler, digestHandler, retentionSweepHandler stub, _resetSchedulerForTests, _getRegisteredJobNames).

Add imports at the top of cron.ts (alongside existing `runDigestPipeline` and `sendDigest` imports):

```ts
import { runThreadSummaryPipeline } from '../modules/thread-summary/thread-summary.service.js';
import { sendThreadSummary } from '../modules/thread-summary/thread-summary.sender.js';
```

Replace the stub `threadSummaryHandler` body:

```ts
async function threadSummaryHandler(): Promise<void> {
  // Phase 6 D-33 + DLV-10 — orchestrator handles idempotency internally.
  const result = await runThreadSummaryPipeline();
  if (result.alreadyPublished) {
    logger.warn(
      { date: result.date.toISOString() },
      'Cron: thread-summary already published today, skipping send',
    );
    return;
  }
  if (result.chunks.length === 0) {
    logger.warn('Cron: thread-summary returned 0 chunks, nothing to send');
    return;
  }
  await sendThreadSummary(result.chunks);
  logger.info(
    {
      event: 'thread-summary-published',
      threadsSummarised: result.threadsSummarised,
      threadsSkippedLowVolume: result.threadsSkippedLowVolume,
      threadsSkippedError: result.threadsSkippedError,
      totalMessageCount: result.totalMessageCount,
      chunkCount: result.chunks.length,
    },
    'Cron: thread-summary cycle complete',
  );
}
```

2. **Add to existing src/scheduler/cron.test.ts** (extend Plan 02's test file) the integration assertions C7, C8, C9 — with mocks for `runThreadSummaryPipeline` and `sendThreadSummary` and a check that registry still has all 3 jobs:

```ts
// Append to existing src/scheduler/cron.test.ts
import { vi } from 'vitest';

vi.mock('../modules/thread-summary/thread-summary.service.js', () => ({
  runThreadSummaryPipeline: vi.fn(),
}));
vi.mock('../modules/thread-summary/thread-summary.sender.js', () => ({
  sendThreadSummary: vi.fn(),
}));

describe('cron thread-summary handler wiring (Plan 06-03 Task 3)', () => {
  it('C7+C8+C9: registry still has 3 jobs and includes thread-summary', () => {
    startScheduler();
    const names = _getRegisteredJobNames();
    expect(names).toContain('digest');
    expect(names).toContain('thread-summary');
    expect(names).toContain('retention-sweep');
    stopScheduler();
  });
});
```
  </action>
  <verify>
    <automated>npm run typecheck 2>&1 | tail -5 && npm test 2>&1 | tail -30</automated>
  </verify>
  <acceptance_criteria>
    - `grep -q "runThreadSummaryPipeline" src/scheduler/cron.ts` (handler now calls real pipeline — Plan 03 wiring)
    - `grep -q "sendThreadSummary" src/scheduler/cron.ts` (handler sends chunks)
    - `! grep -q "thread-summary stub" src/scheduler/cron.ts` (Plan 02 stub message GONE — handler is now real)
    - `grep -q "result.alreadyPublished" src/scheduler/cron.ts` (idempotency check at handler level — DLV-10)
    - `grep -q "thread-summary-published" src/scheduler/cron.ts` (success log event — Phase 7 OBS-02 will read this)
    - `grep -q "retention sweep stub" src/scheduler/cron.ts` (retention-sweep STILL stub — Phase 7 owns)
    - `grep -q "Map<string, ScheduledTask>" src/scheduler/cron.ts` (registry intact from Plan 02)
    - Full test suite — `npm test` — exits 0 with ALL tests from Plans 01, 02, 03 passing (~30+ tests across ~10 test files)
    - `npm run typecheck` exits 0
    - `git diff src/utils/telegram.ts` shows zero changes (sendMessageWithRetry untouched)
    - `git diff src/services/ai.service.ts` shows zero changes (filterArticles signature byte-identical — AI-07)
    - `git diff src/index.ts` shows zero changes in main() (Phase 4 wiring intact)
  </acceptance_criteria>
  <done>thread-summary cron handler is no longer a stub; it runs runThreadSummaryPipeline + sendThreadSummary; idempotency double-fire returns early without send; full test suite passes; ai.service.ts, telegram.ts, index.ts main untouched.</done>
</task>

</tasks>

<threat_model>

## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| Telegram API → bot | `getForumTopic` returns user-controlled forum topic name → published in summary post |
| DB → formatter | `messages.text` (user-controlled), `messages.author_name` (user-controlled), `tracked_threads.title` (Telegram-controlled) all flow into HTML output |
| Cron fire → state | Double cron fire on same MSK day must NOT produce double publish |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-06-12 | Tampering / XSS-like (HTML injection in published post) | thread-summary.formatter.ts | mitigate | DLV-08 / D-04: every dynamic field passes through `escapeHtml` (`&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`). Fields covered: thread title, headline, each bullet, each participant displayName, each open question. Verified by Task 1 tests F4 + F5 (script tag and `&` escape regression). Telegram MessageEntity validation rejects malformed HTML — escaped output is always valid. |
| T-06-13 | Spoofing / Unicode display attack (RTL + zero-width in displayed names) | thread-summary.formatter.ts | mitigate | SUM-07 / D-24 second application site: `normalizeDisplayName` applied to participant names BEFORE escapeHtml in formatter. NFC + strip RTL/zero-width/control. Verified by Task 1 test F7. (First application: Plan 01 buildTranscript before LLM prompt insertion.) |
| T-06-14 | Repudiation / DoS (idempotency bypass — double publish) | thread-summary.service.ts + state.service.ts | mitigate | DLV-10 / D-31: two-layer guard. (1) Orchestrator calls `isThreadSummaryPublishedToday()` from state.service which compares MSK calendar day. (2) After successful publish, `writeState({...prevState, lastThreadSummaryDate: new Date().toISOString()})` merge-write atomically updates state. Cron-fire restart at 06:30:30 MSK reads the just-written state and returns `alreadyPublished:true`. Verified by Task 2 test O1 (idempotent skip) + S3 (corrupt state blocks publish). |
| T-06-15 | DoS (per-thread crash kills cycle) | thread-summary.service.ts | mitigate | D-34: every per-thread iteration is wrapped in try/catch. LLM error / DB query crash / getForumTopic timeout for ONE thread → that thread's summary becomes `{skipped:true, reason:'llm-error'}` and the loop continues. Verified by Task 2 test O4. |
| T-06-16 | DoS (Telegram 4096-char limit reject) | thread-summary.formatter.ts | mitigate | DLV-09 / D-37: greedy section-boundary splitter — chunks ≤ MAX_CHUNK_LENGTH (4096). Edge case (single section >4096): emit anyway with WARN log; Telegram rejects → existing single-retry on 429 from sendMessageWithRetry — eventual surface is logged FATAL via existing telegram.ts pattern. Edge case is rare (would need 6 bullets >680 chars each). Verified by Task 1 test F11 (multi-chunk) + F12 (oversized section warn). |
| T-06-17 | DoS (Telegram getForumTopic API down — pipeline blocks) | thread-summary.service.ts refreshThreadTitle | mitigate | D-06: per-thread try/catch around getForumTopic — failure logs warn, falls back to cached `tracked_threads.title` from listTracked() snapshot, then to `Тред #{N}` if no cache. Pipeline NEVER blocks. Verified by Task 2 test O7. |
| T-06-18 | Information Disclosure (PII leak in success log) | thread-summary.service.ts logger.info | mitigate | PRIV-05: success log payload uses metadata allowlist `{event, threadsSummarised, threadsSkippedLowVolume, threadsSkippedError, totalMessageCount, chunkCount}` — NO message text, NO bullet content, NO headline content. Per-thread logs use `{threadId, messageCount}` only. |
| T-06-19 | DoS (cron job throw kills sibling jobs) | cron.ts threadSummaryHandler | mitigate | SCHED-04 from Plan 02: registerJob wraps every handler in try/catch. Throw inside threadSummaryHandler → ERROR log → cron callback returns → digest + retention-sweep continue ticking. Verified by existing Plan 02 acceptance criteria. |

<security_open_questions>
- Telegram `getForumTopic` is rate-limited (~30 calls/sec across the bot). Phase 6 makes 1 call per tracked thread per day at 06:30 MSK. With club ~200 users and likely <20 tracked threads, this is negligible. **Acceptance:** no rate-limit mitigation needed in v2.0; revisit if club grows >100 tracked threads.
- Thread title from `getForumTopic.name` is technically user-controlled (admins can rename). escapeHtml in formatter (T-06-12) is the defence; Telegram MessageEntity rules reject malformed HTML at the API layer as second defence. **Acceptance:** mitigated.
- Race condition: orchestrator iterates `listTrackedThreadIds()` snapshot, but Phase 5 `/track` could mutate the Set mid-cycle. **Acceptance:** snapshot is `[...set]` copy (Phase 4 D-13 contract). Mid-cycle add → next-day publish includes it. Mid-cycle remove → current cycle still summarises (no harm — was tracked at start). Acceptable for solo-dev MVP.
- Empty state.json on first boot — `readState()` returns defaults (`lastThreadSummaryDate: null`), `isThreadSummaryPublishedToday()` returns false → first cron-fire publishes. **Acceptance:** correct behaviour.
</security_open_questions>
</threat_model>

<verification>

```bash
# 1. Strict TS compiles
npm run typecheck

# 2. Full test suite (Plans 01 + 02 + 03)
npm test

# 3. AI-07: filterArticles signature byte-identical
git diff src/services/ai.service.ts | grep -E "^[+-]" | grep -v "^[+-]\\{3\\}" | wc -l   # expect 0

# 4. telegram.ts UNCHANGED (reuse only)
git diff src/utils/telegram.ts | grep -E "^[+-]" | grep -v "^[+-]\\{3\\}" | wc -l   # expect 0

# 5. index.ts main() UNCHANGED (Phase 4 wiring intact)
git diff src/index.ts | grep -E "^[+-]" | grep -v "^[+-]\\{3\\}" | wc -l   # expect 0

# 6. Success criterion #8 — thread-summary handler is real, not stub
grep -q "runThreadSummaryPipeline" src/scheduler/cron.ts || exit 1
grep -q "sendThreadSummary" src/scheduler/cron.ts || exit 1

# 7. Success criterion #10 — idempotency wiring
grep -q "isThreadSummaryPublishedToday" src/modules/thread-summary/thread-summary.service.ts || exit 1
grep -q "result.alreadyPublished" src/scheduler/cron.ts || exit 1

# 8. Success criterion #11 — atomic write + throw on corrupt (already proven by Plan 02)
grep -q "renameSync" src/services/state.service.ts || exit 1

# 9. Success criterion #12 — digest cron continues unchanged
grep -q "digestHandler\\|runDigestPipeline" src/scheduler/cron.ts || exit 1
```
</verification>

<success_criteria>
- thread-summary cron handler is real (not stub) and calls runThreadSummaryPipeline + sendThreadSummary
- runThreadSummaryPipeline implements all 7 algorithm steps from D-33
- Per-thread try/catch isolation: one fail doesn't abort cycle (D-34)
- Idempotency double-fire test produces ONE post (DLV-10)
- Empty-digest case publishes header + "тихо: N из N" (D-35)
- Zero-tracked-threads case publishes header only
- Long output split on section boundaries (DLV-09)
- All HTML dynamic fields escaped (DLV-08, T-06-12)
- Top-3 participants render with middle-dot separator and Unicode-normalised names (D-04, SUM-07)
- Sort by messageCount DESC (D-02)
- Header `🧵 Сводки тредов · DD.MM.YYYY` MSK calendar day (D-03)
- State merge-write preserves lastDigestDate (D-33 step 7)
- getForumTopic failure isolated per-thread (D-06)
- src/utils/telegram.ts UNCHANGED (DLV-09 reuse only)
- src/services/ai.service.ts UNCHANGED (AI-07 — filterArticles byte-identical)
- src/index.ts main() UNCHANGED (Phase 4 wiring intact)
- Full test suite passes; digest cycle has no v1.0 regression (success criterion #12)
</success_criteria>

<output>
After completion, create `.planning/phases/06-thread-summary-pipeline/06-03-SUMMARY.md` documenting:
- Files created (formatter, sender, service, tests)
- Files modified (cron.ts thread-summary handler swap)
- Files NOT touched (ai.service.ts, telegram.ts, index.ts main, db.service, summarizer.service from Plan 01, state.service from Plan 02)
- Cron registry final shape: 3 jobs, all 3 with real handlers EXCEPT retention-sweep (Phase 7 owns)
- Test count + pass status across all 3 plans
- All 12 ROADMAP success criteria verification status (live grep + test results)
- All 19 phase requirement IDs marked addressed (SUM-01..07 + AI-07 in Plan 01; STATE-01/02 + SCHED-01..04 in Plan 02; DLV-06..10 in Plan 03)
- Threat-model coverage summary: T-06-01 to T-06-19 dispositions
- Phase 7 hand-off pointers: where to fill retention-sweep, where to wire /summary + /dev-summary (orchestrator already accepts skipIdempotency + persistState options)
</output>
