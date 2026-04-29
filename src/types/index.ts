export interface BotConfig {
  botToken: string;
  targetChatId: string;
  aiRadarThreadId: string;
  digestCron: string;
  aiApiKey: string;
  aiModel: string;
  aiBaseUrl?: string;
  logLevel: string;
  nodeEnv: string;
  // ── v2.0 thread summaries (Phase 4) ──
  threadSummaryThreadId: string;     // requireEnvInt — gates Phase 7 publish
  threadSummaryCron: string;         // default '30 3 * * *' (06:30 MSK)
  messageRetentionDays: number;      // default 90, MIN 7 enforced
  retentionSweepCron: string;        // default '0 1 * * *' (04:00 MSK)
  dbPath: string;                    // default 'data/messages.db'
  initialTrackedThreadIds: number[]; // CSV-parsed, default []
}

export interface DigestItem {
  title: string;
  summary: string;
  url: string;
  source: string;
  category: DigestCategory;
  publishedAt: Date;
}

export type DigestCategory =
  | 'agents'
  | 'orchestration'
  | 'models'
  | 'tools'
  | 'technologies'
  | 'business';

export interface DigestPayload {
  date: Date;
  items: DigestItem[];
  totalSources: number;
}

export interface FeedConfig {
  url: string;
  name: string;
  sourceKey: string;
}

export interface RawArticle {
  title: string;
  description: string;
  link: string;
  source: string;
  sourceKey: string;
  pubDate: Date;
}

// ─── v2.0 Thread Summaries — Phase 4 capture infra (D-03..D-05) ───

export interface CapturedMessage {
  chatId: number;
  threadId: number;
  tgMessageId: number;
  authorId: number | null;          // NULL для anon admins (D-04)
  authorName: string;
  isAnonymous: 0 | 1;
  text: string;
  replyToMessageId: number | null;
  createdAt: string;                 // ISO-8601 UTC (D-03)
  editedAt: string | null;
}

export interface TrackedThread {
  threadId: number;
  chatId: number;
  addedBy: number | null;            // NULL when seeded from ENV bootstrap (D-02)
  addedAt: string;
  title: string | null;              // Phase 6 D-05: forum-topic name cache (NULL until first refresh)
}

// ─── Phase 6: Pipeline state (digest + thread-summary idempotency) ───
// Owned by Plan 01 in src/types/index.ts; this plan consumes it via state.service.ts
// and digest.service.ts. lastThreadSummaryDate added in Phase 6 D-28.
export interface PipelineStateV2 {
  lastDigestDate: string | null;
  lastSkipped: boolean;
  lastItemCount: number;
  lastThreadSummaryDate: string | null;
}

export interface ForgottenUser {
  authorId: number;
  forgottenAt: string;
  deletedCount: number;
  requestedVia: 'self' | 'admin' | 'bootstrap-test';
}
