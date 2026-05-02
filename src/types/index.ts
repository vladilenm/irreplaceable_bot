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
  title: string | null;              // Phase 6 D-05 — forum-topic name cache; NULL until a future title-writer is introduced
}

export interface ForgottenUser {
  authorId: number;
  forgottenAt: string;
  deletedCount: number;
  requestedVia: 'self' | 'admin' | 'bootstrap-test';
}

// ─── v2.0 Phase 6 — Thread summary pipeline (D-12, D-32, D-28) ───

/**
 * What the LLM returns BEFORE orchestrator merges in participants[] from DB.
 * Schema-validated by Zod in summarizer.service.ts.
 */
export interface LLMSummaryOutput {
  headline: string;          // ≤80 chars (truncated server-side per D-08)
  bullets: string[];         // 1-6 items (D-09 soft 3-6)
  openQuestions: string[];   // 0-3 (D-11)
}

export type ThreadSummary =
  | {
      skipped: false;
      threadId: number;
      windowHours: number;
      messageCount: number;
      headline: string;
      bullets: string[];
      participants: Array<{ displayName: string; messageCount: number }>;
      openQuestions: string[];
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
  /** If true, write data/state.json after the run. Default: true. */
  persistState?: boolean;
  /** Override default 24h window (Phase 7 /dev-summary). Default: 24. */
  windowHours?: number;
}

export interface ThreadSummaryResult {
  alreadyPublished: boolean;
  threadsSummarised: number;
  threadsSkippedLowVolume: number;
  threadsSkippedError: number;
  totalMessageCount: number;
  date: Date;
  chunks: string[];   // formatted HTML chunks; empty array if alreadyPublished or zero tracked threads
  /**
   * Phase 8 fix A: when true, cron handler (or any caller) MUST call
   * markThreadSummaryPublished(prevState, date) AFTER successful
   * sendThreadSummary so lastThreadSummaryDate persists ONLY on confirmed
   * delivery. When false (e.g. /dev-summary), the caller MUST NOT write state.
   */
  persistState: boolean;
  /**
   * Phase 8 fix A: snapshot of state read at the start of the cycle, used by
   * the post-send merge-write so lastDigestDate is preserved (D-33).
   */
  prevState: PipelineStateV2;
  /**
   * Phase 8 fix B: true when there is at least one tracked thread AND every
   * thread was skipped with reason:'llm-error'. The cron handler MUST refuse
   * to publish in this case (publishing would put a misleading «тихо: N из N»
   * in the group, masking an LLM outage as a quiet day) AND MUST NOT advance
   * lastThreadSummaryDate, so the next cycle can re-attempt once the LLM is
   * back. A genuine quiet day (low-volume / transcript-too-large / mixed
   * skip-reasons) keeps current behaviour and publishes the «тихо» chunk.
   */
  llmOutage: boolean;
}

/**
 * State.json shape — Phase 6 D-28 extends with lastThreadSummaryDate.
 * Mirrors PipelineState from digest.service.ts but lives in state.service.ts owned scope.
 */
export interface PipelineStateV2 {
  lastDigestDate: string | null;
  lastSkipped: boolean;
  lastItemCount: number;
  lastThreadSummaryDate: string | null;  // NEW Phase 6 D-28 — separate field
}
