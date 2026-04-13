export interface BotConfig {
  botToken: string;
  targetChatId: string;
  aiRadarThreadId: string;
  digestCron: string;
  aiApiKey: string;
  aiModel: string;
  logLevel: string;
  nodeEnv: string;
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

export interface RawArticle {
  title: string;
  description: string;
  link: string;
  source: string;
  sourceKey: string;
  pubDate: Date;
}
