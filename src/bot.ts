import { Bot, type Context } from 'grammy';
import { config } from './config.js';
import { logger, errMsg } from './logger.js';
import {
  runDigestPipeline,
  sendDigest,
} from './radar.js';
import { isDigestPublishedTodayWithState } from './job-state.repository.js';
import { registerCaptureHandlers } from './capture.js';
import { registerRequestHandlers } from './requests.js';
import type { RequestMatchingRuntime } from './request.runtime.js';
import type { CorePersistence } from './persistence.js';

export interface CreateBotOptions {
  persistence: CorePersistence;
  requestMatching?: RequestMatchingRuntime;
}

export function createBot(options: CreateBotOptions): Bot {
  const bot = new Bot(config.botToken);

  bot.catch((err) => {
    logger.error({ err: err.error, update: err.ctx?.update?.update_id }, `Bot error caught: ${errMsg(err.error)}`);
  });

  // Cache administrators briefly to avoid a Telegram API call for every command.
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
    logger.error({ err }, `Failed to check admin status: ${errMsg(err)}`);
    return false;
  }
  }

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

  bot.command('digest', async (ctx) => {
  logger.info({ userId: ctx.from?.id }, '/digest command received');

  if (!(await isAdmin(ctx))) {
    await ctx.reply('Команда доступна только администраторам.');
    return;
  }

  const state = await options.persistence.jobs.read();
  if (isDigestPublishedTodayWithState(state)) {
    await ctx.reply('Дайджест уже опубликован сегодня.');
    return;
  }

  const statusMsg = await ctx.reply('Запускаю сборку дайджеста...');

  try {
    const result = await runDigestPipeline(options.persistence.jobs);

    if (result.skipped) {
      await ctx.api.editMessageText(
        statusMsg.chat.id,
        statusMsg.message_id,
        'Дайджест пропущен: ни одной новости не прошло фильтр.',
      );
      return;
    }

    await sendDigest(bot.api, result, options.persistence.jobs);

    await ctx.api.editMessageText(
      statusMsg.chat.id,
      statusMsg.message_id,
      `Дайджест опубликован: ${result.itemCount} новостей.`,
    );
  } catch (err: unknown) {
    logger.error({ err }, `/digest command failed: ${errMsg(err)}`);
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

  bot.command('status', async (ctx) => {
  logger.info({ userId: ctx.from?.id }, '/status command received');

  if (!(await isAdmin(ctx))) {
    await ctx.reply('Команда доступна только администраторам.');
    return;
  }

  const state = await options.persistence.jobs.read();

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

  const nextRunInfo = `⏰ Расписание: ${config.digestCron} UTC`;

  // Bot uptime
  const uptimeSeconds = process.uptime();
  const uptimeHours = Math.floor(uptimeSeconds / 3600);
  const uptimeMinutes = Math.floor((uptimeSeconds % 3600) / 60);
  const uptimeText =
    uptimeHours > 0 ? `${uptimeHours}ч ${uptimeMinutes}м` : `${uptimeMinutes}м`;

  const matchingSnapshot = options.requestMatching
    ? await options.requestMatching.memberRepository.readIndexStatus('postgres')
    : null;
  const matchingInfo = !config.requestMatching
    ? '🧩 Подбор участников: выключен'
    : !matchingSnapshot
      ? '🧩 Подбор участников: индекс ещё не готов'
      : `🧩 Подбор участников: ${String(matchingSnapshot.activeCount)} активных, ${String(matchingSnapshot.pendingCount)} ожидают индексации, ${matchingSnapshot.embeddingModel}, индекс обновлён ${new Date(matchingSnapshot.lastSuccessAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} МСК`;

  const statusText = [
    '🤖 Статус бота',
    '',
    lastDigestInfo,
    nextRunInfo,
    matchingInfo,
    `⏱ Аптайм: ${uptimeText}`,
  ].join('\n');

  await ctx.reply(statusText);
  });

// Repeatable development run: publishes the real format without advancing job state.
  bot.command('dev-digest', async (ctx) => {
  logger.info({ userId: ctx.from?.id, devRun: true }, '/dev-digest command received');

  if (!(await isAdmin(ctx))) {
    await ctx.reply('Команда доступна только администраторам.');
    return;
  }

  const statusMsg = await ctx.reply('Dev-run: запускаю сборку дайджеста...');

  try {
    const result = await runDigestPipeline(options.persistence.jobs, {
      skipIdempotency: true,
      persistState: false,
    });

    if (result.skipped) {
      await ctx.api.editMessageText(
        statusMsg.chat.id,
        statusMsg.message_id,
        'Dev-run: дайджест пропущен: ни одной новости не прошло фильтр. Состояние запуска не изменено.',
      );
      return;
    }

    await sendDigest(bot.api, result, options.persistence.jobs);

    logger.info(
      { itemCount: result.itemCount, devRun: true },
      'Dev-digest published (state NOT persisted)',
    );

    await ctx.api.editMessageText(
      statusMsg.chat.id,
      statusMsg.message_id,
      `Dev-run: опубликовано ${result.itemCount} новостей. Состояние запуска не изменено.`,
    );
  } catch (err: unknown) {
    logger.error({ err, devRun: true }, `/dev-digest command failed: ${errMsg(err)}`);
    await ctx.api
      .editMessageText(
        statusMsg.chat.id,
        statusMsg.message_id,
        'Dev-run: ошибка при сборке дайджеста. Подробности в логах.',
      )
      .catch(() => {
        /* ignore edit failure */
      });
  }
  });

  if (options.requestMatching) {
    registerRequestHandlers(bot, options.requestMatching.handlerOptions);
  }
  // Capture is terminal middleware, so commands and member requests precede it.
  registerCaptureHandlers(bot, {
    targetChatId: config.targetChatId,
    trackedThreadIds: new Set(config.trackedThreadIds),
    messages: options.persistence.messages,
  });
  return bot;
}
