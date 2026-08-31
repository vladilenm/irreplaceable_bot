import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Api } from 'grammy';
import { runMigrations } from './db/migrations.js';
import { createDigestImporter } from './digest-importer.js';
import { createPersistence } from './persistence.js';
import { createPublicationDispatcher } from './publication-dispatcher.js';
import type { PublishedDigestV3 } from './published-digest.js';
import { createTestPool, resetPostgres } from './test/postgres.js';
import { sendRichMessageOnce } from './telegram.js';

const pool = createTestPool();
const digestId = '11111111-1111-4111-8111-111111111111';
const now = new Date('2026-08-31T12:00:00.000Z');

function makeDigest(): PublishedDigestV3 {
  return {
    schemaVersion: 3,
    digestId,
    topic: { id: 'ai', title: 'AI Radar', language: 'ru', timezone: 'Europe/Moscow' },
    publicationDate: '2026-08-31',
    generatedAt: '2026-08-31T06:00:00.000Z',
    status: 'complete',
    selectionMode: 'standard',
    sourceStats: {
      telegram: { total: 1, succeeded: 1, skipped: 0 },
      web: { total: 1, succeeded: 1, skipped: 0 },
    },
    sections: {
      main: [{
        eventId: 'event-main',
        title: 'Новый агент & безопасность',
        claimKind: 'fact',
        confidence: 'confirmed',
        summary: 'Короткое проверенное описание.',
        whyImportant: 'Влияет на команды, которые внедряют агентов.',
        affected: 'AI-команды',
        keyQuote: {
          text: 'Подтверждённая цитата',
          url: 'https://example.com/main',
          sourceLabel: 'Primary',
        },
        tags: [{ id: 'agents', label: 'AI-агенты' }],
        entities: [],
        sources: [{ url: 'https://example.com/main', label: 'Primary', role: 'primary' }],
        publishedAt: '2026-08-31T05:00:00.000Z',
      }],
      radar: [{
        eventId: 'event-radar',
        title: 'Сигнал радара',
        claimKind: 'analysis',
        confidence: 'single-source',
        summary: 'Короткий сигнал.',
        whyImportant: 'Стоит наблюдать.',
        affected: 'Продуктовые команды',
        keyQuote: {
          text: 'Сигнал требует наблюдения',
          url: 'https://example.com/radar',
          sourceLabel: 'Radar',
        },
        tags: [],
        entities: [],
        sources: [{ url: 'https://example.com/radar', label: 'Radar', role: 'discovery' }],
        publishedAt: '2026-08-31T05:30:00.000Z',
      }],
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

describe('Topic Digest delivery', () => {
  it('imports and sends one Rich Message once across a repeated poll and restart', async () => {
    await insertIssue(makeDigest());
    const rawSendRichMessage = vi.fn(async () => ({
      message_id: 4242,
      date: 1_788_177_600,
      chat: { id: -100123, type: 'supergroup' as const },
    }));
    const api = { raw: { sendRichMessage: rawSendRichMessage } } as unknown as Api;

    const runConsumer = async (): Promise<void> => {
      const persistence = createPersistence(pool);
      const dispatcher = createPublicationDispatcher({
        publications: persistence.publications,
        jobs: persistence.jobs,
        sendMessageOnce: async () => {
          throw new Error('regular sendMessage must not be used for a digest issue');
        },
        sendRichMessageOnce: (params) => sendRichMessageOnce(api, params),
      });
      const importer = createDigestImporter({
        source: persistence.digestSource,
        publications: persistence.publications,
        dispatcher,
        targetChatId: -100123,
        threadId: 77,
        intervalMs: 30_000,
        onError: vi.fn(),
        logInvalid: vi.fn(),
      });
      await importer.importDue(now);
    };

    await runConsumer();
    await runConsumer();

    expect(rawSendRichMessage).toHaveBeenCalledOnce();
    expect(rawSendRichMessage).toHaveBeenCalledWith({
      chat_id: -100123,
      message_thread_id: 77,
      rich_message: {
        html: expect.stringMatching(/^<h1>.*<\/h1>/s),
        skip_entity_detection: true,
      },
    });

    const result = await pool.query<{
      origin_digest_id: string;
      message_format: string;
      status: string;
      target_chat_id: string;
      thread_id: string;
      attempt_count: number;
      chunk_count: string;
      delivered_chunk_count: string;
      telegram_message_ids: string[];
    }>(`
      SELECT publication.origin_digest_id,
             publication.message_format,
             publication.status,
             publication.target_chat_id,
             publication.thread_id,
             publication.attempt_count,
             COUNT(chunk.*)::text AS chunk_count,
             COUNT(chunk.delivered_at)::text AS delivered_chunk_count,
             ARRAY_AGG(chunk.telegram_message_id ORDER BY chunk.chunk_index) AS telegram_message_ids
      FROM scheduled_publications publication
      JOIN scheduled_publication_chunks chunk ON chunk.publication_id = publication.id
      GROUP BY publication.id
    `);
    expect(result.rows).toEqual([{
      origin_digest_id: digestId,
      message_format: 'rich-html',
      status: 'delivered',
      target_chat_id: '-100123',
      thread_id: '77',
      attempt_count: 1,
      chunk_count: '1',
      delivered_chunk_count: '1',
      telegram_message_ids: ['4242'],
    }]);
  });
});
