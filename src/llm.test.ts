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

import { _resetLlmCapabilitiesForTests, LlmSchemaError, requestJson } from './llm.js';

const baseConfig = {
  apiKey: 'gateway-token',
  baseUrl: 'https://api.timeweb.ai/v1',
  model: 'openai/gpt-5.6-luna',
};

beforeEach(() => {
  openaiConstructor.mockClear();
  openaiCreate.mockReset();
  _resetLlmCapabilitiesForTests();
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
    for (const [input] of openaiCreate.mock.calls) {
      expect(input).toMatchObject({
        model: 'openai/gpt-5.6-luna',
        max_completion_tokens: 100,
        reasoning_effort: 'none',
      });
      expect(input).not.toHaveProperty('max_tokens');
    }
    expect(openaiCreate.mock.calls[1]?.[0]?.response_format).toEqual({
      type: 'json_object',
    });
    expect(openaiConstructor).toHaveBeenCalledWith({
      apiKey: 'gateway-token',
      baseURL: 'https://api.timeweb.ai/v1',
    });
  });

  it('reports malformed JSON with response length without leaking response content', async () => {
    const malformedContent = 'sensitive-profile-DO-NOT-LOG';
    openaiCreate.mockResolvedValueOnce({
      choices: [{ message: { content: malformedContent } }],
    });

    let caught: unknown;
    try {
      await requestJson(baseConfig, {
        system: 'system',
        user: 'user',
        maxTokens: 100,
        schemaName: 'result',
        schema: { type: 'object' },
      });
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(LlmSchemaError);
    const message = (caught as Error).message;
    expect(message).not.toContain(malformedContent);
    expect(message).toContain(`responseLength=${String(malformedContent.length)}`);
  });

  it('remembers a rejected json_schema capability for later requests to the same model', async () => {
    openaiCreate
      .mockRejectedValueOnce(Object.assign(new Error('unsupported'), { status: 400 }))
      .mockResolvedValueOnce({ choices: [{ message: { content: '{"first":true}' } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: '{"second":true}' } }] });

    const request = {
      system: 'system', user: 'user', maxTokens: 100, schemaName: 'result', schema: { type: 'object' },
    };
    await requestJson(baseConfig, request);
    await requestJson(baseConfig, request);

    expect(openaiCreate).toHaveBeenCalledTimes(3);
    expect(openaiCreate.mock.calls[2]?.[0]?.response_format).toEqual({ type: 'json_object' });
  });
});
