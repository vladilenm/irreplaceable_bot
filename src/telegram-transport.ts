import { once } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { SocksProxyAgent } from 'socks-proxy-agent';
import type { ApiClientOptions } from 'grammy';
import { RUNTIME_DEFAULTS } from './runtime-defaults.js';
import type { TelegramProxyConfig } from './types.js';

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

interface XrayClientConfig {
  log: { access: 'none'; dnsLog: false; loglevel: 'warning' };
  inbounds: Array<{
    listen: string;
    port: number;
    protocol: 'socks';
    settings: { auth: 'noauth'; udp: false };
  }>;
  outbounds: Array<Record<string, unknown>>;
}

function spawnXray(binary: string, args: string[]): XrayProcess {
  return spawn(binary, args, { stdio: ['pipe', 'ignore', 'ignore'] }) as ChildProcess;
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForPort(host: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host, port });
      const settle = (value: boolean): void => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(value);
      };
      socket.once('connect', () => settle(true));
      socket.once('error', () => settle(false));
      socket.setTimeout(1_000, () => settle(false));
    });
    if (connected) return;
    await pause(100);
  }
  throw new Error('SOCKS port did not become ready');
}

export function buildXrayClientConfig(proxy: TelegramProxyConfig): XrayClientConfig {
  return {
    log: { access: 'none', dnsLog: false, loglevel: 'warning' },
    inbounds: [{
      listen: RUNTIME_DEFAULTS.telegram.proxy.socksHost,
      port: RUNTIME_DEFAULTS.telegram.proxy.socksPort,
      protocol: 'socks',
      settings: { auth: 'noauth', udp: false },
    }],
    outbounds: [{
      protocol: 'vless',
      settings: {
        vnext: [{
          address: proxy.host,
          port: proxy.port,
          users: [{
            id: proxy.clientId,
            encryption: proxy.encryption,
            flow: proxy.flow,
          }],
        }],
      },
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
  };
}

function safeExitError(code: number | null, signal: NodeJS.Signals | null): Error {
  if (code !== null) return new Error(`Telegram proxy exited: code=${String(code)}`);
  return new Error(`Telegram proxy exited: signal=${signal ?? 'unknown'}`);
}

function safeChildError(error: Error): Error {
  return new Error(`Telegram proxy process error: ${error.name}`);
}

function defaultCreateAgent(url: string): NonNullable<ApiClientOptions['baseFetchConfig']>['agent'] {
  return new SocksProxyAgent(url) as NonNullable<ApiClientOptions['baseFetchConfig']>['agent'];
}

export async function startTelegramTransport(
  proxy: TelegramProxyConfig | null,
  overrides: Partial<TelegramTransportDependencies> = {},
): Promise<TelegramTransportRuntime> {
  const clientOptions: ApiClientOptions = {
    timeoutSeconds: RUNTIME_DEFAULTS.telegram.requestTimeoutSeconds,
  };
  if (!proxy) {
    return {
      clientOptions,
      completed: new Promise<void>(() => undefined),
      async stop(): Promise<void> {},
    };
  }

  const dependencies: TelegramTransportDependencies = {
    spawnXray: overrides.spawnXray ?? spawnXray,
    waitForPort: overrides.waitForPort ?? waitForPort,
    createAgent: overrides.createAgent ?? defaultCreateAgent,
  };
  const child = dependencies.spawnXray(
    RUNTIME_DEFAULTS.telegram.proxy.binaryPath,
    ['run', '-config', 'stdin:'],
  );
  let expectedExit = false;
  let exited = false;
  let resolveExited: (() => void) | undefined;
  const exitCompleted = new Promise<void>((resolve) => {
    resolveExited = resolve;
  });
  let rejectCompleted: (error: Error) => void = () => undefined;
  const completed = new Promise<void>((_resolve, reject) => {
    rejectCompleted = reject;
  });
  void completed.catch(() => undefined);

  const markExited = (): void => {
    if (exited) return;
    exited = true;
    resolveExited?.();
  };
  child.once('error', (error) => {
    markExited();
    if (!expectedExit) rejectCompleted(safeChildError(error));
  });
  child.once('exit', (code, signal) => {
    markExited();
    if (!expectedExit) rejectCompleted(safeExitError(code, signal));
  });

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    expectedExit = true;
    if (exited) return;
    child.kill('SIGTERM');
    const timeout = pause(RUNTIME_DEFAULTS.telegram.proxy.shutdownTimeoutMs)
      .then(() => 'timeout' as const);
    const result = await Promise.race([
      exitCompleted.then(() => 'exited' as const),
      timeout,
    ]);
    if (result === 'timeout' && !exited) {
      child.kill('SIGKILL');
      await exitCompleted;
    }
  };

  if (!child.stdin) {
    await stop();
    throw new Error('Telegram proxy stdin is unavailable');
  }
  child.stdin.end(JSON.stringify(buildXrayClientConfig(proxy)));

  try {
    await dependencies.waitForPort(
      RUNTIME_DEFAULTS.telegram.proxy.socksHost,
      RUNTIME_DEFAULTS.telegram.proxy.socksPort,
      RUNTIME_DEFAULTS.telegram.proxy.startupTimeoutMs,
    );
  } catch {
    await stop();
    throw new Error('Telegram proxy failed to become ready');
  }

  return {
    clientOptions: {
      ...clientOptions,
      baseFetchConfig: {
        agent: dependencies.createAgent(
          `socks5h://${RUNTIME_DEFAULTS.telegram.proxy.socksHost}:${String(RUNTIME_DEFAULTS.telegram.proxy.socksPort)}`,
        ),
      },
    },
    completed,
    stop,
  };
}
