import { expect, it, vi } from 'vitest';
import type { RequestMatchingRuntime } from './request.runtime.js';

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

it('registers member requests before terminal capture middleware', () => {
  mocks.order.length = 0;

  createBot({ requestMatching: { handlerOptions: {} } as RequestMatchingRuntime });

  expect(mocks.order).toEqual(['request', 'capture']);
});
