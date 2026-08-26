import type { MemberSourceRecord } from './members.js';
import type { ClubMemberSourceRow } from './member-source.repository.js';
import { isPositivePostgresBigint } from './telegram-user-id.js';

export type MemberProjection =
  | { accepted: true; record: MemberSourceRecord }
  | {
      accepted: false;
      reason:
        | 'unsupported-consent-version'
        | 'invalid-telegram-id'
        | 'invalid-telegram-username'
        | 'invalid-profile-field'
        | 'profile-document-too-long';
    };

const scalar = (raw: string, maxLength: number): string | null => {
  const value = raw
    .normalize('NFC')
    .replace(/[\p{C}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return value !== '' && value.length <= maxLength ? value : null;
};

export function projectClubMember(
  row: ClubMemberSourceRow,
  supportedPolicies: ReadonlySet<string>,
): MemberProjection {
  if (!supportedPolicies.has(row.consentPolicyVersion)) {
    return { accepted: false, reason: 'unsupported-consent-version' };
  }
  if (!isPositivePostgresBigint(row.telegramUserId)) {
    return { accepted: false, reason: 'invalid-telegram-id' };
  }
  const telegramUsername = row.telegramUsername.trim().replace(/^@/, '').toLowerCase();
  if (!/^[a-z][a-z0-9_]{4,31}$/.test(telegramUsername)) {
    return { accepted: false, reason: 'invalid-telegram-username' };
  }
  const displayName = scalar(row.displayName, 80);
  const occupation = scalar(row.occupation, 100);
  const industry = scalar(row.industry, 100);
  const expertise = scalar(row.expertise, 1000);
  const canHelpWith = scalar(row.canHelpWith, 700);
  const normalizedSkills = row.skills.map((skill) => scalar(skill, 30));
  if (normalizedSkills.some((skill) => skill === null)) {
    return { accepted: false, reason: 'invalid-profile-field' };
  }
  const skills = [...new Set(normalizedSkills as string[])];
  if (!displayName || !occupation || !industry || !expertise || !canHelpWith
    || skills.length === 0 || skills.length > 12) {
    return { accepted: false, reason: 'invalid-profile-field' };
  }
  const sourceUpdatedAt = new Date(row.sourceUpdatedAt);
  if (Number.isNaN(sourceUpdatedAt.getTime())) {
    return { accepted: false, reason: 'invalid-profile-field' };
  }
  const profileText = [
    `Имя: ${displayName}`,
    `Профессия и специализация: ${occupation}`,
    `Сфера: ${industry}`,
    `Опыт, сильные стороны и кейсы: ${expertise}`,
    `Может помочь с запросами: ${canHelpWith}`,
    `Навыки, технологии и инструменты: ${skills.join(', ')}`,
  ].join('\n');
  if (profileText.length > 2500) {
    return { accepted: false, reason: 'profile-document-too-long' };
  }
  return {
    accepted: true,
    record: {
      source: 'web',
      externalId: row.telegramUserId,
      telegramUserId: row.telegramUserId,
      displayName,
      telegramUsername,
      profileText,
      sourceUpdatedAt: sourceUpdatedAt.toISOString(),
      active: true,
    },
  };
}
