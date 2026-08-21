export interface RequestMatchingConfig {
  embeddingApiKey: string;
  embeddingBaseUrl: string;
  embeddingModel: string;
  embeddingDimensions: number;
  memberIndexCron: string;
  concurrency: number;
  queueLimit: number;
  processingTimeoutMinutes: number;
}

export interface DatabaseConfig {
  url: string;
  ssl: boolean;
  caCert?: string;
  poolMax: number;
  statementTimeoutMs: number;
}

export interface BotConfig {
  botToken: string;
  targetChatId: number;
  aiRadarThreadId: number;
  digestCron: string;
  aiApiKey: string;
  aiModel: string;
  aiBaseUrl: string;
  logLevel: string;
  threadSummaryThreadId: number;
  threadSummaryCron: string;
  messageRetentionDays: number;
  retentionSweepCron: string;
  database: DatabaseConfig;
  trackedThreadIds: number[];
  requestMatching: RequestMatchingConfig;
}

export interface DigestItem {
  title: string;
  summary: string;
  url: string;
  category: DigestCategory;
}

export type DigestCategory =
  | 'agents'
  | 'orchestration'
  | 'models'
  | 'tools'
  | 'technologies'
  | 'business';

export interface FeedConfig {
  url: string;
  name: string;
}

export interface RawArticle {
  title: string;
  description: string;
  link: string;
  source: string;
  pubDate: Date;
}

export interface CapturedMessage {
  chatId: number;
  threadId: number;
  tgMessageId: number;
  authorId: number | null;
  authorName: string;
  isAnonymous: 0 | 1;
  text: string;
  replyToMessageId: number | null;
  createdAt: string;
  editedAt: string | null;
}

/**
 * A summary point and the captured Telegram message that supports it.
 * Hallucinated message ids are discarded after LLM validation.
 */
export interface TopicBullet {
  summary: string;
  msgId: number;
}

/**
 * A sub-theme identified by the LLM. Rendering and deep links remain code-owned.
 */
export interface Topic {
  emoji: string;
  title: string;
  bullets: TopicBullet[];
  links: Array<{ url: string; description: string }>;
}

/**
 * Schema-validated LLM response.
 */
export interface LLMSummaryOutput {
  topics: Topic[];
}

export type ThreadSummary =
  | {
      skipped: false;
      threadId: number;
      windowHours: number;
      /** Input-window message count (NOT sum of topic counts). Source-of-truth. */
      messageCount: number;
      topics: Topic[];
    }
  | {
      skipped: true;
      threadId: number;
      windowHours: number;
      messageCount: number;
      reason: 'low-volume' | 'transcript-too-large' | 'llm-error' | 'schema-invalid';
    };

export interface RunThreadSummaryOptions {
  /** If true, bypass isThreadSummaryPublishedTodayWithState() short-circuit. Default: false. */
  skipIdempotency?: boolean;
  /** Persist successful publication state. Default: true. */
  persistState?: boolean;
  /** Override the default 24-hour window. */
  windowHours?: number;
  /** Explicit override for tests/manual runs; defaults to config.trackedThreadIds. */
  trackedThreadIds?: readonly number[];
}

export interface ThreadSummaryResult {
  alreadyPublished: boolean;
  threadsSummarised: number;
  threadsSkippedLowVolume: number;
  threadsSkippedError: number;
  totalMessageCount: number;
  date: Date;
  chunks: string[];
  /**
   * When true, the caller records completion only after Telegram confirms delivery.
   */
  persistState: boolean;
  /**
   * True when every tracked thread failed at the LLM transport layer.
   * This is distinct from a valid run that simply produced no topics.
   */
  llmOutage: boolean;
}

export interface PipelineState {
  lastDigestDate: string | null;
  lastSkipped: boolean;
  lastItemCount: number;
  lastThreadSummaryDate: string | null;
}
