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

export async function requestJson<T>(
  config: LlmConfig,
  request: JsonCompletionRequest,
): Promise<T> {
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
  } catch {
    throw new LlmSchemaError(
      `OpenAI-compatible response is not valid JSON (responseLength=${String(content.length)})`,
    );
  }
}
