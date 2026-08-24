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

const validProxyUrl =
  'v' + 'less://8f93928e-8193-46e8-a596-9324c11e6fe4@203.0.113.7:443' +
  '?encryption=none&flow=xtls-rprx-vision&security=reality' +
  '&sni=www.cloudflare.com&fp=chrome' +
  '&pbk=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  '&sid=0123456789abcdef&type=tcp#club-bot-amsterdam';

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
      aiModel: 'openai/gpt-5.6-luna',
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
        embeddingModel: 'openai/text-embedding-3-small',
        embeddingDimensions: 1536,
        memberIndexCron: '*/15 * * * *',
        concurrency: 2,
        queueLimit: 50,
        processingTimeoutMinutes: 10,
      },
    });
    expect(config.digestCron).toBe(RUNTIME_DEFAULTS.schedules.digestCron);
    expect(config.threadSummaryCron).toBe('30 6 * * *');
    expect(config.telegramProxy).toBeNull();

    const proxied = readConfig({
      ...validEnv,
      TELEGRAM_PROXY_VLESS_URL: validProxyUrl,
    }, () => 'timeweb-ca');
    expect(proxied.telegramProxy?.host).toBe('203.0.113.7');
  });

  it.each([
    'BOT_TOKEN',
    'TARGET_CHAT_ID',
    'AI_RADAR_THREAD_ID',
    'THREAD_SUMMARY_THREAD_ID',
    'TRACKED_THREAD_IDS',
    'TIMEWEB_AI_TOKEN',
    'DATABASE_URL',
  ])('fails fast when %s is missing', (name) => {
    const env: NodeJS.ProcessEnv = { ...validEnv };
    delete env[name];
    expect(() => readConfig(env, () => 'timeweb-ca')).toThrow(name);
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

  it.each([
    '10.0.0.1',
    '10.255.255.254',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.0.4',
  ])('disables TLS for private PostgreSQL host %s without reading the CA', (host) => {
    const loadCa = vi.fn(() => 'timeweb-ca');
    expect(readDatabaseConfig({
      DATABASE_URL: `postgresql://club:secret@${host}:5432/club`,
    }, loadCa)).toMatchObject({ ssl: false });
    expect(loadCa).not.toHaveBeenCalled();
  });

  it.each([
    '172.15.255.255',
    '172.32.0.1',
    '8.8.8.8',
  ])('keeps verified TLS for non-private IPv4 host %s', (host) => {
    expect(readDatabaseConfig({
      DATABASE_URL: `postgresql://club:secret@${host}:5432/club`,
    }, () => 'timeweb-ca')).toMatchObject({ ssl: true, caCert: 'timeweb-ca' });
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
