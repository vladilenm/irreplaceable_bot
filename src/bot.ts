import { Bot } from 'grammy';
import { config } from './config.js';
import { logger } from './utils/logger.js';

export const bot = new Bot(config.botToken);

// Error handler -- log errors, don't crash (REL-02)
bot.catch((err) => {
  logger.error({ err: err.error, update: err.ctx?.update?.update_id }, 'Bot error caught');
});

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
