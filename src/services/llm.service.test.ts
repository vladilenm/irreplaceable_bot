import { beforeEach, describe, expect, it, vi } from 'vitest';

const { anthropicCreate, openaiCreate } = vi.hoisted(() => ({
  anthropicCreate: vi.fn(),
  openaiCreate: vi.fn(),
}));

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

import { requestJson, requestText } from './llm.service.js';

const baseConfig = {
  apiKey: 'key',
  baseUrl: undefined,
};

beforeEach(() => {
  anthropicCreate.mockReset();
  openaiCreate.mockReset();
});

describe('LLM transport', () => {
  it('normalizes an Anthropic text response', async () => {
    anthropicCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'answer' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 2, output_tokens: 1 },
    });

    const result = await requestText(
      { ...baseConfig, model: 'claude-sonnet' },
      { system: 'system', user: 'user', maxTokens: 100 },
    );

    expect(result.text).toBe('answer');
    expect(result.provider).toBe('anthropic');
    expect(result.finishReason).toBe('end_turn');
  });

  it('falls back from unsupported json_schema to json_object', async () => {
    openaiCreate
      .mockRejectedValueOnce(Object.assign(new Error('unsupported'), { status: 400 }))
      .mockResolvedValueOnce({
        choices: [{ message: { content: '{"ok":true}' } }],
      });

    const result = await requestJson<{ ok: boolean }>(
      { ...baseConfig, model: 'deepseek-chat' },
      {
        system: 'system',
        user: 'user',
        maxTokens: 100,
        schemaName: 'result',
        schema: { type: 'object' },
        anthropicTool: { name: 'submit_result', description: 'Submit result' },
      },
    );

    expect(result).toEqual({ ok: true });
    expect(openaiCreate).toHaveBeenCalledTimes(2);
    expect(openaiCreate.mock.calls[1]?.[0]?.response_format).toEqual({
      type: 'json_object',
    });
  });
});
