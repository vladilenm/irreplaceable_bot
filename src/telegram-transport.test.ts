import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { TelegramProxyConfig } from './types.js';
import {
  buildXrayClientConfig,
  startTelegramTransport,
  type XrayProcess,
} from './telegram-transport.js';

const proxy: TelegramProxyConfig = {
  host: '147.45.149.185',
  port: 443,
  clientId: '8f93928e-8193-46e8-a596-9324c11e6fe4',
  encryption: 'none',
  flow: 'xtls-rprx-vision',
  security: 'reality',
  network: 'tcp',
  serverName: 'www.cloudflare.com',
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
          serverName: 'www.cloudflare.com',
          fingerprint: 'chrome',
          publicKey: proxy.publicKey,
          shortId: proxy.shortId,
          spiderX: '/',
        },
      },
    });
  });
});

describe('startTelegramTransport', () => {
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
      createAgent: vi.fn(() => ({} as never)),
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
});
