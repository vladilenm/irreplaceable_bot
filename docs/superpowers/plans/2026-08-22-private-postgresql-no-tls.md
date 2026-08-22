# Private PostgreSQL Without TLS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow Timeweb Managed PostgreSQL connections over RFC1918 private IPv4 without TLS while retaining verified TLS for domains and public IP addresses, then safely integrate and push `main` without deploying production.

**Architecture:** Extend the existing database URL classifier in `src/database-config.ts`; no new configuration surface or dependency is introduced. `readDatabaseConfig` remains the single place deciding whether `pg` receives strict TLS, and release integration remains blocked until Timeweb auto-deploy is confirmed off.

**Tech Stack:** TypeScript, Node.js 22 `node:net`, Vitest, `pg`, Docker, Git.

## Global Constraints

- Production configuration remains exactly seven environment variables.
- TLS is disabled only for loopback and RFC1918 IPv4 addresses.
- Domains, public IPv4 addresses, and all other hosts retain `rejectUnauthorized: true` with the bundled Timeweb CA.
- No Managed PostgreSQL migration, seed, App Platform configuration change, or production deployment is allowed in this task.
- `main` must be pushed without force only after auto-deploy is confirmed off.
- The untracked secret-bearing `.envt` file must never be staged or committed.

---

### Task 1: Classify RFC1918 PostgreSQL hosts

**Files:**
- Modify: `src/config.request-matching.test.ts`
- Modify: `src/database-config.ts`

**Interfaces:**
- Consumes: `readDatabaseConfig(env: NodeJS.ProcessEnv, loadCa?: () => string): DatabaseConfig`.
- Produces: unchanged `DatabaseConfig`; `ssl` is `false` for RFC1918 IPv4 and `true` for domains/public IP.

- [ ] **Step 1: Write the failing private-IP tests**

Add to `describe('readDatabaseConfig')`:

```ts
it.each([
  '10.0.0.1',
  '10.255.255.254',
  '172.16.0.1',
  '172.31.255.254',
  '192.168.0.4',
])('disables TLS for private PostgreSQL host %s without reading the CA', (host) => {
  const loadCa = vi.fn(() => 'timeweb-ca');
  expect(readDatabaseConfig({
    DATABASE_URL: `postgresql://club:secret@${host}:5432/club`,
  }, loadCa)).toMatchObject({ ssl: false });
  expect(loadCa).not.toHaveBeenCalled();
});

it.each([
  '172.15.255.255',
  '172.32.0.1',
  '8.8.8.8',
])('keeps verified TLS for non-private IPv4 host %s', (host) => {
  expect(readDatabaseConfig({
    DATABASE_URL: `postgresql://club:secret@${host}:5432/club`,
  }, () => 'timeweb-ca')).toMatchObject({ ssl: true, caCert: 'timeweb-ca' });
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `npx vitest run src/config.request-matching.test.ts`

Expected: the five RFC1918 cases fail because current code returns `ssl: true` and reads the CA; existing local/domain tests remain green.

- [ ] **Step 3: Implement the minimal classifier**

Modify `src/database-config.ts`:

```ts
import { isIP } from 'node:net';

function isPrivateIpv4(hostname: string): boolean {
  if (isIP(hostname) !== 4) return false;
  const [first, second] = hostname.split('.').map(Number);
  return first === 10 ||
    (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
    (first === 192 && second === 168);
}
```

Change the TLS decision to:

```ts
const ssl = !isLoopbackHost(parsed.hostname) && !isPrivateIpv4(parsed.hostname);
```

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `npx vitest run src/config.request-matching.test.ts`

Expected: all focused tests pass and `loadCa` is never called for private IPs.

- [ ] **Step 5: Commit the behavior change**

```bash
git add src/config.request-matching.test.ts src/database-config.ts
git commit -m "feat: support private PostgreSQL without TLS"
```

### Task 2: Align operations documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/operations.md`

**Interfaces:**
- Consumes: the host classification from Task 1.
- Produces: operator guidance that private RFC1918 URLs are unencrypted and domain/public connections use strict TLS.

- [ ] **Step 1: Update README production variable guidance**

Replace the `DATABASE_URL` description with text stating that RFC1918 private IP connections disable TLS and domains/public IPs use strict TLS with the bundled Timeweb CA.

- [ ] **Step 2: Update the Timeweb production checklist**

Document that App Platform and Managed PostgreSQL must share a private network when using `192.168.0.4`, and that operators should use the private-IP `DATABASE_URL` only inside that network.

- [ ] **Step 3: Verify documentation formatting**

Run: `git diff --check`

Expected: exit code 0 with no whitespace errors.

- [ ] **Step 4: Commit documentation**

```bash
git add README.md docs/operations.md
git commit -m "docs: explain private PostgreSQL transport"
```

### Task 3: Release verification and safe integration

**Files:**
- Verify only: repository and App Platform deployment settings.

**Interfaces:**
- Consumes: committed Tasks 1–2 and the current `refactor` branch.
- Produces: `origin/main` pointing at the verified merge commit without triggering production deployment.

- [ ] **Step 1: Run release verification on `refactor`**

Run:

```bash
npm test
npm run typecheck
npm run build
git diff --check origin/main...refactor
docker build -t club-bot:release-check .
```

Expected: 34 test files and at least 204 tests pass; all other commands exit 0.

- [ ] **Step 2: Confirm App Platform auto-deploy is off**

Inspect the existing Timeweb application deployment settings read-only. Confirm that automatic deployment from the latest `main` commit is disabled. If enabled or indeterminate, stop before push and obtain approval before changing Timeweb settings.

- [ ] **Step 3: Merge locally**

Run:

```bash
git checkout main
git pull --ff-only origin main
git merge --ff-only refactor
```

Expected: local `main` fast-forwards to the verified `refactor` head.

- [ ] **Step 4: Repeat verification on merged `main`**

Run the same commands as Step 1 and confirm all exit 0.

- [ ] **Step 5: Push without force**

Run: `git push origin main`

Expected: `origin/main` fast-forwards to local `main`; no App Platform deployment starts.

- [ ] **Step 6: Verify final state**

Run:

```bash
git status --short --branch
git rev-parse main
git rev-parse origin/main
```

Expected: hashes match. The only allowed untracked path is `.envt`; `.env` remains ignored and no secret file is committed.
