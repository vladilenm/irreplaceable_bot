import { expect, it } from 'vitest';
import { buildEvidenceOptions } from './member-evidence-options.js';

it('keeps short canonical lines exact and assigns stable local ids', () => {
  const profileText = [
    'Профессия и специализация: Криптоаналитик',
    'Может помочь с запросами: Крипта и P2P',
  ].join('\n');

  expect(buildEvidenceOptions(profileText)).toEqual([
    { evidenceId: 'e0', text: 'Профессия и специализация: Криптоаналитик' },
    { evidenceId: 'e1', text: 'Может помочь с запросами: Крипта и P2P' },
  ]);
});

it('splits long text into exact substrings no longer than 300 characters', () => {
  const first = `Опыт: ${'слово '.repeat(70).trim()}.`;
  const second = `Кейс: ${'я'.repeat(340)}`;
  const profileText = `${first} ${second}`;

  const options = buildEvidenceOptions(profileText);

  expect(options.length).toBeGreaterThan(2);
  for (const option of options) {
    expect(option.text.length).toBeGreaterThan(0);
    expect(option.text.length).toBeLessThanOrEqual(300);
    expect(profileText.includes(option.text)).toBe(true);
  }
});

it('preserves Unicode, casing, numbers, units, and punctuation', () => {
  const metric = 'Опыт: Более 3,5 млн уникальных пользователей — без изменения метрики.';

  expect(buildEvidenceOptions(metric)).toEqual([
    { evidenceId: 'e0', text: metric },
  ]);
});

it('drops empty and duplicate fragments while preserving first order', () => {
  expect(buildEvidenceOptions('Факт\n\nФакт\nДругой факт')).toEqual([
    { evidenceId: 'e0', text: 'Факт' },
    { evidenceId: 'e1', text: 'Другой факт' },
  ]);
});
