# Telegram VLESS Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Добавить в `club_bot` опциональный userspace Xray client, направить только grammY/Telegram через local SOCKS5H и восстановить сохранённый digest через Amsterdam VLESS endpoint.

**Architecture:** `readConfig` разбирает один deployment-specific VLESS URI в типизированную структуру без сохранения raw URI в логах. Application lifecycle запускает bundled Xray binary через stdin, ждёт loopback SOCKS readiness, передаёт `SocksProxyAgent` только grammY и останавливает child вместе с bot; direct local mode сохраняется при отсутствии proxy env.

**Tech Stack:** Node.js 22, TypeScript 6, grammY 1.42, `socks-proxy-agent` 10.1.0, Xray-core 26.3.27, Vitest, Docker multi-stage build, Timeweb App Platform, PostgreSQL outbox.

## Global Constraints

- Выполнять реализацию по TDD: failing test, подтверждённый FAIL, минимальный код, подтверждённый PASS.
- Не логировать raw `TELEGRAM_PROXY_VLESS_URL`, UUID, Reality keys, bot token, Telegram payload или nested provider error message.
- Proxy agent получает только grammY; PostgreSQL, Timeweb AI и RSS остаются direct.
- Local SOCKS bind — только `127.0.0.1:1080`; никакого TUN, privileged mode или дополнительного HTTP listener.
- При заданном proxy env startup обязан fail closed, если URI невалиден, Xray не запустился или SOCKS не готов.
- При отсутствующем proxy env приложение работает direct, но с тем же явным Telegram timeout.
- Telegram request timeout — 60 секунд; publication lease — 300 секунд.
- Production сохраняет ровно один application instance на `BOT_TOKEN`.
- `.env`, `.envt`, VLESS exports и любые реальные secrets не открывать и не добавлять в Git.
- Push, Timeweb secret mutation и production deploy выполнять только после отдельного явного подтверждения и полного release gate.
- Current saved digest восстанавливать только outbox dispatcher или `/retry_publications digest`; не запускать `/digest` или `/dev-digest`.

---

### Task 1: Типизированная proxy-конфигурация и runtime invariants

**Files:**
- Create: `src/telegram-proxy-config.ts`
- Create: `src/telegram-proxy-config.test.ts`
- Modify: `src/types.ts`
- Modify: `src/config.ts`
- Modify: `src/config.request-matching.test.ts`
- Modify: `src/runtime-defaults.ts`

**Interfaces:**
- Consumes: optional `NodeJS.ProcessEnv.TELEGRAM_PROXY_VLESS_URL`.
- Produces: `readTelegramProxyConfig(env): TelegramProxyConfig | null`; `BotConfig.telegramProxy`; exact runtime defaults for timeout, SOCKS lifecycle and delivery lease.

- [ ] **Step 1: Write failing parser and redaction tests**

Create `src/telegram-proxy-config.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { readTelegramProxyConfig } from './telegram-proxy-config.js';

const valid =
  'vless://8f93928e-8193-46e8-a596-9324c11e6fe4@147.45.149.185:443' +
  '?encryption=none&flow=xtls-rprx-vision&security=reality' +
  '&sni=www.microsoft.com&fp=chrome' +
  '&pbk=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  '&sid=0123456789abcdef&type=tcp#club-bot-amsterdam';

describe('readTelegramProxyConfig', () => {
  it('keeps direct mode when the deployment secret is absent or blank', () => {
    expect(readTelegramProxyConfig({})).toBeNull();
    expect(readTelegramProxyConfig({ TELEGRAM_PROXY_VLESS_URL: '  ' })).toBeNull();
  });

  it('returns only validated Reality TCP fields', () => {
    expect(readTelegramProxyConfig({ TELEGRAM_PROXY_VLESS_URL: valid })).toEqual({
      host: '147.45.149.185',
      port: 443,
      clientId: '8f93928e-8193-46e8-a596-9324c11e6fe4',
      encryption: 'none',
      flow: 'xtls-rprx-vision',
      security: 'reality',
      network: 'tcp',
      serverName: 'www.microsoft.com',
      fingerprint: 'chrome',
      publicKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      shortId: '0123456789abcdef',
    });
  });

  it.each([
    valid.replace('vless:', 'https:'),
    valid.replace('security=reality', 'security=none'),
    valid.replace('type=tcp', 'type=ws'),
    valid.replace('xtls-rprx-vision', 'invalid-flow'),
    valid.replace('0123456789abcdef', 'not-hex'),
    `${valid}&unknown=value`,
  ])('rejects unsupported input without echoing it', (secret) => {
    let thrown: unknown;
    try {
      readTelegramProxyConfig({ TELEGRAM_PROXY_VLESS_URL: secret });
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('Invalid TELEGRAM_PROXY_VLESS_URL');
    expect((thrown as Error).message).not.toContain('8f93928e');
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

```bash
npx vitest run src/telegram-proxy-config.test.ts
```

Expected: FAIL because `src/telegram-proxy-config.ts` does not exist.

- [ ] **Step 3: Add exact config types and runtime defaults**

Add to `src/types.ts`:

```ts
export interface TelegramProxyConfig {
  host: string;
  port: number;
  clientId: string;
  encryption: 'none';
  flow: 'xtls-rprx-vision';
  security: 'reality';
  network: 'tcp';
  serverName: string;
  fingerprint: 'chrome' | 'firefox' | 'safari';
  publicKey: string;
  shortId: string;
}
```

Add `telegramProxy: TelegramProxyConfig | null` to `BotConfig`.

Add to `RUNTIME_DEFAULTS`:

```ts
telegram: Object.freeze({
  requestTimeoutSeconds: 60,
  proxy: Object.freeze({
    binaryPath: '/usr/local/bin/xray',
    socksHost: '127.0.0.1',
    socksPort: 1080,
    startupTimeoutMs: 10_000,
    shutdownTimeoutMs: 5_000,
  }),
}),
publications: Object.freeze({ deliveryLeaseMs: 5 * 60_000 }),
```

- [ ] **Step 4: Implement strict non-echoing URI parsing**

Create `src/telegram-proxy-config.ts`:

```ts
import type { TelegramProxyConfig } from './types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/;
const SHORT_ID = /^[0-9a-f]{16}$/i;
const SERVER_NAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const ALLOWED_PARAMS = new Set([
  'encryption', 'flow', 'security', 'sni', 'fp', 'pbk', 'sid', 'type',
]);

function invalid(): never {
  throw new Error('Invalid TELEGRAM_PROXY_VLESS_URL');
}

export function readTelegramProxyConfig(env: NodeJS.ProcessEnv): TelegramProxyConfig | null {
  const raw = env.TELEGRAM_PROXY_VLESS_URL?.trim();
  if (!raw) return null;

  try {
    const url = new URL(raw);
    for (const key of url.searchParams.keys()) {
      if (!ALLOWED_PARAMS.has(key)) invalid();
    }
    for (const key of ALLOWED_PARAMS) {
      if (url.searchParams.getAll(key).length !== 1) invalid();
    }
    if (url.protocol !== 'vless:' || url.password !== '' || !UUID.test(url.username)) invalid();
    const port = Number(url.port);
    if (!url.hostname || !Number.isInteger(port) || port < 1 || port > 65_535) invalid();

    const encryption = url.searchParams.get('encryption');
    const flow = url.searchParams.get('flow');
    const security = url.searchParams.get('security');
    const network = url.searchParams.get('type');
    const serverName = url.searchParams.get('sni');
    const fingerprint = url.searchParams.get('fp');
    const publicKey = url.searchParams.get('pbk');
    const shortId = url.searchParams.get('sid');
    if (encryption !== 'none' || flow !== 'xtls-rprx-vision' ||
        security !== 'reality' || network !== 'tcp' ||
        !serverName || !SERVER_NAME.test(serverName) ||
        (fingerprint !== 'chrome' && fingerprint !== 'firefox' && fingerprint !== 'safari') ||
        !publicKey || !PUBLIC_KEY.test(publicKey) ||
        !shortId || !SHORT_ID.test(shortId)) invalid();

    return {
      host: url.hostname,
      port,
      clientId: url.username,
      encryption,
      flow,
      security,
      network,
      serverName,
      fingerprint,
      publicKey,
      shortId,
    };
  } catch {
    return invalid();
  }
}
```

In `src/config.ts`, import the parser and add:

```ts
telegramProxy: readTelegramProxyConfig(env),
```

to the `BotConfig` returned by `readConfig`.

- [ ] **Step 5: Update the existing config contract test**

Extend `src/config.request-matching.test.ts` with:

```ts
const validProxyUrl =
  'vless://8f93928e-8193-46e8-a596-9324c11e6fe4@147.45.149.185:443' +
  '?encryption=none&flow=xtls-rprx-vision&security=reality' +
  '&sni=www.microsoft.com&fp=chrome' +
  '&pbk=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  '&sid=0123456789abcdef&type=tcp#club-bot-amsterdam';

expect(config.telegramProxy).toBeNull();

const proxied = readConfig({
  ...validEnv,
  TELEGRAM_PROXY_VLESS_URL: validProxyUrl,
}, () => 'timeweb-ca');
expect(proxied.telegramProxy?.host).toBe('147.45.149.185');
```

Keep the existing seven required variables in the missing-variable table: the eighth value is optional for direct local mode.

- [ ] **Step 6: Run tests and commit**

```bash
npx vitest run src/telegram-proxy-config.test.ts src/config.request-matching.test.ts
npm run typecheck
git add src/telegram-proxy-config.ts src/telegram-proxy-config.test.ts src/types.ts src/config.ts src/config.request-matching.test.ts src/runtime-defaults.ts
git commit -m "feat: validate Telegram VLESS configuration"
```

Expected: tests and typecheck PASS; commit contains no real URI.

---

### Task 2: Xray client config, SOCKS readiness and child lifecycle

**Files:**
- Create: `src/telegram-transport.ts`
- Create: `src/telegram-transport.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: `TelegramProxyConfig | null` and `RUNTIME_DEFAULTS.telegram`.
- Produces: `startTelegramTransport(proxy): Promise<TelegramTransportRuntime>` where runtime exposes `clientOptions: ApiClientOptions`, `completed: Promise<void>`, and `stop(): Promise<void>`.

- [ ] **Step 1: Write pure Xray-config tests**

Create `src/telegram-transport.test.ts` with a valid `TelegramProxyConfig` fixture and these assertions:

```ts
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { TelegramProxyConfig } from './types.js';
import {
  buildXrayClientConfig,
  startTelegramTransport,
  type XrayProcess,
} from './telegram-transport.js';
import { RUNTIME_DEFAULTS } from './runtime-defaults.js';

const proxy: TelegramProxyConfig = {
  host: '147.45.149.185',
  port: 443,
  clientId: '8f93928e-8193-46e8-a596-9324c11e6fe4',
  encryption: 'none',
  flow: 'xtls-rprx-vision',
  security: 'reality',
  network: 'tcp',
  serverName: 'www.microsoft.com',
  fingerprint: 'chrome',
  publicKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  shortId: '0123456789abcdef',
};

function makeFakeXrayProcess() {
  const emitter = new EventEmitter();
  let stdinText = '';
  const signals: NodeJS.Signals[] = [];
  const process = Object.assign(emitter, {
    stdin: {
      end(value: string): void {
        stdinText = value;
      },
    },
    kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
      signals.push(signal);
      queueMicrotask(() => emitter.emit('exit', 0, signal));
      return true;
    },
  }) as XrayProcess;
  return {
    process,
    signals,
    get stdinText(): string { return stdinText; },
    exitUnexpectedly(code: number): void {
      emitter.emit('exit', code, null);
    },
  };
}

describe('buildXrayClientConfig', () => {
  it('binds SOCKS to loopback and maps every validated Reality field', () => {
    const built = buildXrayClientConfig(proxy);
    expect(built.inbounds).toEqual([expect.objectContaining({
      listen: '127.0.0.1',
      port: 1080,
      protocol: 'socks',
    })]);
    expect(built.outbounds[0]).toMatchObject({
      protocol: 'vless',
      settings: { vnext: [{
        address: '147.45.149.185',
        port: 443,
        users: [{
          id: proxy.clientId,
          encryption: 'none',
          flow: 'xtls-rprx-vision',
        }],
      }]},
      streamSettings: {
        network: 'tcp',
        security: 'reality',
        realitySettings: {
          serverName: 'www.microsoft.com',
          fingerprint: 'chrome',
          publicKey: proxy.publicKey,
          shortId: proxy.shortId,
          spiderX: '/',
        },
      },
    });
  });
});
```

Add lifecycle cases using injected `spawnXray`, `waitForPort`, and `createAgent` fakes:

```ts
it('direct mode returns a 60-second client without spawning Xray', async () => {
  const spawnXray = vi.fn();
  const runtime = await startTelegramTransport(null, { spawnXray });
  expect(runtime.clientOptions).toEqual({ timeoutSeconds: 60 });
  expect(spawnXray).not.toHaveBeenCalled();
  await runtime.stop();
});

it('passes config only through stdin, waits for SOCKS, and returns socks5h agent', async () => {
  const fake = makeFakeXrayProcess();
  const agent = {} as never;
  const waitForPort = vi.fn(async () => undefined);
  const spawnXray = vi.fn(() => fake.process);
  const runtime = await startTelegramTransport(proxy, {
    spawnXray,
    waitForPort,
    createAgent: vi.fn(() => agent),
  });
  expect(spawnXray).toHaveBeenCalledWith(
    '/usr/local/bin/xray',
    ['run', '-config', 'stdin:'],
  );
  expect(fake.stdinText).toContain(proxy.clientId);
  expect(JSON.stringify(spawnXray.mock.calls)).not.toContain(proxy.clientId);
  expect(waitForPort).toHaveBeenCalledWith('127.0.0.1', 1080, 10_000);
  expect(runtime.clientOptions).toMatchObject({
    timeoutSeconds: 60,
    baseFetchConfig: { agent },
  });
  await runtime.stop();
});

it('fails startup when SOCKS is not ready and terminates the child', async () => {
  const fake = makeFakeXrayProcess();
  await expect(startTelegramTransport(proxy, {
    spawnXray: vi.fn(() => fake.process),
    waitForPort: vi.fn(async () => { throw new Error('not ready'); }),
    createAgent: vi.fn(() => ({})),
  })).rejects.toThrow('Telegram proxy failed to become ready');
  expect(fake.signals).toContain('SIGTERM');
});

it('rejects completed when Xray exits unexpectedly without leaking config', async () => {
  const fake = makeFakeXrayProcess();
  const runtime = await startTelegramTransport(proxy, {
    spawnXray: vi.fn(() => fake.process),
    waitForPort: vi.fn(async () => undefined),
    createAgent: vi.fn(() => ({} as never)),
  });
  fake.exitUnexpectedly(23);
  await expect(runtime.completed).rejects.toThrow('Telegram proxy exited: code=23');
  await expect(runtime.completed).rejects.not.toThrow(proxy.clientId);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

```bash
npx vitest run src/telegram-transport.test.ts
```

Expected: FAIL because `src/telegram-transport.ts` does not exist.

- [ ] **Step 3: Add the only new npm dependency**

```bash
npm install socks-proxy-agent@10.1.0
```

Expected: `package.json` and lockfile contain exact compatible major `^10.1.0`; no proxy credential is written.

- [ ] **Step 4: Implement pure client config generation**

Create `src/telegram-transport.ts` with `buildXrayClientConfig(proxy)` returning:

```ts
{
  log: { access: 'none', dnsLog: false, loglevel: 'warning' },
  inbounds: [{
    listen: RUNTIME_DEFAULTS.telegram.proxy.socksHost,
    port: RUNTIME_DEFAULTS.telegram.proxy.socksPort,
    protocol: 'socks',
    settings: { auth: 'noauth', udp: false },
  }],
  outbounds: [{
    protocol: 'vless',
    settings: { vnext: [{
      address: proxy.host,
      port: proxy.port,
      users: [{
        id: proxy.clientId,
        encryption: proxy.encryption,
        flow: proxy.flow,
      }],
    }]},
    streamSettings: {
      network: proxy.network,
      security: proxy.security,
      realitySettings: {
        serverName: proxy.serverName,
        fingerprint: proxy.fingerprint,
        publicKey: proxy.publicKey,
        shortId: proxy.shortId,
        spiderX: '/',
      },
    },
  }],
}
```

- [ ] **Step 5: Implement the transport runtime**

In the same file define:

```ts
export interface XrayProcess {
  stdin: { end(value: string): void } | null;
  once(event: 'error', listener: (error: Error) => void): this;
  once(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface TelegramTransportRuntime {
  clientOptions: ApiClientOptions;
  completed: Promise<void>;
  stop(): Promise<void>;
}

export interface TelegramTransportDependencies {
  spawnXray(binary: string, args: string[]): XrayProcess;
  waitForPort(host: string, port: number, timeoutMs: number): Promise<void>;
  createAgent(url: string): NonNullable<ApiClientOptions['baseFetchConfig']>['agent'];
}

export async function startTelegramTransport(
  proxy: TelegramProxyConfig | null,
  overrides: Partial<TelegramTransportDependencies> = {},
): Promise<TelegramTransportRuntime>;
```

Implementation requirements with exact behavior:

1. Direct mode returns `{ timeoutSeconds: 60 }`, a never-settling `completed`, and an idempotent no-op `stop`.
2. Proxy mode spawns `/usr/local/bin/xray` with only `['run', '-config', 'stdin:']`; stdio is `['pipe', 'ignore', 'ignore']`.
3. `JSON.stringify(buildXrayClientConfig(proxy))` is written once to child stdin and stdin is closed.
4. Readiness uses a TCP connect loop to `127.0.0.1:1080`, capped at 10 seconds with 100 ms between refused connections.
5. Client options are:

```ts
{
  timeoutSeconds: RUNTIME_DEFAULTS.telegram.requestTimeoutSeconds,
  baseFetchConfig: {
    agent: new SocksProxyAgent('socks5h://127.0.0.1:1080'),
  },
}
```

6. Unexpected `error` or `exit` rejects `completed` with a new safe error containing only class, numeric exit code and signal; the VLESS config is never interpolated.
7. `stop()` is idempotent, sends `SIGTERM`, waits up to five seconds, sends `SIGKILL` only after that bound, and waits for the child exit event.
8. A readiness failure calls `stop()` before throwing `Telegram proxy failed to become ready`.

- [ ] **Step 6: Run tests and commit**

```bash
npx vitest run src/telegram-transport.test.ts src/telegram-proxy-config.test.ts
npm run typecheck
git add package.json package-lock.json src/telegram-transport.ts src/telegram-transport.test.ts
git commit -m "feat: run a scoped Telegram Xray transport"
```

Expected: focused tests and typecheck PASS; no secret fixture resembles the real production UUID.

---

### Task 3: grammY и application lifecycle integration

**Files:**
- Modify: `src/bot.ts`
- Modify: `src/bot.test.ts`
- Modify: `src/application.ts`
- Modify: `src/application.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `startTelegramTransport(config.telegramProxy)` and `TelegramTransportRuntime.clientOptions`.
- Produces: one Bot using proxied client options; `RunningApplication.pollingCompleted` rejects on either polling or Xray runtime failure; shutdown order bot → Xray → PostgreSQL.

- [ ] **Step 1: Write failing Bot client-options test**

Add to `src/bot.test.ts` using the existing persistence fixture:

```ts
it('passes the scoped API client options to grammY', () => {
  const agent = {} as never;
  const bot = createBot({
    persistence: { jobs, messages, publications },
    telegramClientOptions: {
      timeoutSeconds: 60,
      baseFetchConfig: { agent },
    },
  });
  expect(bot.api.options).toMatchObject({
    timeoutSeconds: 60,
    baseFetchConfig: { agent },
  });
});
```

Expected initially: TypeScript/test FAIL because `telegramClientOptions` is not in `CreateBotOptions`.

- [ ] **Step 2: Add failing application lifecycle expectations**

Extend the test dependency factory in `src/application.test.ts` with a fake transport that appends `start-telegram-transport` and `stop-telegram-transport`. Change the successful startup expectation to:

```ts
[
  'migrate',
  'close-migration-pool',
  'connect',
  'create-persistence',
  'start-telegram-transport',
  'create-bot',
  'start-bot',
  'start-dispatcher',
  'start-scheduler',
]
```

Change shutdown expectation to:

```ts
[
  'stop-dispatcher',
  'stop-scheduler',
  'stop-bot',
  'stop-telegram-transport',
  'close-runtime-pool',
]
```

Add a test where `transport.completed` rejects and assert `running.pollingCompleted` rejects with the same safe runtime error.

- [ ] **Step 3: Run focused tests and verify RED**

```bash
npx vitest run src/bot.test.ts src/application.test.ts
```

Expected: FAIL on missing transport dependency and client option.

- [ ] **Step 4: Wire grammY client options**

In `src/bot.ts` import `ApiClientOptions`, extend `CreateBotOptions`:

```ts
telegramClientOptions?: ApiClientOptions;
```

and construct the bot as:

```ts
const bot = new Bot(config.botToken, {
  client: options.telegramClientOptions,
});
```

- [ ] **Step 5: Make application own the transport lifecycle**

Extend `ApplicationDependencies` with:

```ts
telegramProxy: TelegramProxyConfig | null;
startTelegramTransport(
  proxy: TelegramProxyConfig | null,
): Promise<TelegramTransportRuntime>;
```

After PostgreSQL readiness/persistence creation and before `createBot`, start exactly one transport. Pass its `clientOptions` into `createBot`. Return:

```ts
pollingCompleted: Promise.race([
  polling.completed,
  telegramTransport.completed,
]),
```

On normal `stop`, stop dispatcher and scheduler, await `bot.stop()`, await `telegramTransport.stop()`, then close the pool. On startup failure, stop any created bot and transport before closing the pool.

- [ ] **Step 6: Wire production dependencies and safe runtime failure handling**

In `src/index.ts` pass:

```ts
telegramProxy: config.telegramProxy,
startTelegramTransport,
```

Rename `handlePollingFailure` to `handleRuntimeFailure`. Preserve special 409 backoff only when `classifyStartupError(error)` returns `polling-conflict-409`; other polling/Xray failures stop the application and exit `1` without interpolating raw proxy data.

- [ ] **Step 7: Run tests and commit**

```bash
npx vitest run src/bot.test.ts src/application.test.ts src/startup.test.ts src/telegram-transport.test.ts
npm run typecheck
git add src/bot.ts src/bot.test.ts src/application.ts src/application.test.ts src/index.ts
git commit -m "feat: bind Telegram transport to app lifecycle"
```

Expected: focused tests and typecheck PASS; shutdown order matches the design.

---

### Task 4: Bounded timeout, nested network diagnostics and lease safety

**Files:**
- Modify: `src/telegram.ts`
- Modify: `src/telegram.test.ts`
- Modify: `src/publication-dispatcher.ts`
- Modify: `src/publication-dispatcher.test.ts`

**Interfaces:**
- Consumes: grammY `GrammyError`/`HttpError`, `safeErrorMetadata`, runtime timeout and lease defaults.
- Produces: safe `TelegramErrorMetadata`, duration-bearing `SendMessageOnceResult`, actionable dispatcher logs, tested `lease >= 3 × timeout` invariant.

- [ ] **Step 1: Write failing nested-cause/redaction tests**

Add to `src/telegram.test.ts`:

```ts
import { GrammyError, HttpError, type Api } from 'grammy';

const params = {
  chatId: -100,
  threadId: 42,
  text: 'hi',
  parseMode: 'HTML',
} as const;

it('extracts only a safe system code from nested HttpError cause', async () => {
  const nested = Object.assign(new Error('connect to secret proxy URI failed'), {
    code: 'ETIMEDOUT',
  });
  mockSendMessage.mockRejectedValue(new HttpError('network failed', nested));

  await expect(sendMessageOnce(api, params)).resolves.toMatchObject({
    ok: false,
    errorCode: 'telegram-network',
    retryable: true,
    retryAfterMs: null,
    errorMetadata: {
      errorClass: 'HttpError',
      causeClass: 'Error',
      code: 'ETIMEDOUT',
    },
    durationMs: expect.any(Number),
  });
});

it('never puts provider error text into retry logs', async () => {
  const errorSpy = vi.spyOn(logger, 'error');
  vi.useFakeTimers();
  mockSendMessage.mockRejectedValueOnce(
    new HttpError('network failed', new Error('vless://secret-value')),
  ).mockResolvedValueOnce({ message_id: 1 });
  const sent = sendMessageWithRetry(api, params);
  await vi.advanceTimersByTimeAsync(3_100);
  await sent;
  expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('vless://secret-value');
});
```

Update old assertions that currently require `description=flaky-*`; the new contract must explicitly assert those messages are absent.

- [ ] **Step 2: Write failing lease/timeout invariant test**

Add to `src/publication-dispatcher.test.ts`:

```ts
it('keeps the durable lease at least three times longer than Telegram timeout', () => {
  expect(RUNTIME_DEFAULTS.publications.deliveryLeaseMs).toBeGreaterThanOrEqual(
    RUNTIME_DEFAULTS.telegram.requestTimeoutSeconds * 3_000,
  );
});
```

Expected initially: FAIL because dispatcher still owns a private hard-coded lease.

- [ ] **Step 3: Run focused tests and verify RED**

```bash
npx vitest run src/telegram.test.ts src/publication-dispatcher.test.ts
```

Expected: FAIL on missing metadata/duration and runtime-default lease use.

- [ ] **Step 4: Implement safe Telegram metadata**

Add this shape to `src/telegram.ts`:

```ts
export interface TelegramErrorMetadata {
  errorClass: string;
  causeClass?: string;
  status?: number;
  code?: string;
}
```

For `GrammyError`, retain only `errorClass: 'GrammyError'` and numeric `status: error_code`. For `HttpError`, call `safeErrorMetadata(err.error)` and expose only its safe class/status/code as `causeClass`, `status`, and `code`. For other values, expose only `safeErrorMetadata(err)`.

Extend both result variants with `durationMs`; extend the failure variant with `errorMetadata`. Measure each single attempt with `Date.now()` around `attemptSend`.

Replace every `{ err: cause }` logging binding and every description-bearing message with structured safe fields:

```ts
{
  ...logBinding,
  ...result.errorMetadata,
  durationMs: result.durationMs,
  errorCode: result.errorCode,
}
```

Messages remain fixed strings such as `Telegram sendMessage failed, retrying in 3s`; they never interpolate `err.message` or `description`.

- [ ] **Step 5: Improve dispatcher observability and consume the shared lease default**

Import `RUNTIME_DEFAULTS`; replace the private five-minute constant with `RUNTIME_DEFAULTS.publications.deliveryLeaseMs`. On retry log:

```ts
{
  pipeline: publication.pipeline,
  publicationId: publication.id,
  attemptCount: publication.attemptCount,
  nextAttemptAt: retryAt.toISOString(),
  errorCode: result.errorCode,
  durationMs: result.durationMs,
  ...result.errorMetadata,
}
```

Apply the same safe metadata/duration to permanent failure and successful chunk logs. Do not add text/payload.

- [ ] **Step 6: Run tests and commit**

```bash
npx vitest run src/telegram.test.ts src/publication-dispatcher.test.ts src/scheduled-publication.repository.test.ts
npm run typecheck
git add src/telegram.ts src/telegram.test.ts src/publication-dispatcher.ts src/publication-dispatcher.test.ts
git commit -m "fix: bound and diagnose Telegram delivery"
```

Expected: focused tests and typecheck PASS; secret marker is absent from serialized log calls.

---

### Task 5: Production image, environment contract and runbook

**Files:**
- Modify: `Dockerfile`
- Modify: `docker-compose.yml`
- Modify: `.env.example`
- Modify: `src/startup.test.ts`
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/operations.md`
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: Xray runtime binary path `/usr/local/bin/xray` and optional `TELEGRAM_PROXY_VLESS_URL`.
- Produces: reproducible image containing official Xray; explicit eight-name deployment contract; accurate direct/proxied operational documentation.

- [ ] **Step 1: Write failing deployment-file assertions**

Update `src/startup.test.ts` to expect these environment names in order:

```ts
[
  'BOT_TOKEN',
  'TARGET_CHAT_ID',
  'AI_RADAR_THREAD_ID',
  'THREAD_SUMMARY_THREAD_ID',
  'TRACKED_THREAD_IDS',
  'TIMEWEB_AI_TOKEN',
  'DATABASE_URL',
  'TELEGRAM_PROXY_VLESS_URL',
]
```

Add assertions:

```ts
expect(dockerfile).toContain(
  'FROM ghcr.io/xtls/xray-core:26.3.27@sha256:c98160906f3fe1d9d16e950c2a7997dc0c542c71816aa92c21e510412f90e1a2 AS xray',
);
expect(dockerfile).toContain(
  'COPY --from=xray /usr/local/bin/xray /usr/local/bin/xray',
);
```

- [ ] **Step 2: Run deployment test and verify RED**

```bash
npx vitest run src/startup.test.ts
```

Expected: FAIL because deployment files still expose seven names and the image lacks Xray.

- [ ] **Step 3: Bundle the pinned official Xray binary**

Add the first Dockerfile stage:

```dockerfile
FROM ghcr.io/xtls/xray-core:26.3.27@sha256:592ec4d11f656db95598d01e76dbcc6e002d67360b96a5436500a938230f52c7 AS xray
```

In the production stage, before `USER botuser`, add:

```dockerfile
COPY --from=xray /usr/local/bin/xray /usr/local/bin/xray
```

Do not copy Xray configs or GeoData; the client config arrives through stdin and uses no GeoData rules.

- [ ] **Step 4: Add the optional deployment secret name**

Append to `docker-compose.yml`:

```yaml
      TELEGRAM_PROXY_VLESS_URL: "${TELEGRAM_PROXY_VLESS_URL:-}"
```

Append to `.env.example`:

```text
TELEGRAM_PROXY_VLESS_URL=
```

No value or sample credential is committed.

- [ ] **Step 5: Update documentation without claiming an undeployed state**

Make these exact semantic changes:

1. `README.md`: describe seven required variables plus optional deployment-specific `TELEGRAM_PROXY_VLESS_URL`; direct local mode remains valid.
2. `docs/architecture.md`: add local Xray → VLESS Reality → Amsterdam only on the Telegram branch; state DB/AI/RSS remain direct.
3. `docs/operations.md`: document safe startup events, `getMe` verification, outbox recovery, mobile credential separation, rotation and rollback.
4. `AGENTS.md`: distinguish the currently confirmed production env from the locally implemented optional eighth variable until deployment is observed.
5. All four files explicitly forbid printing the URI and forbid `/digest`/`/dev-digest` during recovery.

- [ ] **Step 6: Build the real container and verify Xray runs as the application user**

```bash
docker build -t club-bot:vless-local .
docker run --rm --entrypoint /usr/local/bin/xray club-bot:vless-local version
```

Expected: build succeeds and prints Xray `26.3.27`; it does not require root or config secrets.

- [ ] **Step 7: Run tests and commit**

```bash
npx vitest run src/startup.test.ts src/config.request-matching.test.ts src/telegram-transport.test.ts
npm run typecheck
git diff --check
git add Dockerfile docker-compose.yml .env.example src/startup.test.ts README.md docs/architecture.md docs/operations.md AGENTS.md
git commit -m "docs: operate Telegram through Amsterdam egress"
```

Expected: focused tests/typecheck PASS and documentation describes proposed/local versus production truth accurately.

---

### Task 6: Full release gate and secret scan

**Files:**
- Verify all tracked files
- Do not read: `.env`, `.envt`

**Interfaces:**
- Consumes: Tasks 1–5 commits.
- Produces: release-gated commit range safe to push; evidence that real credentials are absent.

- [ ] **Step 1: Run focused proxy/delivery suite**

```bash
npx vitest run src/telegram-proxy-config.test.ts src/telegram-transport.test.ts src/application.test.ts src/bot.test.ts src/telegram.test.ts src/publication-dispatcher.test.ts src/startup.test.ts
```

Expected: all focused tests PASS.

- [ ] **Step 2: Run the complete release gate**

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

Expected: every command exits `0`.

- [ ] **Step 3: Scan tracked changes for credential shapes without opening local secret files**

```bash
git diff origin/main...HEAD -- . ':!*.lock' | rg -n 'vless://|147\.45\.149\.185.*[0-9a-f]{8}-[0-9a-f]{4}|TELEGRAM_PROXY_VLESS_URL=.+'
```

Expected: no real `vless://` URI and no assigned env value. Mentions of the variable name and documentation examples without a value are allowed; any credential-like match blocks release.

- [ ] **Step 4: Review commit range and worktree**

```bash
git status --short --branch
git log --oneline --decorate origin/main..HEAD
```

Expected: only intentional commits; no untracked secret export, `.env` or `.envt` staged.

---

### Task 7: Controlled Timeweb rollout and persisted digest recovery

**Files:**
- Read remote secret without printing: `/opt/club-bot-egress/secrets/bot-vless.txt`
- Copy task-local secret: `/private/tmp/club-bot-vless.txt`
- Update Timeweb App Platform secret storage
- After observed success, update: `AGENTS.md`, `docs/operations.md`

**Interfaces:**
- Consumes: successful server/mobile acceptance, full release gate, one bot VLESS URI.
- Produces: one proxied production bot instance, delivered existing outbox publication, factual production documentation.

- [ ] **Step 1: Ask for exact mutation approval**

Present the release-gate evidence and ask permission for exactly:

1. copy the bot-only URI to a task-local `600` file;
2. add `TELEGRAM_PROXY_VLESS_URL` to the existing Timeweb app;
3. push the reviewed commits to `origin/main` to trigger one production deploy.

Do not proceed on partial or ambiguous approval.

- [ ] **Step 2: Retrieve the bot credential without stdout**

```bash
scp root@147.45.149.185:/opt/club-bot-egress/secrets/bot-vless.txt /private/tmp/club-bot-vless.txt
chmod 600 /private/tmp/club-bot-vless.txt
```

Validate only shape/counts with a non-printing Node command equivalent to Task 4 of the server plan. Never run `cat` on this file in Codex output.

- [ ] **Step 3: Add the secret in Timeweb and keep one replica**

In the existing App Platform application:

- create secret variable named exactly `TELEGRAM_PROXY_VLESS_URL` from `/private/tmp/club-bot-vless.txt`;
- keep replicas/instances equal to `1`;
- leave the other seven variables unchanged;
- do not create a second application or second bot poller.

Expected: configuration shows eight variable names, while the secret value remains masked.

- [ ] **Step 4: Push only after the environment is ready**

```bash
git push origin main
```

Expected: Timeweb builds the reviewed HEAD once. If Timeweb attempts parallel old/new polling and logs 409, wait for the old instance to terminate; do not launch another instance.

- [ ] **Step 5: Verify startup and proxy health**

Expected ordered application events:

```text
PostgreSQL migrations complete
Starting bot...
Telegram proxy ready
Bot is running (long-polling mode)
Scheduled publication dispatcher started
Scheduler started
```

Reject the deploy if Xray exits, SOCKS readiness times out, Telegram `getMe` times out, or logs contain a credential.

- [ ] **Step 6: Inspect current outbox safely**

From the Timeweb application console:

```bash
node --input-type=module -e 'import{Pool}from"pg";const p=new Pool({connectionString:process.env.DATABASE_URL});const{rows}=await p.query("SELECT id,pipeline,publication_date,status,attempt_count,next_attempt_at AT TIME ZONE \'Europe/Moscow\' AS next_attempt_msk,expires_at AT TIME ZONE \'Europe/Moscow\' AS expires_msk,last_error_code FROM scheduled_publications ORDER BY created_at DESC LIMIT 5");console.table(rows);await p.end()'
```

Expected: current digest becomes `delivered` automatically if still active. A stale `delivering` row is reclaimed after its lease.

- [ ] **Step 7: Recover an expired/failed digest without LLM**

If the saved digest is `expired` or `failed`, ask a non-anonymous administrator to run in the target group:

```text
/retry_publications digest
```

Do not run `/digest` or `/dev-digest`. Re-run the safe SQL query and require `status=delivered`, non-null Telegram message IDs in chunks, and advanced `job_state`.

- [ ] **Step 8: Record factual production state and clean task-local secret**

After delivery is observed, update `AGENTS.md` and `docs/operations.md` with the deployed commit from `git rev-parse --short HEAD`, eight-variable production contract, verified Amsterdam egress and delivery outcome. Run:

```bash
git diff --check
git add AGENTS.md docs/operations.md
git commit -m "docs: record Telegram egress rollout"
```

Ask separately before pushing this documentation commit. After the Timeweb secret is confirmed and no further local use is required, request approval and delete only:

```bash
rm -f /private/tmp/club-bot-vless.txt
```

The root-only server export remains for controlled rotation.
