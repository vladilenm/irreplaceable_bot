import { GrammyError, type Bot } from 'grammy';
import { config } from './config.js';
import { logger, errMsg } from './logger.js';

export type StartupErrorKind = 'polling-conflict-409' | 'unknown';

/**
 * Classify a bot.start() rejection.
 *
 * Telegram returns 409 when more than one client (long-poll OR webhook) is
 * connected to the same bot token at the same time. grammy 1.42 wraps that
 * response in a GrammyError with error_code === 409 and rethrows it from
 * bot.start().
 *
 * Operationally this is almost always:
 *   • a stale container from a rolling deploy that hasn't been killed yet, or
 *   • a parallel local dev process reading the same .env, or
 *   • a Timeweb App Platform replicas>1 setting.
 *
 * These cases should back off before the process supervisor restarts the bot.
 */
export function classifyStartupError(err: unknown): StartupErrorKind {
  if (err instanceof GrammyError && err.error_code === 409) {
    return 'polling-conflict-409';
  }
  return 'unknown';
}

/** Backoff before exiting after a competing Telegram poller is detected. */
export const POLLING_CONFLICT_BACKOFF_MS = 60_000;

export async function runPreflight(bot: Bot): Promise<void> {
  try {
    const me = await bot.api.getMe();
    if (me.can_read_all_group_messages !== true) {
      logger.warn(
        { botId: me.id, username: me.username },
        'Privacy mode is ON — normal group messages are unavailable',
      );
    }
    const member = await bot.api.getChatMember(config.targetChatId, me.id);
    if (member.status !== 'administrator' && member.status !== 'creator') {
      logger.warn(
        { chatId: config.targetChatId, status: member.status },
        'Bot is not an administrator in the target chat',
      );
    }
  } catch (err: unknown) {
    logger.error({ err }, `Preflight check failed (non-fatal): ${errMsg(err)}`);
  }
}
