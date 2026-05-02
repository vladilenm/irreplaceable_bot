// Sender: formats a DigestResult as Telegram HTML and ships it to the AI-radar thread.
import { formatDigestHtml } from './digest.formatter.js';
import { sendMessageWithRetry } from '../../utils/telegram.js';
import { readState, writeState } from '../../services/state.service.js';
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

  // Phase 8 fix A: state.json write is post-send, not pre-send. If
  // sendMessageWithRetry throws (Telegram down, 409 polling-conflict on the
  // sender side, etc.) the catch in cron handler / /digest handler swallows
  // the throw and lastDigestDate stays UNCHANGED — so the next /digest call
  // can retry instead of being blocked by isDigestPublishedToday() === true.
  await sendMessageWithRetry({
    chatId: config.targetChatId,
    threadId: config.aiRadarThreadId,
    text: html,
    parseMode: 'HTML',
    pipeline: 'digest',
  });

  if (result.persistState) {
    // Phase 6 D-33 merge-write semantics preserved: load fresh state and
    // overwrite ONLY the digest fields so the thread-summary cycle's
    // lastThreadSummaryDate is never clobbered.
    const prev = readState();
    writeState({
      ...prev,
      lastDigestDate: new Date().toISOString(),
      lastSkipped: false,
      lastItemCount: result.itemCount,
    });
  }

  logger.info(
    { itemCount: result.itemCount, date: result.date.toISOString() },
    'Digest published',
  );
}
