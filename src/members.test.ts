import { describe, expect, it } from 'vitest';
import { buildMemberId, canonicalSearchText } from './members.js';

describe('member identity', () => {
  it('uses provider-scoped IDs and canonical text', () => {
    expect(buildMemberId('notion', 'page-1')).toBe('notion:page-1');
    expect(canonicalSearchText({ displayName: 'Анна', profileText: 'B2B SaaS' }))
      .toBe('Анна\nB2B SaaS');
  });
});
