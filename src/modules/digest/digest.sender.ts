// Sender: formats a DigestResult as Telegram HTML and ships it to the AI-radar thread.
import { formatDigestHtml } from './digest.formatter.js';
import { sendMessageWithRetry } from '../../utils/telegram.js';
import { config } from '../../config.js';
import { logger } from '../../utils/logger.js';
import type { DigestResult } from './digest.service.js';

export async function sendDigest(result: DigestResult): Promise<void> {
  if (result.skipped) {
    logger.warn({ itemCount: result.itemCount }, 'Digest skipped, not sending');
    return;
  }
  if (result.text === '') {
    logger.warn('Digest text is empty, not sending');
    return;
  }

  const html = formatDigestHtml(result.text);

  await sendMessageWithRetry({
    chatId: config.targetChatId,
    threadId: config.aiRadarThreadId,
    text: html,
    parseMode: 'HTML',
  });

  logger.info(
    { itemCount: result.itemCount, date: result.date.toISOString() },
    'Digest published',
  );
}
