import { config } from './config.js';
import { getDb } from './database.js';
import { OpenAiEmbeddingProvider } from './embeddings.js';
import { MemberIndex, MemberSyncService } from './members.js';
import { NotionMemberDirectoryProvider } from './members.notion.js';
import { SqliteMemberRepository } from './members.repository.js';
import type { MemberDirectoryProvider, EmbeddingProvider } from './members.js';
import type { MemberRepository } from './members.repository.js';
import { MemberMatcher } from './request.matcher.js';
import { SqliteRequestRepository } from './request.repository.js';
import type { RequestRepository } from './request.repository.js';
import type { RequestHandlerOptions } from './requests.js';
import type { RequestMatchingConfig } from './types.js';

export interface RequestMatchingRuntime {
  index: MemberIndex;
  syncService: MemberSyncService;
  matcher: MemberMatcher;
  memberRepository: MemberRepository;
  requestRepository: RequestRepository;
  handlerOptions: RequestHandlerOptions;
}

export function createRequestMatchingRuntime(
  feature: RequestMatchingConfig,
  overrides: Partial<{
    memberRepository: MemberRepository;
    requestRepository: RequestRepository;
    directory: MemberDirectoryProvider;
    embeddings: EmbeddingProvider;
    now: () => Date;
  }> = {},
): RequestMatchingRuntime {
  const now = overrides.now ?? (() => new Date());
  const memberRepository = overrides.memberRepository ?? new SqliteMemberRepository(getDb());
  const requestRepository = overrides.requestRepository ?? new SqliteRequestRepository(getDb());
  const directory = overrides.directory ?? new NotionMemberDirectoryProvider({
    token: feature.notionToken,
    dataSourceId: feature.notionDataSourceId,
  });
  const embeddings = overrides.embeddings ?? new OpenAiEmbeddingProvider({
    apiKey: feature.embeddingApiKey,
    model: feature.embeddingModel,
  });
  const index = new MemberIndex();
  const syncService = new MemberSyncService({
    provider: directory,
    embeddings,
    repository: memberRepository,
    index,
    now,
  });
  syncService.hydrate();

  const staleCutoff = new Date(
    now().getTime() - feature.processingTimeoutMinutes * 60_000,
  ).toISOString();
  requestRepository.failStale(staleCutoff);

  const matcher = new MemberMatcher({
    embeddings,
    index,
    llm: {
      apiKey: config.aiApiKey,
      model: config.aiModel,
      baseUrl: config.aiBaseUrl,
    },
  });
  const handlerOptions: RequestHandlerOptions = {
    targetChatId: config.targetChatId,
    matcher,
    repository: requestRepository,
    concurrency: feature.concurrency,
    queueLimit: feature.queueLimit,
    now,
  };

  return {
    index,
    syncService,
    matcher,
    memberRepository,
    requestRepository,
    handlerOptions,
  };
}
