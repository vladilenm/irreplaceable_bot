import type { Bot } from 'grammy';
import { config } from '../config.js';
import { logger, errMsg } from './logger.js';

/**
 * Boot-time self-check (MSG-08, OPS-03). Logs WARN on misconfig but does NOT
 * throw — the bot keeps running, the operator gets a clear log line to act on.
 *
 * Two checks:
 * 1. getMe().can_read_all_group_messages — privacy mode toggle. ON means
 *    the bot only sees commands; capture appears to "work" in tests but stays
 *    empty in production (PITFALLS CRIT-01).
 * 2. getChatMember(targetChatId, botId).status — admin status in club group.
 *    Re-invite after privacy-off can demote the bot (PITFALLS CRIT-02).
 *
 * Wired in src/index.ts via bot.start({ onStart: () => { void runPreflight(bot) } }).
 * Non-blocking: runs after bot.start() returns, before first poll-cycle update.
 */
export async function runPreflight(bot: Bot): Promise<void> {
  try {
    const me = await bot.api.getMe();
    if (me.can_read_all_group_messages !== true) {
      logger.warn(
        {
          botId: me.id,
          username: me.username,
          can_read_all_group_messages: me.can_read_all_group_messages,
        },
        'PRIVACY MODE ON — bot will not see normal user messages. Disable in BotFather and re-promote.',
      );
    } else {
      logger.info(
        { botId: me.id, username: me.username },
        'Privacy mode OFF, bot will receive group messages',
      );
    }

    const targetChatId = Number(config.targetChatId);
    if (!Number.isInteger(targetChatId)) {
      logger.warn(
        { targetChatId: config.targetChatId },
        'TARGET_CHAT_ID is not numeric — skipping admin status check',
      );
      return;
    }
    const member = await bot.api.getChatMember(targetChatId, me.id);
    if (member.status !== 'administrator' && member.status !== 'creator') {
      logger.warn(
        { chatId: targetChatId, status: member.status },
        'Bot is NOT admin in target chat — capture may behave unexpectedly. Promote in chat settings.',
      );
    } else {
      logger.info(
        { chatId: targetChatId, status: member.status },
        'Bot is admin in target chat',
      );
    }
  } catch (err: unknown) {
    logger.error({ err }, `Preflight check failed (non-fatal): ${errMsg(err)}`);
  }
}
