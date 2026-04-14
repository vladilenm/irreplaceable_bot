import { Bot, type Context } from 'grammy';
import { config } from './config.js';
import { logger } from './utils/logger.js';
import {
  runDigestPipeline,
  isDigestPublishedToday,
} from './modules/digest/digest.service.js';
import { sendDigest } from './modules/digest/digest.sender.js';

export const bot = new Bot(config.botToken);

// Error handler -- log errors, don't crash (REL-02)
bot.catch((err) => {
  logger.error({ err: err.error, update: err.ctx?.update?.update_id }, 'Bot error caught');
});

// Admin-only guard (D-13, D-17, T-03-07, T-03-08)
async function isAdmin(ctx: Context): Promise<boolean> {
  if (!ctx.chat || !ctx.from) return false;
  try {
    const admins = await ctx.api.getChatAdministrators(ctx.chat.id);
    return admins.some((admin) => admin.user.id === ctx.from?.id);
  } catch (err: unknown) {
    logger.error({ err }, 'Failed to check admin status');
    return false;
  }
}

// /start command (CMD-01)
bot.command('start', async (ctx) => {
  logger.info({ userId: ctx.from?.id }, '/start command received');
  await ctx.reply(
    '👋 Привет! Я бот Клуба Незаменимых.\n\n' +
    '📡 AI-радар — ежедневный дайджест AI-новостей.\n' +
    'Каждое утро я публикую 3–5 самых значимых новостей из мира AI, ' +
    'отфильтрованных под контекст клуба.\n\n' +
    'Источники: Habr, vc.ru, OpenAI, Anthropic, HuggingFace, LangChain, ' +
    'VentureBeat, Cursor, Tproger.\n\n' +
    'Система > Навык',
  );
});

// /digest command (CMD-02) -- manual pipeline trigger, admin-only, idempotent
bot.command('digest', async (ctx) => {
  logger.info({ userId: ctx.from?.id }, '/digest command received');

  // D-13 / T-03-07: Admin-only
  if (!(await isAdmin(ctx))) {
    await ctx.reply('Команда доступна только администраторам.');
    return;
  }

  // D-14 / T-03-09: Idempotency check
  if (isDigestPublishedToday()) {
    await ctx.reply('Дайджест уже опубликован сегодня.');
    return;
  }

  // D-15: status message, edited in place with result
  const statusMsg = await ctx.reply('Запускаю сборку дайджеста...');

  try {
    const result = await runDigestPipeline();

    if (result.skipped) {
      await ctx.api.editMessageText(
        statusMsg.chat.id,
        statusMsg.message_id,
        'Дайджест пропущен: недостаточно значимых новостей (менее 3).',
      );
      return;
    }

    await sendDigest(result);

    await ctx.api.editMessageText(
      statusMsg.chat.id,
      statusMsg.message_id,
      `Дайджест опубликован: ${result.itemCount} новостей.`,
    );
  } catch (err: unknown) {
    logger.error({ err }, '/digest command failed');
    await ctx.api
      .editMessageText(
        statusMsg.chat.id,
        statusMsg.message_id,
        'Ошибка при сборке дайджеста. Подробности в логах.',
      )
      .catch(() => {
        /* ignore edit failure */
      });
  }
});
