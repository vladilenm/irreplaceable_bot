import type { BotConfig, DatabaseConfig, RequestMatchingConfig } from './types.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

// Fail at startup rather than at the first scheduled Telegram API call.
function requireEnvInt(name: string): number {
  const value = requireEnv(name);
  if (!/^-?\d+$/.test(value)) {
    throw new Error(`Environment variable ${name} must be an integer, got "${value}"`);
  }
  return Number(value);
}

function readEnvIntWithDefault(name: string, defaultValue: number, min?: number): number {
  const raw = process.env[name];
  const value = raw === undefined || raw === '' ? defaultValue : Number(raw);
  if (!Number.isInteger(value)) {
    throw new Error(`Environment variable ${name} must be an integer, got "${String(raw)}"`);
  }
  if (min !== undefined && value < min) {
    throw new Error(`Environment variable ${name} must be >= ${String(min)}, got ${String(value)}`);
  }
  return value;
}

function parseTrackedThreadIds(raw: string): number[] {
  if (raw.trim() === '') return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const n = Number(s);
      if (!Number.isInteger(n)) {
        throw new Error(`TRACKED_THREAD_IDS contains non-integer: "${s}"`);
      }
      return n;
    });
}

export function readRequestMatchingConfig(
  env: NodeJS.ProcessEnv,
): RequestMatchingConfig | null {
  const flag = env['REQUEST_MATCHING_ENABLED'] ?? 'false';
  if (flag !== 'true' && flag !== 'false') {
    throw new Error('REQUEST_MATCHING_ENABLED must be true or false');
  }
  if (flag === 'false') return null;

  const required = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`Missing required environment variable: ${name}`);
    return value;
  };
  const positive = (name: string, fallback: number): number => {
    const raw = env[name];
    const value = raw === undefined || raw === '' ? fallback : Number(raw);
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`${name} must be >= 1`);
    }
    return value;
  };

  return {
    embeddingApiKey: required('EMBEDDING_API_KEY'),
    embeddingModel: required('EMBEDDING_MODEL'),
    memberIndexCron: env['MEMBER_INDEX_CRON'] ?? '*/15 * * * *',
    concurrency: positive('REQUEST_MATCH_CONCURRENCY', 2),
    queueLimit: positive('REQUEST_QUEUE_LIMIT', 50),
    processingTimeoutMinutes: positive('REQUEST_PROCESSING_TIMEOUT_MINUTES', 10),
  };
}

export function readDatabaseConfig(env: NodeJS.ProcessEnv): DatabaseConfig {
  const required = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`Missing required environment variable: ${name}`);
    return value;
  };
  const positive = (name: string, fallback: number): number => {
    const raw = env[name];
    const value = raw === undefined || raw === '' ? fallback : Number(raw);
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`${name} must be >= 1`);
    }
    return value;
  };
  const sslRaw = env['DATABASE_SSL'] ?? 'true';
  if (sslRaw !== 'true' && sslRaw !== 'false') {
    throw new Error('DATABASE_SSL must be true or false');
  }
  return {
    runtimeUrl: required('DATABASE_URL'),
    migrationUrl: required('DATABASE_MIGRATION_URL'),
    ssl: sslRaw === 'true',
    poolMax: positive('DATABASE_POOL_MAX', 5),
    statementTimeoutMs: positive('DATABASE_STATEMENT_TIMEOUT_MS', 10_000),
  };
}

export const config: BotConfig = {
  botToken: requireEnv('BOT_TOKEN'),
  targetChatId: requireEnvInt('TARGET_CHAT_ID'),
  aiRadarThreadId: requireEnvInt('AI_RADAR_THREAD_ID'),
  digestCron: process.env['DIGEST_CRON'] ?? '0 6 * * *',
  aiApiKey: requireEnv('AI_API_KEY'),
  aiModel: process.env['AI_MODEL'] ?? 'claude-sonnet-4-20250514',
  aiBaseUrl: process.env['AI_BASE_URL'],
  logLevel: process.env['LOG_LEVEL'] ?? 'info',
  nodeEnv: process.env['NODE_ENV'] ?? 'production',
  threadSummaryThreadId: requireEnvInt('THREAD_SUMMARY_THREAD_ID'),
  threadSummaryCron: process.env['THREAD_SUMMARY_CRON'] ?? '30 3 * * *',
  messageRetentionDays: readEnvIntWithDefault('MESSAGE_RETENTION_DAYS', 90, 7),
  retentionSweepCron: process.env['RETENTION_SWEEP_CRON'] ?? '0 1 * * *',
  database: readDatabaseConfig(process.env),
  dbPath: process.env['DB_PATH'] ?? 'data/messages.db',
  trackedThreadIds: parseTrackedThreadIds(
    process.env['TRACKED_THREAD_IDS'] ??
      process.env['INITIAL_TRACKED_THREAD_IDS'] ??
      '',
  ),
  requestMatching: readRequestMatchingConfig(process.env),
};
