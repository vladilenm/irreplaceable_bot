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

export interface JsonCompletionRequest extends CompletionRequest {
  schemaName: string;
  schema: Record<string, unknown>;
  retryInstruction?: string;
}

export class LlmSchemaError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'LlmSchemaError';
  }
}

function openAiClient(config: LlmConfig): OpenAI {
  return new OpenAI({
    apiKey: config.apiKey,
    ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
  });
}

const JSON_OBJECT_ONLY = new Set<string>();

function capabilityKey(config: LlmConfig): string {
  return `${config.baseUrl ?? ''}\u0000${config.model}`;
}

function messagesFor(request: JsonCompletionRequest, includeSchema: boolean) {
  const retrySuffix = request.retryInstruction ? `\n\n${request.retryInstruction}` : '';
  const system = includeSchema
    ? `${request.system}${retrySuffix}\n\nIMPORTANT: Output ONLY valid JSON matching this schema:\n${JSON.stringify(request.schema, null, 2)}`
    : `${request.system}${retrySuffix}`;
  return [
    { role: 'system' as const, content: system },
    { role: 'user' as const, content: request.user },
  ];
}

export function _resetLlmCapabilitiesForTests(): void {
  JSON_OBJECT_ONLY.clear();
}

export async function requestJson<T>(
  config: LlmConfig,
  request: JsonCompletionRequest,
): Promise<T> {
  const client = openAiClient(config);
  const cacheKey = capabilityKey(config);
  let response: OpenAI.Chat.ChatCompletion;
  const requestJsonObject = () => client.chat.completions.create({
    model: config.model,
    max_completion_tokens: request.maxTokens,
    reasoning_effort: 'none',
    messages: messagesFor(request, true),
    response_format: { type: 'json_object' },
  });
  if (JSON_OBJECT_ONLY.has(cacheKey)) {
    response = await requestJsonObject();
  } else {
    try {
      response = await client.chat.completions.create({
        model: config.model,
        max_completion_tokens: request.maxTokens,
        reasoning_effort: 'none',
        messages: messagesFor(request, false),
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
      JSON_OBJECT_ONLY.add(cacheKey);
      logger.warn('json_schema response_format rejected (400), falling back to json_object');
      response = await requestJsonObject();
    }
  }

  const content = response.choices[0]?.message?.content ?? '';
  if (content === '') {
    throw new Error('OpenAI-compatible response empty content');
  }
  try {
    return JSON.parse(content) as T;
  } catch {
    throw new LlmSchemaError(
      `OpenAI-compatible response is not valid JSON (responseLength=${String(content.length)})`,
    );
  }
}
