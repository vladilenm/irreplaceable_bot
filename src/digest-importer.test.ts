import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDigestImporter,
  type DigestImporterOptions,
} from './digest-importer.js';
import type { DigestSourceRepository } from './digest-source.repository.js';
import type { PublishedDigestV3, PublishedEvent } from './published-digest.js';
import type { PublicationDispatcher } from './publication-dispatcher.js';
import type { ScheduledPublicationRepository } from './scheduled-publication.repository.js';

function makeEvent(overrides: Partial<PublishedEvent> = {}): PublishedEvent {
  return {
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
    ...overrides,
  };
}

function makeDigest(overrides: Partial<PublishedDigestV3> = {}): PublishedDigestV3 {
  return {
    schemaVersion: 3,
    digestId: '11111111-1111-4111-8111-111111111111',
    topic: { id: 'ai', title: 'AI Radar', language: 'ru', timezone: 'Europe/Moscow' },
    publicationDate: '2026-08-31',
    generatedAt: '2026-08-31T06:00:00.000Z',
    status: 'complete',
    selectionMode: 'standard',
    sourceStats: {
      telegram: { total: 1, succeeded: 1, skipped: 0 },
      web: { total: 0, succeeded: 0, skipped: 0 },
    },
    sections: { main: [makeEvent()], radar: [], focus: [] },
    ...overrides,
  };
}

function makeHarness(documents: unknown[] = [makeDigest()]): {
  options: DigestImporterOptions;
  source: DigestSourceRepository;
  publications: ScheduledPublicationRepository;
  dispatcher: PublicationDispatcher;
} {
  const source: DigestSourceRepository = {
    listForDelivery: vi.fn(async () => documents.map((document, index) => ({
      digestId: typeof document === 'object' && document !== null && 'digestId' in document
        ? String(document.digestId)
        : `invalid-${String(index)}`,
      document,
    }))),
  };
  const publications: ScheduledPublicationRepository = {
    enqueue: vi.fn(async () => ({ id: '1', created: true })),
    claimDue: vi.fn(),
    recordChunkDelivered: vi.fn(),
    scheduleRetry: vi.fn(),
    markFailed: vi.fn(),
    markExpired: vi.fn(),
    expireDue: vi.fn(),
    recover: vi.fn(),
    read: vi.fn(),
    getStatusCounts: vi.fn(),
    deleteExpiredPublications: vi.fn(),
  };
  const dispatcher: PublicationDispatcher = {
    dispatchDue: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  };
  return {
    source,
    publications,
    dispatcher,
    options: {
      source,
      publications,
      dispatcher,
      targetChatId: -100123,
      threadId: 77,
      intervalMs: 30_000,
      onError: vi.fn(),
      logInvalid: vi.fn(),
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createDigestImporter', () => {
  it('validates, renders, and enqueues one current-day issue before immediate dispatch', async () => {
    const digest = makeDigest({
      sections: {
        main: [makeEvent()],
        radar: [makeEvent({ eventId: 'event-2', title: 'Radar' })],
        focus: [],
      },
    });
    const harness = makeHarness([digest]);
    const importer = createDigestImporter(harness.options);
    const now = new Date('2026-08-31T12:00:00.000Z');

    await importer.importDue(now);

    expect(harness.source.listForDelivery).toHaveBeenCalledWith('2026-08-31', 20);
    expect(harness.publications.enqueue).toHaveBeenCalledWith({
      pipeline: 'digest',
      messageFormat: 'rich-html',
      originDigestId: digest.digestId,
      publicationDate: '2026-08-31',
      targetChatId: -100123,
      threadId: 77,
      chunks: [expect.stringContaining('<h1>')],
      itemCount: 2,
      nextAttemptAt: now,
      expiresAt: new Date('2026-08-31T21:00:00.000Z'),
    });
    expect(harness.dispatcher.dispatchDue).toHaveBeenCalledWith(now);
  });

  it.each([
    ['partial standard', makeDigest({ status: 'partial' })],
    ['focus', makeDigest({
      selectionMode: 'focus',
      sections: { main: [], radar: [], focus: [makeEvent(), makeEvent({ eventId: 'event-2' })] },
    })],
  ])('accepts %s issues', async (_name, digest) => {
    const harness = makeHarness([digest]);

    await createDigestImporter(harness.options).importDue(
      new Date('2026-08-31T12:00:00.000Z'),
    );

    expect(harness.publications.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      itemCount: digest.selectionMode === 'focus' ? 2 : 1,
    }));
  });

  it('isolates malformed, mismatched-id, and mismatched-date documents', async () => {
    const valid = makeDigest({ digestId: '44444444-4444-4444-8444-444444444444' });
    const harness = makeHarness([]);
    vi.mocked(harness.source.listForDelivery).mockResolvedValue([
      { digestId: 'invalid-0', document: { schemaVersion: 3 } },
      { digestId: '22222222-2222-4222-8222-222222222222', document: makeDigest() },
      {
        digestId: '33333333-3333-4333-8333-333333333333',
        document: makeDigest({
          digestId: '33333333-3333-4333-8333-333333333333',
          publicationDate: '2026-08-30',
        }),
      },
      { digestId: valid.digestId, document: valid },
    ]);

    await createDigestImporter(harness.options).importDue(
      new Date('2026-08-31T12:00:00.000Z'),
    );

    expect(harness.options.logInvalid).toHaveBeenNthCalledWith(1, 'invalid-0', 'schema-invalid');
    expect(harness.options.logInvalid).toHaveBeenNthCalledWith(
      2,
      '22222222-2222-4222-8222-222222222222',
      'digest-id-mismatch',
    );
    expect(harness.options.logInvalid).toHaveBeenNthCalledWith(
      3,
      '33333333-3333-4333-8333-333333333333',
      'publication-date-mismatch',
    );
    expect(harness.publications.enqueue).toHaveBeenCalledOnce();
    expect(harness.publications.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      originDigestId: valid.digestId,
    }));
  });

  it('does not dispatch a repeated origin across polling or a recreated importer', async () => {
    const harness = makeHarness();
    vi.mocked(harness.publications.enqueue)
      .mockResolvedValueOnce({ id: '1', created: true })
      .mockResolvedValue({ id: '1', created: false });
    const now = new Date('2026-08-31T12:00:00.000Z');

    await createDigestImporter(harness.options).importDue(now);
    await createDigestImporter(harness.options).importDue(now);

    expect(harness.publications.enqueue).toHaveBeenCalledTimes(2);
    expect(harness.dispatcher.dispatchDue).toHaveBeenCalledOnce();
  });

  it('starts and stops polling idempotently and routes background errors safely', async () => {
    vi.useFakeTimers();
    const harness = makeHarness([]);
    vi.mocked(harness.source.listForDelivery)
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('database unavailable'));
    const importer = createDigestImporter(harness.options);

    importer.start();
    importer.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.source.listForDelivery).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(harness.source.listForDelivery).toHaveBeenCalledTimes(2);
    expect(harness.options.onError).toHaveBeenCalledWith(expect.any(Error));

    importer.stop();
    importer.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.source.listForDelivery).toHaveBeenCalledTimes(2);
  });
});
