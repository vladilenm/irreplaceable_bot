import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { logger } from './logger.js';

export interface LlmConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
}

interface CompletionRequest {
  system: string;
  user: string;
  maxTokens: number;
}

export interface TextCompletion {
  text: string;
  provider: 'anthropic' | 'openai-compatible';
  finishReason: string | null;
  refusal: string | null;
  reasoningContent: string | null;
  toolCallsCount: number;
  usage: unknown;
  choiceJson: string | null;
}

export interface JsonCompletionRequest extends CompletionRequest {
  schemaName: string;
  schema: Record<string, unknown>;
  anthropicTool: {
    name: string;
    description: string;
  };
}

export class LlmSchemaError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'LlmSchemaError';
  }
}

export function providerForModel(
  model: string,
): 'anthropic' | 'openai-compatible' {
  return model.startsWith('claude') ? 'anthropic' : 'openai-compatible';
}

function openAiClient(config: LlmConfig): OpenAI {
  return new OpenAI({
    apiKey: config.apiKey,
    ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
  });
}

export async function requestText(
  config: LlmConfig,
  request: CompletionRequest,
): Promise<TextCompletion> {
  if (providerForModel(config.model) === 'anthropic') {
    const response = await new Anthropic({ apiKey: config.apiKey }).messages.create({
      model: config.model,
      max_tokens: request.maxTokens,
      system: request.system,
      messages: [{ role: 'user', content: request.user }],
    });
    const block = response.content.find((item) => item.type === 'text');
    if (!block || block.type !== 'text') {
      throw new Error('Unexpected Anthropic response: no text block');
    }
    return {
      text: block.text,
      provider: 'anthropic',
      finishReason: response.stop_reason ?? null,
      refusal: null,
      reasoningContent: null,
      toolCallsCount: 0,
      usage: response.usage,
      choiceJson: null,
    };
  }

  const response = await openAiClient(config).chat.completions.create({
    model: config.model,
    max_tokens: request.maxTokens,
    messages: [
      { role: 'system', content: request.system },
      { role: 'user', content: request.user },
    ],
  });
  const choice = response.choices[0];
  const extension = choice?.message as
    | { refusal?: string | null; reasoning_content?: string | null }
    | undefined;
  return {
    text: choice?.message?.content ?? '',
    provider: 'openai-compatible',
    finishReason: choice?.finish_reason ?? null,
    refusal: extension?.refusal ?? null,
    reasoningContent: extension?.reasoning_content?.slice(0, 400) ?? null,
    toolCallsCount: choice?.message?.tool_calls?.length ?? 0,
    usage: response.usage,
    choiceJson: JSON.stringify(choice ?? null).slice(0, 1500),
  };
}

export async function requestJson<T>(
  config: LlmConfig,
  request: JsonCompletionRequest,
): Promise<T> {
  if (providerForModel(config.model) === 'anthropic') {
    const response = await new Anthropic({ apiKey: config.apiKey }).messages.create({
      model: config.model,
      max_tokens: request.maxTokens,
      system: request.system,
      tools: [
        {
          name: request.anthropicTool.name,
          description: request.anthropicTool.description,
          input_schema: request.schema as Anthropic.Tool.InputSchema,
        },
      ],
      tool_choice: { type: 'tool', name: request.anthropicTool.name },
      messages: [{ role: 'user', content: request.user }],
    });
    const block = response.content.find(
      (item) =>
        item.type === 'tool_use' && item.name === request.anthropicTool.name,
    );
    if (!block || block.type !== 'tool_use') {
      throw new Error(
        `Anthropic response missing tool_use block for ${request.anthropicTool.name}`,
      );
    }
    return block.input as T;
  }

  const client = openAiClient(config);
  let response: OpenAI.Chat.ChatCompletion;
  try {
    response = await client.chat.completions.create({
      model: config.model,
      max_tokens: request.maxTokens,
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.user },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: request.schemaName,
          schema: request.schema,
          strict: true,
        },
      },
    });
  } catch (err: unknown) {
    if ((err as { status?: number }).status !== 400) throw err;
    logger.warn('json_schema response_format rejected (400), falling back to json_object');
    response = await client.chat.completions.create({
      model: config.model,
      max_tokens: request.maxTokens,
      messages: [
        {
          role: 'system',
          content: `${request.system}\n\nIMPORTANT: Output ONLY valid JSON matching this schema:\n${JSON.stringify(request.schema, null, 2)}`,
        },
        { role: 'user', content: request.user },
      ],
      response_format: { type: 'json_object' },
    });
  }

  const content = response.choices[0]?.message?.content ?? '';
  if (content === '') {
    throw new Error('OpenAI-compatible response empty content');
  }
  try {
    return JSON.parse(content) as T;
  } catch (cause: unknown) {
    throw new LlmSchemaError(
      `OpenAI-compatible response is not valid JSON (first 100 chars): ${content.slice(0, 100)}`,
      { cause },
    );
  }
}
