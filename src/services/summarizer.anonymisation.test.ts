// Phase 6 Task 3 — low-volume gate + token gate + threshold-boundary tests.
// Mocks both LLM SDKs at module-load time and asserts the constructors
// are NEVER called when gates fire (SUM-02, SUM-04).
import { describe, it, expect, vi, beforeEach } from 'vitest';
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

import {
  summarizeThread,
  LOW_VOLUME_THRESHOLD,
  TOKEN_LIMIT,
  CHARS_PER_TOKEN,
} from './summarizer.service.js';

const fakeMsg = (i: number, text = 'hi'): CapturedMessage => ({
  chatId: -1,
  threadId: 1,
  tgMessageId: i,
  authorId: 100 + i,
  authorName: `User${i}`,
  isAnonymous: 0,
  text,
  replyToMessageId: null,
  createdAt: '2026-04-29T10:00:00.000Z',
  editedAt: null,
});

describe('summarizeThread gating (SUM-02 + SUM-04)', () => {
  beforeEach(() => {
    anthropicCreate.mockReset();
    openaiCreate.mockReset();
  });

  it('L1: <5 messages returns low-volume skip and does NOT call LLM', async () => {
    const result = await summarizeThread({
      threadId: 1,
      windowHours: 24,
      messages: [fakeMsg(1), fakeMsg(2), fakeMsg(3), fakeMsg(4)],
    });
    expect(result).toMatchObject({ skipped: true, reason: 'low-volume' });
    expect(anthropicCreate).not.toHaveBeenCalled();
    expect(openaiCreate).not.toHaveBeenCalled();
  });

  it('L2: 0 messages returns low-volume skip', async () => {
    const result = await summarizeThread({
      threadId: 1,
      windowHours: 24,
      messages: [],
    });
    expect(result).toMatchObject({ skipped: true, reason: 'low-volume' });
    expect(anthropicCreate).not.toHaveBeenCalled();
    expect(openaiCreate).not.toHaveBeenCalled();
  });

  it(`T1: transcript >${TOKEN_LIMIT} tokens (${TOKEN_LIMIT * CHARS_PER_TOKEN} chars) returns transcript-too-large`, async () => {
    // 6 messages each ~10000 chars → ~60000 chars → ~17143 tokens > 15000
    const bigText = 'а'.repeat(10000);
    const messages = Array.from({ length: 6 }, (_, i) => fakeMsg(i + 1, bigText));
    const result = await summarizeThread({
      threadId: 1,
      windowHours: 24,
      messages,
    });
    expect(result).toMatchObject({ skipped: true, reason: 'transcript-too-large' });
    expect(anthropicCreate).not.toHaveBeenCalled();
    expect(openaiCreate).not.toHaveBeenCalled();
  });

  it('threshold boundary: exactly LOW_VOLUME_THRESHOLD messages does NOT skip on low-volume (would attempt LLM)', async () => {
    // summary-doc-260607: mock LLM returns the bullet-substance shape AND picks
    // msgId from the input id-set so post-validation passes.
    const validShape = {
      topics: [
        { emoji: '💻', title: 't', bullets: [{ summary: 's', msgId: 1 }], links: [] },
      ],
    };
    anthropicCreate.mockResolvedValueOnce({
      content: [
        { type: 'tool_use', name: 'submit_summary', input: validShape },
      ],
    });
    openaiCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify(validShape) } }],
    });
    const messages = Array.from({ length: LOW_VOLUME_THRESHOLD }, (_, i) => fakeMsg(i + 1));
    const result = await summarizeThread({
      threadId: 1,
      windowHours: 24,
      messages,
    });
    if (result.skipped) {
      expect(result.reason).not.toBe('low-volume');
    }
  });
});
