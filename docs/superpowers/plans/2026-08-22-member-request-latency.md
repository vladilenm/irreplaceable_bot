# Member Request Latency Patch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Immediately acknowledge valid `#запрос` messages, replace that acknowledgment with the terminal result, bound AI latency, preserve stage-specific safe errors, log stage durations, and suppress only concurrent duplicate queries from the same author.

**Architecture:** A focused `request.stage.ts` utility owns monotonic timing, timeout/abort, structured stage logs, and safe error classification. `MemberMatcher` wraps embedding, PostgreSQL search, and LLM reranking with that utility; Telegram gains an edit-with-retry primitive; `requests.ts` owns the placeholder lifecycle and a process-local `authorId + queryHash` single-flight set. Existing PostgreSQL schema remains unchanged.

**Tech Stack:** Node.js 22, TypeScript 6, grammY 1.42, OpenAI SDK 6.34, PostgreSQL 16/pgvector, Pino 10, Vitest 1.6.

## Global Constraints

- Valid non-empty requests immediately receive exactly `⏳ Ищу подходящих участников…`.
- Embedding timeout is exactly `15_000` ms; LLM reranking timeout is exactly `60_000` ms.
- PostgreSQL keeps the existing `statement_timeout=10_000` ms.
- Different query text from the same author must still be processed through the shared bounded queue.
- Process-local single-flight suppresses only an identical active `authorId + queryHash`; messages without `authorId` use only Telegram message-id idempotency.
- `processing-failed` must not be persisted by the member-request runtime.
- Logs must not contain query text, profile text, embeddings, prompts, model responses, Telegram message text, or secrets.
- Do not add environment variables or a PostgreSQL migration.
- Preserve the unrelated untracked `.envt` file.

---

## File Structure

- Create `src/request.stage.ts`: matching-stage names, safe codes, typed stage error, monotonic duration logging, timeout, and abort.
- Create `src/request.stage.test.ts`: isolated red/green tests for success, provider failure, timeout, abort, and safe log shape.
- Modify `src/members.ts`: allow an optional `AbortSignal` on embedding calls without changing indexer callers.
- Modify `src/embeddings.ts` and `src/embeddings.test.ts`: pass the signal to the OpenAI SDK only when supplied.
- Modify `src/llm.ts` and `src/llm.test.ts`: pass one signal through both structured-output attempts.
- Modify `src/request.matcher.ts` and `src/request.matcher.test.ts`: wrap embedding, PostgreSQL, and reranking in explicit stages.
- Modify `src/telegram.ts` and `src/telegram.test.ts`: add edit-with-retry and terminal Telegram duration fields.
- Modify `src/request.repository.ts` and `src/request.repository.test.ts`: optionally persist a known placeholder message id on failed requests.
- Modify `src/requests.ts` and `src/requests.test.ts`: immediate acknowledgment, edit lifecycle, safe codes, and in-memory duplicate suppression.
- Modify `src/runtime-defaults.ts`, `src/types.ts`, `src/config.ts`, `src/config.request-matching.test.ts`, `src/request.runtime.ts`, `src/request.runtime.test.ts`, and `src/application.test.ts`: carry fixed timeout defaults into the matcher.
- Modify `docs/architecture.md`: document the bounded pipeline and process-local duplicate semantics.

---

### Task 1: Matching Stage Boundary

**Files:**
- Create: `src/request.stage.ts`
- Create: `src/request.stage.test.ts`

**Interfaces:**
- Produces: `MatchingStage = 'embedding' | 'postgres' | 'reranking'`
- Produces: `MatchingErrorCode = 'embedding-timeout' | 'embedding-failed' | 'postgres-failed' | 'reranking-timeout' | 'reranking-failed'`
- Produces: `RequestStageError` with readonly `stage` and `code`
- Produces: `runRequestStage<T>(options: RunRequestStageOptions<T>): Promise<T>`

- [ ] **Step 1: Write failing stage-runner tests**

Create `src/request.stage.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from './logger.js';
import {
  RequestStageError,
  runRequestStage,
} from './request.stage.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('runRequestStage', () => {
  it('returns the value and logs a safe monotonic duration', async () => {
    const info = vi.spyOn(logger, 'info');
    const ticks = [10, 22.6];

    await expect(runRequestStage({
      stage: 'postgres',
      clock: () => ticks.shift() ?? 22.6,
      operation: async () => ['member'],
    })).resolves.toEqual(['member']);

    expect(info).toHaveBeenCalledWith({
      pipeline: 'member-request',
      stage: 'postgres',
      durationMs: 13,
      outcome: 'ok',
    }, 'Member request stage completed');
  });

  it('wraps provider failures with a stage-specific safe code', async () => {
    const error = vi.spyOn(logger, 'error');
    const providerError = Object.assign(new Error('sensitive provider text'), { status: 503 });

    await expect(runRequestStage({
      stage: 'embedding',
      operation: async () => { throw providerError; },
    })).rejects.toMatchObject<RequestStageError>({
      stage: 'embedding',
      code: 'embedding-failed',
    });

    const binding = error.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(binding).toMatchObject({
      pipeline: 'member-request',
      stage: 'embedding',
      outcome: 'failed',
      status: 503,
    });
    expect(JSON.stringify(binding)).not.toContain('sensitive provider text');
  });

  it('aborts and returns the timeout code at the configured boundary', async () => {
    vi.useFakeTimers();
    let receivedSignal: AbortSignal | undefined;
    const promise = runRequestStage({
      stage: 'reranking',
      timeoutMs: 60_000,
      operation: (signal) => {
        receivedSignal = signal;
        return new Promise<never>(() => undefined);
      },
    });
    const rejection = expect(promise).rejects.toMatchObject<RequestStageError>({
      stage: 'reranking',
      code: 'reranking-timeout',
    });

    await vi.advanceTimersByTimeAsync(60_000);
    await rejection;
    expect(receivedSignal?.aborted).toBe(true);
  });
});
```

- [ ] **Step 2: Run the new test and verify red**

Run: `npx vitest run src/request.stage.test.ts`

Expected: FAIL because `src/request.stage.ts` does not exist.

- [ ] **Step 3: Implement the stage runner**

Create `src/request.stage.ts`:

```ts
import { performance } from 'node:perf_hooks';
import { logger, safeErrorMetadata } from './logger.js';

export type MatchingStage = 'embedding' | 'postgres' | 'reranking';
export type MatchingErrorCode =
  | 'embedding-timeout'
  | 'embedding-failed'
  | 'postgres-failed'
  | 'reranking-timeout'
  | 'reranking-failed';

const failedCode: Record<MatchingStage, MatchingErrorCode> = {
  embedding: 'embedding-failed',
  postgres: 'postgres-failed',
  reranking: 'reranking-failed',
};

const timeoutCode: Partial<Record<MatchingStage, MatchingErrorCode>> = {
  embedding: 'embedding-timeout',
  reranking: 'reranking-timeout',
};

export class RequestStageError extends Error {
  constructor(
    readonly stage: MatchingStage,
    readonly code: MatchingErrorCode,
    options?: ErrorOptions,
  ) {
    super(`Member request ${stage} stage failed`, options);
    this.name = 'RequestStageError';
  }
}

export interface RunRequestStageOptions<T> {
  stage: MatchingStage;
  timeoutMs?: number;
  operation(signal: AbortSignal): Promise<T>;
  clock?: () => number;
}

function elapsedMs(startedAt: number, clock: () => number): number {
  return Math.max(0, Math.round(clock() - startedAt));
}

export async function runRequestStage<T>(
  options: RunRequestStageOptions<T>,
): Promise<T> {
  const clock = options.clock ?? (() => performance.now());
  const startedAt = clock();
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;

  try {
    const operation = options.operation(controller.signal);
    const result = options.timeoutMs === undefined
      ? await operation
      : await Promise.race([
          operation,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              timedOut = true;
              controller.abort();
              reject(new Error('stage timeout'));
            }, options.timeoutMs);
            timer.unref();
          }),
        ]);
    logger.info({
      pipeline: 'member-request',
      stage: options.stage,
      durationMs: elapsedMs(startedAt, clock),
      outcome: 'ok',
    }, 'Member request stage completed');
    return result;
  } catch (cause: unknown) {
    const code = timedOut
      ? timeoutCode[options.stage] ?? failedCode[options.stage]
      : failedCode[options.stage];
    logger.error({
      pipeline: 'member-request',
      stage: options.stage,
      durationMs: elapsedMs(startedAt, clock),
      outcome: timedOut ? 'timeout' : 'failed',
      ...safeErrorMetadata(cause),
    }, 'Member request stage failed');
    throw new RequestStageError(options.stage, code, { cause });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
```

- [ ] **Step 4: Run focused tests and typecheck**

Run: `npx vitest run src/request.stage.test.ts src/logger.test.ts && npm run typecheck`

Expected: PASS with 0 failed tests and TypeScript exit code 0.

- [ ] **Step 5: Commit the stage boundary**

```bash
git add src/request.stage.ts src/request.stage.test.ts
git commit -m "feat: bound and classify request stages"
```

---

### Task 2: Abortable Matcher Stages

**Files:**
- Modify: `src/members.ts`
- Modify: `src/embeddings.ts`
- Modify: `src/embeddings.test.ts`
- Modify: `src/llm.ts`
- Modify: `src/llm.test.ts`
- Modify: `src/request.matcher.ts`
- Modify: `src/request.matcher.test.ts`

**Interfaces:**
- Consumes: `runRequestStage<T>()` and `RequestStageError` from Task 1
- Changes: `EmbeddingProvider.embed(texts, signal?)`
- Produces: `RequestJsonOptions { signal?: AbortSignal }`
- Changes: `requestJson(config, request, options?)`
- Changes: `MemberMatcher` dependencies include exact `embeddingTimeoutMs` and `rerankingTimeoutMs`

- [ ] **Step 1: Add failing adapter tests for `AbortSignal`**

Append to `src/embeddings.test.ts`:

```ts
it('passes an AbortSignal to the OpenAI embedding request', async () => {
  const create = vi.fn().mockResolvedValue({
    model: 'model',
    data: [{ index: 0, embedding: [1, 0] }],
  });
  const provider = new OpenAiEmbeddingProvider({
    apiKey: 'key',
    baseUrl: 'https://api.timeweb.ai/v1',
    model: 'model',
    dimensions: 2,
    client: { embeddings: { create } },
  });
  const controller = new AbortController();

  await provider.embed(['query'], controller.signal);

  expect(create).toHaveBeenCalledWith(expect.any(Object), {
    signal: controller.signal,
  });
});
```

Append to `src/llm.test.ts`:

```ts
it('passes the same AbortSignal through the schema fallback', async () => {
  openaiCreate
    .mockRejectedValueOnce(Object.assign(new Error('unsupported'), { status: 400 }))
    .mockResolvedValueOnce({ choices: [{ message: { content: '{"ok":true}' } }] });
  const controller = new AbortController();

  await requestJson(baseConfig, {
    system: 'system',
    user: 'user',
    maxTokens: 100,
    schemaName: 'result',
    schema: { type: 'object' },
  }, { signal: controller.signal });

  expect(openaiCreate).toHaveBeenNthCalledWith(1, expect.any(Object), {
    signal: controller.signal,
  });
  expect(openaiCreate).toHaveBeenNthCalledWith(2, expect.any(Object), {
    signal: controller.signal,
  });
});
```

- [ ] **Step 2: Add failing matcher classification and timeout tests**

Update `matcherFor` in `src/request.matcher.test.ts` to pass:

```ts
embeddingTimeoutMs: 15_000,
rerankingTimeoutMs: 60_000,
```

Replace the existing provider-failure test and add timeout coverage:

```ts
it.each([
  ['embedding', 'embedding-failed'],
  ['postgres', 'postgres-failed'],
  ['reranking', 'reranking-failed'],
] as const)('classifies a %s failure without running later stages', async (stage, code) => {
  const setup = matcherFor({ matches: [] });
  if (stage === 'embedding') setup.embeddings.embed.mockRejectedValue(new Error('down'));
  if (stage === 'postgres') vi.mocked(setup.members.search).mockRejectedValue(new Error('down'));
  if (stage === 'reranking') setup.requestJsonFn.mockRejectedValue(new Error('down'));

  await expect(setup.matcher.match('Ищу эксперта')).rejects.toMatchObject({ code });
  if (stage === 'embedding') {
    expect(setup.members.search).not.toHaveBeenCalled();
    expect(setup.requestJsonFn).not.toHaveBeenCalled();
  }
  if (stage === 'postgres') expect(setup.requestJsonFn).not.toHaveBeenCalled();
});

it('times out query embedding after 15 seconds and aborts the provider', async () => {
  vi.useFakeTimers();
  const setup = matcherFor({ matches: [] });
  let signal: AbortSignal | undefined;
  setup.embeddings.embed.mockImplementation((_texts, receivedSignal) => {
    signal = receivedSignal;
    return new Promise<never>(() => undefined);
  });
  const promise = setup.matcher.match('Ищу эксперта');
  const rejection = expect(promise).rejects.toMatchObject({ code: 'embedding-timeout' });

  await vi.advanceTimersByTimeAsync(15_000);
  await rejection;
  expect(signal?.aborted).toBe(true);
  expect(setup.members.search).not.toHaveBeenCalled();
  vi.useRealTimers();
});

it('times out reranking after 60 seconds', async () => {
  vi.useFakeTimers();
  const setup = matcherFor({ matches: [] });
  setup.requestJsonFn.mockImplementation(() => new Promise<never>(() => undefined));
  const promise = setup.matcher.match('Ищу эксперта');
  const rejection = expect(promise).rejects.toMatchObject({ code: 'reranking-timeout' });

  await vi.advanceTimersByTimeAsync(60_000);
  await rejection;
  vi.useRealTimers();
});
```

- [ ] **Step 3: Run adapter and matcher tests to verify red**

Run: `npx vitest run src/embeddings.test.ts src/llm.test.ts src/request.matcher.test.ts`

Expected: FAIL because the adapters do not accept signals and matcher errors are not stage-classified.

- [ ] **Step 4: Make embedding calls abortable**

Change `EmbeddingProvider` in `src/members.ts`:

```ts
export interface EmbeddingProvider {
  readonly model: string;
  embed(texts: readonly string[], signal?: AbortSignal): Promise<readonly number[][]>;
}
```

Change the embedding client signature and request in `src/embeddings.ts`:

```ts
interface EmbeddingClient {
  embeddings: {
    create(input: {
      model: string;
      input: string[];
      encoding_format: 'float';
      dimensions: number;
    }, options?: { signal?: AbortSignal }): Promise<{
      model: string;
      data: Array<{ index: number; embedding: number[] }>;
    }>;
  };
}

async embed(
  texts: readonly string[],
  signal?: AbortSignal,
): Promise<readonly number[][]> {
  if (texts.length === 0) return [];
  const input = {
    model: this.model,
    input: [...texts],
    encoding_format: 'float' as const,
    dimensions: this.dimensions,
  };
  const response = signal === undefined
    ? await this.client.embeddings.create(input)
    : await this.client.embeddings.create(input, { signal });
  const ordered = [...response.data].sort((left, right) => left.index - right.index);
  if (ordered.length !== texts.length) {
    throw new Error('OpenAI returned invalid embedding count');
  }
  return ordered.map((row, index) => {
    if (row.index !== index || row.embedding.some((value) => !Number.isFinite(value))) {
      throw new Error(`OpenAI returned invalid embedding at index=${String(index)}`);
    }
    if (row.embedding.length !== this.dimensions) {
      throw new Error(
        `OpenAI returned invalid embedding at index=${String(index)}: expected ${String(this.dimensions)} dimensions, received ${String(row.embedding.length)}`,
      );
    }
    return row.embedding;
  });
}
```

- [ ] **Step 5: Make both LLM attempts abortable**

Add and use the options type in `src/llm.ts`:

```ts
export interface RequestJsonOptions {
  signal?: AbortSignal;
}

export async function requestJson<T>(
  config: LlmConfig,
  request: JsonCompletionRequest,
  options: RequestJsonOptions = {},
): Promise<T> {
  const client = openAiClient(config);
  const requestOptions = options.signal === undefined
    ? undefined
    : { signal: options.signal };
  const create = (input: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming) =>
    requestOptions === undefined
      ? client.chat.completions.create(input)
      : client.chat.completions.create(input, requestOptions);
}
```

Use `response = await create({ ... })` for the current `json_schema` request and for the existing `json_object` fallback. Do not change the `status === 400` fallback condition, the empty-content check, or the `LlmSchemaError` parsing branch.

- [ ] **Step 6: Wrap the three matcher stages**

In `src/request.matcher.ts`, change `RequestJsonFn` and constructor dependencies:

```ts
import { runRequestStage } from './request.stage.js';
import type { RequestJsonOptions } from './llm.js';

type RequestJsonFn = <T>(
  config: LlmConfig,
  request: JsonCompletionRequest,
  options?: RequestJsonOptions,
) => Promise<T>;

constructor(private readonly deps: {
  embeddings: EmbeddingProvider;
  members: Pick<MemberRepository, 'search'>;
  llm: LlmConfig;
  embeddingTimeoutMs: number;
  rerankingTimeoutMs: number;
  requestJsonFn?: RequestJsonFn;
}) {}
```

Replace the beginning and LLM call of `match` with explicit boundaries:

```ts
const vector = await runRequestStage({
  stage: 'embedding',
  timeoutMs: this.deps.embeddingTimeoutMs,
  operation: async (signal) => {
    const vectors = await this.deps.embeddings.embed([query], signal);
    const queryVector = vectors[0];
    if (!queryVector || queryVector.length === 0 ||
        queryVector.some((value) => !Number.isFinite(value))) {
      throw new Error('Query embedding missing');
    }
    return queryVector;
  },
});
const shortlist = await runRequestStage({
  stage: 'postgres',
  operation: () => this.deps.members.search(
    vector,
    this.deps.embeddings.model,
    20,
    requesterUsername,
  ),
});
if (shortlist.length < 3) return [];
```

Leave the current `JsonCompletionRequest` construction byte-for-byte unchanged. Replace only the current `requestFn` invocation with:

```ts
const requestFn = this.deps.requestJsonFn ?? requestJson;
const raw = await runRequestStage({
  stage: 'reranking',
  timeoutMs: this.deps.rerankingTimeoutMs,
  operation: (signal) => requestFn<unknown>(this.deps.llm, request, { signal }),
});
```

The existing `MemberMatchSchema.safeParse`, shortlist ID lookup, duplicate filtering, normalized evidence containment, and 3–5 final gate remain directly below this block with no behavioral changes.

- [ ] **Step 7: Run matcher, adapter, and existing indexer tests**

Run: `npx vitest run src/request.stage.test.ts src/embeddings.test.ts src/llm.test.ts src/request.matcher.test.ts src/member-directory.service.test.ts`

Expected: PASS with timeout tests completing under fake timers and the indexer still calling `embed(batch)` without a signal.

- [ ] **Step 8: Commit abortable matcher stages**

```bash
git add src/members.ts src/embeddings.ts src/embeddings.test.ts src/llm.ts src/llm.test.ts src/request.matcher.ts src/request.matcher.test.ts
git commit -m "feat: time out member matching AI stages"
```

---

### Task 3: Telegram Edit and Duration Logging

**Files:**
- Modify: `src/telegram.ts`
- Modify: `src/telegram.test.ts`

**Interfaces:**
- Produces: `EditMessageParams`
- Produces: `editMessageWithRetry(api, params)`
- Changes: `SendMessageParams` accepts `operation?: 'send' | 'ack'`
- Produces: terminal Telegram log fields `stage`, `operation`, `durationMs`, and `outcome`

- [ ] **Step 1: Add failing edit and duration tests**

Extend the hoisted mock and API in `src/telegram.test.ts`:

```ts
const { mockSendMessage, mockEditMessageText } = vi.hoisted(() => ({
  mockSendMessage: vi.fn(),
  mockEditMessageText: vi.fn(),
}));
const api = {
  sendMessage: mockSendMessage,
  editMessageText: mockEditMessageText,
} as unknown as Api;
```

Import `editMessageWithRetry` and add:

```ts
it('logs acknowledgment duration without logging message text', async () => {
  const info = vi.spyOn(logger, 'info');
  mockSendMessage.mockResolvedValue({ message_id: 88 });

  await sendMessageWithRetry(api, {
    chatId: -100,
    threadId: 42,
    replyToMessageId: 77,
    text: 'sensitive request result',
    parseMode: 'HTML',
    pipeline: 'member-request',
    operation: 'ack',
  });

  const binding = info.mock.calls.at(-1)?.[0] as Record<string, unknown>;
  expect(binding).toMatchObject({
    pipeline: 'member-request',
    stage: 'telegram',
    operation: 'ack',
    outcome: 'ok',
    messageId: 77,
  });
  expect(binding.durationMs).toEqual(expect.any(Number));
  expect(JSON.stringify(binding)).not.toContain('sensitive request result');
});

it('edits a message and retries once while preserving duration metadata', async () => {
  vi.useFakeTimers();
  const info = vi.spyOn(logger, 'info');
  mockEditMessageText
    .mockRejectedValueOnce(new Error('flaky'))
    .mockResolvedValueOnce({ message_id: 88 });

  const promise = editMessageWithRetry(api, {
    chatId: -100,
    threadId: 42,
    messageId: 88,
    text: 'final result',
    parseMode: 'HTML',
    pipeline: 'member-request',
  });
  await vi.advanceTimersByTimeAsync(3_000);
  await expect(promise).resolves.toMatchObject({ message_id: 88 });

  expect(mockEditMessageText).toHaveBeenCalledWith(-100, 88, 'final result', {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
  });
  const binding = info.mock.calls.at(-1)?.[0] as Record<string, unknown>;
  expect(binding).toMatchObject({
    stage: 'telegram',
    operation: 'edit',
    outcome: 'ok',
    messageId: 88,
  });
});

it('logs one terminal failed edit duration after both attempts fail', async () => {
  vi.useFakeTimers();
  const fatal = vi.spyOn(logger, 'fatal');
  mockEditMessageText
    .mockRejectedValueOnce(new Error('first'))
    .mockRejectedValueOnce(new Error('second'));

  const promise = editMessageWithRetry(api, {
    chatId: -100,
    threadId: 42,
    messageId: 88,
    text: 'final result',
    parseMode: 'HTML',
    pipeline: 'member-request',
  });
  const rejection = expect(promise).rejects.toThrow('second');
  await vi.advanceTimersByTimeAsync(3_000);
  await rejection;

  const binding = fatal.mock.calls.at(-1)?.[0] as Record<string, unknown>;
  expect(binding).toMatchObject({
    stage: 'telegram',
    operation: 'edit',
    outcome: 'failed',
    messageId: 88,
  });
  expect(binding.durationMs).toEqual(expect.any(Number));
});
```

- [ ] **Step 2: Run Telegram tests and verify red**

Run: `npx vitest run src/telegram.test.ts`

Expected: FAIL because `editMessageWithRetry` and duration metadata do not exist.

- [ ] **Step 3: Add terminal duration fields to send**

In `src/telegram.ts`, import `performance`, add `operation`, and create the binding once:

```ts
import { performance } from 'node:perf_hooks';

export interface SendMessageParams {
  chatId: number;
  threadId: number;
  text: string;
  parseMode: 'HTML';
  replyToMessageId?: number;
  pipeline?: SendMessagePipeline;
  operation?: 'send' | 'ack';
}

const durationMs = (startedAt: number): number =>
  Math.max(0, Math.round(performance.now() - startedAt));
```

At the start of `sendMessageWithRetry`, record `startedAt` and use:

```ts
const logBinding = {
  chatId: params.chatId,
  threadId: params.threadId,
  messageId: params.replyToMessageId,
  pipeline: params.pipeline,
  stage: 'telegram',
  operation: params.operation ?? 'send',
};
```

Use these exact bindings on the three terminal branches:

```ts
logger.info(
  { ...logBinding, durationMs: durationMs(startedAt), outcome: 'ok' },
  'Telegram sendMessage ok',
);
logger.info(
  { ...logBinding, durationMs: durationMs(startedAt), outcome: 'ok' },
  'Telegram sendMessage ok (after retry)',
);
logger.fatal(
  {
    ...logBinding,
    err: retryErr,
    durationMs: durationMs(startedAt),
    outcome: 'failed',
  },
  `Telegram sendMessage failed after retry: ${describeSendError(retryErr, params.chatId, params.threadId)}`,
);
```

The first-failure diagnostic and one 3-second retry remain non-terminal and therefore do not emit another `outcome` event.

- [ ] **Step 4: Implement edit with the same retry contract**

Append to `src/telegram.ts`:

```ts
export interface EditMessageParams {
  chatId: number;
  threadId: number;
  messageId: number;
  text: string;
  parseMode: 'HTML';
  pipeline?: SendMessagePipeline;
}

type EditedMessage = Awaited<ReturnType<Api['editMessageText']>>;

function attemptEdit(api: Api, params: EditMessageParams): Promise<EditedMessage> {
  return api.editMessageText(params.chatId, params.messageId, params.text, {
    parse_mode: params.parseMode,
    link_preview_options: { is_disabled: true },
  });
}

export async function editMessageWithRetry(
  api: Api,
  params: EditMessageParams,
): Promise<EditedMessage> {
  const startedAt = performance.now();
  const binding = {
    chatId: params.chatId,
    threadId: params.threadId,
    messageId: params.messageId,
    pipeline: params.pipeline,
    stage: 'telegram',
    operation: 'edit',
  };
  try {
    const edited = await attemptEdit(api, params);
    logger.info({ ...binding, durationMs: durationMs(startedAt), outcome: 'ok' },
      'Telegram editMessageText ok');
    return edited;
  } catch (err: unknown) {
    logger.error({ ...binding, err }, 'Telegram editMessageText failed, retrying in 3s');
    await delay(RETRY_DELAY_MS);
    try {
      const edited = await attemptEdit(api, params);
      logger.info({ ...binding, durationMs: durationMs(startedAt), outcome: 'ok' },
        'Telegram editMessageText ok (after retry)');
      return edited;
    } catch (retryErr: unknown) {
      logger.fatal({
        ...binding,
        err: retryErr,
        durationMs: durationMs(startedAt),
        outcome: 'failed',
      }, 'Telegram editMessageText failed after retry');
      throw retryErr;
    }
  }
}
```

- [ ] **Step 5: Run Telegram and sender regression tests**

Run: `npx vitest run src/telegram.test.ts src/summary.sender.test.ts src/radar.sender.test.ts`

Expected: PASS; existing send retry behavior remains intact and new edit coverage passes.

- [ ] **Step 6: Commit Telegram edit support**

```bash
git add src/telegram.ts src/telegram.test.ts
git commit -m "feat: edit request replies with Telegram timing"
```

---

### Task 4: Persist Placeholder IDs on Failure

**Files:**
- Modify: `src/request.repository.ts`
- Modify: `src/request.repository.test.ts`

**Interfaces:**
- Changes: `RequestRepository.fail(chatId, messageId, errorCode, completedAt, responseMessageId?)`
- Keeps all existing four-argument callers source-compatible.

- [ ] **Step 1: Write a failing repository test**

Append to `src/request.repository.test.ts`:

```ts
it('persists the placeholder id with a stage-specific failure code', async () => {
  await repo.reserve(input);

  await repo.fail(
    -1001,
    77,
    'embedding-timeout',
    '2026-08-21T10:00:15.000Z',
    88,
  );

  await expect(repo.read(-1001, 77)).resolves.toEqual({
    status: 'failed',
    matchCount: 0,
    responseMessageId: 88,
    errorCode: 'embedding-timeout',
  });
});
```

- [ ] **Step 2: Run the repository test and verify red**

Run: `npx vitest run src/request.repository.test.ts`

Expected: FAIL because the fifth argument is ignored and `responseMessageId` remains null.

- [ ] **Step 3: Extend the repository contract without a migration**

Change the interface and implementation signature in `src/request.repository.ts`:

```ts
fail(
  chatId: number,
  messageId: number,
  errorCode: string,
  completedAt: string,
  responseMessageId?: number,
): Promise<void>;
```

Use this update in `PgRequestRepository.fail`:

```ts
await this.db.query(`
  UPDATE member_requests
  SET status = 'failed', error_code = $3, completed_at = $4,
    response_message_id = COALESCE($5, response_message_id)
  WHERE chat_id = $1 AND tg_message_id = $2 AND status = 'processing'
`, [chatId, messageId, errorCode, completedAt, responseMessageId ?? null]);
```

- [ ] **Step 4: Run repository and migration tests**

Run: `npx vitest run src/request.repository.test.ts src/db/migrations.test.ts`

Expected: PASS without adding a schema migration.

- [ ] **Step 5: Commit failure persistence**

```bash
git add src/request.repository.ts src/request.repository.test.ts
git commit -m "feat: retain failed request placeholders"
```

---

### Task 5: Immediate Placeholder and Process-Local Duplicate Guard

**Files:**
- Modify: `src/requests.ts`
- Modify: `src/requests.test.ts`

**Interfaces:**
- Consumes: `RequestStageError` from Task 1
- Consumes: `editMessageWithRetry` from Task 3
- Consumes: optional fifth `responseMessageId` argument from Task 4
- Changes: `RequestHandlerOptions` accepts injectable `edit`
- Preserves: `registerRequestHandlers(bot, options)` and existing queue limits

- [ ] **Step 1: Change the handler test harness for send plus edit**

In `src/requests.test.ts`, import `RequestStageError` and `editMessageWithRetry`, then add `edit` to the existing `register` option type and forwarded handler options:

```ts
edit?: typeof editMessageWithRetry;

// Inside registerRequestHandlers(...):
edit: options.edit,
```

Make the default send/edit fakes return distinct Telegram results:

```ts
const send = vi.fn().mockResolvedValue({ message_id: 88 }) as unknown as typeof sendMessageWithRetry;
const edit = vi.fn().mockResolvedValue({ message_id: 88 }) as unknown as typeof editMessageWithRetry;
```

- [ ] **Step 2: Write failing placeholder lifecycle tests**

Replace the old result-send assertions with:

```ts
it('sends the placeholder before matching and edits it with the result', async () => {
  const repository = requestRepository();
  const matcher = { match: vi.fn().mockResolvedValue(matches) } as Pick<MemberMatcher, 'match'>;
  const send = vi.fn().mockResolvedValue({ message_id: 88 }) as unknown as typeof sendMessageWithRetry;
  const edit = vi.fn().mockResolvedValue({ message_id: 88 }) as unknown as typeof editMessageWithRetry;
  const handler = register({ repository, matcher, send, edit });

  await handler(context({
    text: '#запрос Ищу эксперта',
    entities: [{ type: 'hashtag', offset: 0, length: 7 }],
  }), vi.fn().mockResolvedValue(undefined));

  await vi.waitFor(() => expect(repository.complete).toHaveBeenCalledTimes(1));
  expect(send).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
    text: '⏳ Ищу подходящих участников…',
    replyToMessageId: 77,
    operation: 'ack',
  }));
  expect(send.mock.invocationCallOrder[0]).toBeLessThan(matcher.match.mock.invocationCallOrder[0]!);
  expect(edit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
    messageId: 88,
    text: expect.stringContaining('@anna_product'),
  }));
  expect(repository.complete).toHaveBeenCalledWith(-1001, 77, expect.objectContaining({
    responseMessageId: 88,
    matchCount: 3,
  }));
});

it('edits the placeholder for no-match without sending another reply', async () => {
  const repository = requestRepository();
  const matcher = { match: vi.fn().mockResolvedValue([]) } as Pick<MemberMatcher, 'match'>;
  const send = vi.fn().mockResolvedValue({ message_id: 88 }) as unknown as typeof sendMessageWithRetry;
  const edit = vi.fn().mockResolvedValue({ message_id: 88 }) as unknown as typeof editMessageWithRetry;
  const handler = register({ repository, matcher, send, edit });

  await handler(context({
    text: '#запрос Ищу эксперта',
    entities: [{ type: 'hashtag', offset: 0, length: 7 }],
  }), vi.fn().mockResolvedValue(undefined));

  await vi.waitFor(() => expect(repository.noMatch).toHaveBeenCalledTimes(1));
  expect(send).toHaveBeenCalledTimes(1);
  expect(edit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
    messageId: 88,
    text: 'Не удалось найти минимум трёх надёжно подходящих участников.',
  }));
});
```

- [ ] **Step 3: Write failing safe-code and final-edit tests**

Add:

```ts
it.each([
  ['embedding', 'embedding-timeout'],
  ['postgres', 'postgres-failed'],
  ['reranking', 'reranking-timeout'],
] as const)('persists the safe %s stage code', async (stage, code) => {
  const repository = requestRepository();
  const matcher = {
    match: vi.fn().mockRejectedValue(new RequestStageError(stage, code)),
  } as Pick<MemberMatcher, 'match'>;
  const send = vi.fn().mockResolvedValue({ message_id: 88 }) as unknown as typeof sendMessageWithRetry;
  const edit = vi.fn().mockResolvedValue({ message_id: 88 }) as unknown as typeof editMessageWithRetry;
  const handler = register({ repository, matcher, send, edit });

  await handler(context({
    text: '#запрос Ищу эксперта',
    entities: [{ type: 'hashtag', offset: 0, length: 7 }],
  }), vi.fn().mockResolvedValue(undefined));

  await vi.waitFor(() => expect(repository.fail).toHaveBeenCalledWith(
    -1001, 77, code, expect.any(String), 88,
  ));
  expect(edit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
    text: 'Подбор участников временно недоступен. Попробуйте отправить новый запрос позже.',
  }));
});

it('persists telegram-edit-failed when a successful result cannot replace the placeholder', async () => {
  const repository = requestRepository();
  const send = vi.fn().mockResolvedValue({ message_id: 88 }) as unknown as typeof sendMessageWithRetry;
  const edit = vi.fn().mockRejectedValue(new Error('telegram down')) as unknown as typeof editMessageWithRetry;
  const handler = register({ repository, send, edit });

  await handler(context({
    text: '#запрос Ищу эксперта',
    entities: [{ type: 'hashtag', offset: 0, length: 7 }],
  }), vi.fn().mockResolvedValue(undefined));

  await vi.waitFor(() => expect(repository.fail).toHaveBeenCalledWith(
    -1001, 77, 'telegram-edit-failed', expect.any(String), 88,
  ));
  expect(repository.complete).not.toHaveBeenCalled();
});

it('preserves the matcher stage code when the safe error edit also fails', async () => {
  const repository = requestRepository();
  const matcher = {
    match: vi.fn().mockRejectedValue(
      new RequestStageError('embedding', 'embedding-timeout'),
    ),
  } as Pick<MemberMatcher, 'match'>;
  const send = vi.fn().mockResolvedValue({ message_id: 88 }) as unknown as typeof sendMessageWithRetry;
  const edit = vi.fn().mockRejectedValue(new Error('telegram down')) as unknown as typeof editMessageWithRetry;
  const handler = register({ repository, matcher, send, edit });

  await handler(context({
    text: '#запрос Ищу эксперта',
    entities: [{ type: 'hashtag', offset: 0, length: 7 }],
  }), vi.fn().mockResolvedValue(undefined));

  await vi.waitFor(() => expect(repository.fail).toHaveBeenCalledWith(
    -1001, 77, 'embedding-timeout', expect.any(String), 88,
  ));
  expect(repository.fail).not.toHaveBeenCalledWith(
    -1001, 77, 'telegram-edit-failed', expect.any(String), 88,
  );
});

it('persists telegram-ack-failed when the placeholder cannot be sent', async () => {
  const repository = requestRepository();
  const matcher = { match: vi.fn() } as Pick<MemberMatcher, 'match'>;
  const send = vi.fn().mockRejectedValue(new Error('telegram down')) as unknown as typeof sendMessageWithRetry;
  const handler = register({ repository, matcher, send });

  await handler(context({
    text: '#запрос Ищу эксперта',
    entities: [{ type: 'hashtag', offset: 0, length: 7 }],
  }), vi.fn().mockResolvedValue(undefined));

  expect(repository.fail).toHaveBeenCalledWith(
    -1001, 77, 'telegram-ack-failed', expect.any(String),
  );
  expect(matcher.match).not.toHaveBeenCalled();
});
```

- [ ] **Step 4: Write failing duplicate and different-query tests**

Add:

```ts
it('runs only one active identical query for the same author', async () => {
  let finishFirst: ((value: PublicMemberMatch[]) => void) | undefined;
  const pending = new Promise<PublicMemberMatch[]>((resolve) => { finishFirst = resolve; });
  const repository = requestRepository();
  const matcher = { match: vi.fn(() => pending) } as Pick<MemberMatcher, 'match'>;
  const send = vi.fn()
    .mockResolvedValueOnce({ message_id: 88 })
    .mockResolvedValueOnce({ message_id: 89 }) as unknown as typeof sendMessageWithRetry;
  const edit = vi.fn().mockResolvedValue({ message_id: 88 }) as unknown as typeof editMessageWithRetry;
  const handler = register({ repository, matcher, send, edit });
  const request = (messageId: number, text = '#запрос Ищу эксперта') => context({
    messageId,
    text,
    entities: [{ type: 'hashtag', offset: 0, length: 7 }],
  });

  await handler(request(77), vi.fn().mockResolvedValue(undefined));
  await vi.waitFor(() => expect(matcher.match).toHaveBeenCalledTimes(1));
  await handler(request(78), vi.fn().mockResolvedValue(undefined));

  expect(matcher.match).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
    text: 'Такой запрос уже обрабатывается.',
  }));
  expect(repository.fail).toHaveBeenCalledWith(
    -1001, 78, 'duplicate-in-flight', expect.any(String), 89,
  );
  finishFirst?.(matches);
});

it('processes different active queries from the same author', async () => {
  const repository = requestRepository();
  const matcher = { match: vi.fn().mockResolvedValue(matches) } as Pick<MemberMatcher, 'match'>;
  const send = vi.fn()
    .mockResolvedValueOnce({ message_id: 88 })
    .mockResolvedValueOnce({ message_id: 89 }) as unknown as typeof sendMessageWithRetry;
  const edit = vi.fn().mockResolvedValue({}) as unknown as typeof editMessageWithRetry;
  const handler = register({ repository, matcher, send, edit, concurrency: 2 });

  await handler(context({
    messageId: 77,
    text: '#запрос Ищу дизайнера',
    entities: [{ type: 'hashtag', offset: 0, length: 7 }],
  }), vi.fn().mockResolvedValue(undefined));
  await handler(context({
    messageId: 78,
    text: '#запрос Ищу юриста',
    entities: [{ type: 'hashtag', offset: 0, length: 7 }],
  }), vi.fn().mockResolvedValue(undefined));

  await vi.waitFor(() => expect(matcher.match).toHaveBeenCalledTimes(2));
  expect(matcher.match).toHaveBeenCalledWith('Ищу дизайнера', 'author');
  expect(matcher.match).toHaveBeenCalledWith('Ищу юриста', 'author');
});

it('releases an identical-query key after completion', async () => {
  const repository = requestRepository();
  const matcher = { match: vi.fn().mockResolvedValue(matches) } as Pick<MemberMatcher, 'match'>;
  const send = vi.fn()
    .mockResolvedValueOnce({ message_id: 88 })
    .mockResolvedValueOnce({ message_id: 89 }) as unknown as typeof sendMessageWithRetry;
  const edit = vi.fn().mockResolvedValue({}) as unknown as typeof editMessageWithRetry;
  const handler = register({ repository, matcher, send, edit });
  const request = (messageId: number) => context({
    messageId,
    text: '#запрос Ищу эксперта',
    entities: [{ type: 'hashtag', offset: 0, length: 7 }],
  });

  await handler(request(77), vi.fn().mockResolvedValue(undefined));
  await vi.waitFor(() => expect(repository.complete).toHaveBeenCalledTimes(1));
  await handler(request(79), vi.fn().mockResolvedValue(undefined));

  await vi.waitFor(() => expect(matcher.match).toHaveBeenCalledTimes(2));
  expect(send).toHaveBeenCalledTimes(2);
});

it('releases a query key after queue-full', async () => {
  const first = new Promise<PublicMemberMatch[]>(() => undefined);
  const repository = requestRepository();
  const matcher = { match: vi.fn(() => first) } as Pick<MemberMatcher, 'match'>;
  const send = vi.fn()
    .mockResolvedValueOnce({ message_id: 88 })
    .mockResolvedValueOnce({ message_id: 89 })
    .mockResolvedValueOnce({ message_id: 90 }) as unknown as typeof sendMessageWithRetry;
  const edit = vi.fn().mockResolvedValue({}) as unknown as typeof editMessageWithRetry;
  const handler = register({ repository, matcher, send, edit, concurrency: 1, queueLimit: 0 });
  const request = (messageId: number, query: string) => context({
    messageId,
    text: `#запрос ${query}`,
    entities: [{ type: 'hashtag', offset: 0, length: 7 }],
  });

  await handler(request(77, 'первый'), vi.fn().mockResolvedValue(undefined));
  await vi.waitFor(() => expect(matcher.match).toHaveBeenCalledTimes(1));
  await handler(request(78, 'второй'), vi.fn().mockResolvedValue(undefined));
  await handler(request(79, 'второй'), vi.fn().mockResolvedValue(undefined));

  expect(repository.fail).toHaveBeenCalledWith(
    -1001, 78, 'queue-full', expect.any(String), 89,
  );
  expect(repository.fail).toHaveBeenCalledWith(
    -1001, 79, 'queue-full', expect.any(String), 90,
  );
  expect(send).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
    text: 'Такой запрос уже обрабатывается.',
  }));
});
```

- [ ] **Step 5: Run handler tests and verify red**

Run: `npx vitest run src/requests.test.ts`

Expected: FAIL because current code sends terminal replies, has no edit dependency, persists `processing-failed`, and has no author/query guard.

- [ ] **Step 6: Implement acknowledgment and edit helpers**

In `src/requests.ts`, update imports/options/constants:

```ts
import { RequestStageError } from './request.stage.js';
import {
  editMessageWithRetry,
  sendMessageWithRetry,
} from './telegram.js';

export interface RequestHandlerOptions {
  targetChatId: number;
  matcher: MemberMatcher;
  repository: RequestRepository;
  concurrency: number;
  queueLimit: number;
  send?: typeof sendMessageWithRetry;
  edit?: typeof editMessageWithRetry;
  now?: () => Date;
}

const pendingText = '⏳ Ищу подходящих участников…';
const duplicateText = 'Такой запрос уже обрабатывается.';
const queueFullText = 'Сейчас слишком много запросов. Попробуйте ещё раз немного позже.';
```

Make acknowledgment calls include `operation: 'ack'`. Add:

```ts
async function editReply(
  api: Api,
  request: IncomingMemberRequest,
  responseMessageId: number,
  text: string,
  options: RequestHandlerOptions,
) {
  return (options.edit ?? editMessageWithRetry)(api, {
    chatId: request.chatId,
    threadId: request.threadId,
    messageId: responseMessageId,
    text,
    parseMode: 'HTML',
    pipeline: 'member-request',
  });
}

function activeKey(request: IncomingMemberRequest, queryHash: string): string | null {
  return request.authorId === null ? null : `${String(request.authorId)}:${queryHash}`;
}
```

- [ ] **Step 7: Replace terminal second replies with edits and safe codes**

Change `processRequest` to receive `responseMessageId`. Match first, catch only matcher errors, edit the safe error text, and preserve the matcher code:

```ts
async function processRequest(
  api: Api,
  request: IncomingMemberRequest,
  responseMessageId: number,
  options: RequestHandlerOptions,
): Promise<void> {
  let matches: readonly PublicMemberMatch[];
  try {
    matches = await options.matcher.match(
      request.query,
      request.authorUsername ?? undefined,
    );
  } catch (error: unknown) {
    const errorCode = error instanceof RequestStageError
      ? error.code
      : 'reranking-failed';
    try {
      await editReply(api, request, responseMessageId, failedText, options);
    } catch (editError: unknown) {
      logger.error({
        chatId: request.chatId,
        threadId: request.threadId,
        messageId: request.messageId,
        errorClass: editError instanceof Error ? editError.name : 'unknown',
      }, 'Member request failure placeholder edit was not delivered');
    }
    await options.repository.fail(
      request.chatId,
      request.messageId,
      errorCode,
      nowIso(options),
      responseMessageId,
    );
    return;
  }

  const enoughMatches = matches.length >= 3;
  const text = enoughMatches
    ? formatMemberMatches(matches.slice(0, 5))
    : noMatchText;
  try {
    await editReply(api, request, responseMessageId, text, options);
  } catch {
    await options.repository.fail(
      request.chatId,
      request.messageId,
      'telegram-edit-failed',
      nowIso(options),
      responseMessageId,
    );
    return;
  }
  if (!enoughMatches) {
    await options.repository.noMatch(request.chatId, request.messageId, {
      responseMessageId,
      completedAt: nowIso(options),
    });
    return;
  }
  await options.repository.complete(request.chatId, request.messageId, {
    responseMessageId,
    matchCount: Math.min(matches.length, 5),
    completedAt: nowIso(options),
  });
}
```

- [ ] **Step 8: Implement reserve, duplicate guard, placeholder, and release**

Create one `Set<string>` inside `registerRequestHandlers` and pass it to `reserveAndQueue`. After the existing repository reservation and empty-query branch, use:

```ts
const queryHash = createHash('sha256').update(request.query).digest('hex');
const key = activeKey(request, queryHash);
if (key !== null && activeRequests.has(key)) {
  try {
    const sent = await sendReply(api, request, duplicateText, options);
    await options.repository.fail(
      request.chatId,
      request.messageId,
      'duplicate-in-flight',
      nowIso(options),
      sent.message_id,
    );
  } catch {
    await options.repository.fail(
      request.chatId,
      request.messageId,
      'telegram-ack-failed',
      nowIso(options),
    );
  }
  return;
}
if (key !== null) activeRequests.add(key);
const release = (): void => {
  if (key !== null) activeRequests.delete(key);
};

let placeholderId: number;
try {
  const placeholder = await sendReply(api, request, pendingText, options);
  placeholderId = placeholder.message_id;
} catch {
  await options.repository.fail(
    request.chatId,
    request.messageId,
    'telegram-ack-failed',
    nowIso(options),
  );
  release();
  return;
}

if (!queue.submit(async () => {
  try {
    await processRequest(api, request, placeholderId, options);
  } finally {
    release();
  }
})) {
  try {
    await editReply(api, request, placeholderId, queueFullText, options);
  } catch {
    // Telegram helper already recorded the terminal edit failure and duration.
  }
  await options.repository.fail(
    request.chatId,
    request.messageId,
    'queue-full',
    nowIso(options),
    placeholderId,
  );
  release();
}
```

Compute `queryHash` once before `repository.reserve` and pass the same value to both the reservation and active key. Keep duplicate Telegram `message_id` handling before checking `activeRequests`, so a redelivered update remains silent.

- [ ] **Step 9: Preserve the empty-query direct response**

Immediately after a successful reservation and before single-flight acquisition:

```ts
if (request.query === '') {
  try {
    const sent = await sendReply(api, request, emptyRequestText, options);
    await options.repository.noMatch(request.chatId, request.messageId, {
      responseMessageId: sent.message_id,
      completedAt: nowIso(options),
    });
  } catch {
    await options.repository.fail(
      request.chatId,
      request.messageId,
      'telegram-ack-failed',
      nowIso(options),
    );
  }
  return;
}
```

- [ ] **Step 10: Run handler and bot regression tests**

Run: `npx vitest run src/requests.test.ts src/bot.test.ts src/capture.test.ts`

Expected: PASS; valid requests use one placeholder plus edit, empty requests remain direct, exact update duplicates remain silent, identical active author/query duplicates do not call matcher, and different queries both run.

- [ ] **Step 11: Commit request orchestration**

```bash
git add src/requests.ts src/requests.test.ts
git commit -m "feat: acknowledge and edit member requests"
```

---

### Task 6: Wire Fixed Runtime Timeouts

**Files:**
- Modify: `src/runtime-defaults.ts`
- Modify: `src/types.ts`
- Modify: `src/config.ts`
- Modify: `src/config.request-matching.test.ts`
- Modify: `src/request.runtime.ts`
- Modify: `src/request.runtime.test.ts`
- Modify: `src/application.test.ts`

**Interfaces:**
- Produces: `RequestMatchingConfig.embeddingTimeoutMs: number`
- Produces: `RequestMatchingConfig.rerankingTimeoutMs: number`
- Consumes: required timeout dependencies added to `MemberMatcher` in Task 2

- [ ] **Step 1: Add failing configuration expectations**

In `src/config.request-matching.test.ts`, extend the expected `requestMatching` object:

```ts
embeddingTimeoutMs: 15_000,
rerankingTimeoutMs: 60_000,
```

In `src/request.runtime.test.ts`, extend `feature` with the same fields and assert the constructed matcher uses them by making embedding remain pending, advancing fake timers by `15_000`, and expecting `embedding-timeout`.

- [ ] **Step 2: Run config/runtime tests and verify red**

Run: `npx vitest run src/config.request-matching.test.ts src/request.runtime.test.ts`

Expected: FAIL because timeout fields are absent from defaults, config, and runtime wiring.

- [ ] **Step 3: Add fixed defaults and types**

Extend `RUNTIME_DEFAULTS.matching` in `src/runtime-defaults.ts`:

```ts
matching: Object.freeze({
  concurrency: 2,
  queueLimit: 50,
  processingTimeoutMinutes: 10,
  embeddingTimeoutMs: 15_000,
  rerankingTimeoutMs: 60_000,
}),
```

Extend `RequestMatchingConfig` in `src/types.ts`:

```ts
embeddingTimeoutMs: number;
rerankingTimeoutMs: number;
```

Set both fields from `RUNTIME_DEFAULTS.matching` inside `readConfig` in `src/config.ts`. Add the exact values to typed feature literals in `src/request.runtime.test.ts` and `src/application.test.ts`.

- [ ] **Step 4: Pass both values into `MemberMatcher`**

In `src/request.runtime.ts`, extend the constructor object:

```ts
const matcher = new MemberMatcher({
  embeddings,
  members: persistence.members,
  llm: {
    apiKey: config.aiApiKey,
    model: config.aiModel,
    baseUrl: config.aiBaseUrl,
  },
  embeddingTimeoutMs: feature.embeddingTimeoutMs,
  rerankingTimeoutMs: feature.rerankingTimeoutMs,
});
```

- [ ] **Step 5: Run all request-matching tests and typecheck**

Run: `npx vitest run src/config.request-matching.test.ts src/request.runtime.test.ts src/request.matcher.test.ts src/requests.test.ts src/application.test.ts && npm run typecheck`

Expected: PASS with exact 15-second/60-second values and TypeScript exit code 0.

- [ ] **Step 6: Commit runtime wiring**

```bash
git add src/runtime-defaults.ts src/types.ts src/config.ts src/config.request-matching.test.ts src/request.runtime.ts src/request.runtime.test.ts src/application.test.ts
git commit -m "feat: configure member matching timeouts"
```

---

### Task 7: Documentation and Full Verification

**Files:**
- Modify: `docs/architecture.md`

**Interfaces:**
- Consumes: all runtime behavior from Tasks 1–6
- Produces: operator-facing description of placeholder/edit, timeout values, safe codes, and process-local duplicate scope

- [ ] **Step 1: Update architecture documentation**

In the `Подбор по #запрос` section of `docs/architecture.md`, replace the terminal-response description with:

```markdown
После durable reservation валидный запрос сразу получает reply `⏳ Ищу подходящих участников…`. Итоговый список, no-match или безопасная ошибка заменяет этот reply через Telegram edit. Query embedding ограничен 15 секундами, LLM reranking — 60 секундами, а PostgreSQL использует `statement_timeout=10s`.

Одинаковый активный текст одного `authorId` защищён process-local single-flight ключом; другой текст того же автора продолжает обрабатываться общей bounded queue. Эта защита не координирует несколько реплик приложения. В `member_requests.error_code` сохраняется конкретный безопасный этап (`embedding-*`, `postgres-failed`, `reranking-*`, `telegram-*`, `queue-full` или `duplicate-in-flight`), а не общий `processing-failed`.
```

Add to observability/reliability:

```markdown
Каждый этап member-request пишет `stage`, `durationMs` и `outcome`; Telegram дополнительно пишет `operation=ack|edit`. Пользовательские тексты, карточки, vectors, prompts и model responses не логируются.
```

- [ ] **Step 2: Verify no runtime path persists the removed generic code**

Run: `rg -n "processing-failed" src`

Expected: exit code 1 and no matches.

- [ ] **Step 3: Run the complete test suite**

Run: `npm test`

Expected: exit code 0 and 0 failed tests. PostgreSQL-backed suites require the existing test database on `127.0.0.1:55432` or `TEST_DATABASE_URL`.

- [ ] **Step 4: Run static verification and build**

Run: `npm run typecheck && npm run build`

Expected: both TypeScript invocations exit 0 and emit no diagnostics.

- [ ] **Step 5: Inspect the final diff for privacy and scope**

Run: `git diff --check && git status --short && git diff --stat`

Expected: no whitespace errors; only the files listed in this plan are modified; `.envt` remains untracked and untouched.

- [ ] **Step 6: Commit documentation**

```bash
git add docs/architecture.md
git commit -m "docs: explain bounded member request latency"
```

- [ ] **Step 7: Record verification evidence for handoff**

Report the exact `npm test` test-file/test counts, the `npm run typecheck` exit code, the `npm run build` exit code, and any unavailable integration prerequisite. Do not claim completion if any command is failing or skipped without explanation.
