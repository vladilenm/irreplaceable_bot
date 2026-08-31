import type { DigestSourceRepository } from './digest-source.repository.js';
import { logger } from './logger.js';
import { PublishedDigestSchema, type PublishedDigestV3 } from './published-digest.js';
import type { PublicationDispatcher } from './publication-dispatcher.js';
import { renderDigestRichHtml } from './rich-digest.renderer.js';
import type { ScheduledPublicationRepository } from './scheduled-publication.repository.js';
import { moscowDateKey, nextMoscowMidnight } from './time.js';

export type InvalidDigestReason =
  | 'schema-invalid'
  | 'digest-id-mismatch'
  | 'publication-date-mismatch'
  | 'render-invalid';

export interface DigestImporterOptions {
  source: DigestSourceRepository;
  publications: ScheduledPublicationRepository;
  dispatcher: Pick<PublicationDispatcher, 'dispatchDue'>;
  targetChatId: number;
  threadId: number;
  intervalMs: number;
  batchSize?: number;
  onError(error: unknown): void;
  logInvalid(digestId: string, reason: InvalidDigestReason): void;
}

export interface DigestImporter {
  importDue(now?: Date): Promise<void>;
  start(): void;
  stop(): void;
}

function countEvents(digest: PublishedDigestV3): number {
  return digest.sections.main.length
    + digest.sections.radar.length
    + digest.sections.focus.length;
}

export function createDigestImporter(options: DigestImporterOptions): DigestImporter {
  const batchSize = options.batchSize ?? 20;
  let timer: NodeJS.Timeout | null = null;
  let backgroundCycle: Promise<void> | null = null;

  async function importDue(now = new Date()): Promise<void> {
    const publicationDate = moscowDateKey(now);
    const candidates = await options.source.listForDelivery(publicationDate, batchSize);
    let importedCount = 0;
    let invalidCount = 0;

    for (const candidate of candidates) {
      const parsed = PublishedDigestSchema.safeParse(candidate.document);
      if (!parsed.success) {
        invalidCount += 1;
        options.logInvalid(candidate.digestId, 'schema-invalid');
        continue;
      }
      if (parsed.data.digestId !== candidate.digestId) {
        invalidCount += 1;
        options.logInvalid(candidate.digestId, 'digest-id-mismatch');
        continue;
      }
      if (parsed.data.publicationDate !== publicationDate) {
        invalidCount += 1;
        options.logInvalid(candidate.digestId, 'publication-date-mismatch');
        continue;
      }

      let html: string;
      try {
        html = renderDigestRichHtml(parsed.data);
      } catch {
        invalidCount += 1;
        options.logInvalid(candidate.digestId, 'render-invalid');
        continue;
      }

      const result = await options.publications.enqueue({
        pipeline: 'digest',
        messageFormat: 'rich-html',
        originDigestId: parsed.data.digestId,
        publicationDate: parsed.data.publicationDate,
        targetChatId: options.targetChatId,
        threadId: options.threadId,
        chunks: [html],
        itemCount: countEvents(parsed.data),
        nextAttemptAt: now,
        expiresAt: nextMoscowMidnight(now),
      });
      if (result.created) {
        importedCount += 1;
        await options.dispatcher.dispatchDue(now);
      }
    }

    logger.info(
      {
        event: 'digest-import-cycle',
        publicationDate,
        candidateCount: candidates.length,
        importedCount,
        invalidCount,
      },
      'Digest import cycle finished',
    );
  }

  function runInBackground(): void {
    if (backgroundCycle) return;
    backgroundCycle = importDue()
      .catch(options.onError)
      .finally(() => {
        backgroundCycle = null;
      });
  }

  return {
    importDue,
    start(): void {
      if (timer) return;
      timer = setInterval(runInBackground, options.intervalMs);
      timer.unref();
      runInBackground();
      logger.info({ intervalMs: options.intervalMs }, 'Digest importer started');
    },
    stop(): void {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
      logger.info('Digest importer stopped');
    },
  };
}
