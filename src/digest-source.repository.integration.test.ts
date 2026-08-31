import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from './db/migrations.js';
import { PgDigestSourceRepository } from './digest-source.repository.js';
import type { PublishedDigestV3 } from './published-digest.js';
import { PgScheduledPublicationRepository } from './scheduled-publication.repository.js';
import { createTestPool, resetPostgres } from './test/postgres.js';

const pool = createTestPool();
const repository = new PgDigestSourceRepository(pool);

function makeDigest(digestId: string, generatedAt: string, publicationDate = '2026-08-31'):
PublishedDigestV3 {
  return {
    schemaVersion: 3,
    digestId,
    topic: { id: 'ai', title: 'AI Radar', language: 'ru', timezone: 'Europe/Moscow' },
    publicationDate,
    generatedAt,
    status: 'complete',
    selectionMode: 'standard',
    sourceStats: {
      telegram: { total: 1, succeeded: 1, skipped: 0 },
      web: { total: 0, succeeded: 0, skipped: 0 },
    },
    sections: {
      main: [{
        eventId: 'event-1',
        title: 'Событие',
        claimKind: 'fact',
        confidence: 'confirmed',
        summary: 'Суть события',
        whyImportant: 'Почему важно',
        affected: 'Команды',
        keyQuote: {
          text: 'Проверенная цитата',
          url: 'https://example.com/source',
          sourceLabel: 'Example',
        },
        tags: [{ id: 'agents', label: 'AI-агенты' }],
        entities: [],
        sources: [{ url: 'https://example.com/source', label: 'Example', role: 'primary' }],
        publishedAt: '2026-08-31T05:00:00.000Z',
      }],
      radar: [],
      focus: [],
    },
  };
}

async function insertIssue(document: PublishedDigestV3): Promise<void> {
  await pool.query(`
    INSERT INTO digest.issue_fixture(digest_id, publication_date, generated_at, document)
    VALUES ($1, $2, $3, $4::jsonb)
  `, [document.digestId, document.publicationDate, document.generatedAt, JSON.stringify(document)]);
}

beforeEach(async () => {
  await resetPostgres(pool);
  await runMigrations(pool);
  await pool.query('DROP SCHEMA IF EXISTS digest CASCADE');
  await pool.query('CREATE SCHEMA digest');
  await pool.query(`
    CREATE TABLE digest.issue_fixture (
      digest_id uuid PRIMARY KEY,
      publication_date date NOT NULL,
      generated_at timestamptz NOT NULL,
      document jsonb NOT NULL
    )
  `);
  await pool.query(`
    CREATE VIEW digest.telegram_issue_source AS
    SELECT digest_id, publication_date, generated_at, document
    FROM digest.issue_fixture
  `);
});

afterAll(async () => {
  await pool.end();
});

describe('PgDigestSourceRepository', () => {
  it('reads only the requested date in canonical publication order', async () => {
    const later = makeDigest(
      '22222222-2222-4222-8222-222222222222',
      '2026-08-31T07:00:00.000Z',
    );
    const earlier = makeDigest(
      '11111111-1111-4111-8111-111111111111',
      '2026-08-31T06:00:00.000Z',
    );
    const old = makeDigest(
      '33333333-3333-4333-8333-333333333333',
      '2026-08-30T06:00:00.000Z',
      '2026-08-30',
    );
    await insertIssue(later);
    await insertIssue(old);
    await insertIssue(earlier);

    const issues = await repository.listForDelivery('2026-08-31', 20);

    expect(issues).toEqual([
      { digestId: earlier.digestId, document: earlier },
      { digestId: later.digestId, document: later },
    ]);
  });

  it('omits an origin already imported into the bot-owned outbox', async () => {
    const document = makeDigest(
      '11111111-1111-4111-8111-111111111111',
      '2026-08-31T06:00:00.000Z',
    );
    await insertIssue(document);
    await new PgScheduledPublicationRepository(pool).enqueue({
      pipeline: 'digest',
      messageFormat: 'rich-html',
      originDigestId: document.digestId,
      publicationDate: document.publicationDate,
      targetChatId: -100123,
      threadId: 77,
      chunks: ['<h1>Digest</h1>'],
      itemCount: 1,
      nextAttemptAt: new Date('2026-08-31T12:00:00.000Z'),
      expiresAt: new Date('2026-08-31T21:00:00.000Z'),
    });

    await expect(repository.listForDelivery('2026-08-31', 20)).resolves.toEqual([]);
  });
});
