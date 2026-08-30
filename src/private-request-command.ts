import type { Bot } from 'grammy';
import { logger } from './logger.js';
import type { MemberMatcher } from './request.matcher.js';
import { formatMemberMatches } from './requests.js';

export interface PrivateRequestCommandOptions {
  adminUserId: number | null;
  matcher: Pick<MemberMatcher, 'match'>;
  isMatchingReady?: () => Promise<boolean>;
}

const usageText = 'Использование: /test_request <текст запроса>';
const pendingText = '⏳ Ищу подходящих участников…';
const noMatchText = 'Надёжных совпадений не найдено.';
const failureText = 'Подбор участников временно недоступен. Попробуйте позже.';

export function registerPrivateRequestCommand(
  bot: Bot,
  options: PrivateRequestCommandOptions,
): void {
  if (options.adminUserId === null) return;

  bot.command('test_request', async (ctx) => {
    if (ctx.chat.type !== 'private' || ctx.from?.id !== options.adminUserId) return;

    const query = ctx.match.trim();
    if (!query) {
      await ctx.reply(usageText);
      return;
    }

    const status = await ctx.reply(pendingText);
    try {
      if (options.isMatchingReady && !(await options.isMatchingReady())) {
        throw new Error('Member source is not ready');
      }

      const matches = await options.matcher.match(query, {
        requesterTelegramUserId: String(ctx.from.id),
        minimumMatches: 1,
      });
      const text = matches.length === 0
        ? noMatchText
        : formatMemberMatches(matches.slice(0, 5));
      await ctx.api.editMessageText(
        status.chat.id,
        status.message_id,
        text,
        { parse_mode: 'HTML' },
      );
    } catch (error: unknown) {
      logger.error({
        command: 'test_request',
        errorClass: error instanceof Error ? error.name : 'unknown',
      }, 'Private member request failed');
      await ctx.api.editMessageText(
        status.chat.id,
        status.message_id,
        failureText,
      ).catch((editError: unknown) => {
        logger.error({
          command: 'test_request',
          operation: 'edit',
          errorClass: editError instanceof Error ? editError.name : 'unknown',
        }, 'Private member request status edit failed');
      });
    }
  });
}
