// Phase 6 D-24, SUM-07 — Unicode display-name normaliser unit tests.
import { describe, it, expect } from 'vitest';
import { normalizeDisplayName } from './display-name.js';

describe('normalizeDisplayName (D-24, SUM-07)', () => {
  it('Test 1: NFC idempotent on plain ASCII Cyrillic', () => {
    expect(normalizeDisplayName('Маша')).toBe('Маша');
  });

  it('Test 2: zero-width space U+200B is stripped', () => {
    // 'Ма' + U+200B + 'ша'
    const input = 'Ма​ша';
    expect(normalizeDisplayName(input)).toBe('Маша');
  });

  it('Test 3: RTL override U+202E is stripped', () => {
    // 'hello' + U+202E + 'world'
    const input = 'hello‮world';
    expect(normalizeDisplayName(input)).toBe('helloworld');
  });

  it('Test 4: control char (NUL \\x00) stripped via \\p{C}', () => {
    expect(normalizeDisplayName('foo\x00bar')).toBe('foobar');
  });

  it('Test 5: surrounding whitespace trimmed', () => {
    expect(normalizeDisplayName('  Маша  ')).toBe('Маша');
  });

  it('Test 6: NFC composes decomposed accents (e + combining acute → é)', () => {
    // 'Cafe' + 'e' + U+0301 (combining acute) → should normalise to 'Café' (single composed char)
    const decomposed = 'Café';
    const composed = 'Café';
    expect(normalizeDisplayName(decomposed)).toBe(composed);
    // length: 4 composed chars (NFC), not 5
    expect(normalizeDisplayName(decomposed).length).toBe(4);
  });

  it('Test 7: combined zero-width + RTL + control + trim case', () => {
    // 'Маша' with U+200B inside, U+202E around, NUL prefix and trailing spaces
    const input = '  \x00‮Ма​ша‬  ';
    expect(normalizeDisplayName(input)).toBe('Маша');
  });
});
