import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { requestJson } from './llm.js';
import type { JsonCompletionRequest, LlmConfig } from './llm.js';
import type { EmbeddingProvider } from './members.js';
import type { MemberRepository } from './members.repository.js';

const promptUrl = new URL('../prompts/member-matcher.md', import.meta.url);
const PROMPT = readFileSync(promptUrl, 'utf8');

export const MemberMatchSchema = z.object({
  matches: z.array(z.object({
    memberId: z.string().min(1),
    reason: z.string().min(1).max(160),
    evidence: z.string().min(1).max(300),
  })).max(5),
});

export interface PublicMemberMatch {
  memberId: string;
  displayName: string;
  telegramUsername: string;
  reason: string;
  similarity: number;
}

type RequestJsonFn = <T>(config: LlmConfig, request: JsonCompletionRequest) => Promise<T>;

const normalized = (value: string): string => value
  .normalize('NFC')
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase();

export class MemberMatcher {
  constructor(private readonly deps: {
    embeddings: EmbeddingProvider;
    members: Pick<MemberRepository, 'search'>;
    llm: LlmConfig;
    requestJsonFn?: RequestJsonFn;
  }) {}

  async match(query: string, requesterUsername?: string): Promise<PublicMemberMatch[]> {
    const vectors = await this.deps.embeddings.embed([query]);
    const vector = vectors[0];
    if (!vector || vector.length === 0 || vector.some((value) => !Number.isFinite(value))) {
      throw new Error('Query embedding missing');
    }
    const shortlist = await this.deps.members.search(
      vector,
      this.deps.embeddings.model,
      20,
      requesterUsername,
    );
    if (shortlist.length < 3) return [];

    const request: JsonCompletionRequest = {
      system: PROMPT,
      user: JSON.stringify({
        query,
        candidates: shortlist.map(({ member, similarity }) => ({
          memberId: member.memberId,
          profileText: member.profileText,
          similarity,
        })),
      }),
      maxTokens: 1200,
      schemaName: 'member_matches',
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['matches'],
        properties: {
          matches: {
            type: 'array',
            maxItems: 5,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['memberId', 'reason', 'evidence'],
              properties: {
                memberId: { type: 'string' },
                reason: { type: 'string', maxLength: 160 },
                evidence: { type: 'string', maxLength: 300 },
              },
            },
          },
        },
      },
      anthropicTool: {
        name: 'submit_member_matches',
        description: 'Submit grounded matches',
      },
    };
    const requestFn = this.deps.requestJsonFn ?? requestJson;
    const raw = await requestFn<unknown>(this.deps.llm, request);
    const parsed = MemberMatchSchema.safeParse(raw);
    if (!parsed.success) return [];

    const byId = new Map(shortlist.map((item) => [item.member.memberId, item]));
    const seen = new Set<string>();
    const valid: PublicMemberMatch[] = [];
    for (const match of parsed.data.matches) {
      const candidate = byId.get(match.memberId);
      if (
        !candidate ||
        seen.has(match.memberId) ||
        !normalized(candidate.member.profileText).includes(normalized(match.evidence))
      ) {
        continue;
      }
      seen.add(match.memberId);
      valid.push({
        memberId: match.memberId,
        displayName: candidate.member.displayName,
        telegramUsername: candidate.member.telegramUsername,
        reason: match.reason,
        similarity: candidate.similarity,
      });
    }
    return valid.length >= 3 ? valid.slice(0, 5) : [];
  }
}
