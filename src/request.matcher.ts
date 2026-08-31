import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { LlmSchemaError, requestJson } from './llm.js';
import type { JsonCompletionRequest, LlmConfig } from './llm.js';
import { logger } from './logger.js';
import { buildEvidenceOptions } from './member-evidence-options.js';
import type { EmbeddingProvider } from './members.js';
import type { MemberRepository } from './members.repository.js';

const promptUrl = new URL('../prompts/member-matcher.md', import.meta.url);
const PROMPT = readFileSync(promptUrl, 'utf8');

export const MemberMatchSchema = z.object({
  matches: z.array(z.object({
    memberId: z.string().min(1),
    evidenceId: z.string().min(1),
  })).max(5),
});

export interface PublicMemberMatch {
  memberId: string;
  displayName: string;
  telegramUsername: string;
  evidence: string;
  similarity: number;
}

export interface MemberMatchOptions {
  requesterTelegramUserId?: string;
  minimumMatches?: 1 | 3;
}

type RequestJsonFn = <T>(config: LlmConfig, request: JsonCompletionRequest) => Promise<T>;

type PreparedCandidate = {
  row: Awaited<ReturnType<MemberRepository['search']>>[number];
  evidenceOptions: ReturnType<typeof buildEvidenceOptions>;
};

type ValidationResult = {
  schemaValid: boolean;
  modelMatchCount: number;
  accepted: PublicMemberMatch[];
  unknownMemberCount: number;
  duplicateMemberCount: number;
  unknownEvidenceCount: number;
};

const RETRY_INSTRUCTION = [
  'Your previous output was structurally invalid.',
  'Return only existing memberId and evidenceId pairs from the supplied candidates.',
  'Do not copy or create evidence text.',
].join(' ');

function validateModelMatches(
  raw: unknown,
  prepared: readonly PreparedCandidate[],
): ValidationResult {
  const parsed = MemberMatchSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      schemaValid: false,
      modelMatchCount: 0,
      accepted: [],
      unknownMemberCount: 0,
      duplicateMemberCount: 0,
      unknownEvidenceCount: 0,
    };
  }
  const byId = new Map(prepared.map((candidate) => [
    candidate.row.member.memberId,
    candidate,
  ]));
  const seen = new Set<string>();
  const accepted: PublicMemberMatch[] = [];
  let unknownMemberCount = 0;
  let duplicateMemberCount = 0;
  let unknownEvidenceCount = 0;
  for (const match of parsed.data.matches) {
    const candidate = byId.get(match.memberId);
    if (!candidate) {
      unknownMemberCount++;
      continue;
    }
    if (seen.has(match.memberId)) {
      duplicateMemberCount++;
      continue;
    }
    const evidence = candidate.evidenceOptions.find(
      (option) => option.evidenceId === match.evidenceId,
    )?.text;
    if (!evidence || !candidate.row.member.profileText.includes(evidence)) {
      unknownEvidenceCount++;
      continue;
    }
    seen.add(match.memberId);
    accepted.push({
      memberId: match.memberId,
      displayName: candidate.row.member.displayName,
      telegramUsername: candidate.row.member.telegramUsername,
      evidence,
      similarity: candidate.row.similarity,
    });
  }
  return {
    schemaValid: true,
    modelMatchCount: parsed.data.matches.length,
    accepted,
    unknownMemberCount,
    duplicateMemberCount,
    unknownEvidenceCount,
  };
}

function isStructurallyInvalid(result: ValidationResult): boolean {
  return !result.schemaValid ||
    result.unknownMemberCount > 0 ||
    result.duplicateMemberCount > 0 ||
    result.unknownEvidenceCount > 0;
}

export class MemberMatcher {
  constructor(private readonly deps: {
    embeddings: EmbeddingProvider;
    members: Pick<MemberRepository, 'search'>;
    llm: LlmConfig;
    requestJsonFn?: RequestJsonFn;
  }) {}

  async match(
    query: string,
    options: MemberMatchOptions = {},
  ): Promise<PublicMemberMatch[]> {
    const minimumMatches = options.minimumMatches ?? 3;
    const vectors = await this.deps.embeddings.embed([query]);
    const vector = vectors[0];
    if (!vector || vector.length === 0 || vector.some((value) => !Number.isFinite(value))) {
      throw new Error('Query embedding missing');
    }
    const shortlist = await this.deps.members.search(
      vector,
      this.deps.embeddings.model,
      20,
      options.requesterTelegramUserId,
    );
    if (shortlist.length < minimumMatches) {
      logger.info({
        event: 'member-match-rerank',
        shortlistCount: shortlist.length,
        modelMatchCount: 0,
        acceptedCount: 0,
        unknownMemberCount: 0,
        duplicateMemberCount: 0,
        unknownEvidenceCount: 0,
        schemaValid: true,
        retryUsed: false,
        minimumMatches,
        outcome: 'below-threshold',
      }, 'Member match rerank complete');
      return [];
    }

    const prepared: PreparedCandidate[] = shortlist.map((row) => ({
      row,
      evidenceOptions: buildEvidenceOptions(row.member.profileText),
    }));
    const request: JsonCompletionRequest = {
      system: PROMPT,
      user: JSON.stringify({
        query,
        candidates: prepared.map(({ row, evidenceOptions }) => ({
          memberId: row.member.memberId,
          similarity: row.similarity,
          evidenceOptions,
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
              required: ['memberId', 'evidenceId'],
              properties: {
                memberId: { type: 'string', minLength: 1 },
                evidenceId: { type: 'string', minLength: 1 },
              },
            },
          },
        },
      },
    };
    const requestFn = this.deps.requestJsonFn ?? requestJson;
    const runAttempt = async (retryInstruction?: string): Promise<ValidationResult> => {
      try {
        const raw = await requestFn<unknown>(this.deps.llm, {
          ...request,
          ...(retryInstruction ? { retryInstruction } : {}),
        });
        return validateModelMatches(raw, prepared);
      } catch (error: unknown) {
        if (!(error instanceof LlmSchemaError)) throw error;
        return validateModelMatches(undefined, prepared);
      }
    };

    let result = await runAttempt();
    let retryUsed = false;
    if (isStructurallyInvalid(result)) {
      retryUsed = true;
      result = await runAttempt(RETRY_INSTRUCTION);
    }
    const accepted = [...result.accepted]
      .sort((left, right) =>
        right.similarity - left.similarity || left.memberId.localeCompare(right.memberId));
    const outcome = !result.schemaValid
      ? 'invalid-output'
      : accepted.length >= minimumMatches
        ? 'completed'
        : 'below-threshold';
    logger.info({
      event: 'member-match-rerank',
      shortlistCount: shortlist.length,
      modelMatchCount: result.modelMatchCount,
      acceptedCount: accepted.length,
      unknownMemberCount: result.unknownMemberCount,
      duplicateMemberCount: result.duplicateMemberCount,
      unknownEvidenceCount: result.unknownEvidenceCount,
      schemaValid: result.schemaValid,
      retryUsed,
      minimumMatches,
      outcome,
    }, 'Member match rerank complete');
    return accepted.length >= minimumMatches ? accepted.slice(0, 5) : [];
  }
}
