import { describe, expect, it } from 'vitest';
import { parseRetryPublicationPipeline } from './bot.js';

describe('parseRetryPublicationPipeline', () => {
  it.each([
    ['', null],
    ['all', null],
    ['digest', 'digest'],
    ['summary', 'thread-summary'],
  ] as const)('accepts %s', (argument, expected) => {
    expect(parseRetryPublicationPipeline(argument)).toBe(expected);
  });

  it('rejects arbitrary command arguments', () => {
    expect(parseRetryPublicationPipeline('everything')).toBeUndefined();
  });
});
