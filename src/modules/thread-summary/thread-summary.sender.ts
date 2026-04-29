// Phase 6 thread-summary sender (D-38, DLV-09).
// Iterates chunks; each chunk shipped via existing sendMessageWithRetry
// (single retry on 429 inherited; src/utils/telegram.ts UNCHANGED).
import { sendMessageWithRetry } from '../../utils/telegram.js';
import { config } from '../../config.js';
import { logger } from '../../utils/logger.js';

/**
 * Send thread-summary HTML chunks to THREAD_SUMMARY_THREAD_ID.
 * No-op for empty array. Per-chunk send is sequential (avoids burst rate-limit).
 */
export async function sendThreadSummary(chunks: string[]): Promise<void> {
  if (chunks.length === 0) {
    logger.debug('sendThreadSummary: zero chunks, skipping');
    return;
  }
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (chunk === undefined || chunk === '') continue;
    await sendMessageWithRetry({
      chatId: config.targetChatId,
      threadId: config.threadSummaryThreadId,
      text: chunk,
      parseMode: 'HTML',
    });
    logger.info(
      { chunkIndex: i + 1, chunkCount: chunks.length, chunkLength: chunk.length },
      'Thread-summary chunk sent',
    );
  }
}
