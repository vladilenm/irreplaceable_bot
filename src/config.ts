import type { BotConfig } from './types/index.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

// Fail fast on malformed integer env vars (WR-03): a typo like THREAD_ID=abc
// would otherwise silently become NaN and crash only at first Telegram API call,
// potentially 9 hours after startup when the cron fires.
function requireEnvInt(name: string): string {
  const value = requireEnv(name);
  if (!/^-?\d+$/.test(value)) {
    throw new Error(`Environment variable ${name} must be an integer, got "${value}"`);
  }
  return value;
}

// v2.0 Phase 4: integer ENV with optional default and a minimum bound.
// MESSAGE_RETENTION_DAYS uses this with min=7 to defeat PRIV-02 typo regression
// (e.g. MESSAGE_RETENTION_DAYS=9 instead of 90 would empty the summariser window).
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

// v2.0 Phase 4 D-02: CSV of message_thread_id values to seed tracked_threads on first boot.
// Empty string → []. Whitespace tolerated. Non-integer entry → throw at startup.
function parseInitialTrackedThreadIds(raw: string): number[] {
  if (raw.trim() === '') return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const n = Number(s);
      if (!Number.isInteger(n)) {
        throw new Error(`INITIAL_TRACKED_THREAD_IDS contains non-integer: "${s}"`);
      }
      return n;
    });
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
  // ── v2.0 thread summaries (Phase 4) ──
  threadSummaryThreadId: requireEnvInt('THREAD_SUMMARY_THREAD_ID'),
  threadSummaryCron: process.env['THREAD_SUMMARY_CRON'] ?? '30 3 * * *',
  messageRetentionDays: readEnvIntWithDefault('MESSAGE_RETENTION_DAYS', 90, 7),
  retentionSweepCron: process.env['RETENTION_SWEEP_CRON'] ?? '0 1 * * *',
  dbPath: process.env['DB_PATH'] ?? 'data/messages.db',
  initialTrackedThreadIds: parseInitialTrackedThreadIds(process.env['INITIAL_TRACKED_THREAD_IDS'] ?? ''),
};
