import type { Pool } from 'pg';

export interface ClubMemberSourceRow {
  telegramUserId: string;
  telegramUsername: string;
  displayName: string;
  occupation: string;
  industry: string;
  expertise: string;
  canHelpWith: string;
  skills: string[];
  consentPolicyVersion: string;
  sourceUpdatedAt: string;
}

export interface MemberSourceRepository {
  readSnapshot(): Promise<readonly ClubMemberSourceRow[]>;
}

export class PgMemberSourceRepository implements MemberSourceRepository {
  constructor(private readonly pool: Pool) {}

  async readSnapshot(): Promise<readonly ClubMemberSourceRow[]> {
    const result = await this.pool.query<{
      telegram_user_id: string;
      telegram_username: string;
      display_name: string;
      occupation: string;
      industry: string;
      expertise: string;
      can_help_with: string;
      skills: string[];
      consent_policy_version: string;
      source_updated_at: Date;
    }>(`
      SELECT telegram_user_id, telegram_username, display_name, occupation,
        industry, expertise, can_help_with, skills, consent_policy_version,
        source_updated_at
      FROM club.member_matching_source
      ORDER BY telegram_user_id
    `);
    const seen = new Set<string>();
    return result.rows.map((row) => {
      const telegramUserId = String(row.telegram_user_id);
      if (!/^[1-9]\d*$/.test(telegramUserId)) {
        throw new Error('invalid-member-source-id');
      }
      if (seen.has(telegramUserId)) throw new Error('duplicate-member-source-id');
      seen.add(telegramUserId);
      if ([
        row.telegram_username,
        row.display_name,
        row.occupation,
        row.industry,
        row.expertise,
        row.can_help_with,
        row.consent_policy_version,
      ].some((value) => typeof value !== 'string')
        || !(row.source_updated_at instanceof Date)
        || Number.isNaN(row.source_updated_at.getTime())
        || !Array.isArray(row.skills)
        || row.skills.some((skill) => typeof skill !== 'string')) {
        throw new Error('invalid-member-source-row');
      }
      return {
        telegramUserId,
        telegramUsername: row.telegram_username,
        displayName: row.display_name,
        occupation: row.occupation,
        industry: row.industry,
        expertise: row.expertise,
        canHelpWith: row.can_help_with,
        skills: row.skills,
        consentPolicyVersion: row.consent_policy_version,
        sourceUpdatedAt: row.source_updated_at.toISOString(),
      };
    });
  }
}
