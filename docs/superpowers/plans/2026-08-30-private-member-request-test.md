# Private Member Request Test Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an owner-only `/test_request <query>` command in Telegram DM that runs the production member-matching pipeline and can return one grounded candidate without changing the public `#запрос` minimum of three.

**Architecture:** An optional deployment-specific Telegram user ID enables a focused private-command module. `MemberMatcher` receives typed per-call options with a default minimum of three; the private command overrides it to one while reusing PostgreSQL search, requester exclusion, LLM reranking, evidence validation, and code-owned formatting. Private tests do not write `member_requests` rows because that repository models idempotent forum-topic messages.

**Tech Stack:** Node.js 22, TypeScript 6, grammY 1.42, PostgreSQL 16/pgvector, OpenAI-compatible Timeweb AI Gateway, Vitest 1.6.

## Global Constraints

- `/test_request` responds only in a private chat and only when `ctx.from.id` exactly equals `PRIVATE_TEST_ADMIN_ID`.
- Unauthorized users and non-private chats receive no reply.
- `PRIVATE_TEST_ADMIN_ID` is optional, deployment-specific, and must never be committed with a real value or logged.
- The existing seven production environment variables remain required; the command is disabled when the optional ID is absent.
- The private minimum is exactly one and the public minimum remains exactly three.
- The maximum published match count remains five.
- The requester remains excluded by stable Telegram user ID.
- Query text, profiles, embeddings, prompts, model responses, environment values, and credentials must not enter logs.
- Do not persist private test invocations in `member_requests`.
- Do not push to `origin/main`.
- Deployment is allowed only after `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check` all pass.

---

## File Structure

- Modify `src/types.ts`: add the nullable owner ID to `BotConfig`.
- Modify `src/config.ts`: parse the optional Telegram ID without echoing its value.
- Modify `src/config.request-matching.test.ts`: cover disabled, valid, and invalid configuration.
- Modify `.env.example`: add only the blank optional variable name.
- Modify `src/request.matcher.ts`: add typed per-call requester/minimum options.
- Modify `src/request.matcher.test.ts`: prove default-three and private-one behavior.
- Modify `src/requests.ts` and `src/requests.test.ts`: adapt the public call to the new typed options while retaining the public threshold.
- Create `src/private-request-command.ts`: own authorization and private command lifecycle.
- Create `src/private-request-command.test.ts`: cover authorization, one result, no result, readiness, and safe failure.
- Modify `src/bot.ts` and `src/bot.test.ts`: wire the command only when matching runtime and owner ID are available.
- Modify `README.md`, `docs/architecture.md`, and `docs/operations.md`: document the optional command and release behavior.

---

### Task 1: Optional owner-ID configuration

**Files:**
- Modify: `src/types.ts`
- Modify: `src/config.ts`
- Modify: `src/config.request-matching.test.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces: `BotConfig.privateTestAdminId: number | null`
- Produces: disabled command state when `PRIVATE_TEST_ADMIN_ID` is absent or blank

- [ ] **Step 1: Write failing config tests**

Extend the primary `readConfig` expectation:

```ts
expect(config.privateTestAdminId).toBeNull();

expect(readConfig({
  ...validEnv,
  PRIVATE_TEST_ADMIN_ID: '123456789',
}, () => 'timeweb-ca').privateTestAdminId).toBe(123456789);
```

Add invalid-value coverage without asserting the sensitive value:

```ts
it.each(['0', '-1', 'not-a-number', '9007199254740992'])(
  'rejects an invalid optional private test administrator ID',
  (privateTestAdminId) => {
    expect(() => readConfig({
      ...validEnv,
      PRIVATE_TEST_ADMIN_ID: privateTestAdminId,
    }, () => 'timeweb-ca')).toThrow('PRIVATE_TEST_ADMIN_ID must be a positive safe integer');
  },
);
```

- [ ] **Step 2: Verify the tests fail for the missing config field**

Run: `npx vitest run src/config.request-matching.test.ts`

Expected: FAIL because `BotConfig` and `readConfig` do not expose `privateTestAdminId`.

- [ ] **Step 3: Implement minimal parsing and configuration**

Add to `src/config.ts`:

```ts
function optionalPositiveSafeInteger(
  env: NodeJS.ProcessEnv,
  name: string,
): number | null {
  const raw = env[name]?.trim();
  if (!raw) return null;
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}
```

Add `privateTestAdminId: number | null` to `BotConfig` and set:

```ts
privateTestAdminId: optionalPositiveSafeInteger(env, 'PRIVATE_TEST_ADMIN_ID'),
```

Append only this blank line to `.env.example`:

```text
PRIVATE_TEST_ADMIN_ID=
```

- [ ] **Step 4: Verify focused config tests pass**

Run: `npx vitest run src/config.request-matching.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the configuration slice**

```bash
git add .env.example src/types.ts src/config.ts src/config.request-matching.test.ts
git commit -m "feat: configure private request owner"
```

---

### Task 2: Per-call matcher minimum

**Files:**
- Modify: `src/request.matcher.ts`
- Modify: `src/request.matcher.test.ts`
- Modify: `src/requests.ts`
- Modify: `src/requests.test.ts`

**Interfaces:**
- Produces: `MemberMatchOptions`
- Produces: `MemberMatcher.match(query: string, options?: MemberMatchOptions): Promise<PublicMemberMatch[]>`
- Preserves: public requester exclusion and minimum-three behavior

- [ ] **Step 1: Write failing matcher tests for a one-member shortlist and grounded result**

Add to `src/request.matcher.test.ts`:

```ts
it('allows one grounded result only when minimumMatches is one', async () => {
  const one = shortlist.slice(0, 1);
  const raw = {
    matches: [{ memberId: 'anna', reason: 'Запускала SaaS', evidence: 'B2B SaaS' }],
  };
  const defaultMatcher = matcherFor(raw, one);
  const privateMatcher = matcherFor(raw, one);

  await expect(defaultMatcher.matcher.match('Ищу эксперта')).resolves.toEqual([]);
  expect(defaultMatcher.requestJsonFn).not.toHaveBeenCalled();
  await expect(privateMatcher.matcher.match('Ищу эксперта', {
    minimumMatches: 1,
  })).resolves.toEqual([
    expect.objectContaining({ memberId: 'anna', telegramUsername: 'anna_product' }),
  ]);
});
```

Update the requester assertion to the new API:

```ts
await matcher.match('Ищу эксперта', { requesterTelegramUserId: '1001' });
```

- [ ] **Step 2: Verify matcher tests fail on the missing options API**

Run: `npx vitest run src/request.matcher.test.ts`

Expected: FAIL because `match` still accepts a requester string and hard-codes three.

- [ ] **Step 3: Implement typed matcher options**

Add to `src/request.matcher.ts`:

```ts
export interface MemberMatchOptions {
  requesterTelegramUserId?: string;
  minimumMatches?: 1 | 3;
}
```

Change the method boundary and both threshold gates:

```ts
async match(
  query: string,
  options: MemberMatchOptions = {},
): Promise<PublicMemberMatch[]> {
  const minimumMatches = options.minimumMatches ?? 3;
  // embedding remains unchanged
  const shortlist = await this.deps.members.search(
    vector,
    this.deps.embeddings.model,
    20,
    options.requesterTelegramUserId,
  );
  if (shortlist.length < minimumMatches) return [];
  // schema/evidence validation remains unchanged
  return valid.length >= minimumMatches ? valid.slice(0, 5) : [];
}
```

Adapt the public call in `src/requests.ts`:

```ts
const matches = await options.matcher.match(request.query, {
  requesterTelegramUserId,
});
```

Update existing direct matcher expectations in both test files to use the typed
options object.

- [ ] **Step 4: Verify matcher and public orchestration tests pass**

Run: `npx vitest run src/request.matcher.test.ts src/requests.test.ts`

Expected: PASS, including the existing public fewer-than-three no-match test.

- [ ] **Step 5: Commit the matcher slice**

```bash
git add src/request.matcher.ts src/request.matcher.test.ts src/requests.ts src/requests.test.ts
git commit -m "feat: support private member match minimum"
```

---

### Task 3: Owner-only private Telegram command

**Files:**
- Create: `src/private-request-command.ts`
- Create: `src/private-request-command.test.ts`
- Modify: `src/bot.ts`
- Modify: `src/bot.test.ts`

**Interfaces:**
- Produces: `registerPrivateRequestCommand(bot: Bot, options: PrivateRequestCommandOptions): void`
- Consumes: `MemberMatcher.match`, `formatMemberMatches`, readiness callback, nullable owner ID

- [ ] **Step 1: Write failing private-command tests**

Create a fake `Bot.command` registrar that captures the handler and test these
observable cases in `src/private-request-command.test.ts`:

```ts
it('does not register when the owner ID is absent', () => {
  const { bot, command } = fakeBot();
  registerPrivateRequestCommand(bot, options({ adminUserId: null }));
  expect(command).not.toHaveBeenCalled();
});

it('silently ignores another user and non-private chat', async () => {
  const { handler, matcher, reply } = registeredCommand();
  await handler(context({ fromId: 202, chatType: 'private', match: 'query' }));
  await handler(context({ fromId: 101, chatType: 'supergroup', match: 'query' }));
  expect(reply).not.toHaveBeenCalled();
  expect(matcher.match).not.toHaveBeenCalled();
});

it('edits the status message with one grounded match', async () => {
  const oneMatch = [{
    memberId: 'anna', displayName: 'Анна', telegramUsername: 'anna_product',
    reason: 'Запускала B2B SaaS', similarity: 1,
  }];
  const { handler, matcher, reply, editMessageText } = registeredCommand({ oneMatch });
  await handler(context({ fromId: 101, chatType: 'private', match: 'Ищу B2B SaaS' }));
  expect(reply).toHaveBeenCalledWith('⏳ Ищу подходящих участников…');
  expect(matcher.match).toHaveBeenCalledWith('Ищу B2B SaaS', {
    requesterTelegramUserId: '101',
    minimumMatches: 1,
  });
  expect(editMessageText).toHaveBeenCalledWith(
    101,
    88,
    expect.stringContaining('@anna_product'),
    { parse_mode: 'HTML' },
  );
});
```

Also cover empty usage, no results, not-ready state, matcher rejection, safe logging,
and the absence of the query string from logged metadata.

- [ ] **Step 2: Verify the new test file fails because the module is absent**

Run: `npx vitest run src/private-request-command.test.ts`

Expected: FAIL because `private-request-command.ts` does not exist.

- [ ] **Step 3: Implement the focused command module**

Create `src/private-request-command.ts` with this boundary:

```ts
import type { Bot } from 'grammy';
import { logger } from './logger.js';
import type { MemberMatcher } from './request.matcher.js';
import { formatMemberMatches } from './requests.js';

export interface PrivateRequestCommandOptions {
  adminUserId: number | null;
  matcher: Pick<MemberMatcher, 'match'>;
  isMatchingReady?: () => Promise<boolean>;
}

export function registerPrivateRequestCommand(
  bot: Bot,
  options: PrivateRequestCommandOptions,
): void {
  if (options.adminUserId === null) return;
  bot.command('test_request', async (ctx) => {
    if (ctx.chat.type !== 'private' || ctx.from?.id !== options.adminUserId) return;
    const query = ctx.match.trim();
    if (!query) {
      await ctx.reply('Использование: /test_request <текст запроса>');
      return;
    }
    const status = await ctx.reply('⏳ Ищу подходящих участников…');
    try {
      if (options.isMatchingReady && !(await options.isMatchingReady())) {
        throw new Error('Member source is not ready');
      }
      const matches = await options.matcher.match(query, {
        requesterTelegramUserId: String(ctx.from.id),
        minimumMatches: 1,
      });
      const text = matches.length === 0
        ? 'Надёжных совпадений не найдено.'
        : formatMemberMatches(matches.slice(0, 5));
      await ctx.api.editMessageText(
        status.chat.id,
        status.message_id,
        text,
        { parse_mode: 'HTML' },
      );
    } catch (error: unknown) {
      logger.error({
        command: 'test_request',
        errorClass: error instanceof Error ? error.name : 'unknown',
      }, 'Private member request failed');
      await ctx.api.editMessageText(
        status.chat.id,
        status.message_id,
        'Подбор участников временно недоступен. Попробуйте позже.',
      ).catch((editError: unknown) => {
        logger.error({
          command: 'test_request',
          operation: 'edit',
          errorClass: editError instanceof Error ? editError.name : 'unknown',
        }, 'Private member request status edit failed');
      });
    }
  });
}
```

- [ ] **Step 4: Wire the module in `createBot`**

Import `registerPrivateRequestCommand` and, before generic request/capture handlers,
add:

```ts
if (options.requestMatching && config.privateTestAdminId !== null) {
  registerPrivateRequestCommand(bot, {
    adminUserId: config.privateTestAdminId,
    matcher: options.requestMatching.matcher,
    isMatchingReady: options.requestMatching.handlerOptions.isMatchingReady,
  });
}
```

In `src/bot.test.ts`, mock the registrar alongside the existing request/capture
registrars and assert no registration under the default null test config. Direct
command behavior remains covered by the focused module tests.

- [ ] **Step 5: Verify focused command, bot, matcher, and request tests pass**

Run: `npx vitest run src/private-request-command.test.ts src/bot.test.ts src/request.matcher.test.ts src/requests.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the command slice**

```bash
git add src/private-request-command.ts src/private-request-command.test.ts src/bot.ts src/bot.test.ts
git commit -m "feat: add private member request command"
```

---

### Task 4: Documentation and full release gate

**Files:**
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/operations.md`

**Interfaces:**
- Documents: optional configuration, strict DM authorization, threshold isolation, and manual smoke test

- [ ] **Step 1: Update user and operator documentation**

Document all of the following exact facts:

- `PRIVATE_TEST_ADMIN_ID` is optional and deployment-specific.
- `/test_request <text>` works only in DM for the exact configured ID.
- The private minimum is one; public `#запрос` remains three.
- The requester is excluded by Telegram ID.
- The command exercises the real PostgreSQL/pgvector and LLM pipeline but does not
  create `member_requests` rows.
- The ID value is never committed or logged.

- [ ] **Step 2: Run focused verification**

Run:

```bash
npx vitest run src/config.request-matching.test.ts src/request.matcher.test.ts src/requests.test.ts src/private-request-command.test.ts src/bot.test.ts
```

Expected: PASS with zero failures.

- [ ] **Step 3: Run the complete release gate**

Run each command independently and inspect its exit code:

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

Expected: all commands exit 0 with no test failures, type errors, build errors, or whitespace errors.

- [ ] **Step 4: Commit documentation after the gate**

```bash
git add README.md docs/architecture.md docs/operations.md
git commit -m "docs: operate private member request tests"
```

---

### Task 5: Production release without updating `origin/main`

**Files:**
- No source files
- External state: one non-main remote branch, Timeweb app configuration, Timeweb deployment

**Interfaces:**
- Produces: remote branch `codex/private-test-request`
- Preserves: `origin/main` commit exactly unchanged
- Produces: production environment with `PRIVATE_TEST_ADMIN_ID` set as a protected value

- [ ] **Step 1: Re-run the full release gate on the exact release commit**

Run:

```bash
git status --short --branch
npm test
npm run typecheck
npm run build
git diff --check
```

Expected: clean working tree and all checks exit 0.

- [ ] **Step 2: Record the remote-main baseline without changing it**

Run:

```bash
git ls-remote --heads origin main
git rev-parse HEAD
```

Record only commit IDs; do not inspect or print environment values.

- [ ] **Step 3: Push the verified commit only to the non-main release branch**

Run:

```bash
git push origin HEAD:refs/heads/codex/private-test-request
```

Expected: `codex/private-test-request` points at the verified local release commit;
`origin/main` is untouched.

- [ ] **Step 4: Configure and deploy through Timeweb**

Using the authenticated Timeweb App Platform UI:

1. Select the existing bot application; do not create paid resources.
2. Set the source branch to `codex/private-test-request`.
3. Add/update protected `PRIVATE_TEST_ADMIN_ID` from the value supplied directly by
   the owner; never copy it into a tracked file or logs.
4. Keep all seven required variables and other existing settings unchanged.
5. Trigger one deployment and observe build/runtime logs.

Expected runtime sequence:

```text
PostgreSQL migrations complete
Starting bot...
Bot is running (long-polling mode)
Scheduler started
Initial member source sync attempt finished
```

`No HTTP ports discovered` remains expected for this worker.

- [ ] **Step 5: Verify production and the no-main-push invariant**

Confirm in Timeweb that the deployed revision equals the release-branch HEAD and the
container remains healthy with a single polling instance. Then run:

```bash
git ls-remote --heads origin main codex/private-test-request
```

Expected: remote `main` still equals the recorded baseline; the release branch equals
the verified commit. Do not seed, deactivate mocks, rotate credentials, or change
other Timeweb resources during this release.
