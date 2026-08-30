import { RUNTIME_DEFAULTS } from './runtime-defaults.js';
import type { BotConfig } from './types.js';
import { readDatabaseConfig } from './database-config.js';
import { readTelegramProxyConfig } from './telegram-proxy-config.js';

export { readDatabaseConfig } from './database-config.js';

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

// Fail at startup rather than at the first scheduled Telegram API call.
function requireEnvInt(env: NodeJS.ProcessEnv, name: string): number {
  const value = requireEnv(env, name);
  if (!/^-?\d+$/.test(value)) {
    throw new Error(`Environment variable ${name} must be an integer, got "${value}"`);
  }
  return Number(value);
}

function optionalPositiveSafeInteger(
  env: NodeJS.ProcessEnv,
  name: string,
): number | null {
  const raw = env[name]?.trim();
  if (!raw) return null;
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} must be a positive safe integer`);
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

export function readTimewebAiToken(env: NodeJS.ProcessEnv): string {
  return requireEnv(env, 'TIMEWEB_AI_TOKEN');
}

export function readConfig(
  env: NodeJS.ProcessEnv,
  loadCa?: () => string,
): BotConfig {
  const timewebAiToken = readTimewebAiToken(env);
  return {
    botToken: requireEnv(env, 'BOT_TOKEN'),
    targetChatId: requireEnvInt(env, 'TARGET_CHAT_ID'),
    aiRadarThreadId: requireEnvInt(env, 'AI_RADAR_THREAD_ID'),
    digestCron: RUNTIME_DEFAULTS.schedules.digestCron,
    aiApiKey: timewebAiToken,
    aiModel: RUNTIME_DEFAULTS.ai.chatModel,
    aiBaseUrl: RUNTIME_DEFAULTS.ai.baseUrl,
    logLevel: RUNTIME_DEFAULTS.logging.level,
    threadSummaryThreadId: requireEnvInt(env, 'THREAD_SUMMARY_THREAD_ID'),
    threadSummaryCron: RUNTIME_DEFAULTS.schedules.threadSummaryCron,
    messageRetentionDays: RUNTIME_DEFAULTS.messages.retentionDays,
    retentionSweepCron: RUNTIME_DEFAULTS.schedules.retentionSweepCron,
    database: readDatabaseConfig(env, loadCa),
    trackedThreadIds: parseTrackedThreadIds(requireEnv(env, 'TRACKED_THREAD_IDS')),
    privateTestAdminId: optionalPositiveSafeInteger(env, 'PRIVATE_TEST_ADMIN_ID'),
    requestMatching: {
      embeddingApiKey: timewebAiToken,
      embeddingBaseUrl: RUNTIME_DEFAULTS.ai.baseUrl,
      embeddingModel: RUNTIME_DEFAULTS.ai.embeddingModel,
      embeddingDimensions: RUNTIME_DEFAULTS.ai.embeddingDimensions,
      memberSyncCron: RUNTIME_DEFAULTS.schedules.memberSyncCron,
      memberSyncStartupTimeoutMs: RUNTIME_DEFAULTS.matching.memberSyncStartupTimeoutMs,
      supportedConsentPolicyVersions: RUNTIME_DEFAULTS.matching.supportedConsentPolicyVersions,
      concurrency: RUNTIME_DEFAULTS.matching.concurrency,
      queueLimit: RUNTIME_DEFAULTS.matching.queueLimit,
      processingTimeoutMinutes: RUNTIME_DEFAULTS.matching.processingTimeoutMinutes,
    },
    telegramProxy: readTelegramProxyConfig(env),
  };
}

export const config = readConfig(process.env);
