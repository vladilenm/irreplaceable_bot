import { beforeEach, describe, expect, it, vi } from 'vitest';

const { openaiConstructor, openaiCreate } = vi.hoisted(() => ({
  openaiConstructor: vi.fn(),
  openaiCreate: vi.fn(),
}));

vi.mock('openai', () => ({
  default: openaiConstructor.mockImplementation(() => ({
    chat: { completions: { create: openaiCreate } },
  })),
}));

import { requestJson } from './llm.js';

const baseConfig = {
  apiKey: 'gateway-token',
  baseUrl: 'https://api.timeweb.ai/v1',
  model: 'openai/gpt-4.1-mini',
};

beforeEach(() => {
  openaiConstructor.mockClear();
  openaiCreate.mockReset();
});

describe('LLM transport', () => {
  it('falls back from unsupported json_schema to json_object', async () => {
    openaiCreate
      .mockRejectedValueOnce(Object.assign(new Error('unsupported'), { status: 400 }))
      .mockResolvedValueOnce({
        choices: [{ message: { content: '{"ok":true}' } }],
      });

    const result = await requestJson<{ ok: boolean }>(
      baseConfig,
      {
        system: 'system',
        user: 'user',
        maxTokens: 100,
        schemaName: 'result',
        schema: { type: 'object' },
      },
    );

    expect(result).toEqual({ ok: true });
    expect(openaiCreate).toHaveBeenCalledTimes(2);
    expect(openaiCreate.mock.calls[1]?.[0]?.response_format).toEqual({
      type: 'json_object',
    });
    expect(openaiConstructor).toHaveBeenCalledWith({
      apiKey: 'gateway-token',
      baseURL: 'https://api.timeweb.ai/v1',
    });
  });
});
