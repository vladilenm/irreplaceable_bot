export const RUNTIME_DEFAULTS = Object.freeze({
  ai: Object.freeze({
    baseUrl: 'https://api.timeweb.ai/v1',
    chatModel: 'openai/gpt-5.6-luna',
    embeddingModel: 'openai/text-embedding-3-small',
    embeddingDimensions: 1536,
  }),
  schedules: Object.freeze({
    threadSummaryCron: '30 6 * * *',
    retentionSweepCron: '0 1 * * *',
    memberSyncCron: '*/5 * * * *',
  }),
  messages: Object.freeze({ retentionDays: 90 }),
  database: Object.freeze({ poolMax: 5, statementTimeoutMs: 10_000 }),
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
  publications: Object.freeze({
    deliveryLeaseMs: 5 * 60_000,
    digestPollIntervalMs: 30_000,
  }),
  matching: Object.freeze({
    concurrency: 2,
    queueLimit: 50,
    processingTimeoutMinutes: 10,
    memberSyncStartupTimeoutMs: 60_000,
    supportedConsentPolicyVersions: Object.freeze(['member-matching-v1'] as const),
  }),
  logging: Object.freeze({ level: 'info' }),
} as const);
