import { Bot, type Context } from 'grammy';
import { config } from './config.js';
import { logger } from './utils/logger.js';
import {
  runDigestPipeline,
  isDigestPublishedToday,
  readState,
} from './modules/digest/digest.service.js';
import { sendDigest } from './modules/digest/digest.sender.js';

export const bot = new Bot(config.botToken);

// Error handler -- log errors, don't crash (REL-02)
bot.catch((err) => {
  logger.error({ err: err.error, update: err.ctx?.update?.update_id }, 'Bot error caught');
});

// Admin-only guard (D-13, D-17, T-03-07, T-03-08).
// WR-04: cache admin list per-chat with a short TTL so that /status or /digest
// spam from non-admins does not hammer the Telegram API (rate-limit / DoS surface).
// Also short-circuit in non-group chats to avoid noisy error logs from
// getChatAdministrators failing on private DMs.
const ADMIN_CACHE_TTL_MS = 5 * 60_000;
const adminCache = new Map<number, { ids: Set<number>; expires: number }>();

async function isAdmin(ctx: Context): Promise<boolean> {
  if (!ctx.chat || !ctx.from) return false;
  if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') return false;

  const now = Date.now();
  const cached = adminCache.get(ctx.chat.id);
  if (cached && cached.expires > now) {
    return cached.ids.has(ctx.from.id);
  }

  try {
    const admins = await ctx.api.getChatAdministrators(ctx.chat.id);
    const ids = new Set(admins.map((admin) => admin.user.id));
    adminCache.set(ctx.chat.id, { ids, expires: now + ADMIN_CACHE_TTL_MS });
    return ids.has(ctx.from.id);
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

// /status command (CMD-03) -- admin-only, reads state.json only, no LLM calls
bot.command('status', async (ctx) => {
  logger.info({ userId: ctx.from?.id }, '/status command received');

  // D-17 / T-03-08: Admin-only
  if (!(await isAdmin(ctx))) {
    await ctx.reply('Команда доступна только администраторам.');
    return;
  }

  // D-20 / T-03-10: Read from state.json, no LLM calls, no secrets exposed
  const state = readState();

  let lastDigestInfo: string;
  if (state.lastDigestDate) {
    const lastDate = new Date(state.lastDigestDate);
    const formattedDate = lastDate.toLocaleDateString('ru-RU', {
      day: 'numeric',
      month: 'long',
      timeZone: 'Europe/Moscow',
    });
    const resultText = state.lastSkipped ? 'пропущен' : 'опубликован';
    lastDigestInfo = `📡 Последний дайджест: ${formattedDate} — ${state.lastItemCount} новостей (${resultText})`;
  } else {
    lastDigestInfo = '📡 Дайджестов ещё не было';
  }

  // D-18: cron schedule (UTC expression from config)
  const nextRunInfo = `⏰ Расписание: ${config.digestCron} UTC`;

  // Bot uptime
  const uptimeSeconds = process.uptime();
  const uptimeHours = Math.floor(uptimeSeconds / 3600);
  const uptimeMinutes = Math.floor((uptimeSeconds % 3600) / 60);
  const uptimeText =
    uptimeHours > 0 ? `${uptimeHours}ч ${uptimeMinutes}м` : `${uptimeMinutes}м`;

  const statusText = [
    '🤖 Статус бота',
    '',
    lastDigestInfo,
    nextRunInfo,
    `⏱ Аптайм: ${uptimeText}`,
  ].join('\n');

  // D-19: reply in same chat/thread
  await ctx.reply(statusText);
});
