import { config } from './config.js';
import { OpenAiEmbeddingProvider } from './embeddings.js';
import { MemberDirectoryService } from './member-directory.service.js';
import type { EmbeddingProvider } from './members.js';
import type { MemberRepository } from './members.repository.js';
import type { Persistence } from './persistence.js';
import { MemberMatcher } from './request.matcher.js';
import type { RequestRepository } from './request.repository.js';
import type { RequestHandlerOptions } from './requests.js';
import type { RequestMatchingConfig } from './types.js';

export interface RequestMatchingRuntime {
  memberDirectory: MemberDirectoryService;
  matcher: MemberMatcher;
  memberRepository: MemberRepository;
  requestRepository: RequestRepository;
  handlerOptions: RequestHandlerOptions;
}

export async function createRequestMatchingRuntime(
  feature: RequestMatchingConfig,
  persistence: Pick<Persistence, 'members' | 'requests'>,
  overrides: Partial<{
    embeddings: EmbeddingProvider;
    now: () => Date;
  }> = {},
): Promise<RequestMatchingRuntime> {
  const now = overrides.now ?? (() => new Date());
  const embeddings = overrides.embeddings ?? new OpenAiEmbeddingProvider({
    apiKey: feature.embeddingApiKey,
    model: feature.embeddingModel,
  });
  const memberDirectory = new MemberDirectoryService({
    repository: persistence.members,
    embeddings,
    now,
  });
  const staleCutoff = new Date(
    now().getTime() - feature.processingTimeoutMinutes * 60_000,
  ).toISOString();
  await persistence.requests.failStale(staleCutoff);

  const matcher = new MemberMatcher({
    embeddings,
    members: persistence.members,
    llm: {
      apiKey: config.aiApiKey,
      model: config.aiModel,
      baseUrl: config.aiBaseUrl,
    },
  });
  const handlerOptions: RequestHandlerOptions = {
    targetChatId: config.targetChatId,
    matcher,
    repository: persistence.requests,
    concurrency: feature.concurrency,
    queueLimit: feature.queueLimit,
    now,
  };

  return {
    memberDirectory,
    matcher,
    memberRepository: persistence.members,
    requestRepository: persistence.requests,
    handlerOptions,
  };
}
