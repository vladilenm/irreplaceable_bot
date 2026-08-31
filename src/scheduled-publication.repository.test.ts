import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from './db/migrations.js';
import {
  PgScheduledPublicationRepository,
  type ScheduledPublicationInput,
} from './scheduled-publication.repository.js';
import { createTestPool, resetPostgres } from './test/postgres.js';

const pool = createTestPool();
const repo = new PgScheduledPublicationRepository(pool);

const start = new Date('2030-08-23T06:00:00.000Z');
const input = (overrides: Partial<ScheduledPublicationInput> = {}): ScheduledPublicationInput => ({
  pipeline: 'digest',
  messageFormat: 'regular-html',
  originDigestId: null,
  publicationDate: '2030-08-23',
  targetChatId: -100123,
  threadId: 6359,
  chunks: ['first', 'second'],
  itemCount: 2,
  nextAttemptAt: start,
  expiresAt: new Date('2030-08-23T21:00:00.000Z'),
  ...overrides,
});

beforeEach(async () => {
  await resetPostgres(pool);
  await runMigrations(pool);
});

afterAll(async () => {
  await pool.end();
});

describe('PgScheduledPublicationRepository', () => {
  it('enqueues a publication once per pipeline and Moscow date', async () => {
    const first = await repo.enqueue(input());
    const second = await repo.enqueue(input({ chunks: ['different text'] }));

    expect(first.created).toBe(true);
    expect(second).toEqual({ id: first.id, created: false });
    const chunks = await pool.query<{ chunk_index: number; text: string }>(`
      SELECT chunk_index, text
      FROM scheduled_publication_chunks
      ORDER BY chunk_index
    `);
    expect(chunks.rows).toEqual([
      { chunk_index: 0, text: 'first' },
      { chunk_index: 1, text: 'second' },
    ]);
  });

  it('enqueues one rich digest publication for an origin across repeated dates', async () => {
    const originDigestId = '11111111-1111-4111-8111-111111111111';
    const first = await repo.enqueue(input({
      messageFormat: 'rich-html',
      originDigestId,
      chunks: ['<h1>Digest</h1>'],
    }));
    const repeated = await repo.enqueue(input({
      messageFormat: 'rich-html',
      originDigestId,
      publicationDate: '2030-08-24',
      chunks: ['<h1>Duplicate</h1>', '<p>extra chunk</p>'],
    }));

    expect(first.created).toBe(true);
    expect(repeated).toEqual({ id: first.id, created: false });
    const rows = await pool.query<{ message_format: string; origin_digest_id: string }>(`
      SELECT message_format, origin_digest_id FROM scheduled_publications
    `);
    expect(rows.rows).toEqual([{ message_format: 'rich-html', origin_digest_id: originDigestId }]);
    const chunks = await pool.query<{ text: string }>(`
      SELECT text FROM scheduled_publication_chunks ORDER BY chunk_index
    `);
    expect(chunks.rows).toEqual([{ text: '<h1>Digest</h1>' }]);
  });

  it('claims the first undelivered chunk and completes only after the final chunk', async () => {
    const publication = await repo.enqueue(input());

    const first = await repo.claimDue(start, 5 * 60_000);
    expect(first).toMatchObject({
      id: publication.id,
      pipeline: 'digest',
      messageFormat: 'regular-html',
      originDigestId: null,
      attemptCount: 1,
      chunk: { chunkIndex: 0, text: 'first' },
    });
    await repo.recordChunkDelivered(publication.id, 0, 101, start);
    expect((await repo.read(publication.id))?.status).toBe('ready');

    const second = await repo.claimDue(start, 5 * 60_000);
    expect(second?.chunk).toEqual({ chunkIndex: 1, text: 'second' });
    const completed = await repo.recordChunkDelivered(
      publication.id,
      1,
      102,
      new Date('2030-08-23T06:06:01.000Z'),
    );

    expect(completed).toMatchObject({
      id: publication.id,
      pipeline: 'digest',
      itemCount: 2,
    });
    expect((await repo.read(publication.id))?.status).toBe('delivered');
  });

  it('persists a retry and allows a stale delivery lease to be recovered', async () => {
    const publication = await repo.enqueue(input());
    await repo.claimDue(start, 5 * 60_000);
    const retryAt = new Date('2030-08-23T06:00:03.000Z');
    await repo.scheduleRetry(publication.id, retryAt, 'network');

    expect(await repo.claimDue(new Date('2030-08-23T06:00:02.000Z'), 5 * 60_000)).toBeNull();
    expect((await repo.claimDue(retryAt, 5 * 60_000))?.attemptCount).toBe(2);

    const reclaimed = await repo.claimDue(new Date('2030-08-23T06:06:00.000Z'), 5 * 60_000);
    expect(reclaimed?.attemptCount).toBe(3);
  });

  it('expires due work and manually recovers failed or expired publications', async () => {
    const publication = await repo.enqueue(input({ expiresAt: new Date('2030-08-23T06:00:01.000Z') }));

    await repo.expireDue(new Date('2030-08-23T06:00:01.000Z'));
    expect((await repo.read(publication.id))?.status).toBe('expired');
    expect(await repo.claimDue(new Date('2030-08-23T06:00:02.000Z'), 5 * 60_000)).toBeNull();

    const recovered = await repo.recover('digest', new Date('2030-08-23T07:00:00.000Z'), new Date('2030-08-23T21:00:00.000Z'));
    expect(recovered).toBe(1);
    expect((await repo.read(publication.id))?.status).toBe('ready');
  });
});
