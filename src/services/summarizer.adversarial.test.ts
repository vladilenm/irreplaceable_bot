// Phase 6 Task 3 — Adversarial fixture exercise (D-20..D-23, SUM-05).
// Two assertions:
//  ADV-1: when LLM "succumbs" and returns garbage, Zod last-gate hard-rejects → schema-invalid skip.
//  ADV-2: buildTranscript over the adversarial fixture preserves sandwich integrity,
//          escapes literal TRANSCRIPT_END inside a message, anchors REAFFIRM after the
//          closing delimiter, and does NOT leak any numeric author_id.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import type { CapturedMessage } from '../types/index.js';

const anthropicCreate = vi.fn();
const openaiCreate = vi.fn();

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: anthropicCreate },
  })),
}));

vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(() => ({
    chat: { completions: { create: openaiCreate } },
  })),
}));

import { summarizeThread, buildTranscript } from './summarizer.service.js';

// Parse the adversarial fixture lines `[HH:MM] Name: text` into CapturedMessage rows.
function parseFixture(): CapturedMessage[] {
  const text = readFileSync(
    new URL('../../tests/fixtures/adversarial-transcript.txt', import.meta.url),
    'utf-8',
  );
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  return lines.map((line, i) => {
    const match = /^\[(\d{2}:\d{2})\] ([^:]+): (.+)$/.exec(line);
    if (!match) throw new Error(`Bad fixture line ${i}: ${line}`);
    const hhmm = match[1] as string;
    const name = match[2] as string;
    const body = match[3] as string;
    return {
      chatId: -1001234567890,
      threadId: 100,
      tgMessageId: 1000 + i,
      authorId: 123456789 + i, // numeric — must NOT leak
      authorName: name.trim(),
      isAnonymous: 0,
      text: body,
      replyToMessageId: null,
      createdAt: `2026-04-29T${hhmm}:00.000Z`,
      editedAt: null,
    };
  });
}

describe('Adversarial fixture — prompt-injection resistance (D-20..D-23, SUM-05)', () => {
  beforeEach(() => {
    anthropicCreate.mockReset();
    openaiCreate.mockReset();
  });

  it('ADV-1: jailbreak that bypasses prompt-side defences is hard-rejected by Zod (schema-invalid skip)', async () => {
    // LLM "succumbs" and returns garbage tool-use payload (no topics field at all).
    anthropicCreate.mockResolvedValueOnce({
      content: [
        { type: 'tool_use', name: 'submit_summary', input: { leak: 'pwned' } },
      ],
    });
    openaiCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({ leak: 'pwned' }) } }],
    });

    const messages = parseFixture(); // >=6 messages, <=15k tokens
    const result = await summarizeThread({
      threadId: 100,
      windowHours: 24,
      messages,
    });

    expect(result).toMatchObject({ skipped: true, reason: 'schema-invalid' });
  });

  it('ADV-1b (summary-doc-260607): jailbreak returning valid shape but hallucinated msgId is hard-rejected', async () => {
    // Parsed fixture tgMessageIds start at 1000 and run 1000..1005 (6 messages).
    // LLM "succumbs" and returns a shape-valid topics array whose only bullet
    // cites msgId=42 which is NOT in the input id-set → the bullet is dropped,
    // the topic empties out, and with no topics left the result is a
    // schema-invalid skip (NOT llm-error — model hallucination is a regression
    // signal).
    const validShapeHallucinatedId = {
      topics: [
        { emoji: '💻', title: 'pwn', bullets: [{ summary: 'pwn', msgId: 42 }], links: [] },
      ],
    };
    anthropicCreate.mockResolvedValueOnce({
      content: [
        {
          type: 'tool_use',
          name: 'submit_summary',
          input: validShapeHallucinatedId,
        },
      ],
    });
    openaiCreate.mockResolvedValueOnce({
      choices: [
        {
          message: { content: JSON.stringify(validShapeHallucinatedId) },
        },
      ],
    });

    const messages = parseFixture();
    const result = await summarizeThread({
      threadId: 100,
      windowHours: 24,
      messages,
    });

    expect(result).toMatchObject({ skipped: true, reason: 'schema-invalid' });
  });

  it('ADV-2: buildTranscript enforces sandwich integrity, reaffirm placement, anon contract on adversarial fixture', () => {
    const messages = parseFixture();
    expect(messages.length).toBeGreaterThanOrEqual(6);

    const out = buildTranscript(messages);

    // (1) Exactly one START and one END boundary marker.
    const startMatches = out.match(/<<<TRANSCRIPT_START>>>/g) ?? [];
    const endMatches = out.match(/<<<TRANSCRIPT_END>>>/g) ?? [];
    expect(startMatches.length).toBe(1);
    expect(endMatches.length).toBe(1);

    // (2) All fixture message bodies appear between delimiters in order. The
    // line prefix is now `[id=N HH:MM] Name: ` (quick-260511-fkn) — probe the
    // message TEXT after the `: ` separator, not the line start.
    const startIdx = out.indexOf('<<<TRANSCRIPT_START>>>');
    const endIdx = out.indexOf('<<<TRANSCRIPT_END>>>');
    expect(endIdx).toBeGreaterThan(startIdx);
    const between = out.slice(startIdx, endIdx);
    let cursor = 0;
    for (const m of messages) {
      // Pre-escape probe — strip HTML-meta chars (the formatter escapes them).
      const fragment = m.text.slice(0, 10).replace(/[<>&]/g, '');
      const pos = between.indexOf(fragment, cursor);
      expect(pos).toBeGreaterThanOrEqual(0);
      cursor = pos;
    }

    // (3) REAFFIRM string appears AFTER the closing delimiter (post-transcript reaffirm — D-22).
    const reaffirmIdx = out.indexOf('Reminder: respond ONLY by calling submit_summary');
    expect(reaffirmIdx).toBeGreaterThan(endIdx);

    // (4) Literal `<<<TRANSCRIPT_END>>>` inside any escaped message body — the fixture
    // contains a message with literal `<<<TRANSCRIPT_END>>>` which MUST be HTML-escaped.
    expect(out).toContain('&lt;&lt;&lt;TRANSCRIPT_END&gt;&gt;&gt;');

    // (5) No numeric author_id leaks. parseFixture() assigns ids starting at 123456789.
    for (let i = 0; i < messages.length; i++) {
      const id = String(123456789 + i);
      expect(out).not.toContain(id);
    }

    // (6) quick-260511-fkn: the [id=N ...] prefix DOES appear (numeric tgMessageId
    // is exposed, by design, so the LLM can cite it in topic.firstMessageId).
    expect(out).toContain('[id=1000 ');
  });
});
