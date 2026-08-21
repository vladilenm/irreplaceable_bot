import { buildMemberId, canonicalSearchText, memberContentHash } from './members.js';
import type { EmbeddingProvider, MemberSourceRecord } from './members.js';
import type { MemberRepository } from './members.repository.js';
import { logger } from './logger.js';

const INDEX_BATCH_SIZE = 100;

function normalizeVisibleText(raw: string, maxLength: number): string {
  return raw
    .normalize('NFC')
    .replace(/[\p{C}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function normalizeTelegramUsername(raw: string): string {
  const value = raw.trim().replace(/^@/, '').toLowerCase();
  return /^[a-z][a-z0-9_]{4,31}$/.test(value) ? value : '';
}

export function normalizeMemberCard(record: MemberSourceRecord): MemberSourceRecord {
  const externalId = normalizeVisibleText(record.externalId, 256);
  if (externalId === '') throw new Error('member externalId is required');
  const displayName = normalizeVisibleText(record.displayName, 200);
  const telegramUsername = normalizeTelegramUsername(record.telegramUsername);
  const profileText = normalizeVisibleText(record.profileText, 2000);
  const sourceUpdatedAt = new Date(record.sourceUpdatedAt);
  if (Number.isNaN(sourceUpdatedAt.getTime())) {
    throw new Error('member sourceUpdatedAt must be a valid timestamp');
  }
  return {
    source: record.source,
    externalId,
    displayName,
    telegramUsername,
    profileText,
    sourceUpdatedAt: sourceUpdatedAt.toISOString(),
    active: record.active && displayName !== '' && telegramUsername !== '' && profileText !== '',
  };
}

export class MemberDirectoryService {
  constructor(private readonly deps: {
    repository: MemberRepository;
    embeddings: EmbeddingProvider;
    now?: () => Date;
  }) {}

  async upsert(records: readonly MemberSourceRecord[]): Promise<number> {
    return this.deps.repository.upsertCards(records.map(normalizeMemberCard));
  }

  async indexPending(limit = INDEX_BATCH_SIZE): Promise<{ indexed: number; failed: number }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new Error('index limit must be an integer between 1 and 1000');
    }
    const pending = await this.deps.repository.readPending(this.deps.embeddings.model, limit);
    let indexed = 0;
    let failed = 0;

    for (let start = 0; start < pending.length; start += INDEX_BATCH_SIZE) {
      const batch = pending.slice(start, start + INDEX_BATCH_SIZE);
      let vectors: readonly number[][];
      try {
        vectors = await this.deps.embeddings.embed(batch.map(canonicalSearchText));
        if (vectors.length !== batch.length) {
          throw new Error('embedding provider returned invalid vector count');
        }
      } catch (error: unknown) {
        failed += batch.length;
        logger.error(
          {
            event: 'member-index-batch-failed',
            batchSize: batch.length,
            errorClass: error instanceof Error ? error.name : 'unknown',
          },
          'Member embedding batch failed',
        );
        continue;
      }

      for (let index = 0; index < batch.length; index++) {
        const record = batch[index];
        const vector = vectors[index];
        if (!record || !vector) {
          failed += 1;
          continue;
        }
        try {
          await this.deps.repository.upsertEmbedding(
            buildMemberId(record.source, record.externalId),
            this.deps.embeddings.model,
            memberContentHash(record),
            vector,
          );
          indexed += 1;
        } catch (error: unknown) {
          failed += 1;
          logger.error(
            {
              event: 'member-index-write-failed',
              errorClass: error instanceof Error ? error.name : 'unknown',
            },
            'Member embedding write failed',
          );
        }
      }
    }

    await this.deps.repository.recordIndexStatus(
      'postgres',
      this.deps.embeddings.model,
      (this.deps.now ?? (() => new Date()))(),
    );
    logger.info(
      { event: 'member-index-complete', pending: pending.length, indexed, failed },
      'Member indexing cycle complete',
    );
    return { indexed, failed };
  }
}
