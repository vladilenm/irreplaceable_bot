import { Bot, type ApiClientOptions, type Context } from 'grammy';
import { config } from './config.js';
import { logger, errMsg } from './logger.js';
import { registerCaptureHandlers } from './capture.js';
import { registerRequestHandlers } from './requests.js';
import { registerPrivateRequestCommand } from './private-request-command.js';
import type { RequestMatchingRuntime } from './request.runtime.js';
import type { CorePersistence } from './persistence.js';
import type { PublicationDispatcher } from './publication-dispatcher.js';
import type { ScheduledPublicationPipeline } from './scheduled-publication.repository.js';
import { nextMoscowMidnight } from './time.js';

export interface CreateBotOptions {
  persistence: CorePersistence;
  requestMatching?: RequestMatchingRuntime;
  dispatcher?: PublicationDispatcher;
  telegramClientOptions?: ApiClientOptions;
}

export function parseRetryPublicationPipeline(
  argument: string,
): ScheduledPublicationPipeline | null | undefined {
  const value = argument.trim().toLowerCase();
  if (value === '' || value === 'all') return null;
  if (value === 'digest') return 'digest';
  if (value === 'summary') return 'thread-summary';
  return undefined;
}

export function createBot(options: CreateBotOptions): Bot {
  const bot = new Bot(config.botToken, {
    client: options.telegramClientOptions,
  });

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
    '🗞 Я доставляю готовый выпуск Topic Digest в клубный AI-топик ' +
    'и помогаю находить участников по точному хэштегу #запрос.\n\n' +
    'Система > Навык',
  );
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

  const nextRunInfo = '🗞 Дайджест: автоматически после публикации Topic Digest';

  // Bot uptime
  const uptimeSeconds = process.uptime();
  const uptimeHours = Math.floor(uptimeSeconds / 3600);
  const uptimeMinutes = Math.floor((uptimeSeconds % 3600) / 60);
  const uptimeText =
    uptimeHours > 0 ? `${uptimeHours}ч ${uptimeMinutes}м` : `${uptimeMinutes}м`;

  let sourceInfo = '🗂 Источник анкет: успешной синхронизации ещё не было';
  let indexInfo = '🧩 Индекс: ещё не готов';
  try {
    const [sourceStatus, indexStatus] = options.requestMatching
      ? await Promise.all([
        options.requestMatching.memberRepository.readSourceStatus('web'),
        options.requestMatching.memberRepository.readIndexStatus('postgres'),
      ])
      : [null, null];
    sourceInfo = sourceStatus
      ? `🗂 Источник анкет: ${String(sourceStatus.activeCount)} активных, ${String(sourceStatus.rejectedCount)} отклонена, поколение ${String(sourceStatus.generation)}, синхронизация ${new Date(sourceStatus.lastSuccessAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} МСК`
      : '🗂 Источник анкет: успешной синхронизации ещё не было';
    indexInfo = indexStatus
      ? `🧩 Индекс: ${String(indexStatus.activeCount)} активных, ${String(indexStatus.pendingCount)} ожидают индексации, ${indexStatus.embeddingModel}`
      : '🧩 Индекс: ещё не готов';
  } catch (error: unknown) {
    logger.error(
      { errorClass: error instanceof Error ? error.name : 'unknown' },
      'Member matching status read failed',
    );
    sourceInfo = '🗂 Источник анкет: нет данных';
    indexInfo = '🧩 Индекс: нет данных';
  }
  let publicationInfo = '📨 Очередь публикаций: нет данных';
  try {
    const counts = await options.persistence.publications.getStatusCounts();
    if (counts.length > 0) {
      publicationInfo = `📨 Очередь публикаций: ${counts.map((entry) =>
        `${entry.pipeline} ${entry.status}: ${String(entry.count)}`).join(', ')}`;
    }
  } catch (error: unknown) {
    logger.error(
      { errorClass: error instanceof Error ? error.name : 'unknown' },
      'Publication status read failed',
    );
  }

  const statusText = [
    '🤖 Статус бота',
    '',
    lastDigestInfo,
    nextRunInfo,
    publicationInfo,
    sourceInfo,
    indexInfo,
    `⏱ Аптайм: ${uptimeText}`,
  ].join('\n');

  await ctx.reply(statusText);
  });

  bot.command('retry_publications', async (ctx) => {
  logger.info({ userId: ctx.from?.id }, '/retry_publications command received');
  if (!(await isAdmin(ctx))) {
    await ctx.reply('Команда доступна только администраторам.');
    return;
  }
  const pipeline = parseRetryPublicationPipeline(ctx.match);
  if (pipeline === undefined) {
    await ctx.reply('Использование: /retry_publications [digest|summary|all]');
    return;
  }
  if (!options.dispatcher) {
    await ctx.reply('Повторная отправка сейчас недоступна.');
    return;
  }
  const now = new Date();
  const recovered = await options.persistence.publications.recover(
    pipeline,
    now,
    nextMoscowMidnight(now),
  );
  await options.dispatcher.dispatchDue();
  await ctx.reply(`Поставлено на повторную отправку: ${String(recovered)}.`);
  });

  if (options.requestMatching && config.privateTestAdminId !== null) {
    registerPrivateRequestCommand(bot, {
      adminUserId: config.privateTestAdminId,
      matcher: options.requestMatching.matcher,
      isMatchingReady: options.requestMatching.handlerOptions.isMatchingReady,
    });
  }
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
