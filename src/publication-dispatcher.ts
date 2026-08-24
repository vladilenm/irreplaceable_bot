import { logger } from './logger.js';
import { RUNTIME_DEFAULTS } from './runtime-defaults.js';
import type { JobStateRepository } from './job-state.repository.js';
import type { ScheduledPublicationRepository } from './scheduled-publication.repository.js';
import type { SendMessageOnceResult, SendMessageParams } from './telegram.js';

const RETRY_DELAYS_MS = [3_000, 15_000, 60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000] as const;
const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_BATCH_SIZE = 10;

export function retryDelayMs(attemptCount: number): number {
  return RETRY_DELAYS_MS[Math.min(Math.max(attemptCount - 1, 0), RETRY_DELAYS_MS.length - 1)]!;
}

export interface PublicationDispatcher {
  dispatchDue(now?: Date): Promise<void>;
  start(): void;
  stop(): void;
}

export interface PublicationDispatcherOptions {
  publications: ScheduledPublicationRepository;
  jobs: JobStateRepository;
  sendMessageOnce(params: SendMessageParams): Promise<SendMessageOnceResult>;
  leaseMs?: number;
  intervalMs?: number;
  batchSize?: number;
}

export function createPublicationDispatcher(options: PublicationDispatcherOptions): PublicationDispatcher {
  const leaseMs = options.leaseMs ?? RUNTIME_DEFAULTS.publications.deliveryLeaseMs;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  let timer: NodeJS.Timeout | null = null;

  async function recordCompletion(
    completed: Awaited<ReturnType<ScheduledPublicationRepository['recordChunkDelivered']>>,
  ): Promise<void> {
    if (!completed) return;
    if (completed.pipeline === 'digest') {
      await options.jobs.recordDigest(completed.deliveredAt, false, completed.itemCount);
    } else {
      await options.jobs.recordThreadSummary(completed.deliveredAt);
    }
  }

  async function dispatchDue(now = new Date()): Promise<void> {
    await options.publications.expireDue(now);
    for (let i = 0; i < batchSize; i++) {
      const publication = await options.publications.claimDue(now, leaseMs);
      if (!publication) return;
      const result = await options.sendMessageOnce({
        chatId: publication.targetChatId,
        threadId: publication.threadId,
        text: publication.chunk.text,
        parseMode: 'HTML',
        pipeline: publication.pipeline,
      });
      if (result.ok) {
        const messageId = result.message.message_id;
        if (!Number.isSafeInteger(messageId)) {
          await options.publications.markFailed(publication.id, 'telegram-invalid-message-id');
          continue;
        }
        const completed = await options.publications.recordChunkDelivered(
          publication.id,
          publication.chunk.chunkIndex,
          messageId,
          now,
        );
        await recordCompletion(completed);
        logger.info(
          {
            pipeline: publication.pipeline,
            publicationId: publication.id,
            chunkIndex: publication.chunk.chunkIndex,
            durationMs: result.durationMs,
          },
          'Scheduled publication chunk delivered',
        );
        continue;
      }
      if (!result.retryable) {
        await options.publications.markFailed(publication.id, result.errorCode);
        logger.error(
          {
            pipeline: publication.pipeline,
            publicationId: publication.id,
            errorCode: result.errorCode,
            durationMs: result.durationMs,
            ...result.errorMetadata,
          },
          'Scheduled publication delivery failed permanently',
        );
        continue;
      }
      const delay = Math.max(retryDelayMs(publication.attemptCount), result.retryAfterMs ?? 0);
      const retryAt = new Date(now.getTime() + delay);
      if (retryAt.getTime() >= publication.expiresAt.getTime()) {
        await options.publications.markExpired(publication.id);
        logger.warn(
          {
            pipeline: publication.pipeline,
            publicationId: publication.id,
            errorCode: result.errorCode,
            durationMs: result.durationMs,
            ...result.errorMetadata,
          },
          'Scheduled publication expired before next retry',
        );
        continue;
      }
      await options.publications.scheduleRetry(publication.id, retryAt, result.errorCode);
      logger.warn(
        {
          pipeline: publication.pipeline,
          publicationId: publication.id,
          attemptCount: publication.attemptCount,
          nextAttemptAt: retryAt.toISOString(),
          errorCode: result.errorCode,
          durationMs: result.durationMs,
          ...result.errorMetadata,
        },
        'Scheduled publication delivery deferred',
      );
    }
  }

  function runInBackground(): void {
    void dispatchDue().catch((error: unknown) => {
      logger.error(
        { errorClass: error instanceof Error ? error.name : 'unknown' },
        'Scheduled publication dispatcher cycle failed',
      );
    });
  }

  return {
    dispatchDue,
    start(): void {
      if (timer) return;
      timer = setInterval(runInBackground, intervalMs);
      timer.unref();
      runInBackground();
      logger.info({ intervalMs }, 'Scheduled publication dispatcher started');
    },
    stop(): void {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
      logger.info('Scheduled publication dispatcher stopped');
    },
  };
}
