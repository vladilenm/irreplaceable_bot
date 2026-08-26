import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  PgMemberSourceRepository,
  type MemberSourceRepository,
} from './member-source.repository.js';
import { createTestPool } from './test/postgres.js';

const pool = createTestPool();
let repo: MemberSourceRepository;

async function insertFixture(overrides: Partial<{
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
}> = {}): Promise<void> {
  const row = {
    telegramUserId: '9007199254740993',
    telegramUsername: 'vladilen_minin',
    displayName: 'Владилен Минин',
    occupation: 'Автор и преподаватель',
    industry: 'EdTech',
    expertise: 'Запустил несколько продуктов',
    canHelpWith: 'Упаковка экспертизы',
    skills: ['Product strategy', 'EdTech'],
    consentPolicyVersion: 'member-matching-v1',
    sourceUpdatedAt: '2026-08-26T10:00:00.000Z',
    ...overrides,
  };
  await pool.query(`
    INSERT INTO club.member_matching_fixture (
      telegram_user_id, telegram_username, display_name, occupation, industry,
      expertise, can_help_with, skills, consent_policy_version, source_updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
  `, [
    row.telegramUserId,
    row.telegramUsername,
    row.displayName,
    row.occupation,
    row.industry,
    row.expertise,
    row.canHelpWith,
    row.skills,
    row.consentPolicyVersion,
    row.sourceUpdatedAt,
  ]);
}

beforeEach(async () => {
  await pool.query('DROP SCHEMA IF EXISTS club CASCADE');
  await pool.query('CREATE SCHEMA club');
  await pool.query(`
    CREATE TABLE club.member_matching_fixture (
      telegram_user_id bigint NOT NULL,
      telegram_username text NOT NULL,
      display_name text NOT NULL,
      occupation text NOT NULL,
      industry text NOT NULL,
      expertise text NOT NULL,
      can_help_with text NOT NULL,
      skills text[] NOT NULL,
      consent_policy_version text NOT NULL,
      source_updated_at timestamptz NOT NULL
    )
  `);
  await pool.query(`
    CREATE VIEW club.member_matching_source AS
    SELECT * FROM club.member_matching_fixture
  `);
  repo = new PgMemberSourceRepository(pool);
});

afterAll(async () => {
  await pool.end();
});

describe('PgMemberSourceRepository', () => {
  it('reads the ten-column source view with decimal Telegram IDs and ISO timestamps', async () => {
    await insertFixture();

    await expect(repo.readSnapshot()).resolves.toEqual([{
      telegramUserId: '9007199254740993',
      telegramUsername: 'vladilen_minin',
      displayName: 'Владилен Минин',
      occupation: 'Автор и преподаватель',
      industry: 'EdTech',
      expertise: 'Запустил несколько продуктов',
      canHelpWith: 'Упаковка экспертизы',
      skills: ['Product strategy', 'EdTech'],
      consentPolicyVersion: 'member-matching-v1',
      sourceUpdatedAt: '2026-08-26T10:00:00.000Z',
    }]);
  });

  it('rejects duplicate Telegram IDs', async () => {
    await insertFixture();
    await insertFixture({ telegramUsername: 'second_member' });

    await expect(repo.readSnapshot()).rejects.toThrow('duplicate-member-source-id');
  });

  it('propagates source-view schema failures instead of returning an empty snapshot', async () => {
    await pool.query('DROP VIEW club.member_matching_source');
    await pool.query('ALTER TABLE club.member_matching_fixture RENAME COLUMN occupation TO role');
    await pool.query(`
      CREATE VIEW club.member_matching_source AS
      SELECT * FROM club.member_matching_fixture
    `);

    await expect(repo.readSnapshot()).rejects.toThrow(/occupation/);
  });
});
