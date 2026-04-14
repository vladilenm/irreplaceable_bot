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
};
