import { expect, it } from 'vitest';
import { caseSucceeded, parseEvaluationCases } from './evaluate-member-matching.js';

it('accepts a protected evaluation set of 20 to 30 cases only', () => {
  const valid = Array.from({ length: 20 }, (_, index) => ({
    query: `query-${String(index)}`,
    expectedUsernames: ['anna_product'],
  }));

  expect(parseEvaluationCases(valid)).toHaveLength(20);
  expect(() => parseEvaluationCases(valid.slice(0, 19))).toThrow();
  expect(() => parseEvaluationCases([...valid, ...valid.slice(0, 11)])).toThrow();
});

it('scores success from code-owned top-five usernames only', () => {
  const matches = [
    { telegramUsername: 'someone_else' },
    { telegramUsername: 'Anna_Product' },
  ];

  expect(caseSucceeded(matches, ['anna_product'])).toBe(true);
  expect(caseSucceeded(matches, ['missing'])).toBe(false);
  expect(caseSucceeded([
    ...Array.from({ length: 5 }, () => ({ telegramUsername: 'other' })),
    { telegramUsername: 'anna_product' },
  ], ['anna_product'])).toBe(false);
});
