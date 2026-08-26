import { expect, it } from 'vitest';
import { projectClubMember } from './member-profile-text.js';
import type { ClubMemberSourceRow } from './member-source.repository.js';

const row = (overrides: Partial<ClubMemberSourceRow> = {}): ClubMemberSourceRow => ({
  telegramUserId: '94659185',
  telegramUsername: 'Vladilen_Minin',
  displayName: ' Владилен\u0000  Минин ',
  occupation: ' Автор и\nпреподаватель ',
  industry: ' EdTech ',
  expertise: ' Запустил  несколько продуктов ',
  canHelpWith: ' Упаковка экспертизы ',
  skills: [' Product strategy ', 'EdTech', 'Product  strategy'],
  consentPolicyVersion: 'member-matching-v1',
  sourceUpdatedAt: '2026-08-26T10:00:00.000Z',
  ...overrides,
});

it('builds the deterministic labeled expert document', () => {
  expect(projectClubMember(row(), new Set(['member-matching-v1']))).toEqual({
    accepted: true,
    record: {
      source: 'web',
      externalId: '94659185',
      telegramUserId: '94659185',
      displayName: 'Владилен Минин',
      telegramUsername: 'vladilen_minin',
      profileText: [
        'Имя: Владилен Минин',
        'Профессия и специализация: Автор и преподаватель',
        'Сфера: EdTech',
        'Опыт, сильные стороны и кейсы: Запустил несколько продуктов',
        'Может помочь с запросами: Упаковка экспертизы',
        'Навыки, технологии и инструменты: Product strategy, EdTech',
      ].join('\n'),
      sourceUpdatedAt: '2026-08-26T10:00:00.000Z',
      active: true,
    },
  });
});

it('rejects unsupported consent without exposing profile values', () => {
  expect(projectClubMember(
    row({ consentPolicyVersion: 'member-matching-v2' }),
    new Set(['member-matching-v1']),
  )).toEqual({ accepted: false, reason: 'unsupported-consent-version' });
});

it.each([
  [{ telegramUserId: '9223372036854775808' }, 'invalid-telegram-id'],
  [{ telegramUsername: 'bad name' }, 'invalid-telegram-username'],
  [{ occupation: '   ' }, 'invalid-profile-field'],
  [{ skills: [] }, 'invalid-profile-field'],
  [{ sourceUpdatedAt: 'not-a-date' }, 'invalid-profile-field'],
] as const)('rejects an invalid card with a safe reason', (overrides, reason) => {
  expect(projectClubMember(
    row(overrides as Partial<ClubMemberSourceRow>),
    new Set(['member-matching-v1']),
  )).toEqual({ accepted: false, reason });
});

it('keeps the maximum valid card within the document ceiling', () => {
  const result = projectClubMember(row({
    displayName: 'x'.repeat(80),
    occupation: 'x'.repeat(100),
    industry: 'x'.repeat(100),
    expertise: 'x'.repeat(1000),
    canHelpWith: 'x'.repeat(700),
    skills: Array.from({ length: 12 }, (_, index) =>
      String(index).padEnd(30, 'x')),
  }), new Set(['member-matching-v1']));
  expect(result.accepted).toBe(true);
  if (result.accepted) {
    expect(result.record.profileText.length).toBeLessThanOrEqual(2500);
  }
});

it('deduplicates skills after normalization', () => {
  const result = projectClubMember(row({
    skills: ['Product strategy', ' Product  strategy '],
  }), new Set(['member-matching-v1']));
  expect(result.accepted).toBe(true);
  if (result.accepted) {
    expect(result.record.profileText.match(/Product strategy/g) ?? []).toHaveLength(1);
  }
});
