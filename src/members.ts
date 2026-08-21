import { createHash } from 'node:crypto';

export interface MemberSourceRecord {
  source: 'notion';
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
