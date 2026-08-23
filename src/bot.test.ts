import { expect, it, vi } from 'vitest';
import type { JobStateRepository } from './job-state.repository.js';
import type { MessageRepository } from './messages.repository.js';
import type { RequestMatchingRuntime } from './request.runtime.js';
import type { ScheduledPublicationRepository } from './scheduled-publication.repository.js';

const mocks = vi.hoisted(() => {
  const order: string[] = [];
  return {
    order,
    registerCaptureHandlers: vi.fn(() => order.push('capture')),
    registerRequestHandlers: vi.fn(() => order.push('request')),
  };
});

vi.mock('./capture.js', () => ({ registerCaptureHandlers: mocks.registerCaptureHandlers }));
vi.mock('./requests.js', () => ({ registerRequestHandlers: mocks.registerRequestHandlers }));

import { createBot } from './bot.js';

const jobs: JobStateRepository = {
  read: vi.fn(async () => ({
    lastDigestDate: null,
    lastSkipped: false,
    lastItemCount: 0,
    lastThreadSummaryDate: null,
  })),
  recordDigest: vi.fn(async () => undefined),
  recordThreadSummary: vi.fn(async () => undefined),
};
const messages: MessageRepository = {
  upsert: vi.fn(async () => undefined),
  selectWindow: vi.fn(async () => []),
  runRetention: vi.fn(async () => ({ rowsDeleted: 0, durationMs: 0 })),
};
const publications: ScheduledPublicationRepository = {
  enqueue: vi.fn(),
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

it('registers member requests before terminal capture middleware', () => {
  mocks.order.length = 0;

  createBot({
    persistence: { jobs, messages, publications },
    requestMatching: { handlerOptions: {} } as RequestMatchingRuntime,
  });

  expect(mocks.order).toEqual(['request', 'capture']);
  expect(mocks.registerCaptureHandlers).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ messages }),
  );
});
