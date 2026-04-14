import type { BotConfig } from './types/index.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config: BotConfig = {
  botToken: requireEnv('BOT_TOKEN'),
  targetChatId: requireEnv('TARGET_CHAT_ID'),
  aiRadarThreadId: requireEnv('AI_RADAR_THREAD_ID'),
  digestCron: process.env['DIGEST_CRON'] ?? '0 6 * * *',
  aiApiKey: requireEnv('AI_API_KEY'),
  aiModel: process.env['AI_MODEL'] ?? 'claude-sonnet-4-20250514',
  aiBaseUrl: process.env['AI_BASE_URL'],
  logLevel: process.env['LOG_LEVEL'] ?? 'info',
  nodeEnv: process.env['NODE_ENV'] ?? 'production',
};
