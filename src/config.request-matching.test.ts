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
