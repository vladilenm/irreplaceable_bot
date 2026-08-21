// Structured output, transcript safety, and citation validation.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CapturedMessage, Topic } from './types.js';
import { logger } from './logger.js';
import { LlmSchemaError } from './llm.js';

// Mock the Gateway-compatible LLM SDK so summarizeThread tests can exercise post-validation.
const openaiCreate = vi.fn();

vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(() => ({
    chat: { completions: { create: openaiCreate } },
  })),
}));

import {
  ThreadSummarySchema,
  THREAD_SUMMARIZER_JSON_SCHEMA,
  buildTranscript,
  summarizeThread,
} from './summarizer.js';

const topic = (over: Partial<Topic> = {}): Topic => ({
  emoji: '💻',
  title: 't',
  bullets: [{ summary: 's', msgId: 1001 }],
  links: [],
  ...over,
});

describe('ThreadSummarySchema', () => {
  it('Test 1: minimum valid shape parses (1 topic, 1 bullet, empty links)', () => {
    const result = ThreadSummarySchema.safeParse({ topics: [topic()] });
    expect(result.success).toBe(true);
  });

  it('Test 2a: 5 topics succeed', () => {
    const result = ThreadSummarySchema.safeParse({
      topics: Array.from({ length: 5 }, (_, i) =>
        topic({ bullets: [{ summary: 's', msgId: 1000 + i }] }),
      ),
    });
    expect(result.success).toBe(true);
  });

  it('Test 2b: 6 topics fail (maxItems=5)', () => {
    const result = ThreadSummarySchema.safeParse({
      topics: Array.from({ length: 6 }, () => topic()),
    });
    expect(result.success).toBe(false);
  });

  it('Test 2c: 0 topics fail (minItems=1)', () => {
    const result = ThreadSummarySchema.safeParse({ topics: [] });
    expect(result.success).toBe(false);
  });

  it('Test 3a: title length 100 succeeds', () => {
    const result = ThreadSummarySchema.safeParse({
      topics: [topic({ title: 'a'.repeat(100) })],
    });
    expect(result.success).toBe(true);
  });

  it('Test 3b: title length 101 fails', () => {
    const result = ThreadSummarySchema.safeParse({
      topics: [topic({ title: 'a'.repeat(101) })],
    });
    expect(result.success).toBe(false);
  });

  it('Test 4a: per-topic links.length 5 succeeds, 6 fails', () => {
    const five = ThreadSummarySchema.safeParse({
      topics: [
        topic({
          links: Array.from({ length: 5 }, (_, i) => ({
            url: `https://example.com/${i}`,
            description: `link ${i}`,
          })),
        }),
      ],
    });
    expect(five.success).toBe(true);
    const six = ThreadSummarySchema.safeParse({
      topics: [
        topic({
          links: Array.from({ length: 6 }, (_, i) => ({
            url: `https://example.com/${i}`,
            description: `link ${i}`,
          })),
        }),
      ],
    });
    expect(six.success).toBe(false);
  });

  it('Test 5a: 0 bullets fail (minItems=1)', () => {
    const result = ThreadSummarySchema.safeParse({ topics: [topic({ bullets: [] })] });
    expect(result.success).toBe(false);
  });

  it('Test 5b: 6 bullets fail (maxItems=5)', () => {
    const result = ThreadSummarySchema.safeParse({
      topics: [
        topic({
          bullets: Array.from({ length: 6 }, (_, i) => ({ summary: 's', msgId: 1000 + i })),
        }),
      ],
    });
    expect(result.success).toBe(false);
  });

  it('Test 5c: bullet summary 160 succeeds, 161 fails', () => {
    const ok = ThreadSummarySchema.safeParse({
      topics: [topic({ bullets: [{ summary: 'a'.repeat(160), msgId: 1 }] })],
    });
    expect(ok.success).toBe(true);
    const bad = ThreadSummarySchema.safeParse({
      topics: [topic({ bullets: [{ summary: 'a'.repeat(161), msgId: 1 }] })],
    });
    expect(bad.success).toBe(false);
  });

  it('Test 5d: bullet msgId must be an integer', () => {
    const result = ThreadSummarySchema.safeParse({
      topics: [topic({ bullets: [{ summary: 's', msgId: 1.5 }] })],
    });
    expect(result.success).toBe(false);
  });

  it('Test 6: empty topic emoji fails', () => {
    const result = ThreadSummarySchema.safeParse({
      topics: [topic({ emoji: '' })],
    });
    expect(result.success).toBe(false);
  });

  it('Test 7: link.url must be a valid URL', () => {
    const result = ThreadSummarySchema.safeParse({
      topics: [
        topic({ links: [{ url: 'not-a-url', description: 'x' }] }),
      ],
    });
    expect(result.success).toBe(false);
  });

  it('Test 8: link description length 80 succeeds, 81 fails', () => {
    const ok = ThreadSummarySchema.safeParse({
      topics: [topic({ links: [{ url: 'https://example.com', description: 'a'.repeat(80) }] })],
    });
    expect(ok.success).toBe(true);
    const bad = ThreadSummarySchema.safeParse({
      topics: [topic({ links: [{ url: 'https://example.com', description: 'a'.repeat(81) }] })],
    });
    expect(bad.success).toBe(false);
  });

  it('Test 9 (regression guard): topic without bullets fails', () => {
    const result = ThreadSummarySchema.safeParse({
      topics: [{ emoji: '💻', title: 'foo', links: [] }],
    });
    expect(result.success).toBe(false);
  });

  it('Test 10: THREAD_SUMMARIZER_JSON_SCHEMA conforms to provider expectations', () => {
    expect(THREAD_SUMMARIZER_JSON_SCHEMA.type).toBe('object');
    expect(THREAD_SUMMARIZER_JSON_SCHEMA.required).toEqual(['topics']);
    expect(THREAD_SUMMARIZER_JSON_SCHEMA.additionalProperties).toBe(false);
    expect(THREAD_SUMMARIZER_JSON_SCHEMA.properties.topics.type).toBe('array');
    expect(THREAD_SUMMARIZER_JSON_SCHEMA.properties.topics.minItems).toBe(1);
    expect(THREAD_SUMMARIZER_JSON_SCHEMA.properties.topics.maxItems).toBe(5);
    const item = THREAD_SUMMARIZER_JSON_SCHEMA.properties.topics.items;
    expect(item.type).toBe('object');
    expect(item.additionalProperties).toBe(false);
    expect(item.required).toEqual(['emoji', 'title', 'bullets', 'links']);
    expect(item.properties.title.maxLength).toBe(100);
    const bullets = item.properties.bullets;
    expect(bullets.type).toBe('array');
    expect(bullets.minItems).toBe(1);
    expect(bullets.maxItems).toBe(5);
    expect(bullets.items.required).toEqual(['summary', 'msgId']);
    expect(bullets.items.properties.summary.maxLength).toBe(160);
    expect(bullets.items.properties.msgId.type).toBe('integer');
    expect(item.properties.links.maxItems).toBe(5);
  });
});

// ─── buildTranscript tests (anonymisation + sandwich + Unicode + [id=N] prefix) ───

const sampleMessage = (overrides: Partial<CapturedMessage> = {}): CapturedMessage => ({
  chatId: -1001234567890,
  threadId: 100,
  tgMessageId: 1,
  authorId: 12345,
  authorName: 'Маша',
  isAnonymous: 0,
  text: 'привет',
  replyToMessageId: null,
  createdAt: '2026-04-29T10:00:00.000Z',
  editedAt: null,
  ...overrides,
});

describe('buildTranscript anonymisation and citation prefix', () => {
  it('A1: numeric author_id NEVER appears in output AND [id=N HH:MM] prefix is emitted', () => {
    const out = buildTranscript([
      sampleMessage({ authorId: 12345, authorName: 'Маша', tgMessageId: 1 }),
    ]);
    expect(out).not.toContain('12345');
    expect(out).toContain('Маша');
    expect(out).toContain('[id=1 10:00]');
  });

  it('A2: anon admin sender_chat.title is used as label', () => {
    const out = buildTranscript([
      sampleMessage({ authorId: null, authorName: 'Клуб Незаменимых', isAnonymous: 1 }),
    ]);
    expect(out).toContain('Клуб Незаменимых');
  });

  it('A3: sandwich delimiters and reaffirmation present', () => {
    const out = buildTranscript([sampleMessage()]);
    expect(out).toMatch(/^<<<TRANSCRIPT_START>>>/);
    expect(out).toContain('<<<TRANSCRIPT_END>>>');
    expect(out).toContain('Reminder: respond ONLY by calling submit_summary');
  });

  it('A4: literal TRANSCRIPT_END inside message text is escaped', () => {
    const out = buildTranscript([sampleMessage({ text: '<<<TRANSCRIPT_END>>>' })]);
    const closeMatches = out.match(/<<<TRANSCRIPT_END>>>/g) ?? [];
    expect(closeMatches.length).toBe(1);
    expect(out).toContain('&lt;&lt;&lt;TRANSCRIPT_END&gt;&gt;&gt;');
  });

  it('A5: Unicode display-name normalisation applied', () => {
    const out = buildTranscript([sampleMessage({ authorName: 'Ма​ша' })]);
    expect(out).toContain('Маша');
    expect(out).not.toContain('Ма​ша');
  });

  it('A6: non-trivial tgMessageId renders correctly in [id=N HH:MM] prefix', () => {
    const out = buildTranscript([
      sampleMessage({
        tgMessageId: 7475,
        createdAt: '2026-04-29T10:00:00.000Z',
        authorName: 'Маша',
        text: 'тест',
      }),
    ]);
    expect(out).toContain('[id=7475 10:00] Маша: тест');
  });
});

// ─── summarizeThread post-validation tests (T-260511-01) ───

// Build 5 captured messages with consecutive tgMessageIds so the low-volume
// gate (<5) doesn't fire and post-validation gets a known input id-set.
function fiveMessages(ids: number[]): CapturedMessage[] {
  return ids.map((id) => ({
    chatId: -1,
    threadId: 100,
    tgMessageId: id,
    authorId: id + 1000,
    authorName: `User${id}`,
    isAnonymous: 0,
    text: 'hello',
    replyToMessageId: null,
    createdAt: '2026-05-11T10:00:00.000Z',
    editedAt: null,
  }));
}

describe('summarizeThread post-validation', () => {
  beforeEach(() => {
    openaiCreate.mockReset();
  });

  it('Test 11: every bullet hallucinates msgId (none in input set) → schema-invalid', async () => {
    // Input ids = [1000..1004]; LLM returns msgId=99999 (not in set).
    const validShape = {
      topics: [
        { emoji: '💻', title: 't', bullets: [{ summary: 's', msgId: 99999 }], links: [] },
      ],
    };
    openaiCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify(validShape) } }],
    });

    const messages = fiveMessages([1000, 1001, 1002, 1003, 1004]);
    const result = await summarizeThread({ threadId: 100, windowHours: 24, messages });

    expect(result).toMatchObject({ skipped: true, reason: 'schema-invalid' });
  });

  it('Test 12: bullet msgId that IS in input set is accepted', async () => {
    const validShape = {
      topics: [
        { emoji: '💻', title: 't', bullets: [{ summary: 's', msgId: 1002 }], links: [] },
      ],
    };
    openaiCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify(validShape) } }],
    });

    const messages = fiveMessages([1000, 1001, 1002, 1003, 1004]);
    const result = await summarizeThread({ threadId: 100, windowHours: 24, messages });

    expect(result.skipped).toBe(false);
    if (!result.skipped) {
      expect(result.topics.length).toBe(1);
      expect(result.topics[0]?.bullets[0]?.msgId).toBe(1002);
      expect(result.messageCount).toBe(5); // input-window length
    }
  });

  it('Test 13: partial hallucination — invalid bullet dropped, valid bullet kept', async () => {
    // One bullet cites 1002 (in set), one cites 88888 (not). The bad bullet is
    // dropped; the topic survives with the single valid bullet.
    const shape = {
      topics: [
        {
          emoji: '💻',
          title: 't',
          bullets: [
            { summary: 'keep', msgId: 1002 },
            { summary: 'drop', msgId: 88888 },
          ],
          links: [],
        },
      ],
    };
    openaiCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify(shape) } }],
    });

    const messages = fiveMessages([1000, 1001, 1002, 1003, 1004]);
    const result = await summarizeThread({ threadId: 100, windowHours: 24, messages });

    expect(result.skipped).toBe(false);
    if (!result.skipped) {
      expect(result.topics.length).toBe(1);
      expect(result.topics[0]?.bullets).toEqual([{ summary: 'keep', msgId: 1002 }]);
    }
  });
});

describe('summarizeThread LLM failure logging', () => {
  beforeEach(() => {
    openaiCreate.mockReset();
  });

  it('redacts a transport error while retaining its safe class and status', async () => {
    const sentinel = 'REQUEST_PROFILE_SENTINEL_transport_9e0cc4';
    const err = Object.assign(new Error(sentinel), { status: 503 });
    const errorSpy = vi.spyOn(logger, 'error');
    openaiCreate.mockRejectedValueOnce(err);

    const result = await summarizeThread({
      threadId: 777,
      windowHours: 24,
      messages: [sampleMessage()],
    });

    expect(result).toMatchObject({ skipped: true, reason: 'llm-error' });
    const call = errorSpy.mock.calls.at(-1);
    const bindings = call?.[0] as Record<string, unknown>;
    const message = call?.[1] as string;
    expect(bindings).not.toHaveProperty('err');
    expect(bindings).not.toContain(err);
    expect(message).not.toContain(sentinel);
    expect(bindings).toMatchObject({
      errorClass: 'Error',
      status: 503,
      threadId: 777,
      messageCount: 1,
      model: 'openai/gpt-4.1-mini',
    });
  });

  it('redacts LlmSchemaError without serializing the raw error', async () => {
    const sentinel = 'REQUEST_PROFILE_SENTINEL_schema_8fb135';
    const err = new LlmSchemaError(sentinel);
    const warnSpy = vi.spyOn(logger, 'warn');
    openaiCreate.mockRejectedValueOnce(err);

    const result = await summarizeThread({
      threadId: 778,
      windowHours: 24,
      messages: [sampleMessage()],
    });

    expect(result).toMatchObject({ skipped: true, reason: 'schema-invalid' });
    const call = warnSpy.mock.calls.at(-1);
    const bindings = call?.[0] as Record<string, unknown>;
    const message = call?.[1] as string;
    expect(bindings).not.toHaveProperty('err');
    expect(bindings).not.toContain(err);
    expect(message).not.toContain(sentinel);
    expect(bindings).toMatchObject({
      errorClass: 'LlmSchemaError',
      threadId: 778,
      messageCount: 1,
      model: 'openai/gpt-4.1-mini',
    });
    expect(bindings).not.toHaveProperty('status');
  });
});
