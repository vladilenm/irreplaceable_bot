import { createHash } from 'node:crypto';

export interface MemberSourceRecord {
  source: 'mock' | 'web' | 'notion';
  externalId: string;
  telegramUserId: string | null;
  displayName: string;
  telegramUsername: string;
  profileText: string;
  sourceUpdatedAt: string;
  active: boolean;
}

export interface MemberCandidate {
  memberId: string;
  displayName: string;
  telegramUsername: string;
  profileText: string;
}

/** Legacy SQLite importer compatibility; never used by the production runtime. */
export interface IndexedMember extends MemberCandidate {
  embedding: Float32Array;
  embeddingModel: string;
  generation: number;
}

export interface SimilarMember {
  member: MemberCandidate;
  similarity: number;
}

export interface EmbeddingProvider {
  readonly model: string;
  embed(texts: readonly string[]): Promise<readonly number[][]>;
}

export function buildMemberId(source: string, externalId: string): string {
  return `${source}:${externalId}`;
}

export function canonicalSearchText(
  member: Pick<MemberSourceRecord, 'profileText'>,
): string {
  return member.profileText;
}

export function memberContentHash(record: MemberSourceRecord): string {
  return createHash('sha256').update(canonicalSearchText(record)).digest('hex');
}
