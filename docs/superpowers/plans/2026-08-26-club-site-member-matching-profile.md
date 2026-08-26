# Club Site Member Matching Profile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current broad participant questionnaire with the minimal expert profile, explicit member-matching consent, and a read-only PostgreSQL view consumed by `club-bot`.

**Architecture:** `club-site` remains the sole owner of `club.users`, `club.member_profiles`, `club.user_consents`, membership eligibility, and the database view `club.member_matching_source`. Next.js Server Actions derive identity from the verified session, write the profile and consent history in one transaction, and never call an AI provider. The first migration is additive: legacy questionnaire columns remain physically present for rollback but leave the active TypeScript, DAL, form, and bot contract.

**Tech Stack:** Next.js 16.3.1 App Router, React 19.2.8, TypeScript, Zod 4, Drizzle ORM, PostgreSQL 16, Vitest, Testing Library.

## Global Constraints

- Project root: `/Users/vladilen/Documents/тнз/club-site`.
- Before implementation, read `AGENTS.md` and the local Next.js guides `node_modules/next/dist/docs/01-app/02-guides/forms.md` and `server-actions.md`.
- The current `club-site` main worktree is dirty, including edits to the profile form and tests. Do not reset, stash, overwrite, or commit unrelated changes. Before Task 1, either have the user preserve that WIP in its own commit/branch or explicitly choose the hunks to port into an isolated worktree.
- Use `superpowers:using-git-worktrees` when execution begins in an isolated checkout.
- Telegram identity comes only from the verified session and `club.users.telegram_user_id`; never accept a Telegram ID, username, role, or user UUID from `FormData`.
- Active form fields and limits are exactly: `displayName` 80, `occupation` 100, `industry` 100, `expertise` 1000, `canHelpWith` 700, and at most 12 `skills` of at most 30 characters each.
- Every user-authored field above participates in the bot's canonical embedding document. Do not keep goals, current project, bottleneck, AI experience, or additional context in the active product model.
- Matching consent is optional and separate: `purpose = 'member_matching'`, `policy_version = 'member-matching-v1'`. Never reinterpret historical `llm_personalization` consent.
- The site stores structured source data only. It does not create embeddings, call an AI provider, or implement participant search.
- The bot reads only `club.member_matching_source`; do not grant it base-table access.
- Do not log form values, consent payloads, Telegram tokens, or database credentials.
- Do not deploy, change provider roles, run production migrations, or load real profiles without a separate user instruction.

---

### Task 1: Add the additive profile schema and matching source view

**Files:**
- Modify: `src/lib/db/schema.ts:40-89`
- Modify: `src/lib/db/schema.integration.test.ts`
- Create: `drizzle/0002_member_matching_profile.sql`
- Create: `drizzle/meta/0002_snapshot.json`
- Modify: `drizzle/meta/_journal.json`

**Interfaces:**
- Consumes: existing `club.users`, `club.member_profiles`, `club.user_consents`, and `club.subscriptions`.
- Produces: Drizzle fields `memberProfiles.expertise`, `memberProfiles.canHelpWith`, `memberProfiles.skills`; consent union `"llm_personalization" | "member_matching"`; SQL view `club.member_matching_source` with the exact columns documented below.

- [ ] **Step 1: Write failing schema tests for new fields and independent consent purposes**

Add these cases to `src/lib/db/schema.integration.test.ts` and import `subscriptions`:

```ts
it("stores the minimal expert fields", async () => {
  const [user] = await db.insert(users).values({
    telegramUserId: BigInt(10002),
    telegramUsername: "expert_user",
    displayName: "Эксперт",
    role: "member",
  }).returning({ id: users.id });

  await db.insert(memberProfiles).values({
    userId: user.id,
    occupation: "Продуктолог",
    industry: "B2B SaaS",
    expertise: "Запустил три корпоративных продукта",
    canHelpWith: "Customer development и go-to-market",
    skills: ["CustDev", "Product strategy"],
  });

  const [profile] = await db.select().from(memberProfiles);
  expect(profile).toMatchObject({
    expertise: "Запустил три корпоративных продукта",
    canHelpWith: "Customer development и go-to-market",
    skills: ["CustDev", "Product strategy"],
  });
});

it("keeps personalization history separate from matching consent", async () => {
  const [user] = await db.insert(users).values({
    telegramUserId: BigInt(10003),
    displayName: "Участник",
    role: "member",
  }).returning({ id: users.id });

  await db.insert(userConsents).values([
    {
      userId: user.id,
      purpose: "llm_personalization",
      policyVersion: "llm-personalization-v1",
    },
    {
      userId: user.id,
      purpose: "member_matching",
      policyVersion: "member-matching-v1",
    },
  ]);

  await expect(db.insert(userConsents).values({
    userId: user.id,
    purpose: "member_matching",
    policyVersion: "member-matching-v1",
  })).rejects.toMatchObject({ cause: { code: "23505" } });
});
```

- [ ] **Step 2: Run the focused integration test and verify the schema is missing**

Run:

```bash
npm run db:up
DATABASE_URL=postgresql://club:club@127.0.0.1:54329/club_test DATABASE_SSL=disable DB_POOL_MAX=2 DB_INTEGRATION_RESET=allow npm run test:integration -- src/lib/db/schema.integration.test.ts
```

Expected: FAIL because `expertise`, `canHelpWith`, `skills`, and the new consent purpose are not in the current Drizzle/PostgreSQL schema.

- [ ] **Step 3: Extend the physical Drizzle schema without deleting rollback columns**

In `src/lib/db/schema.ts`, keep the legacy columns mapped but mark them deprecated, and add the active fields:

```ts
export const memberProfiles = club.table(
  "member_profiles",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    occupation: text("occupation"),
    industry: text("industry"),
    expertise: text("expertise"),
    canHelpWith: text("can_help_with"),
    skills: text("skills").array().notNull().default(sql`'{}'::text[]`),
    /** @deprecated Rollback-only storage; active code must not read or write it. */
    aiExperienceLevel: text("ai_experience_level").$type<
      "beginner" | "tool_user" | "automation_builder" | "ai_system_builder"
    >(),
    /** @deprecated Rollback-only storage. */
    goal90Days: text("goal_90_days"),
    /** @deprecated Rollback-only storage. */
    currentProject: text("current_project"),
    /** @deprecated Rollback-only storage. */
    bottleneck: text("bottleneck"),
    /** @deprecated Rollback-only storage. */
    tools: text("tools").array().notNull().default(sql`'{}'::text[]`),
    /** @deprecated Rollback-only storage. */
    additionalContext: text("additional_context"),
    onboardingCompletedAt: timestamptz("onboarding_completed_at"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    check(
      "member_profiles_ai_experience_check",
      sql`${table.aiExperienceLevel} is null or ${table.aiExperienceLevel} in ('beginner', 'tool_user', 'automation_builder', 'ai_system_builder')`,
    ),
  ],
);
```

Change the consent type and check while retaining old history:

```ts
purpose: text("purpose")
  .$type<"llm_personalization" | "member_matching">()
  .notNull(),
```

```ts
check(
  "user_consents_purpose_check",
  sql`${table.purpose} in ('llm_personalization', 'member_matching')`,
),
```

- [ ] **Step 4: Generate and review the forward migration**

Run:

```bash
DATABASE_URL=postgresql://club:club@127.0.0.1:54329/club_dev DATABASE_SSL=disable npm run db:generate -- --name member_matching_profile
```

Expected: `drizzle/0002_member_matching_profile.sql` adds three columns and widens the consent check; it must not drop any legacy profile column.

Append this exact view definition after the generated table alterations:

```sql
CREATE VIEW "club"."member_matching_source"
WITH (security_barrier = true) AS
SELECT
  u.telegram_user_id,
  u.telegram_username,
  u.display_name,
  p.occupation,
  p.industry,
  p.expertise,
  p.can_help_with,
  p.skills,
  c.policy_version AS consent_policy_version,
  GREATEST(
    u.updated_at,
    p.updated_at,
    c.granted_at,
    COALESCE(s.updated_at, '-infinity'::timestamptz)
  ) AS source_updated_at
FROM club.users AS u
INNER JOIN club.member_profiles AS p ON p.user_id = u.id
INNER JOIN club.user_consents AS c
  ON c.user_id = u.id
 AND c.purpose = 'member_matching'
 AND c.revoked_at IS NULL
LEFT JOIN club.subscriptions AS s
  ON s.user_id = u.id
 AND s.provider = 'nemiling'
WHERE p.onboarding_completed_at IS NOT NULL
  AND NULLIF(BTRIM(u.display_name), '') IS NOT NULL
  AND NULLIF(BTRIM(p.occupation), '') IS NOT NULL
  AND NULLIF(BTRIM(p.industry), '') IS NOT NULL
  AND NULLIF(BTRIM(p.expertise), '') IS NOT NULL
  AND NULLIF(BTRIM(p.can_help_with), '') IS NOT NULL
  AND CARDINALITY(p.skills) > 0
  AND NULLIF(BTRIM(u.telegram_username), '') IS NOT NULL
  AND (
    u.role = 'admin'
    OR (s.active = true AND s.ends_at > now())
  );
```

- [ ] **Step 5: Apply the migration to the disposable test database and rerun the schema tests**

Run the focused command from Step 2 again.

Expected: PASS, and the integration setup applies all three migrations exactly once.

- [ ] **Step 6: Commit the additive database contract**

```bash
git add src/lib/db/schema.ts src/lib/db/schema.integration.test.ts drizzle/0002_member_matching_profile.sql drizzle/meta/0002_snapshot.json drizzle/meta/_journal.json
git commit -m "feat: add member matching profile contract"
```

### Task 2: Replace the active questionnaire model and consent transaction

**Files:**
- Modify: `src/lib/members/profile-schema.ts`
- Modify: `src/lib/members/profile-schema.test.ts`
- Modify: `src/lib/members/repository.ts`
- Modify: `src/lib/members/repository.integration.test.ts`
- Modify: `src/lib/members/actions.ts`
- Modify: `src/lib/members/actions.test.ts`

**Interfaces:**
- Consumes: Task 1 Drizzle fields and matching consent purpose.
- Produces: `MemberProfileInput`, `MemberProfileFormValues`, `parseMemberProfileForm(formData)`, `MemberAccount.profile`, and `saveMemberProfile()` using only the six approved fields plus `consentGranted`.

- [ ] **Step 1: Rewrite the profile-schema tests around the minimal contract**

Use this valid form factory in `src/lib/members/profile-schema.test.ts`:

```ts
function validForm(consentGranted = true) {
  const form = new FormData();
  const values = {
    displayName: "Владилен Минин",
    occupation: "Автор и преподаватель",
    industry: "EdTech",
    expertise: "Создал образовательные продукты и AI-воркфлоу",
    canHelpWith: "Упаковка экспертизы и запуск образовательного продукта",
    skills: "Product strategy, EdTech, Product strategy",
  };
  for (const [key, value] of Object.entries(values)) form.set(key, value);
  if (consentGranted) form.set("consentGranted", "on");
  return form;
}
```

Assert these exact behaviors:

```ts
it("accepts the minimal profile without forcing matching consent", () => {
  expect(parseMemberProfileForm(validForm(false))).toEqual({
    success: true,
    data: {
      displayName: "Владилен Минин",
      occupation: "Автор и преподаватель",
      industry: "EdTech",
      expertise: "Создал образовательные продукты и AI-воркфлоу",
      canHelpWith: "Упаковка экспертизы и запуск образовательного продукта",
      skills: ["Product strategy", "EdTech"],
      consentGranted: false,
    },
  });
});

it.each([
  ["displayName", 80, true],
  ["displayName", 81, false],
  ["occupation", 100, true],
  ["occupation", 101, false],
  ["industry", 100, true],
  ["industry", 101, false],
  ["expertise", 1000, true],
  ["expertise", 1001, false],
  ["canHelpWith", 700, true],
  ["canHelpWith", 701, false],
] as const)("enforces the %s boundary at %i", (field, length, accepted) => {
  const form = validForm();
  form.set(field, "x".repeat(length));
  expect(parseMemberProfileForm(form).success).toBe(accepted);
});

it.each([
  [Array.from({ length: 12 }, (_, index) => `skill-${index}`).join(","), true],
  [Array.from({ length: 13 }, (_, index) => `skill-${index}`).join(","), false],
  ["x".repeat(30), true],
  ["x".repeat(31), false],
])("enforces skill count and item length", (skills, accepted) => {
  const form = validForm();
  form.set("skills", skills);
  expect(parseMemberProfileForm(form).success).toBe(accepted);
});
```

- [ ] **Step 2: Run the focused unit test and verify old fields still drive the parser**

Run:

```bash
npm test -- src/lib/members/profile-schema.test.ts
```

Expected: FAIL because the parser still requires AI experience, goals, project, and bottleneck.

- [ ] **Step 3: Implement the exact profile and form types**

Replace the constants and schema in `src/lib/members/profile-schema.ts` with:

```ts
export const MEMBER_CONSENT_PURPOSE = "member_matching" as const;
export const MEMBER_CONSENT_POLICY_VERSION = "member-matching-v1";

const requiredText = (label: string, max: number) =>
  z.string().trim().min(2, `${label}: минимум 2 символа`).max(
    max,
    `${label}: не более ${max} символов`,
  );

export const memberProfileInputSchema = z.object({
  displayName: requiredText("Имя", 80),
  occupation: requiredText("Профессия", 100),
  industry: requiredText("Сфера", 100),
  expertise: requiredText("Опыт", 1000),
  canHelpWith: requiredText("Запросы", 700),
  skills: z.array(z.string().trim().min(1).max(30)).min(1).max(12),
  consentGranted: z.boolean(),
});

export type MemberProfileInput = z.infer<typeof memberProfileInputSchema>;

export type MemberProfileFormValues = {
  displayName: string;
  occupation: string;
  industry: string;
  expertise: string;
  canHelpWith: string;
  skills: string;
  consentGranted: boolean;
};
```

Change `readMemberProfileFormValues()` to read only those keys, normalize comma-separated skills with NFC, collapsed whitespace, and first-occurrence deduplication, and expose this signature:

```ts
export function parseMemberProfileForm(formData: FormData) {
  const values = readMemberProfileFormValues(formData);
  const skills = [
    ...new Set(
      values.skills
        .split(",")
        .map((skill) => skill.normalize("NFC").replace(/\s+/g, " ").trim())
        .filter(Boolean),
    ),
  ];
  const parsed = memberProfileInputSchema.safeParse({ ...values, skills });
  if (!parsed.success) {
    const flattened = z.flattenError(parsed.error).fieldErrors;
    const fieldErrors = Object.fromEntries(
      Object.entries(flattened).map(([key, messages]) => [key, messages?.[0]]),
    ) as Partial<Record<keyof MemberProfileFormValues, string>>;
    return { success: false as const, values, fieldErrors };
  }
  return { success: true as const, data: parsed.data };
}
```

- [ ] **Step 4: Update the DAL mapping and transactional write**

Change `MemberAccount.profile` in `src/lib/members/repository.ts` to:

```ts
profile: {
  occupation: string | null;
  industry: string | null;
  expertise: string | null;
  canHelpWith: string | null;
  skills: string[];
  onboardingCompletedAt: Date | null;
  updatedAt: Date;
} | null;
```

Map only those fields from `row.profile`. Build the upsert values exactly as:

```ts
const profileValues = {
  occupation: profile.occupation,
  industry: profile.industry,
  expertise: profile.expertise,
  canHelpWith: profile.canHelpWith,
  skills: profile.skills,
  updatedAt: now,
};
```

Keep the existing transaction and consent-versioning algorithm, but because `MEMBER_CONSENT_PURPOSE` is now `member_matching`, it must query, revoke, and insert only matching consent. Historical `llm_personalization` rows must remain untouched.

- [ ] **Step 5: Update both Server Actions without weakening authentication**

In `src/lib/members/actions.ts`, keep `requireCurrentMember()` as the first operation in each action. Change both calls to `parseMemberProfileForm(formData)` and use:

```ts
function valuesFromValidProfile(
  profile: MemberProfileInput,
): MemberProfileFormValues {
  return {
    ...profile,
    skills: profile.skills.join(", "),
  };
}
```

Do not add `userId` or Telegram fields to either action signature. Keep `revalidatePath("/", "layout")` before onboarding redirect, and keep profile/dashboard revalidation for edits.

- [ ] **Step 6: Update repository and action tests**

Replace old test fixtures with:

```ts
const base = {
  displayName: "Карточка участника",
  occupation: "Продуктолог",
  industry: "SaaS",
  expertise: "Запустил B2B-продукт и провёл 50 интервью",
  canHelpWith: "CustDev, product strategy и go-to-market",
  skills: ["CustDev", "Product strategy"],
  consentGranted: true,
};
```

Add an integration assertion that a pre-existing active `llm_personalization` row remains active when `saveMemberProfile()` grants or revokes `member_matching`. Add an action assertion that onboarding succeeds with `consentGranted` absent and still uses `session.userId` instead of an attacker-supplied form field.

- [ ] **Step 7: Run focused unit and integration tests**

Run:

```bash
npm test -- src/lib/members/profile-schema.test.ts src/lib/members/actions.test.ts
DATABASE_URL=postgresql://club:club@127.0.0.1:54329/club_test DATABASE_SSL=disable DB_POOL_MAX=2 DB_INTEGRATION_RESET=allow npm run test:integration -- src/lib/members/repository.integration.test.ts
```

Expected: all focused tests PASS; no assertion mentions removed active fields or mandatory consent.

- [ ] **Step 8: Commit the minimal server-side profile model**

```bash
git add src/lib/members/profile-schema.ts src/lib/members/profile-schema.test.ts src/lib/members/repository.ts src/lib/members/repository.integration.test.ts src/lib/members/actions.ts src/lib/members/actions.test.ts
git commit -m "feat: save minimal expert profiles"
```

### Task 3: Reduce the profile UI to embedding fields and explicit matching consent

**Files:**
- Modify: `src/components/club-cabinet/member-profile-form.tsx`
- Modify: `src/components/club-cabinet/member-profile-form.test.tsx`
- Modify: `src/components/club-cabinet/profile-screen.tsx`
- Modify: `src/components/club-cabinet/screens.test.tsx`
- Modify: `src/app/(club)/(onboarded)/profile/page.test.tsx` (replace any profile fixture with the Task 2 shape)

**Interfaces:**
- Consumes: Task 2 `MemberProfileFormValues` and Server Action signatures.
- Produces: one accessible form containing six expert inputs and one optional matching-consent checkbox; username eligibility notice comes from the trusted cabinet user state.

- [ ] **Step 1: Replace the component test expectations**

Use this form fixture:

```ts
const values: MemberProfileFormValues = {
  displayName: "Владилен Минин",
  occupation: "Автор",
  industry: "EdTech",
  expertise: "Создаю образовательные продукты",
  canHelpWith: "Запуск онлайн-программ",
  skills: "EdTech, Product strategy",
  consentGranted: false,
};
```

Assert the six approved labels are present and the removed labels are absent:

```ts
for (const label of [
  "Как вас называть",
  "Профессия или специализация",
  "Сфера работы",
  "Опыт, сильные стороны и кейсы",
  "С какими запросами можете помочь",
  "Навыки, технологии и инструменты",
]) {
  expect(screen.getByLabelText(label)).toBeInTheDocument();
}
for (const removed of [
  "Опыт работы с AI",
  "Главная цель на ближайшие 90 дней",
  "Текущий проект или задача",
  "Главный барьер или ограничение",
  "Что ещё важно знать о вас",
]) {
  expect(screen.queryByLabelText(removed)).not.toBeInTheDocument();
}
expect(screen.getByRole("checkbox")).not.toBeRequired();
expect(screen.getByText(/публичному упоминанию @username/)).toBeInTheDocument();
```

- [ ] **Step 2: Run the component test and verify the broad form still renders**

Run:

```bash
npm test -- src/components/club-cabinet/member-profile-form.test.tsx
```

Expected: FAIL because old goal/context fields still exist and the new expert fields do not.

- [ ] **Step 3: Implement the minimal accessible form**

Keep the existing `useActionState`, error association, pending state, and failure-value preservation. Render these controls:

```tsx
<Field name="displayName" label="Как вас называть" error={error("displayName")}>
  <input name="displayName" defaultValue={values.displayName} required maxLength={80} />
</Field>
<Field name="occupation" label="Профессия или специализация" error={error("occupation")}>
  <input name="occupation" defaultValue={values.occupation} required maxLength={100} />
</Field>
<Field name="industry" label="Сфера работы" error={error("industry")}>
  <input name="industry" defaultValue={values.industry} required maxLength={100} />
</Field>
<Field name="expertise" label="Опыт, сильные стороны и кейсы" error={error("expertise")} wide>
  <textarea name="expertise" defaultValue={values.expertise} required maxLength={1000} rows={5} />
</Field>
<Field name="canHelpWith" label="С какими запросами можете помочь" error={error("canHelpWith")} wide>
  <textarea name="canHelpWith" defaultValue={values.canHelpWith} required maxLength={700} rows={4} />
</Field>
<Field name="skills" label="Навыки, технологии и инструменты" error={error("skills")} wide>
  <input
    name="skills"
    defaultValue={values.skills}
    required
    placeholder="Product strategy, TypeScript, B2B-продажи"
  />
</Field>
```

Use this optional consent copy and do not set `required`:

```tsx
<label className={styles.consentRow}>
  <input
    type="checkbox"
    name="consentGranted"
    defaultChecked={values.consentGranted}
    aria-invalid={consentError ? true : undefined}
    aria-describedby={
      consentError ? "member-profile-consentGranted-error" : undefined
    }
  />
  <span>
    Разрешаю передавать ответы AI-провайдеру для подбора по #запрос и
    публичному упоминанию @username в чате клуба. Согласие можно отозвать
    здесь в любой момент.
  </span>
</label>
```

- [ ] **Step 4: Show username eligibility without adding a new form field**

In `ProfileScreen`, read the already trusted `user.username`. Directly above `MemberProfileForm`, render this only when it is absent:

```tsx
{!user.username ? (
  <p className={styles.note} role="status">
    Анкета сохранится, но подбор по #запрос включится только после того,
    как вы создадите публичный Telegram username и снова войдёте на сайт.
  </p>
) : null}
```

Do not add a username input or permit manual username editing.

- [ ] **Step 5: Update UI tests for value preservation and missing username**

Change the failure test to edit `expertise` instead of the removed goal field. In `screens.test.tsx`, add one fixture with `user.username = null` and assert the eligibility notice is present, plus one fixture with a username and assert it is absent.

- [ ] **Step 6: Run the focused UI suite**

Run:

```bash
npm test -- src/components/club-cabinet/member-profile-form.test.tsx src/components/club-cabinet/screens.test.tsx src/app/'(club)'/'(onboarded)'/profile/page.test.tsx
```

Expected: PASS with exactly six content fields, optional consent, and no editable Telegram identity.

- [ ] **Step 7: Commit only the profile UI files**

Review `git diff` carefully because these paths overlap the pre-existing WIP. Stage only the intended hunks, then commit:

```bash
git add -p src/components/club-cabinet/member-profile-form.tsx src/components/club-cabinet/member-profile-form.test.tsx src/components/club-cabinet/profile-screen.tsx src/components/club-cabinet/screens.test.tsx src/app/'(club)'/'(onboarded)'/profile/page.test.tsx
git commit -m "feat: reduce participant profile form"
```

### Task 4: Prove view eligibility and install least-privilege reader operations

**Files:**
- Create: `src/lib/members/member-matching-source.integration.test.ts`
- Create: `ops/postgres/bot-reader-grants.sql`
- Create: `ops/postgres/grant-bot-reader-membership.sql`
- Create: `ops/postgres/verify-bot-reader.sql`
- Modify: `docs/integrations/club-bot-database.md`
- Modify: `docs/operations/postgresql.md`

**Interfaces:**
- Consumes: Task 1 view and Task 2 profile/consent transaction.
- Produces: executable eligibility contract and operations for a no-login group role `club_bot_reader`; the bot runtime login gets only schema usage and view select.

- [ ] **Step 1: Write an integration test covering every eligibility transition**

Create this helper to insert a complete profile, optional subscription, and optional consent. Import `db` and `pool` from the database client plus all four schema tables:

```ts
type ExpertOptions = {
  telegramUserId: string;
  username: string | null;
  role?: "member" | "admin";
  consentPurpose?: "llm_personalization" | "member_matching";
  policyVersion?: string;
  active?: boolean;
  endsAt?: Date;
  profile?: Partial<{
    occupation: string;
    industry: string;
    expertise: string;
    canHelpWith: string;
    skills: string[];
  }>;
};

async function insertExpert(options: ExpertOptions) {
  const [user] = await db.insert(users).values({
    telegramUserId: BigInt(options.telegramUserId),
    telegramUsername: options.username,
    displayName: `Участник ${options.telegramUserId}`,
    role: options.role ?? "member",
  }).returning({ id: users.id });
  await db.insert(memberProfiles).values({
    userId: user.id,
    occupation: "Продуктолог",
    industry: "B2B SaaS",
    expertise: "Запускал корпоративные продукты",
    canHelpWith: "Customer development и go-to-market",
    skills: ["CustDev", "Product strategy"],
    onboardingCompletedAt: new Date("2026-08-26T09:00:00.000Z"),
    ...options.profile,
  });
  if (options.consentPurpose) {
    await db.insert(userConsents).values({
      userId: user.id,
      purpose: options.consentPurpose,
      policyVersion: options.policyVersion ?? "member-matching-v1",
    });
  }
  if (options.active !== undefined && options.endsAt) {
    await db.insert(subscriptions).values({
      userId: user.id,
      provider: "nemiling",
      projectId: "7h1w",
      tariffId: 1,
      active: options.active,
      endsAt: options.endsAt,
      lastVerifiedAt: new Date("2026-08-26T09:00:00.000Z"),
    });
  }
  return { userId: user.id };
}
```

Use fixed far-future/far-past dates so `now()` remains deterministic. Query `club.member_matching_source` through `pool.query`:

```ts
const rows = () => pool.query<{
  telegram_user_id: string;
  telegram_username: string;
  consent_policy_version: string;
}>(`
  SELECT telegram_user_id::text, telegram_username, consent_policy_version
  FROM club.member_matching_source
  ORDER BY telegram_user_id
`);

it("exposes only eligible explicitly consented profiles", async () => {
  const eligible = await insertExpert({
    telegramUserId: "20001",
    username: "eligible_user",
    consentPurpose: "member_matching",
    policyVersion: "member-matching-v1",
    role: "member",
    active: true,
    endsAt: new Date("2099-01-01T00:00:00.000Z"),
  });
  await insertExpert({
    telegramUserId: "20002",
    username: "old_consent",
    consentPurpose: "llm_personalization",
    policyVersion: "llm-personalization-v1",
    role: "member",
    active: true,
    endsAt: new Date("2099-01-01T00:00:00.000Z"),
  });

  expect((await rows()).rows).toEqual([
    {
      telegram_user_id: "20001",
      telegram_username: "eligible_user",
      consent_policy_version: "member-matching-v1",
    },
  ]);

  await db.update(userConsents)
    .set({ revokedAt: new Date("2026-08-26T12:00:00.000Z") })
    .where(eq(userConsents.userId, eligible.userId));
  expect((await rows()).rows).toEqual([]);
});
```

Add this table-driven visibility test:

```ts
it.each([
  ["unsupported policy stays visible", {
    telegramUserId: "20003", username: "future_policy", role: "admin",
    consentPurpose: "member_matching", policyVersion: "member-matching-v2",
  }, true],
  ["admin needs no subscription", {
    telegramUserId: "20004", username: "admin_user", role: "admin",
    consentPurpose: "member_matching",
  }, true],
  ["expired member is hidden", {
    telegramUserId: "20005", username: "expired_user",
    consentPurpose: "member_matching", active: true,
    endsAt: new Date("2000-01-01T00:00:00.000Z"),
  }, false],
  ["inactive member is hidden", {
    telegramUserId: "20006", username: "inactive_user",
    consentPurpose: "member_matching", active: false,
    endsAt: new Date("2099-01-01T00:00:00.000Z"),
  }, false],
  ["missing username is hidden", {
    telegramUserId: "20007", username: null, role: "admin",
    consentPurpose: "member_matching",
  }, false],
  ["empty skills are hidden", {
    telegramUserId: "20008", username: "empty_skills", role: "admin",
    consentPurpose: "member_matching", profile: { skills: [] },
  }, false],
  ["incomplete expert field is hidden", {
    telegramUserId: "20009", username: "empty_expertise", role: "admin",
    consentPurpose: "member_matching", profile: { expertise: "" },
  }, false],
] as const)("%s", async (_name, options, visible) => {
  await insertExpert(options);
  expect((await rows()).rows.some(
    (entry) => entry.telegram_user_id === options.telegramUserId,
  )).toBe(visible);
});
```

Add one separate test that reads `source_updated_at`, updates `memberProfiles.expertise` and `updatedAt` to `2026-08-26T12:00:00.000Z`, and asserts the view timestamp changes to that ISO value.

- [ ] **Step 2: Run the new integration test**

Run:

```bash
DATABASE_URL=postgresql://club:club@127.0.0.1:54329/club_test DATABASE_SSL=disable DB_POOL_MAX=2 DB_INTEGRATION_RESET=allow npm run test:integration -- src/lib/members/member-matching-source.integration.test.ts
```

Expected: PASS against the generated migration and real view.

- [ ] **Step 3: Add exact grants for the bot reader role**

Create `ops/postgres/bot-reader-grants.sql`:

```sql
REVOKE ALL ON club.member_matching_source FROM PUBLIC;
GRANT USAGE ON SCHEMA club TO club_bot_reader;
GRANT SELECT ON club.member_matching_source TO club_bot_reader;
REVOKE ALL ON club.users, club.member_profiles, club.user_consents, club.subscriptions
  FROM club_bot_reader;
```

Create `ops/postgres/grant-bot-reader-membership.sql`:

```sql
-- Run as provider administrator with -v bot_runtime_login='provider_bot_login'.
GRANT club_bot_reader TO :"bot_runtime_login";
```

Create `ops/postgres/verify-bot-reader.sql` with these checks:

```sql
SELECT set_config('club.bot_runtime_login', :'bot_runtime_login', false);

DO $$
DECLARE
  bot_role name := current_setting('club.bot_runtime_login');
BEGIN
  IF NOT pg_has_role(bot_role, 'club_bot_reader', 'member') THEN
    RAISE EXCEPTION 'bot runtime login is not a club_bot_reader member';
  END IF;
  IF NOT has_schema_privilege(bot_role, 'club', 'USAGE') THEN
    RAISE EXCEPTION 'bot runtime login lacks club schema usage';
  END IF;
  IF NOT has_table_privilege(bot_role, 'club.member_matching_source', 'SELECT') THEN
    RAISE EXCEPTION 'bot runtime login lacks matching view select';
  END IF;
  IF has_table_privilege(bot_role, 'club.users', 'SELECT')
    OR has_table_privilege(bot_role, 'club.member_profiles', 'SELECT')
    OR has_table_privilege(bot_role, 'club.user_consents', 'SELECT')
    OR has_table_privilege(bot_role, 'club.subscriptions', 'SELECT') THEN
    RAISE EXCEPTION 'bot runtime login must not read club base tables';
  END IF;
END $$;
```

- [ ] **Step 4: Replace the old shared-database document with the exact view contract**

Document all ten view columns, the five eligibility rules, consent version behavior, Telegram BIGINT/string conversion, the no-base-table-grants rule, and the five-minute revocation SLA. State explicitly that the site's migration role creates the view, while the existing bot `DATABASE_URL` login retains ownership of bot tables and receives `club_bot_reader` membership; no new bot environment variable is introduced.

- [ ] **Step 5: Update the PostgreSQL runbook without executing it**

Add this ordered future-production procedure to `docs/operations/postgresql.md`:

```text
1. Provider admin creates NOLOGIN role club_bot_reader once.
2. Site migration login applies Drizzle migration 0002.
3. Site migration login runs bot-reader-grants.sql.
4. Provider admin grants club_bot_reader to the existing bot runtime login.
5. verify-bot-reader.sql passes for the exact bot login.
6. Site runtime release proceeds; bot deployment remains a separate approval.
```

- [ ] **Step 6: Run all site release gates**

Run:

```bash
npm test
DATABASE_URL=postgresql://club:club@127.0.0.1:54329/club_test DATABASE_SSL=disable DB_POOL_MAX=2 DB_INTEGRATION_RESET=allow npm run test:integration
npm run lint
npm run build
git diff --check
```

Expected: every command exits 0. Inspect logs to confirm they contain no questionnaire or consent values.

- [ ] **Step 7: Commit the view contract, grants, and runbook**

```bash
git add src/lib/members/member-matching-source.integration.test.ts ops/postgres/bot-reader-grants.sql ops/postgres/grant-bot-reader-membership.sql ops/postgres/verify-bot-reader.sql docs/integrations/club-bot-database.md docs/operations/postgresql.md
git commit -m "docs: publish bot member source contract"
```

## Site Plan Completion Gate

The site phase is complete only when:

- the active UI and TypeScript model contain exactly six expert fields plus optional consent;
- a saved profile without consent is absent from the view;
- a current explicit matching consent adds an eligible profile to the view;
- revocation, membership expiry, or missing username removes it from the next view read;
- old personalization consent never authorizes matching;
- the bot reader has `SELECT` on the view and no base-table access;
- all unit, integration, lint, build, and whitespace gates pass;
- no site migration or role script has been executed in production.
