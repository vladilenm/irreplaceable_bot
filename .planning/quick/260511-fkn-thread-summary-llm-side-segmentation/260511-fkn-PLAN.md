---
phase: quick-260511-fkn
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - prompts/thread-summarizer.md
  - src/types/index.ts
  - src/services/summarizer.service.ts
  - src/services/summarizer.service.test.ts
  - src/services/summarizer.adversarial.test.ts
  - src/services/summarizer.anonymisation.test.ts
  - src/modules/thread-summary/thread-summary.service.ts
  - src/modules/thread-summary/thread-summary.service.test.ts
  - src/modules/thread-summary/thread-summary.formatter.ts
  - src/modules/thread-summary/thread-summary.formatter.test.ts
autonomous: true
requirements:
  - SUM-02
  - SUM-03
  - SUM-04
  - WR-02
  - D-20
  - D-23
  - D-24

must_haves:
  truths:
    - "One Telegram-thread with N distinct sub-themes renders as N topic lines (one per sub-theme), not 1 collapsed line"
    - "All topic lines across all threads are sorted by messageCount DESC in a single flat ranking"
    - "Each topic line links to t.me/c/{chatIdNoPrefix}/{threadId}/{topic.firstMessageId} — the first message of THAT sub-theme, not the first message of the whole thread"
    - "LLM-returned topic.firstMessageId that is NOT in the input set of tgMessageId → summary routed to schema-invalid (NOT llm-error)"
    - "Anonymisation invariant holds: tgMessageId in transcript is fine; numeric author_id MUST NOT leak to outbound prompt"
    - "Low-volume gate (<5 messages) still fires BEFORE LLM client is constructed"
    - "Token-limit gate (>15k est. tokens) still fires BEFORE LLM client is constructed"
    - "LLM-outage detection: orchestrator still flags llmOutage=true when every tracked thread skipped with reason='llm-error'"
    - "Sandwich integrity (D-20): literal `<<<TRANSCRIPT_END>>>` inside message text remains HTML-escaped; exactly one START and one END boundary remain"
    - "Link aggregation/dedup walks topics->links (case-insensitive, trim, first-occurrence-wins) across all summaries"
  artifacts:
    - path: "src/types/index.ts"
      provides: "LLMSummaryOutput.topics: Array<Topic> (1..5); Topic={emoji,title,messageCount,firstMessageId,links}; ThreadSummary non-skipped variant has topics:Topic[] instead of flat emoji/title/links"
    - path: "src/services/summarizer.service.ts"
      provides: "Zod schema with topics.min(1).max(5); JSON Schema mirror with minItems:1, maxItems:5; buildTranscript injects [id=N HH:MM] DisplayName: text; post-validation step rejects hallucinated firstMessageId not in input id-set with kind='schema-invalid'; summarizeThread no longer accepts firstMessageId arg"
    - path: "prompts/thread-summarizer.md"
      provides: "Updated prompt: ask for topics array (1..5), each with emoji+title+messageCount+firstMessageId+links; firstMessageId MUST be drawn from the [id=N ...] prefixes in the transcript; messageCount is self-reported (documented limitation)"
    - path: "src/modules/thread-summary/thread-summary.service.ts"
      provides: "Orchestrator no longer passes firstMessageId to summarizeThread (LLM picks per-topic); link aggregation walks summaries[].topics[].links; totalMessageCount unchanged (sum of per-summary messageCount across non-skipped)"
    - path: "src/modules/thread-summary/thread-summary.formatter.ts"
      provides: "Flattens summaries.flatMap(s => s.skipped ? [] : s.topics.map(t => ({...t, threadId: s.threadId}))); sorts by messageCount DESC across the flat list; one topic line per element with t.me/c link using topic.firstMessageId"
    - path: "src/services/summarizer.service.test.ts"
      provides: "New tests: schema accepts 1..5 topics; rejects 0 and 6; rejects hallucinated firstMessageId not in input set; accepts valid id from set; buildTranscript emits [id=N HH:MM] prefix"
    - path: "src/modules/thread-summary/thread-summary.service.test.ts"
      provides: "Updated okSummary helper returns topics shape; O8-AGG walks topics->links; B1/B2 unchanged; new test: two topics from one thread aggregated"
    - path: "src/modules/thread-summary/thread-summary.formatter.test.ts"
      provides: "Updated FT-T1/T3: one ThreadSummary with two topics → two topic lines; flat sort across multiple threads' topics by messageCount DESC; each topic uses its own firstMessageId in URL"
  key_links:
    - from: "src/services/summarizer.service.ts buildTranscript"
      to: "src/services/summarizer.service.ts validateTopicIds (post-validation)"
      via: "shared id-set computed from messages.map(m=>m.tgMessageId)"
      pattern: "Set<number>.*tgMessageId"
    - from: "src/services/summarizer.service.ts post-validation"
      to: "summarizeThread reason='schema-invalid' branch"
      via: "kind:'schema-invalid' tagged error OR direct return of skipped:true reason:'schema-invalid'"
      pattern: "reason: 'schema-invalid'"
    - from: "src/modules/thread-summary/thread-summary.service.ts link aggregation loop"
      to: "ThreadSummary.topics[].links"
      via: "for (s of summaries) if(!s.skipped) for (t of s.topics) for (link of t.links)"
      pattern: "topics.*links"
    - from: "src/modules/thread-summary/thread-summary.formatter.ts flat topic list"
      to: "topic line t.me/c URL"
      via: "t.firstMessageId interpolated into href"
      pattern: "t\\.me/c/.*\\$\\{(topic|t)\\.firstMessageId\\}"
---

<objective>
Switch thread-summary from "1 thread = 1 topic" to "1 thread = 1..5 sub-topics" via LLM-side segmentation (Approach A). Today's contract collapses 128 messages spanning multiple sub-questions into a single line; the new contract returns an array of topics from the LLM, each with its own emoji, title, messageCount, firstMessageId (deep-link target) and links.

Purpose: Eliminate the "single dominant theme" lossy collapse in long threads. Participants see distinct sub-discussions and can deep-link to the exact message that started each one. Flat ranking across ALL topics from ALL threads ensures the most-active sub-themes surface, regardless of which forum-topic they originated in.

Output: Contract-coherent change across types → summarizer (incl. prompt + Zod + JSON Schema + post-validation against tgMessageId set) → orchestrator (aggregation walks one extra nesting level) → formatter (flat sort across all topics from all threads, per-topic deep-link). All existing invariants preserved: SUM-02 low-volume, SUM-03 anonymisation, SUM-04 token limit, WR-02 schema-invalid routing, D-20 sandwich integrity, D-24 display-name normalisation, Phase-8 llm-outage detection, T-260507-01 HTML attr injection guard.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@CLAUDE.md
@.planning/STATE.md
@prompts/thread-summarizer.md
@src/types/index.ts
@src/services/summarizer.service.ts
@src/services/summarizer.service.test.ts
@src/services/summarizer.adversarial.test.ts
@src/services/summarizer.anonymisation.test.ts
@src/modules/thread-summary/thread-summary.service.ts
@src/modules/thread-summary/thread-summary.service.test.ts
@src/modules/thread-summary/thread-summary.formatter.ts
@src/modules/thread-summary/thread-summary.formatter.test.ts

<interfaces>
<!-- Current shape (before this plan). Reference for delta. -->

From src/types/index.ts (BEFORE):
```typescript
export interface LLMSummaryOutput {
  emoji: string;
  title: string;
  links: Array<{ url: string; description: string }>;
}

export type ThreadSummary =
  | {
      skipped: false;
      threadId: number;
      windowHours: number;
      messageCount: number;
      emoji: string;
      title: string;
      links: Array<{ url: string; description: string }>;
      firstMessageId: number;
    }
  | { skipped: true; threadId: number; windowHours: number; messageCount: number;
      reason: 'low-volume' | 'transcript-too-large' | 'llm-error' | 'schema-invalid'; };
```

From src/services/summarizer.service.ts:
- `export const ThreadSummarySchema = z.object({emoji, title, links})`
- `export const THREAD_SUMMARIZER_JSON_SCHEMA = {required:['emoji','title','links'], ...}`
- `export function buildTranscript(messages: CapturedMessage[]): string` — currently `[HH:MM] DisplayName: text`
- `export async function summarizeThread(input: {threadId, windowHours, messages, firstMessageId}): Promise<ThreadSummary>`

From src/modules/thread-summary/thread-summary.service.ts:
- Orchestrator currently: computes `firstMessageId = MIN(tgMessageId)`, passes it into summarizeThread; aggregates `s.links` directly (one level).

From src/modules/thread-summary/thread-summary.formatter.ts:
- `nonSkipped.sort((a, b) => b.messageCount - a.messageCount)` — sort key is per-thread messageCount.
- `buildTopicLine` reads `s.emoji, s.title, s.threadId, s.firstMessageId, s.messageCount` directly off the summary.
</interfaces>

<target_shape>
<!-- TARGET shape (after this plan). -->

```typescript
// src/types/index.ts (AFTER)
export interface Topic {
  emoji: string;                                                   // 1 unicode emoji
  title: string;                                                   // ≤100 chars
  messageCount: number;                                            // LLM self-reported, ≥1, integer
  firstMessageId: number;                                          // MUST be in the input tgMessageId set
  links: Array<{ url: string; description: string }>;              // 0..5 items
}

export interface LLMSummaryOutput {
  topics: Topic[];                                                 // 1..5 items
}

export type ThreadSummary =
  | {
      skipped: false;
      threadId: number;
      windowHours: number;
      messageCount: number;                                        // sum of topic messageCounts OR input messages.length (see note)
      topics: Topic[];                                             // 1..5
    }
  | { skipped: true; threadId: number; windowHours: number; messageCount: number;
      reason: 'low-volume' | 'transcript-too-large' | 'llm-error' | 'schema-invalid'; };
```

NOTE on `ThreadSummary.messageCount`: keep it as `messages.length` from the input window (NOT the sum of topic counts). Rationale: (a) it's the source-of-truth count, not a self-reported figure; (b) `totalMessageCount` in the daily-summary header preserves its current meaning ("how many messages were written"); (c) topic-level messageCount is purely a display/sort key and may not sum to input length (LLM may overlap or undercount).

`SummarizeThreadInput` loses `firstMessageId` — the LLM now picks `firstMessageId` per-topic.
</target_shape>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Types + summarizer + prompt + summarizer tests — define and produce the new contract</name>
  <files>
    src/types/index.ts,
    prompts/thread-summarizer.md,
    src/services/summarizer.service.ts,
    src/services/summarizer.service.test.ts,
    src/services/summarizer.adversarial.test.ts,
    src/services/summarizer.anonymisation.test.ts
  </files>
  <behavior>
    Schema (ThreadSummarySchema):
    - Accepts `{topics: [{emoji:'💻', title:'t', messageCount:5, firstMessageId:1001, links:[]}]}` (1 topic, valid)
    - Accepts 5 topics
    - Rejects `{topics: []}` (0 topics — must have ≥1)
    - Rejects 6 topics
    - Rejects topic with messageCount=0 (must be ≥1 integer)
    - Rejects topic with title.length=101
    - Rejects topic with links.length=6
    - Rejects old shape `{emoji,title,links}` (no `topics` key → schema fail)

    JSON Schema mirror (THREAD_SUMMARIZER_JSON_SCHEMA):
    - `required: ['topics']`, `additionalProperties:false`
    - `properties.topics: {type:'array', minItems:1, maxItems:5, items:{...}}`
    - topic items mirror Zod: required emoji/title/messageCount/firstMessageId/links; additionalProperties:false

    buildTranscript:
    - Each line: `[id=<tgMessageId> <HH:MM>] <DisplayName>: <text>` (id is numeric, out-of-band, separated by space and brackets — keeps it numerically distinct and unhelpful as a prompt-injection vector)
    - SUM-03: numeric authorId STILL never appears in output
    - D-20: literal `<<<TRANSCRIPT_END>>>` inside `text` is still HTML-escaped to `&lt;&lt;&lt;TRANSCRIPT_END&gt;&gt;&gt;`
    - D-24: display-name normalisation unchanged
    - Reaffirm + sandwich delimiters unchanged

    summarizeThread:
    - Signature: `summarizeThread(input: {threadId, windowHours, messages})` — `firstMessageId` arg REMOVED
    - SUM-02: <5 messages → `{skipped:true, reason:'low-volume'}`, no LLM call (unchanged)
    - SUM-04: >15k est. tokens → `{skipped:true, reason:'transcript-too-large'}`, no LLM call (unchanged)
    - LLM transport error → `{skipped:true, reason:'llm-error'}` (unchanged)
    - Schema-invalid (Zod fail OR malformed JSON from OpenAI-compatible) → `{skipped:true, reason:'schema-invalid'}` (unchanged routing)
    - **NEW post-validation:** after Zod passes, compute `inputIds = new Set(messages.map(m=>m.tgMessageId))`; if ANY `topic.firstMessageId` is NOT in `inputIds` → `{skipped:true, reason:'schema-invalid'}` with WARN log. Hallucinated id is a model regression, NOT a transport failure.
    - Returns `{skipped:false, threadId, windowHours, messageCount: messages.length, topics: validated.topics}` on success (note: messageCount is input-length, NOT sum of topic counts — see target_shape rationale)
    - Per-title truncation safeguard (title>100 → ellipsised) is applied PER-TOPIC

    Prompt:
    - Asks for `topics` array (1..5)
    - Each topic: emoji + title (≤100) + messageCount (integer ≥1, self-reported, model's best estimate of how many messages discussed this sub-theme) + firstMessageId (MUST be one of the `[id=N ...]` values from the transcript — DO NOT invent ids) + links (0..5, url+description)
    - Single dominant theme is fine: return 1 topic. Many distinct sub-themes: split into up to 5.
    - Documented limitation in prompt: "messageCount is your self-reported estimate; we do not cross-check it against actual message counts"
    - Anonymisation/sandwich/tone wording carried over

    Existing test files (anonymisation + adversarial):
    - summarizer.service.test.ts: replace old `{emoji,title,links}` schema tests with new `{topics}` tests covering all 8 cases above; keep buildTranscript A1-A5 tests, updating expectations to include the `[id=N` prefix; old "Test 8: old shape" → keep as "shape regression guard: old {emoji,title,links} fails"
    - summarizer.adversarial.test.ts: update mock LLM return values to new shape `{topics:[{emoji,title,messageCount,firstMessageId,links}]}`; ADV-1 still asserts garbage → schema-invalid; ADV-2 transcript probe needs to handle the `[id=` prefix when scanning between delimiters (use the message text fragment AFTER the prefix). Also add ADV-1b: LLM returns topics with hallucinated firstMessageId (e.g. id=99999 when input ids are 1000-1010) → schema-invalid skip.
    - summarizer.anonymisation.test.ts: update L1/L2 to pass valid mock LLM responses in new shape so "threshold boundary" test still validates non-low-volume path; mocks return `{topics:[{emoji:'💻',title:'t',messageCount:5,firstMessageId:1,links:[]}]}` and the input messages MUST include tgMessageId=1 so post-validation passes.

    Strict-TypeScript: no `any`. Use explicit `Topic` type. Reuse the Zod `z.infer` pattern if helpful but DO NOT introduce a duplicate type definition (one canonical `Topic` in types/index.ts; Zod schema references it via inference assertion).
  </behavior>
  <action>
    1. **src/types/index.ts**: Add `export interface Topic { emoji; title; messageCount; firstMessageId; links }`. Rewrite `LLMSummaryOutput` to `{ topics: Topic[] }`. Rewrite the non-skipped `ThreadSummary` variant: drop top-level `emoji/title/links/firstMessageId`, add `topics: Topic[]`. Skipped variant unchanged. Update the inline comment block to note "quick-260511-fkn: topics-array contract".

    2. **prompts/thread-summarizer.md**: Rewrite ВЫХОДНЫЕ ДАННЫЕ block:
       - Single field `topics`: массив 1..5 объектов
       - Each topic: `emoji` (один Unicode), `title` (≤100 символов), `messageCount` (integer ≥1, self-reported), `firstMessageId` (число — должно быть ОДНИМ из `[id=N ...]` префиксов в transcript; ВЫДУМЫВАТЬ id ЗАПРЕЩЕНО), `links` (0..5)
       - Add a "СЕГМЕНТАЦИЯ" section: «Если в треде обсуждалась одна тема — верни 1 объект в массиве. Если обсуждалось несколько отдельных под-вопросов — раздели на 2..5 тем по смыслу. НЕ дроби искусственно: пара уточняющих вопросов в рамках одной темы — это всё ещё одна тема.»
       - Note in messageCount description: «твоя оценка количества сообщений, относящихся к этой под-теме. Перепроверка не выполняется — будь честен.»
       - ВХОД section: update to describe `[id=N HH:MM] DisplayName: text` format and that the id is the Telegram message id to be cited in `firstMessageId`.
       - Anonymisation + sandwich + tone wording carries over unchanged.

    3. **src/services/summarizer.service.ts**:
       - Rewrite `ThreadSummarySchema`: `z.object({ topics: z.array(z.object({emoji: z.string().min(1), title: z.string().min(1).max(100), messageCount: z.number().int().min(1), firstMessageId: z.number().int(), links: z.array(z.object({url: z.string().url(), description: z.string().min(1).max(80)})).max(5)})).min(1).max(5) })`.
       - Rewrite `THREAD_SUMMARIZER_JSON_SCHEMA` mirror: `required:['topics']`, topics is array minItems:1 maxItems:5 with item required emoji/title/messageCount/firstMessageId/links and additionalProperties:false; messageCount is `{type:'integer', minimum:1}`, firstMessageId is `{type:'integer'}`. Set `additionalProperties:false` on both wrapper and item objects.
       - Rewrite `buildTranscript`: line format `[id=${m.tgMessageId} ${time}] ${displayName}: ${safeText}`. Everything else (escape, sandwich, reaffirm) unchanged.
       - Remove `firstMessageId` from `SummarizeThreadInput`.
       - In `summarizeThread`, after Zod `safeParse` succeeds: compute `const inputIds = new Set(messages.map(m => m.tgMessageId)); const validated = parsed.data;`. Walk `validated.topics`; if any `topic.firstMessageId` is not in `inputIds`, log WARN with the offending id + threadId, return `{skipped:true, threadId, windowHours, messageCount, reason:'schema-invalid'}`. Apply title-truncation safeguard per-topic. Return `{skipped:false, threadId, windowHours, messageCount: messages.length, topics: validated.topics}`.
       - Update success log: `topicCount: validated.topics.length` instead of `linkCount`; sum links across topics for an aggregate count log.

    4. **src/services/summarizer.service.test.ts**: Replace schema tests with new topics-array battery (Test 1-9 from `<behavior>`). Keep buildTranscript A1-A5 (anonymisation/sandwich/Unicode) tests, updating expectations:
       - A1: still asserts `12345` (numeric authorId) NOT in output AND `Маша` IS in output. ADD assertion that `[id=1 10:00]` (or whatever tgMessageId+time) is in output.
       - A3-A4 unchanged.
       - A5 unchanged.
       - Add new test (Test 10): `[id=N ...]` prefix format renders correctly for non-trivial id (e.g. tgMessageId=7475 → `[id=7475 10:00]`).
       - Add Test 11: post-validation rejects hallucinated firstMessageId. Mock LLM returns valid-shape topics with `firstMessageId:99999` when input messages have tgMessageId in [1000,1001,1002,1003,1004]. Assert `{skipped:true, reason:'schema-invalid'}`.
       - Add Test 12: post-validation accepts firstMessageId that IS in input set. Mock returns `firstMessageId:1002`; assert `skipped:false` and `topics[0].firstMessageId === 1002`.

    5. **src/services/summarizer.adversarial.test.ts**:
       - Update ADV-1 mock returns to new garbage shape (e.g. `{leak:'pwned'}` already works — wrapper is missing `topics`). Assertion unchanged (schema-invalid).
       - ADV-2: when probing message bodies between delimiters, account for `[id=N HH:MM] Name:` prefix in transcript lines. The probe should locate the message TEXT (the part after the colon-space) rather than expecting the line to start with `[HH:MM]`.
       - Add ADV-1b: jailbreak that returns valid shape but with `topics[0].firstMessageId` not in the parsed-fixture id-set → schema-invalid. (Use a fixture id-set of e.g. 1000..1000+N and force topics[].firstMessageId=42.)

    6. **src/services/summarizer.anonymisation.test.ts**:
       - Update threshold-boundary test (line 87-118) to make the mock LLM responses use the NEW shape: `{ topics: [{ emoji:'💻', title:'t', messageCount:5, firstMessageId:<one of input ids>, links:[] }] }`. Pick `firstMessageId` from the `fakeMsg(i).tgMessageId` values to pass post-validation. Anthropic mock: same shape inside `tool_use.input`. OpenAI mock: same shape, JSON-stringified.
       - L1/L2 tests (low-volume gate) are independent of shape — no LLM call happens, so leave them as-is BUT remove the now-invalid `firstMessageId` arg from `summarizeThread` calls (the orchestrator no longer passes it; the input shape doesn't include it).

    Strict-TypeScript: every change must compile under `tsc --noEmit`. No `any`. No `as unknown as`. The Zod-inferred type and the `Topic` interface should be structurally identical — assert this with a type-level test or by deriving one from the other.
  </action>
  <verify>
    <automated>cd /Users/vladilen/Documents/тнз/club-bot && npx tsc --noEmit && npx vitest run src/services/summarizer.service.test.ts src/services/summarizer.adversarial.test.ts src/services/summarizer.anonymisation.test.ts</automated>
  </verify>
  <done>
    - `LLMSummaryOutput = { topics: Topic[] }` in types/index.ts
    - `ThreadSummary` non-skipped variant has `topics: Topic[]`, no top-level emoji/title/links/firstMessageId
    - `ThreadSummarySchema` enforces topics.min(1).max(5) with per-topic emoji+title(≤100)+messageCount(int≥1)+firstMessageId(int)+links(≤5)
    - `THREAD_SUMMARIZER_JSON_SCHEMA` mirror reflects same constraints with additionalProperties:false at both levels
    - `buildTranscript` emits `[id=<tgMessageId> <HH:MM>] <Name>: <text>`; numeric authorId still NOT in output; literal TRANSCRIPT_END still escaped; reaffirm still after closing delimiter
    - `summarizeThread` takes no `firstMessageId` arg; post-validates each `topic.firstMessageId ∈ Set(messages.tgMessageId)`; hallucinated id → reason:'schema-invalid' (NOT 'llm-error')
    - prompts/thread-summarizer.md instructs topics array (1..5), explains firstMessageId-from-transcript-ids constraint, documents messageCount self-report limitation
    - All summarizer test files green; new tests cover: 1..5 topics accepted, 0/6 rejected, hallucinated id rejected, valid id accepted, `[id=N` in transcript
    - `npx tsc --noEmit` clean
    - SUM-02, SUM-03, SUM-04, WR-02, D-20, D-24 invariants asserted by existing tests still pass
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Orchestrator + formatter + their tests — consume the new contract with flat ranking across all sub-topics</name>
  <files>
    src/modules/thread-summary/thread-summary.service.ts,
    src/modules/thread-summary/thread-summary.service.test.ts,
    src/modules/thread-summary/thread-summary.formatter.ts,
    src/modules/thread-summary/thread-summary.formatter.test.ts
  </files>
  <behavior>
    Orchestrator (thread-summary.service.ts):
    - No longer computes `firstMessageId` (LLM picks per-topic). The MIN(tgMessageId) calculation block is DELETED.
    - `summarizeThread({ threadId, windowHours, messages })` — no firstMessageId arg.
    - Link aggregation: iterate `for (const s of summaries) if (!s.skipped) for (const t of s.topics) for (const link of t.links) { dedup; push }`. Dedup key still `url.trim().toLowerCase()`, first occurrence wins (description from first appearance preserved).
    - `totalMessageCount` semantics unchanged: sum of `s.messageCount` across non-skipped summaries (input-length, NOT sum of topic counts).
    - Phase-8-fix-B llm-outage detection unchanged: every summary skipped with reason:'llm-error' → llmOutage:true → chunks:[].
    - Per-thread try/catch behaviour unchanged: thrown error → push skipped:true reason:'llm-error'.
    - `markThreadSummaryPublished` helper unchanged.

    Formatter (thread-summary.formatter.ts):
    - `FormatThreadSummaryInput` shape unchanged externally (still summaries + date + totalMessageCount + aggregatedLinks + chatId), but consumer logic now flattens topics.
    - Build `const allTopics: Array<Topic & { threadId: number }> = summaries.flatMap(s => s.skipped ? [] : s.topics.map(t => ({...t, threadId: s.threadId})))`.
    - Sort `allTopics` by `messageCount` DESC — flat across ALL topics from ALL threads.
    - One topic line per element: `${emoji} ${escapeHtml(title)} (<a href="https://t.me/c/${chatIdNoPrefix}/${threadId}/${firstMessageId}">${messageCount} сообщений</a>)`.
    - Edge cases unchanged:
      - `summaries.length === 0` → `[header + footer]`
      - `allTopics.length === 0` (all skipped, OR no topics — shouldn't happen but defensive) → `[header + total + footer]`
    - Link section + footer + chunk splitter unchanged.
    - T-260507-01 HTML-attr injection guard on links unchanged.

    Tests:
    - service.test.ts: rewrite `okSummary` helper to return `{skipped:false, threadId, windowHours, messageCount, topics:[{emoji:'💻', title:'topic', messageCount:<mc>, firstMessageId:1000+threadId, links:<links>}]}`. The third positional arg (`links`) lands inside `topics[0].links`.
      - Add new test O7-MULTI-TOPIC: a single summary with 2 topics (different messageCount each) → formatter renders 2 topic lines, both deep-linked with their respective firstMessageIds. (The split-into-sub-themes behaviour.)
      - O8-AGG: aggregation now walks topics→links. Test still asserts dedup across summaries, but the mock-summary structure has links nested in topics. Update the mock returns so first summary has `topics:[{...,links:[{url:'…/a',…},{url:'…/b',…}]}]` and second summary has `topics:[{...,links:[{url:'  HTTPS://Example.com/A  ',…},{url:'…/c',…}]}]`. Assertions unchanged.
      - O7-NEW (firstMessageId is MIN(...)): this test is now invalid (orchestrator no longer computes firstMessageId). Replace with O7-CONTRACT: orchestrator calls `summarizeThread` with `{threadId, windowHours, messages}` and NO firstMessageId field. Assert `call.firstMessageId === undefined`.
      - B-tests (llm-outage detection): no shape changes inside (return `{skipped:true, reason:'llm-error'}`). Untouched. B4 (genuine quiet day) untouched. B6 (one success, rest llm-error): okSummary needs to return new shape — already covered by helper rewrite.
    - formatter.test.ts: rewrite `ok()` helper to return topics shape. Existing FT-T1/T3/T4 assertions adjust to the new layer of nesting. Add NEW tests:
      - FT-T3b: TWO summaries each with TWO topics of different messageCounts (e.g. S1: [50, 5]; S2: [30, 10]) → output order is 50, 30, 10, 5 (FLAT sort across threads). Each topic line links to its own (threadId, firstMessageId) pair.
      - FT-T5: one summary with 5 topics, all rendered as separate lines with their own deep-links.

    Strict-TypeScript clean. No `any`. The `flatMap` projection must produce a properly-typed `Array<Topic & {threadId:number}>` without casts.
  </behavior>
  <action>
    1. **src/modules/thread-summary/thread-summary.service.ts**:
       - Delete the `firstMessageId = messages.length === 0 ? 0 : messages.reduce(...)` block inside the for-loop (lines ~123-133).
       - Update the call to `summarizeThread({ threadId, windowHours, messages })` — drop the `firstMessageId` field.
       - Rewrite the link aggregation block (lines ~166-176):
         ```ts
         const seenUrls = new Set<string>();
         const aggregatedLinks: Array<{ url: string; description: string }> = [];
         for (const s of summaries) {
           if (s.skipped) continue;
           for (const t of s.topics) {
             for (const link of t.links) {
               const key = link.url.trim().toLowerCase();
               if (key === '' || seenUrls.has(key)) continue;
               seenUrls.add(key);
               aggregatedLinks.push(link);
             }
           }
         }
         ```
       - Everything else (idempotency, state, llmOutage detection, persistState, return shape) unchanged.

    2. **src/modules/thread-summary/thread-summary.formatter.ts**:
       - Import `Topic` type from types/index.ts.
       - Replace `nonSkipped` filter+sort block (lines ~92-101) with:
         ```ts
         type TopicWithThread = Topic & { threadId: number };
         const allTopics: TopicWithThread[] = summaries.flatMap(
           (s): TopicWithThread[] =>
             s.skipped ? [] : s.topics.map((t) => ({ ...t, threadId: s.threadId })),
         );
         allTopics.sort((a, b) => b.messageCount - a.messageCount);
         ```
       - Edge case: rename `nonSkipped.length === 0` check to `allTopics.length === 0`.
       - `buildTopicLine` signature: change to `(t: TopicWithThread, chatIdNoPrefix: string)`. Use `t.threadId`, `t.firstMessageId`, `t.emoji`, `t.title`, `t.messageCount`. URL format unchanged: `https://t.me/c/${chatIdNoPrefix}/${t.threadId}/${t.firstMessageId}`.
       - `topicLines = allTopics.map((t) => buildTopicLine(t, chatIdNoPrefix))`.
       - Everything else (header, total line, links section, splitter, footer) unchanged.

    3. **src/modules/thread-summary/thread-summary.service.test.ts**:
       - Rewrite `okSummary`:
         ```ts
         const okSummary = (threadId, mc=10, links=[]): ThreadSummary => ({
           skipped: false, threadId, windowHours: 24, messageCount: mc,
           topics: [{ emoji:'💻', title:'topic', messageCount: mc, firstMessageId: 1000+threadId, links }],
         });
         ```
       - Add `okSummaryMulti(threadId, topics: Array<{messageCount, firstMessageId, links?}>): ThreadSummary` helper for multi-topic cases.
       - Replace O7-NEW test (firstMessageId-is-MIN) with O7-CONTRACT: assert `call.firstMessageId === undefined` after `runThreadSummaryPipeline()`.
       - Add O7-MULTI: single thread, 2 topics. Mock returns one summary with two topics (different mc, different firstMessageId). Assert resulting chunk contains BOTH topic lines with their respective deep-links. Verifies the whole "1 thread = N topics" feature.
       - O8-AGG: update mock returns to put links inside `topics[0].links`; assertions unchanged.
       - B6: depends on `okSummary` — auto-updated by helper rewrite.

    4. **src/modules/thread-summary/thread-summary.formatter.test.ts**:
       - Rewrite `ok()` helper to return topics-shape. Map old top-level emoji/title/messageCount/firstMessageId/links into `topics[0]`. Allow `over` partial to override the topics array directly OR override top-level threadId/messageCount.
       - Existing tests (FT-H1, FT-H2, FT-T1, FT-T2, FT-T3, FT-T4, FT-L1, FT-L2, FT-L3, FT-L4, FT-FOOT, FT-EDGE-1, FT-EDGE-2, FT-SPLIT) — update only the `ok()` calls; assertions are mostly unchanged. FT-T3 (sort) still works because one topic per summary keeps the sort key 1:1.
       - Add FT-T3b: two summaries, each with two topics — assert order is FLAT by messageCount DESC across all four topics. Verify each line carries its own (threadId, firstMessageId) deep-link.
       - Add FT-T5: one summary with 5 topics → 5 topic lines rendered, each with its own deep-link.

    Strict-TypeScript clean. The flatMap projection must compile without any `as` casts (use explicit return-type annotation on the arrow as shown).
  </action>
  <verify>
    <automated>cd /Users/vladilen/Documents/тнз/club-bot && npx tsc --noEmit && npx vitest run src/modules/thread-summary/</automated>
  </verify>
  <done>
    - Orchestrator no longer computes firstMessageId; passes only {threadId, windowHours, messages} into summarizeThread
    - Link aggregation walks `summaries[i].topics[j].links` with three-level loop; dedup + first-occurrence-wins preserved
    - Formatter flattens summaries→topics, sorts by messageCount DESC across the ENTIRE flat list, renders one line per topic with its own threadId+firstMessageId deep-link
    - Edge cases (empty summaries, all-skipped, all-zero-topics) handled
    - service.test.ts: O7-MULTI passes (one thread, two topics → two lines). O7-CONTRACT asserts summarizeThread called without firstMessageId arg. O8-AGG updated and passing. B1-B6 (llm-outage) passing. S3 (corrupt state) passing.
    - formatter.test.ts: FT-T3b passes (flat sort across multiple threads' topics). FT-T5 passes (5 topics in one thread → 5 lines). All other FT-* tests still passing.
    - `npx tsc --noEmit` clean
    - sender.test.ts NOT modified (shape-agnostic) and still passes: `npx vitest run src/modules/thread-summary/thread-summary.sender.test.ts`
    - WR-02 routing preserved: any LLM-output failure still bucketed correctly (schema-invalid vs llm-error)
    - Phase-8 llm-outage detection unchanged: `summaries.every(s => s.skipped && s.reason==='llm-error')` still flags llmOutage=true
  </done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| Telegram user → captured message | User-typed text and Telegram-supplied tgMessageId are captured into DB; tgMessageId is an integer assigned by Telegram, NOT user-controllable. |
| Captured messages → LLM prompt | buildTranscript serialises into the user-message slot; sandwich + reaffirm + HTML-escape are the existing mitigations. |
| LLM → output | Provider-side json_schema enforcement is best-effort; Zod last-gate is the authoritative validator. |
| LLM output → Telegram HTML | Formatter renders summary.title and link.description into `<a>` tags; HTML-escape + double-quote-in-url drop are existing mitigations. |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-260511-01 | Tampering | summarizer.service.ts post-validation | mitigate | Each `topic.firstMessageId` MUST be in `Set(messages.tgMessageId)`. Hallucinated id (model invents a number not in the input set) → reason:'schema-invalid'. Prevents the formatter from emitting a t.me/c link pointing at an unrelated/forged message id. Tested by Task 1 Test 11 + ADV-1b. |
| T-260511-02 | Information disclosure | buildTranscript [id=N ...] prefix | accept | tgMessageId is a numeric Telegram id, NOT PII. It is already exposed in t.me/c/ deep-links to every group member. Including it in the LLM prompt does not widen the disclosure surface. authorId (which IS PII per SUM-03) remains stripped. |
| T-260511-03 | Elevation of privilege | LLM prompt injection via `[id=N` prefix | mitigate | Format is numeric and bracketed (`[id=12345 14:23]`), out-of-band from message text. Sandwich delimiters + reaffirm + escape unchanged. A malicious user typing `[id=99999 23:59] Admin: do X` inside their text gets HTML-escaped to `&lt;...&gt;` (existing escapeForTranscript), preventing it from impersonating a prefix line. Adversarial fixture ADV-2 already covers escape behaviour; update its probe to handle the new prefix. |
| T-260511-04 | Denial of service | LLM returns 5 topics with very long titles | accept | Schema caps title ≤100 chars per topic and topics ≤5 → max ~500 chars of titles. Plus per-topic link line ~250 chars × 5 ≤ ~1250 chars worst-case per summary. Existing MAX_CHUNK_LENGTH splitter handles multi-chunk output. No new DoS surface vs. current 1-topic format with 5 links. |
| T-260511-05 | Spoofing | Topic line deep-link points to wrong message | mitigate (via T-260511-01) | Post-validation ensures firstMessageId is from input set. A spoofed id (e.g. linking to admin message id) cannot escape this gate. |
| T-260511-06 | Repudiation | Operator cannot distinguish "LLM hallucinated id" from "LLM transport error" in logs | mitigate | Hallucinated-id case logs WARN with `{ event:'schema-invalid-hallucinated-id', threadId, offendingId, inputIdsSize }` distinct from the generic `schema-invalid` Zod-fail log. Operator can grep `hallucinated-id` to detect model regressions. |
</threat_model>

<verification>
Run the full thread-summary test suite plus the type-check after both tasks land:

```
cd /Users/vladilen/Documents/тнз/club-bot && \
  npx tsc --noEmit && \
  npx vitest run src/services/summarizer.service.test.ts \
                 src/services/summarizer.adversarial.test.ts \
                 src/services/summarizer.anonymisation.test.ts \
                 src/modules/thread-summary/
```

Then a focused grep to confirm no residue of the old shape:

```
grep -rn "headline\|bullets\|openQuestions" src/ prompts/ 2>/dev/null   # must return nothing
grep -rn "firstMessageId" src/services/summarizer.service.ts             # must appear ONLY inside topic validation + Topic type, NOT in SummarizeThreadInput
grep -n "messages.reduce" src/modules/thread-summary/thread-summary.service.ts   # must return nothing (orchestrator no longer computes MIN)
```

Final integration check: the orchestrator + formatter + summarizer interact through the new types only. The sender (`thread-summary.sender.ts`) consumes `string[]` chunks — sender tests must still pass without modification.
</verification>

<success_criteria>
- `LLMSummaryOutput` is `{ topics: Topic[] }`; `Topic` has `emoji, title, messageCount, firstMessageId, links`
- `ThreadSummary` non-skipped variant carries `topics: Topic[]`; skipped variant unchanged
- Zod schema: topics array 1..5, per-topic constraints (title ≤100, messageCount integer ≥1, links ≤5)
- JSON Schema mirror: identical constraints with `additionalProperties:false` at both levels
- Prompt: requests topics array, instructs firstMessageId to be picked from `[id=N ...]` transcript prefixes, documents messageCount self-report limitation
- `buildTranscript` emits `[id=<tgMessageId> <HH:MM>] <DisplayName>: <text>`; numeric authorId still NEVER in output; literal TRANSCRIPT_END still HTML-escaped
- `summarizeThread` post-validates each `topic.firstMessageId ∈ Set(input tgMessageIds)`; hallucinated id → reason:'schema-invalid' (distinct WARN log for grep-ability)
- `summarizeThread` no longer accepts `firstMessageId` arg
- Orchestrator no longer computes MIN(tgMessageId); link aggregation walks `s.topics[].links`
- Formatter flattens `summaries.flatMap(s => s.topics)` and sorts FLAT by messageCount DESC across all topics from all threads
- One topic line per element with t.me/c/<chatIdNoPrefix>/<threadId>/<topic.firstMessageId> deep-link
- All existing tests pass with shape changes applied
- New tests cover: 1..5 topics accepted, 0/6 rejected, hallucinated id rejected, multi-topic per thread renders multiple lines, flat sort across threads
- `npx tsc --noEmit` clean; no `any` introduced anywhere
- SUM-02, SUM-03, SUM-04, WR-02, D-20, D-23, D-24, T-260507-01, Phase-8 llm-outage detection all invariant
</success_criteria>

<output>
After completion, create `.planning/quick/260511-fkn-thread-summary-llm-side-segmentation/260511-fkn-SUMMARY.md` per the standard summary template, noting:
- The contract change (top-level shape diff)
- The new post-validation invariant (firstMessageId ∈ input set) and where it lives
- That sender + state-service + tracking-service were NOT touched (shape-agnostic consumers)
- Test count delta (added vs. modified vs. removed)
- Grep evidence that no old-shape residue remains
</output>
