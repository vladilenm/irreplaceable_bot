# Minimal Timeweb Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current 28-variable deployment contract with seven production variables, one Timeweb AI Gateway token, and one verified-TLS PostgreSQL URL.

**Architecture:** A typed `runtime-defaults` module owns operational constants while `config.ts` validates only deployment identity and secrets. Both chat completions and embeddings use the OpenAI SDK against Timeweb AI Gateway; database migrations and runtime share one `DATABASE_URL`, with loopback-aware TLS and a committed public Timeweb CA certificate.

**Tech Stack:** TypeScript 6, Node.js 22, Vitest, OpenAI Node SDK, node-postgres, pgvector, Docker, Timeweb App Platform, Timeweb Managed PostgreSQL.

## Global Constraints

- Production env contains exactly `BOT_TOKEN`, `TARGET_CHAT_ID`, `AI_RADAR_THREAD_ID`, `THREAD_SUMMARY_THREAD_ID`, `TRACKED_THREAD_IDS`, `TIMEWEB_AI_TOKEN`, and `DATABASE_URL`.
- Timeweb AI Gateway base URL is `https://api.timeweb.ai/v1`.
- Embedding model is `openai/text-embedding-3-large` with requested dimensions `1536`.
- The provisional chat model is `openai/gpt-4.1-mini`; the live Gateway `/models` probe must confirm this exact ID before production deployment.
- Database pool size is `5`; PostgreSQL statement timeout is `10_000` ms.
- Remote PostgreSQL connections require `rejectUnauthorized: true` and the Timeweb CA; loopback connections do not use TLS.
- Cron defaults remain digest `0 6 * * *`, summaries `30 3 * * *`, retention `0 1 * * *`, and member indexing `*/15 * * * *`, all evaluated in UTC.
- Request matching is enabled with concurrency `2`, queue limit `50`, processing timeout `10` minutes, and message retention `90` days.
- No secret value, connection string, member profile, or user request may be logged.
- Implementation follows TDD and each task ends in its own commit.

---

## File Structure

- Create `src/runtime-defaults.ts`: one immutable source for AI, schedules, retention, PostgreSQL, and matching constants.
- Create `config/timeweb-cloud-ca.crt`: public Timeweb root used to verify Managed PostgreSQL.
- Modify `src/config.ts`: validate the seven-variable contract and derive typed runtime/database settings.
- Modify `src/types.ts`: represent one database URL and the derived Gateway embedding configuration.
- Modify `src/db/pool.ts`, `src/db/migrate.ts`, `src/application.ts`, `src/member.seed.ts`, and `src/migrate-sqlite.ts`: consume one database config instead of runtime/migration URLs.
- Modify `src/embeddings.ts` and `src/request.runtime.ts`: use Gateway base URL and enforce 1536 dimensions.
- Modify `src/llm.ts`, `src/radar.curator.ts`, `src/summarizer.ts`, and `src/request.matcher.ts`: remove the direct Anthropic transport and use the Timeweb OpenAI-compatible path.
- Modify `.env.example`, `docker-compose.yml`, `Dockerfile`, and `tests/setup.ts`: expose only the seven-variable deployment contract.
- Modify `src/member.seed.ts`: replace the persistent production seed flag with an explicit CLI switch.
- Modify focused Vitest files next to each production module.
- Modify `README.md`, `docs/architecture.md`, and `docs/operations.md`: document the final local and Timeweb workflows.

---

### Task 1: Typed Seven-Variable Configuration and One PostgreSQL URL

**Files:**
- Create: `src/runtime-defaults.ts`
- Create: `config/timeweb-cloud-ca.crt`
- Modify: `src/types.ts`
- Modify: `src/config.ts`
- Modify: `src/db/pool.ts`
- Modify: `src/db/migrate.ts`
- Modify: `src/application.ts`
- Modify: `src/migrate-sqlite.ts`
- Modify: `src/evaluate-member-matching.ts`
- Modify: `tests/setup.ts`
- Test: `src/config.request-matching.test.ts`
- Test: `src/db/pool.test.ts`
- Test: `src/application.test.ts`

**Interfaces:**
- Produces: `RUNTIME_DEFAULTS`, `readConfig(env, loadCa?)`, `readDatabaseConfig(env, loadCa?)`, `readTimewebAiToken(env)`, and `DatabaseConfig.url`.
- Produces: `RequestMatchingConfig.embeddingBaseUrl` and `RequestMatchingConfig.embeddingDimensions` for Task 2.
- Consumes: the seven env names from the approved design.

- [ ] **Step 1: Write failing configuration tests**

Replace the old env-override tests in `src/config.request-matching.test.ts` with exact contract tests:

```ts
import { describe, expect, it, vi } from 'vitest';
import { readConfig, readDatabaseConfig } from './config.js';
import { RUNTIME_DEFAULTS } from './runtime-defaults.js';

const validEnv: NodeJS.ProcessEnv = {
  BOT_TOKEN: 'telegram-token',
  TARGET_CHAT_ID: '-100123',
  AI_RADAR_THREAD_ID: '11',
  THREAD_SUMMARY_THREAD_ID: '22',
  TRACKED_THREAD_IDS: '11,22,33',
  TIMEWEB_AI_TOKEN: 'gateway-token',
  DATABASE_URL: 'postgresql://club:secret@db.example/club',
};

describe('readConfig', () => {
  it('builds the complete runtime config from exactly seven env values', () => {
    const config = readConfig(validEnv, () => 'timeweb-ca');

    expect(config).toMatchObject({
      botToken: 'telegram-token',
      targetChatId: -100123,
      aiRadarThreadId: 11,
      threadSummaryThreadId: 22,
      trackedThreadIds: [11, 22, 33],
      aiApiKey: 'gateway-token',
      aiBaseUrl: 'https://api.timeweb.ai/v1',
      database: {
        url: 'postgresql://club:secret@db.example/club',
        ssl: true,
        caCert: 'timeweb-ca',
        poolMax: 5,
        statementTimeoutMs: 10_000,
      },
      requestMatching: {
        embeddingApiKey: 'gateway-token',
        embeddingBaseUrl: 'https://api.timeweb.ai/v1',
        embeddingModel: 'openai/text-embedding-3-large',
        embeddingDimensions: 1536,
        memberIndexCron: '*/15 * * * *',
        concurrency: 2,
        queueLimit: 50,
        processingTimeoutMinutes: 10,
      },
    });
    expect(config.digestCron).toBe(RUNTIME_DEFAULTS.schedules.digestCron);
  });

  it.each([
    'BOT_TOKEN',
    'TARGET_CHAT_ID',
    'AI_RADAR_THREAD_ID',
    'THREAD_SUMMARY_THREAD_ID',
    'TIMEWEB_AI_TOKEN',
    'DATABASE_URL',
  ])('fails fast when %s is missing', (name) => {
    const env: NodeJS.ProcessEnv = { ...validEnv };
    delete env[name];
    expect(() => readConfig(env, () => 'timeweb-ca')).toThrow(name);
  });

  it('ignores removed legacy overrides', () => {
    const config = readConfig({
      ...validEnv,
      AI_MODEL: 'legacy-model',
      EMBEDDING_API_KEY: 'legacy-key',
      DATABASE_POOL_MAX: '999',
      REQUEST_MATCHING_ENABLED: 'false',
    }, () => 'timeweb-ca');

    expect(config.aiModel).toBe(RUNTIME_DEFAULTS.ai.chatModel);
    expect(config.requestMatching.embeddingApiKey).toBe('gateway-token');
    expect(config.database.poolMax).toBe(5);
  });
});

describe('readDatabaseConfig', () => {
  it('disables TLS for local PostgreSQL without reading the CA', () => {
    const loadCa = vi.fn(() => 'timeweb-ca');
    expect(readDatabaseConfig({
      DATABASE_URL: 'postgresql://club:club@127.0.0.1:55432/club',
    }, loadCa)).toEqual({
      url: 'postgresql://club:club@127.0.0.1:55432/club',
      ssl: false,
      poolMax: 5,
      statementTimeoutMs: 10_000,
    });
    expect(loadCa).not.toHaveBeenCalled();
  });

  it('requires the bundled CA for a remote hostname', () => {
    expect(readDatabaseConfig({
      DATABASE_URL: 'postgresql://club:secret@managed.example/club',
    }, () => 'timeweb-ca')).toMatchObject({ ssl: true, caCert: 'timeweb-ca' });
  });

  it('rejects malformed and non-PostgreSQL URLs', () => {
    expect(() => readDatabaseConfig({ DATABASE_URL: 'not-a-url' }, () => 'ca'))
      .toThrow('DATABASE_URL must be a valid PostgreSQL URL');
    expect(() => readDatabaseConfig({ DATABASE_URL: 'mysql://db/club' }, () => 'ca'))
      .toThrow('DATABASE_URL must use postgresql:');
  });
});
```

- [ ] **Step 2: Run the focused tests and confirm the old parser fails**

Run:

```bash
npm test -- src/config.request-matching.test.ts src/db/pool.test.ts src/application.test.ts
```

Expected: FAIL because `RUNTIME_DEFAULTS`, `readConfig`, `DatabaseConfig.url`, and the seven-variable contract do not exist.

- [ ] **Step 3: Add immutable operational defaults**

Create `src/runtime-defaults.ts`:

```ts
export const RUNTIME_DEFAULTS = Object.freeze({
  ai: Object.freeze({
    baseUrl: 'https://api.timeweb.ai/v1',
    chatModel: 'openai/gpt-4.1-mini',
    embeddingModel: 'openai/text-embedding-3-large',
    embeddingDimensions: 1536,
  }),
  schedules: Object.freeze({
    digestCron: '0 6 * * *',
    threadSummaryCron: '30 3 * * *',
    retentionSweepCron: '0 1 * * *',
    memberIndexCron: '*/15 * * * *',
  }),
  messages: Object.freeze({ retentionDays: 90 }),
  database: Object.freeze({ poolMax: 5, statementTimeoutMs: 10_000 }),
  matching: Object.freeze({
    concurrency: 2,
    queueLimit: 50,
    processingTimeoutMinutes: 10,
  }),
  logging: Object.freeze({ level: 'info' }),
} as const);
```

- [ ] **Step 4: Add the verified public Timeweb CA**

Create `config/timeweb-cloud-ca.crt` with the certificate downloaded from `https://st.timeweb.com/cloud-static/ca.crt`. Verify it before adding it:

```bash
openssl x509 -in /tmp/timeweb-cloud-ca.crt -noout -subject -issuer -dates -fingerprint -sha256
shasum -a 256 /tmp/timeweb-cloud-ca.crt
```

Expected certificate SHA-256 file digest:

```text
404d1f55c314a51297d9a728021424fa55a2086ceb4ed66fcf194a1af7bc6980
```

Expected certificate fingerprint:

```text
17:17:9B:AD:B9:92:FE:B0:38:42:6F:F3:1B:A6:6A:B7:FA:71:1F:09:2C:A2:27:05:BD:72:51:F3:01:1A:12:4D
```

The committed PEM must be:

```pem
-----BEGIN CERTIFICATE-----
MIIEqTCCAxGgAwIBAgIURrz1bzHoED7eWQfikj3tGxR3/MkwDQYJKoZIhvcNAQEL
BQAwgYMxCzAJBgNVBAYTAlJVMRkwFwYDVQQIDBBTYWludC1QZXRlcnNidXJnMRkw
FwYDVQQHDBBTYWludC1QZXRlcnNidXJnMRYwFAYDVQQKDA1UaW1ld2ViIENsb3Vk
MSYwJAYDVQQDDB1tYW5hZ2VkLXNlcnZpY2UudGltZXdlYi5jbG91ZDAeFw0yNTA1
MjAxMjIyNDVaFw00MDA1MTYxMjIyNDVaMIGDMQswCQYDVQQGEwJSVTEZMBcGA1UE
CAwQU2FpbnQtUGV0ZXJzYnVyZzEZMBcGA1UEBwwQU2FpbnQtUGV0ZXJzYnVyZzEW
MBQGA1UECgwNVGltZXdlYiBDbG91ZDEmMCQGA1UEAwwdbWFuYWdlZC1zZXJ2aWNl
LnRpbWV3ZWIuY2xvdWQwggGiMA0GCSqGSIb3DQEBAQUAA4IBjwAwggGKAoIBgQCh
1DLVEy6fHyfqwLj2o24wXedeuOQ4L+hBIvDIWPL/4CRhTd6xVrlCzC+50otIaowZ
3IneM1/y4m4EC8zv15ViMzBJVnvkbWI3o8hcD1VrykRU42ZyWiVSizYpQW77Bti5
FXZQwaLfBbDeuvgOLFDJBDPwz2dSojf1BTz7Om+zLQdeQ+yDzfvwwXSkrDbGxBz4
uG9MHgSwA291wkNz/QONBLRQVYCL9RV4aoNJcedDJE5Bdlf9cJrJfHod5PR7+aLZ
ACfg74D6QMnmK5ITkqY83pTZTBqIGcp7HR/NKr+vX6EYFHJGX1zSyHMdg4mzLa0q
CjmZPNXYwhl2V7alDgyfT3xK0U88wB5kEab/+WV+hlDPLiIiLJL+NkzpNEczBcz9
TuilfbhGtg9EYMbIgX/57Vv/HtEK7Wxuv9GLAZCqghVuHfSXXT+Yo7nrSjm5cqbI
sQavUU12/26pMehTOzvs0ZRusjGFfmYkAPScVFs3uJSUtKg5VXkNlKNaWobLbF8C
AwEAAaMTMBEwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAYEAR5Xy
+bOYqW1khzbtq1PPW89cyYVpdpfOqBaHZlM8AhXek53y9I6kVYX1FxHyTJUqRib/
5WSQYa2cSQwT+yRWqvH9mdW6L+h6dDdHYHskKVrnSYhIkC2GsHGaT6zyykqYeBKt
n8ld3WZSbUXuku1/dI75pj/vHHcjoxKYD5U4W5DlvlDynBCE7TKZSVrZrXUGamDY
GS8PzIBWgk8EgbjNMMF8raHRbUXluJ5aTU5hx/7HFC5F5BM/l8NTZD3OYjqzLFzB
bR0XeckS6uJuXhAgScMQAC0jQCCrYxOj6EYZQ0e155kp1a6Qjm5ZotTWcpZft+sL
79v24ujuOm7cNmXMeaSoHZZol/j73T/2lI/ZeP22TygJWtvPNBGzS36RhZ5xj3Mp
XVCo3+JK2zJoFwV1L+GeiLdwlOFE22JW/qQ8kCqdYAemTQaZqVLbCfdj2VNHdiXD
FEwHd3k3L3bF2QCp4a0g5IBX9eadhhaSjOx/8pTTp7eocXX0gsKQMqf749km
-----END CERTIFICATE-----
```

- [ ] **Step 5: Replace env overrides with derived typed config**

Update `RequestMatchingConfig` and `DatabaseConfig` in `src/types.ts`:

```ts
export interface RequestMatchingConfig {
  embeddingApiKey: string;
  embeddingBaseUrl: string;
  embeddingModel: string;
  embeddingDimensions: number;
  memberIndexCron: string;
  concurrency: number;
  queueLimit: number;
  processingTimeoutMinutes: number;
}

export interface DatabaseConfig {
  url: string;
  ssl: boolean;
  caCert?: string;
  poolMax: number;
  statementTimeoutMs: number;
}
```

In `src/config.ts`, export parsers with these exact signatures:

```ts
export function readTimewebAiToken(env: NodeJS.ProcessEnv): string;
export function readDatabaseConfig(
  env: NodeJS.ProcessEnv,
  loadCa?: () => string,
): DatabaseConfig;
export function readConfig(
  env: NodeJS.ProcessEnv,
  loadCa?: () => string,
): BotConfig;
```

Use `new URL('../config/timeweb-cloud-ca.crt', import.meta.url)` with `readFileSync(..., 'utf8')`. Parse `DATABASE_URL` using `new URL(value)`, require protocol `postgresql:` or `postgres:`, and treat only `localhost`, `127.0.0.1`, `[::1]`, and `::1` as loopback. Build `config` with `readConfig(process.env)` and source every removed setting from `RUNTIME_DEFAULTS`.

- [ ] **Step 6: Make every PostgreSQL caller consume one URL**

Change `createPool` in `src/db/pool.ts` to:

```ts
export function createPool(config: DatabaseConfig): Pool {
  return new Pool({
    connectionString: config.url,
    max: config.poolMax,
    ssl: config.ssl
      ? { rejectUnauthorized: true, ca: config.caCert }
      : false,
    options: `-c statement_timeout=${String(config.statementTimeoutMs)}`,
  });
}
```

Change `ApplicationDependencies.createPool` to accept only `DatabaseConfig`. In `startApplication`, create and close one migration pool with `deps.createPool(deps.database)`, then create the runtime pool with the same call. Make the same replacement in `src/db/migrate.ts`, `src/migrate-sqlite.ts`, `src/member.seed.ts`, and `src/evaluate-member-matching.ts`.

- [ ] **Step 7: Update the test bootstrap and pool expectations**

Set only the new names in `tests/setup.ts`:

```ts
process.env['BOT_TOKEN'] ??= 'test-token';
process.env['TARGET_CHAT_ID'] ??= '-1001';
process.env['AI_RADAR_THREAD_ID'] ??= '1';
process.env['THREAD_SUMMARY_THREAD_ID'] ??= '2';
process.env['TRACKED_THREAD_IDS'] ??= '1,2';
process.env['TIMEWEB_AI_TOKEN'] ??= 'test-gateway-token';
process.env['DATABASE_URL'] ??=
  'postgresql://club_bot:club_bot@127.0.0.1:55432/club_bot_test';
```

Update `src/db/pool.test.ts` to expect `connectionString: databaseConfig.url`, verified TLS for remote config, and `ssl: false` for local config. Update `src/application.test.ts` so every `createPool` call receives only the database config.

- [ ] **Step 8: Run configuration, pool, and application tests**

Run:

```bash
npm test -- src/config.request-matching.test.ts src/db/pool.test.ts src/application.test.ts src/migrate-sqlite.test.ts
npm run typecheck
```

Expected: all selected tests PASS and TypeScript reports no errors.

- [ ] **Step 9: Commit the configuration contract**

```bash
git add src/runtime-defaults.ts config/timeweb-cloud-ca.crt src/types.ts src/config.ts src/db/pool.ts src/db/migrate.ts src/application.ts src/migrate-sqlite.ts src/member.seed.ts src/evaluate-member-matching.ts tests/setup.ts src/config.request-matching.test.ts src/db/pool.test.ts src/application.test.ts
git commit -m "refactor: reduce runtime configuration to seven values"
```

---

### Task 2: One Timeweb Gateway Transport for Chat and Embeddings

**Files:**
- Modify: `src/embeddings.ts`
- Modify: `src/request.runtime.ts`
- Modify: `src/llm.ts`
- Modify: `src/radar.curator.ts`
- Modify: `src/summarizer.ts`
- Modify: `src/request.matcher.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Test: `src/embeddings.test.ts`
- Test: `src/request.runtime.test.ts`
- Test: `src/llm.test.ts`

**Interfaces:**
- Consumes: `RequestMatchingConfig.embeddingBaseUrl` and `.embeddingDimensions` from Task 1.
- Produces: `OpenAiEmbeddingProvider({ apiKey, baseUrl, model, dimensions })` and a Timeweb-only OpenAI-compatible `requestJson` transport.

- [ ] **Step 1: Write failing Gateway embedding tests**

Extend `src/embeddings.test.ts` with exact request and dimension assertions:

```ts
it('sends Timeweb base configuration and requests exactly 1536 dimensions', async () => {
  const create = vi.fn().mockResolvedValue({
    model: 'openai/text-embedding-3-large',
    data: [{ index: 0, embedding: Array.from({ length: 1536 }, () => 0.1) }],
  });
  const provider = new OpenAiEmbeddingProvider({
    apiKey: 'gateway-token',
    baseUrl: 'https://api.timeweb.ai/v1',
    model: 'openai/text-embedding-3-large',
    dimensions: 1536,
    client: { embeddings: { create } },
  });

  await expect(provider.embed(['профиль'])).resolves.toHaveLength(1);
  expect(create).toHaveBeenCalledWith({
    model: 'openai/text-embedding-3-large',
    input: ['профиль'],
    encoding_format: 'float',
    dimensions: 1536,
  });
});

it('rejects a Gateway response with the wrong dimensions', async () => {
  const provider = new OpenAiEmbeddingProvider({
    apiKey: 'gateway-token',
    baseUrl: 'https://api.timeweb.ai/v1',
    model: 'openai/text-embedding-3-large',
    dimensions: 1536,
    client: {
      embeddings: {
        create: vi.fn().mockResolvedValue({
          model: 'openai/text-embedding-3-large',
          data: [{ index: 0, embedding: [0.1, 0.2] }],
        }),
      },
    },
  });

  await expect(provider.embed(['профиль']))
    .rejects.toThrow('expected 1536 dimensions, received 2');
});
```

- [ ] **Step 2: Write a failing request-runtime composition test**

In `src/request.runtime.test.ts`, update the fixture to include:

```ts
const feature: RequestMatchingConfig = {
  embeddingApiKey: 'gateway-token',
  embeddingBaseUrl: 'https://api.timeweb.ai/v1',
  embeddingModel: 'openai/text-embedding-3-large',
  embeddingDimensions: 1536,
  memberIndexCron: '*/15 * * * *',
  concurrency: 2,
  queueLimit: 50,
  processingTimeoutMinutes: 10,
};
```

Mock the `openai` constructor and assert it receives `{ apiKey: 'gateway-token', baseURL: 'https://api.timeweb.ai/v1', maxRetries: 1 }` when no embedding override is supplied.

- [ ] **Step 3: Run focused AI tests and confirm failure**

```bash
npm test -- src/embeddings.test.ts src/request.runtime.test.ts src/llm.test.ts
```

Expected: FAIL because the embedding provider does not accept `baseUrl` or `dimensions`, and the LLM layer still contains the Anthropic transport.

- [ ] **Step 4: Enforce Gateway URL and dimensions in the embedding provider**

Change the provider constructor to:

```ts
constructor(options: {
  apiKey: string;
  baseUrl: string;
  model: string;
  dimensions: number;
  client?: EmbeddingClient;
}) {
  this.model = options.model;
  this.dimensions = options.dimensions;
  this.client = options.client ?? new OpenAI({
    apiKey: options.apiKey,
    baseURL: options.baseUrl,
    maxRetries: 1,
  });
}
```

Add `dimensions: number` to `EmbeddingClient.embeddings.create`, send it in every request, and reject every response row whose length differs from `this.dimensions`. Do not accept the first returned row as the source of truth for dimension length.

In `src/request.runtime.ts`, pass all four derived embedding fields from `feature`.

- [ ] **Step 5: Remove the direct Anthropic branch**

Remove `@anthropic-ai/sdk` from `src/llm.ts` and remove `anthropicTool` from `JsonCompletionRequest`. Keep the current `json_schema` request and 400-to-`json_object` fallback unchanged. Remove each `anthropicTool` object from `src/radar.curator.ts`, `src/summarizer.ts`, and `src/request.matcher.ts`.

Replace provider logging in `src/summarizer.ts` with the constant value:

```ts
provider: 'timeweb-ai-gateway'
```

Remove the unused dependency mechanically:

```bash
npm uninstall @anthropic-ai/sdk
```

- [ ] **Step 6: Simplify the LLM transport test**

Delete the Anthropic mock from `src/llm.test.ts`. Use this base config:

```ts
const baseConfig = {
  apiKey: 'gateway-token',
  baseUrl: 'https://api.timeweb.ai/v1',
  model: 'openai/gpt-4.1-mini',
};
```

Keep the fallback test, remove `anthropicTool` from its request, and assert the mocked OpenAI constructor receives the Timeweb base URL.

- [ ] **Step 7: Run AI and matching tests**

```bash
npm test -- src/embeddings.test.ts src/request.runtime.test.ts src/llm.test.ts src/request.matcher.test.ts src/radar.curator.test.ts src/summarizer.test.ts
npm run typecheck
```

Expected: all selected tests PASS and TypeScript reports no errors.

- [ ] **Step 8: Commit the unified Gateway transport**

```bash
git add src/embeddings.ts src/request.runtime.ts src/llm.ts src/radar.curator.ts src/summarizer.ts src/request.matcher.ts src/embeddings.test.ts src/request.runtime.test.ts src/llm.test.ts package.json package-lock.json
git commit -m "refactor: use one Timeweb AI Gateway transport"
```

---

### Task 3: Explicit Mock Seed and Seven-Variable Deployment Files

**Files:**
- Modify: `src/member.seed.ts`
- Test: `src/member.seed.test.ts`
- Modify: `.env.example`
- Modify: `docker-compose.yml`
- Modify: `Dockerfile`
- Test: `src/startup.test.ts`

**Interfaces:**
- Consumes: `readTimewebAiToken`, `RUNTIME_DEFAULTS.ai`, and one `DatabaseConfig.url` from Tasks 1–2.
- Produces: production seed opt-in `--allow-production` and exact seven-variable deployment manifests.

- [ ] **Step 1: Write failing seed safety tests**

Update the seed options to a typed object and test it in `src/member.seed.test.ts`:

```ts
it('blocks production seeding without an explicit CLI decision', async () => {
  await expect(seedMockMembers(service, {
    nodeEnv: 'production',
    allowProduction: false,
  })).rejects.toThrow('--allow-production is required in production');
});

it('allows exactly twenty mock cards with production opt-in', async () => {
  await expect(seedMockMembers(service, {
    nodeEnv: 'production',
    allowProduction: true,
  })).resolves.toEqual({ upserted: 20, indexed: 20 });
});
```

- [ ] **Step 2: Write a failing deployment-manifest test**

Replace the deployment assertions in `src/startup.test.ts` with an exact env-name extraction:

```ts
const composeEnvNames = [...compose.matchAll(/^\s{6}([A-Z][A-Z0-9_]+):/gm)]
  .map((match) => match[1]);
expect(composeEnvNames).toEqual([
  'BOT_TOKEN',
  'TARGET_CHAT_ID',
  'AI_RADAR_THREAD_ID',
  'THREAD_SUMMARY_THREAD_ID',
  'TRACKED_THREAD_IDS',
  'TIMEWEB_AI_TOKEN',
  'DATABASE_URL',
]);

const exampleEnvNames = env
  .split('\n')
  .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
  .map((line) => line.slice(0, line.indexOf('=')));
expect(exampleEnvNames).toEqual(composeEnvNames);
expect(dockerfile).toContain('COPY config ./config');
expect(dockerfile).toContain('ENV NODE_ENV=production');
```

- [ ] **Step 3: Run seed and deployment tests and confirm failure**

```bash
npm test -- src/member.seed.test.ts src/startup.test.ts
```

Expected: FAIL because the seed still reads `ALLOW_MOCK_MEMBER_SEED` and Compose still exposes 28 settings.

- [ ] **Step 4: Replace the seed env flag with CLI options**

Use this interface in `src/member.seed.ts`:

```ts
export interface MockSeedOptions {
  nodeEnv: string;
  allowProduction: boolean;
}
```

Change `seedMockMembers` to receive `MockSeedOptions`. In the CLI, derive the option only from `process.argv.includes('--allow-production')`, load the Gateway token with `readTimewebAiToken(process.env)`, and construct the embedding provider with the fixed Timeweb base URL, model, and dimensions from `RUNTIME_DEFAULTS.ai`.

The production error must be:

```text
--allow-production is required in production
```

- [ ] **Step 5: Reduce `.env.example` to seven values**

Replace its complete contents with:

```dotenv
BOT_TOKEN=
TARGET_CHAT_ID=
AI_RADAR_THREAD_ID=
THREAD_SUMMARY_THREAD_ID=
TRACKED_THREAD_IDS=
TIMEWEB_AI_TOKEN=
DATABASE_URL=postgresql://club_bot:club_bot@127.0.0.1:55432/club_bot_test
```

- [ ] **Step 6: Reduce Compose to seven injected values**

The complete `environment` block in `docker-compose.yml` must be:

```yaml
    environment:
      BOT_TOKEN: "${BOT_TOKEN}"
      TARGET_CHAT_ID: "${TARGET_CHAT_ID}"
      AI_RADAR_THREAD_ID: "${AI_RADAR_THREAD_ID}"
      THREAD_SUMMARY_THREAD_ID: "${THREAD_SUMMARY_THREAD_ID}"
      TRACKED_THREAD_IDS: "${TRACKED_THREAD_IDS}"
      TIMEWEB_AI_TOKEN: "${TIMEWEB_AI_TOKEN}"
      DATABASE_URL: "${DATABASE_URL}"
```

Keep the existing restart and bounded JSON logging settings. Keep `COPY config ./config` in the production image so the Timeweb CA is present at `/app/config/timeweb-cloud-ca.crt`.

- [ ] **Step 7: Run deployment and seed tests**

```bash
npm test -- src/member.seed.test.ts src/startup.test.ts
npm run typecheck
```

Expected: both test files PASS and TypeScript reports no errors.

- [ ] **Step 8: Commit the deployment cleanup**

```bash
git add src/member.seed.ts src/member.seed.test.ts .env.example docker-compose.yml Dockerfile src/startup.test.ts
git commit -m "chore: expose seven production variables"
```

---

### Task 4: Operations Documentation and Legacy-Name Audit

**Files:**
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/operations.md`

**Interfaces:**
- Consumes: the final env contract, seed command, Gateway models, and TLS behavior from Tasks 1–3.
- Produces: one local runbook and one Timeweb rollout path with no legacy configuration advice.

- [ ] **Step 1: Update the README quick start**

Document this sequence exactly:

```bash
cp .env.example .env
docker compose -f docker-compose.test.yml up -d
npm install
npm run build
npm run seed:members
npm run dev
```

Explain that local `.env` must receive the Telegram token/IDs and `TIMEWEB_AI_TOKEN`, while the example `DATABASE_URL` already targets the local pgvector container.

- [ ] **Step 2: Update architecture documentation**

Document the production data flow:

```text
Telegram -> bot on Timeweb App Platform
         -> Timeweb AI Gateway (chat + embeddings, one token)
         -> Timeweb Managed PostgreSQL (messages + members + vector index)
```

State that operational constants live in `src/runtime-defaults.ts`, deployment identity/secrets live in seven env values, and `config/timeweb-cloud-ca.crt` is public certificate material rather than a secret.

- [ ] **Step 3: Rewrite the Timeweb operations checklist**

Include these exact production steps:

1. Create one AI Gateway key and store it as `TIMEWEB_AI_TOKEN`.
2. Confirm `openai/gpt-4.1-mini` through `/models` and confirm `openai/text-embedding-3-large` returns 1536 values when `dimensions: 1536` is sent.
3. Create Managed PostgreSQL with pgvector and use its TLS domain in `DATABASE_URL`.
4. Configure the seven variables in the existing App Platform application.
5. Deploy one bot replica and verify `/status`.
6. Run `npm run seed:members -- --allow-production` once for the 20 temporary cards.
7. Test `#запрос` with three representative requests and confirm 3–5 mentions.

Add rollback instructions: redeploy the previous application commit, keep the Managed PostgreSQL cluster intact, and do not delete or rotate credentials during rollback.

- [ ] **Step 4: Audit executable files for removed env names**

Run:

```bash
rg -n 'AI_API_KEY|AI_MODEL|AI_BASE_URL|EMBEDDING_API_KEY|EMBEDDING_MODEL|DIGEST_CRON|THREAD_SUMMARY_CRON|RETENTION_SWEEP_CRON|MEMBER_INDEX_CRON|MESSAGE_RETENTION_DAYS|DATABASE_MIGRATION_URL|DATABASE_SSL|DATABASE_CA_CERT|DATABASE_POOL_MAX|DATABASE_STATEMENT_TIMEOUT_MS|REQUEST_MATCHING_ENABLED|REQUEST_MATCH_CONCURRENCY|REQUEST_QUEUE_LIMIT|REQUEST_PROCESSING_TIMEOUT_MINUTES|ALLOW_MOCK_MEMBER_SEED|LOG_LEVEL' src tests .env.example docker-compose.yml Dockerfile README.md docs/architecture.md docs/operations.md
```

Expected: no matches. `NODE_ENV` may appear only in `Dockerfile`, seed safety logic, and tests because it is a standard runtime mode set by the image, not an App Platform variable.

- [ ] **Step 5: Commit the runbook**

```bash
git add README.md docs/architecture.md docs/operations.md
git commit -m "docs: document minimal Timeweb deployment"
```

---

### Task 5: Resolve Local Seed and Legacy-Audit Regressions

**Files:**
- Modify: `src/member.seed.ts`
- Modify: `src/member.seed.test.ts`
- Modify: `src/config.request-matching.test.ts`

**Interfaces:**
- Consumes: Docker-owned `NODE_ENV=production` and the already-approved local quick-start command `npm run seed:members`.
- Produces: local seed behavior that defaults to `development` only when `NODE_ENV` is absent, and a legacy-name audit with no source/test false positives.

- [ ] **Step 1: Write a failing local-seed default test**

Add this test in `src/member.seed.test.ts`:

```ts
it('treats an absent NODE_ENV as development for the local seed CLI', () => {
  expect(readMockSeedCliOptions({
    argv: ['node', 'src/member.seed.ts'],
  })).toEqual({ nodeEnv: 'development', allowProduction: false });
});
```

Change the options interface used by `readMockSeedCliOptions` to accept an optional `nodeEnv?: string`.

- [ ] **Step 2: Run the new test and confirm RED**

```bash
npm test -- src/member.seed.test.ts
```

Expected: FAIL because `nodeEnv` is currently required and `runSeedCli` defaults its missing value to `production`.

- [ ] **Step 3: Make the CLI default local-only without weakening production safety**

Implement the default inside `readMockSeedCliOptions`:

```ts
const nodeEnv = options.nodeEnv ?? 'development';
const allowProduction = options.argv.includes('--allow-production');
if (nodeEnv === 'production' && !allowProduction) {
  throw new Error('--allow-production is required in production');
}
return { nodeEnv, allowProduction };
```

Change `runSeedCli` to pass `nodeEnv: process.env.NODE_ENV` directly. Do not change Dockerfile `ENV NODE_ENV=production`; production remains blocked before key, database, pool, or migration access unless `--allow-production` is present.

- [ ] **Step 4: Remove legacy names from source tests without reducing default coverage**

Delete the `ignores removed legacy overrides` test from `src/config.request-matching.test.ts`. The preceding `builds the complete runtime config from exactly seven env values` test already asserts the fixed chat model, embedding model, pool size, and matching defaults without embedding removed environment variable names in source.

- [ ] **Step 5: Run focused tests and the exact legacy scan**

```bash
npm test -- src/member.seed.test.ts src/config.request-matching.test.ts
rg -n 'AI_API_KEY|AI_MODEL|AI_BASE_URL|EMBEDDING_API_KEY|EMBEDDING_MODEL|DIGEST_CRON|THREAD_SUMMARY_CRON|RETENTION_SWEEP_CRON|MEMBER_INDEX_CRON|MESSAGE_RETENTION_DAYS|DATABASE_MIGRATION_URL|DATABASE_SSL|DATABASE_CA_CERT|DATABASE_POOL_MAX|DATABASE_STATEMENT_TIMEOUT_MS|REQUEST_MATCHING_ENABLED|REQUEST_MATCH_CONCURRENCY|REQUEST_QUEUE_LIMIT|REQUEST_PROCESSING_TIMEOUT_MINUTES|ALLOW_MOCK_MEMBER_SEED|LOG_LEVEL' src tests .env.example docker-compose.yml Dockerfile README.md docs/architecture.md docs/operations.md
```

Expected: focused tests PASS; `rg` returns exit code 1 with no output. The only permitted `NODE_ENV` references remain in Dockerfile, seed safety logic, and tests.

- [ ] **Step 6: Run full regression verification and commit**

```bash
npm test
npm run typecheck
git add src/member.seed.ts src/member.seed.test.ts src/config.request-matching.test.ts
git commit -m "fix: align local seed and config audit"
```

Expected: all tests pass, typecheck passes, and only the three listed source/test files are committed for this task.

---

### Task 6: Full Local Verification and Production Gate

**Files:**
- Verify only: all modified files

**Interfaces:**
- Consumes: every deliverable from Tasks 1–4.
- Produces: evidence that the branch is ready for Timeweb configuration, but does not create paid resources or expose secrets.

- [ ] **Step 1: Run the complete automated suite**

```bash
npm test
npm run typecheck
npm run build
```

Expected: all Vitest files pass, TypeScript reports no errors, and `dist/` builds successfully.

- [ ] **Step 2: Build the production Docker image**

```bash
docker build -t club-bot:timeweb-config .
```

Expected: build succeeds on the Node 22 Alpine stages and includes `/app/config/timeweb-cloud-ca.crt`.

- [ ] **Step 3: Run the local PostgreSQL migration smoke test**

```bash
docker compose -f docker-compose.test.yml up -d
npm run build
DATABASE_URL=postgresql://club_bot:club_bot@127.0.0.1:55432/club_bot_test node dist/db/migrate.js
```

Expected: migration exits with code 0 and reports zero or more applied migrations without TLS errors.

- [ ] **Step 4: Verify the final env contract mechanically**

```bash
awk -F= '/^[A-Z][A-Z0-9_]*=/{print $1}' .env.example
git status --short
git log --oneline -8
```

Expected env output, in order:

```text
BOT_TOKEN
TARGET_CHAT_ID
AI_RADAR_THREAD_ID
THREAD_SUMMARY_THREAD_ID
TRACKED_THREAD_IDS
TIMEWEB_AI_TOKEN
DATABASE_URL
```

Expected git status: clean.

- [ ] **Step 5: Stop before live Timeweb side effects**

Report the test/build evidence and request action-time confirmation before:

- creating the paid Managed PostgreSQL cluster;
- creating the persistent AI Gateway API key;
- placing the Gateway token or database credentials into App Platform;
- confirming any Timeweb charge.

The confirmation must include the selected PostgreSQL configuration, region, billing period, public IP/backup choices, and exact displayed total.

---

## Self-Review Results

- Spec coverage: all seven env values, 21 removals, one Gateway token, embedding dimension gate, one database URL, verified TLS, CLI seed safety, documentation, and browser confirmation boundaries are mapped to tasks.
- Placeholder scan: no deferred implementation markers are present; the live model ID has a concrete provisional value and an explicit verification gate.
- Type consistency: `DatabaseConfig.url`, `RequestMatchingConfig.embeddingBaseUrl`, `RequestMatchingConfig.embeddingDimensions`, and `OpenAiEmbeddingProvider` options use identical names in producing and consuming tasks.
