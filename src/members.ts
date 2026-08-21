import { createHash } from 'node:crypto';
import type { LegacyMemberRepository } from './members.repository.js';

export interface MemberSourceRecord {
  source: 'mock' | 'web' | 'notion';
  externalId: string;
  displayName: string;
  telegramUsername: string;
  profileText: string;
  sourceUpdatedAt: string;
  active: boolean;
}

export interface IndexedMember {
  memberId: string;
  displayName: string;
  telegramUsername: string;
  profileText: string;
  embedding: Float32Array;
  embeddingModel: string;
  generation: number;
}

export interface MemberCandidate {
  memberId: string;
  displayName: string;
  telegramUsername: string;
  profileText: string;
}

export interface MemberDirectoryProvider {
  listMembers(): Promise<MemberSourceRecord[]>;
}

export interface EmbeddingProvider {
  readonly model: string;
  embed(texts: readonly string[]): Promise<readonly number[][]>;
}

export function buildMemberId(source: string, externalId: string): string {
  return `${source}:${externalId}`;
}

export function canonicalSearchText(
  member: Pick<MemberSourceRecord, 'displayName' | 'profileText'>,
): string {
  return `${member.displayName}\n${member.profileText}`;
}

export function memberContentHash(record: MemberSourceRecord): string {
  return createHash('sha256').update(canonicalSearchText(record)).digest('hex');
}

export interface SimilarMember {
  member: MemberCandidate;
  similarity: number;
}

export interface IndexedSimilarMember {
  member: IndexedMember;
  similarity: number;
}

function cosine(left: ArrayLike<number>, right: ArrayLike<number>): number {
  if (left.length !== right.length || left.length === 0) {
    throw new Error('embedding dimension mismatch');
  }
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index++) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return 0;
  return dot / Math.sqrt(leftMagnitude * rightMagnitude);
}

export class MemberIndex {
  private members: IndexedMember[] = [];

  get size(): number {
    return this.members.length;
  }

  replace(input: readonly IndexedMember[]): void {
    this.members = input.map((member) => ({
      ...member,
      embedding: new Float32Array(member.embedding),
    }));
  }

  search(
    query: readonly number[],
    limit: number,
    excludedUsername?: string,
  ): IndexedSimilarMember[] {
    const excluded = excludedUsername?.toLowerCase();
    return this.members
      .filter((member) => member.telegramUsername.toLowerCase() !== excluded)
      .map((member) => ({ member, similarity: cosine(query, member.embedding) }))
      .sort((left, right) =>
        right.similarity - left.similarity ||
        left.member.memberId.localeCompare(right.member.memberId))
      .slice(0, limit);
  }
}

export interface MemberSyncResult {
  fetched: number;
  active: number;
  embedded: number;
  generation: number;
}

async function embedBatches(
  records: readonly MemberSourceRecord[],
  embeddings: EmbeddingProvider,
  batchSize: number,
): Promise<Map<string, readonly number[]>> {
  const result = new Map<string, readonly number[]>();
  let dimensions: number | null = null;

  for (let start = 0; start < records.length; start += batchSize) {
    const batch = records.slice(start, start + batchSize);
    const vectors = await embeddings.embed(batch.map(canonicalSearchText));
    if (vectors.length !== batch.length) {
      throw new Error('embedding provider returned invalid vector count');
    }
    for (let index = 0; index < batch.length; index++) {
      const record = batch[index];
      const vector = vectors[index];
      if (!record || !vector || vector.length === 0 || vector.some((value) => !Number.isFinite(value))) {
        throw new Error('embedding provider returned invalid vector');
      }
      if (dimensions !== null && dimensions !== vector.length) {
        throw new Error('embedding provider returned mixed dimensions');
      }
      dimensions = vector.length;
      result.set(buildMemberId(record.source, record.externalId), vector);
    }
  }

  return result;
}

export class MemberSyncService {
  private inFlight: Promise<MemberSyncResult> | null = null;

  constructor(private readonly deps: {
    provider: MemberDirectoryProvider;
    embeddings: EmbeddingProvider;
    repository: LegacyMemberRepository;
    index: MemberIndex;
    now?: () => Date;
  }) {}

  hydrate(): void {
    this.deps.index.replace(this.deps.repository.readActiveIndex(this.deps.embeddings.model));
  }

  sync(): Promise<MemberSyncResult> {
    if (this.inFlight) return this.inFlight;
    const operation = this.performSync().finally(() => {
      this.inFlight = null;
    });
    this.inFlight = operation;
    return operation;
  }

  private async performSync(): Promise<MemberSyncResult> {
    const records = await this.deps.provider.listMembers();
    const versions = this.deps.repository.readVersions();
    const changed = records
      .filter((record) => {
        if (!record.active) return false;
        const current = versions.get(buildMemberId(record.source, record.externalId));
        return current?.contentHash !== memberContentHash(record) ||
          current.embeddingModel !== this.deps.embeddings.model;
      })
      .sort((left, right) =>
        buildMemberId(left.source, left.externalId)
          .localeCompare(buildMemberId(right.source, right.externalId)));
    const changedEmbeddings = await embedBatches(changed, this.deps.embeddings, 100);
    const status = this.deps.repository.commitSnapshot({
      provider: 'notion',
      model: this.deps.embeddings.model,
      completedAt: (this.deps.now ?? (() => new Date()))().toISOString(),
      records,
      changedEmbeddings,
    });
    this.deps.index.replace(this.deps.repository.readActiveIndex(this.deps.embeddings.model));
    return {
      fetched: records.length,
      active: status.activeCount,
      embedded: changedEmbeddings.size,
      generation: status.generation,
    };
  }
}
