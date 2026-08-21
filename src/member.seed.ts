import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { readDatabaseConfig, readTimewebAiToken } from './config.js';
import { runMigrations } from './db/migrations.js';
import { assertDatabaseReady, createPool } from './db/pool.js';
import { OpenAiEmbeddingProvider } from './embeddings.js';
import { logger } from './logger.js';
import { MemberDirectoryService } from './member-directory.service.js';
import { PgMemberRepository } from './members.repository.js';
import type { MemberSourceRecord } from './members.js';
import { RUNTIME_DEFAULTS } from './runtime-defaults.js';

export interface MockSeedOptions {
  nodeEnv: string;
  allowProduction: boolean;
}

export function readMockSeedCliOptions(options: {
  nodeEnv?: string;
  argv: readonly string[];
}): MockSeedOptions {
  const nodeEnv = options.nodeEnv ?? 'development';
  const allowProduction = options.argv.includes('--allow-production');
  if (nodeEnv === 'production' && !allowProduction) {
    throw new Error('--allow-production is required in production');
  }
  return { nodeEnv, allowProduction };
}

const MOCK_UPDATED_AT = '2026-08-21T00:00:00.000Z';
const PROFILES = [
  ['Анна Продуктова', 'Продуктовый менеджмент: запуск B2B SaaS, customer development, проверка гипотез и управление продуктовой командой.'],
  ['Михаил Продажин', 'B2B-продажи: построение enterprise-воронки, переговоры с корпорациями, пилоты и развитие отделов продаж.'],
  ['Елена Талантина', 'Рекрутинг и HR: поиск руководителей и IT-специалистов, интервью, адаптация и развитие команд.'],
  ['Игорь Финансов', 'Финансы: управленческий учёт, финансовые модели, бюджетирование, unit-экономика и подготовка к инвестициям.'],
  ['Мария Правова', 'Юридическое сопровождение бизнеса: договоры, интеллектуальная собственность, персональные данные и корпоративное право.'],
  ['Олег Маркетов', 'Маркетинг: позиционирование, go-to-market, performance-каналы, контент и рост B2B-продуктов.'],
  ['Софья Дизайнова', 'Продуктовый дизайн: UX-исследования, интерфейсы веб-сервисов, дизайн-системы и прототипирование.'],
  ['Алексей Разработов', 'Разработка: архитектура веб-приложений, TypeScript, Node.js, PostgreSQL и управление инженерными командами.'],
  ['Дарья Данных', 'Data analytics: продуктовая аналитика, метрики, SQL, BI, эксперименты и построение аналитической функции.'],
  ['Роман Нейронов', 'AI и автоматизация: LLM-приложения, RAG, AI-агенты, интеграция моделей и оценка качества решений.'],
  ['Наталья Операций', 'Операционный менеджмент: регламенты, автоматизация процессов, контроль качества и масштабирование сервиса.'],
  ['Виктор Инвестов', 'Инвестиции: венчурный анализ, подготовка pitch deck, due diligence и работа со стартапами ранних стадий.'],
  ['Ирина Обучаева', 'Образование: проектирование программ, корпоративное обучение, методология онлайн-курсов и развитие экспертов.'],
  ['Павел Событий', 'События: деловые конференции, камерные встречи, партнёрские мероприятия и работа с сообществами.'],
  ['Ксения Медиа', 'Медиа и PR: редакционная стратегия, работа со СМИ, личный бренд, подкасты и деловой контент.'],
  ['Артём Экспортов', 'Экспорт: выход компаний на международные рынки, поиск дистрибьюторов, локализация и внешнеторговые операции.'],
  ['Вера Коммерс', 'E-commerce: маркетплейсы, D2C, ассортимент, логистика, юнит-экономика и рост онлайн-продаж.'],
  ['Сергей Производов', 'Производство: бережливые процессы, снабжение, планирование мощностей, качество и цифровизация предприятий.'],
  ['Людмила Комьюнити', 'Сообщества: стратегия клубов, онбординг участников, вовлечение, событийная программа и удержание.'],
  ['Денис Партнёров', 'Партнёрства: поиск стратегических союзов, интеграции, совместные продукты и развитие партнёрских каналов.'],
] as const;

export const MOCK_MEMBERS: readonly MemberSourceRecord[] = PROFILES.map(
  ([displayName, profileText], index) => {
    const suffix = String(index + 1).padStart(2, '0');
    return {
      source: 'mock',
      externalId: `mock-${suffix}`,
      displayName,
      telegramUsername: `club_demo_member_${suffix}`,
      profileText,
      sourceUpdatedAt: MOCK_UPDATED_AT,
      active: true,
    };
  },
);

export async function seedMockMembers(
  service: MemberDirectoryService,
  options: MockSeedOptions,
): Promise<{ upserted: number; indexed: number }> {
  if (options.nodeEnv === 'production' && !options.allowProduction) {
    throw new Error('--allow-production is required in production');
  }
  const upserted = await service.upsert(MOCK_MEMBERS);
  const result = await service.indexPending(100);
  return { upserted, indexed: result.indexed };
}

async function runSeedCli(): Promise<void> {
  const seedOptions = readMockSeedCliOptions({
    nodeEnv: process.env.NODE_ENV,
    argv: process.argv,
  });
  const database = readDatabaseConfig(process.env);
  const timewebAiToken = readTimewebAiToken(process.env);
  const migrationPool = createPool(database);
  try {
    await runMigrations(migrationPool);
  } finally {
    await migrationPool.end();
  }
  const pool = createPool(database);
  try {
    await assertDatabaseReady(pool);
    const service = new MemberDirectoryService({
      repository: new PgMemberRepository(pool),
      embeddings: new OpenAiEmbeddingProvider({
        apiKey: timewebAiToken,
        baseUrl: RUNTIME_DEFAULTS.ai.baseUrl,
        model: RUNTIME_DEFAULTS.ai.embeddingModel,
        dimensions: RUNTIME_DEFAULTS.ai.embeddingDimensions,
      }),
    });
    const result = await seedMockMembers(service, seedOptions);
    logger.info(
      { event: 'mock-member-seed', upserted: result.upserted, indexed: result.indexed },
      'Mock member seed complete',
    );
  } finally {
    await pool.end();
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  void runSeedCli().catch((error: unknown) => {
    logger.fatal(
      { errorClass: error instanceof Error ? error.name : 'unknown' },
      'Mock member seed failed',
    );
    process.exitCode = 1;
  });
}
