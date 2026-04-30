---
quick_id: 260430-iju
slug: v2-0-grep-vitest-typecheck-summary-md
description: "финальная верификация v2.0: запустить все проверки (grep, vitest, typecheck), создать SUMMARY.md и сделать финальный коммит"
date: 2026-04-30
must_haves:
  truths:
    - "npm run typecheck exits 0 (zero TS errors)"
    - "npx vitest run exits 0 (all 74+ tests pass)"
    - "All Phase 7 worktree branches merged into main"
    - "SUMMARY.md created at .planning/quick/260430-iju-v2-0-grep-vitest-typecheck-summary-md/260430-iju-SUMMARY.md"
    - "STATE.md Quick Tasks Completed table updated"
    - "Final docs commit created"
  artifacts:
    - path: ".planning/quick/260430-iju-v2-0-grep-vitest-typecheck-summary-md/260430-iju-SUMMARY.md"
      provides: "Quick task summary"
    - path: ".planning/STATE.md"
      provides: "Updated with quick task row"
---

# Plan: финальная верификация v2.0

## Context

Phase 7 (v2.0 Closure) was executed in 5 parallel worktree branches but was never merged to `main`. The current state on `main` is:

- `main` HEAD: `64f3771` (plan commit for Phase 7)
- Worktree branches ahead of main: 07-01 (retention sweep), 07-02 (migration v3 + forget-me cleanup), 07-03 (dead code cleanup), 07-04 (REQUIREMENTS.md drift fix), 07-05 (Phase 0-Ops checklist scaffold)

All verifications pass on the worktree branches. This quick task merges the work, runs final checks, and creates the closure commit.

## Tasks

### Task 1: Merge all Phase 7 worktree branches into main

Merge worktree branches in dependency order:
1. `worktree-agent-a77ee37b88a7dd650` — 07-01 retention sweep (feat)
2. `worktree-agent-ab162c39fef9f16e7` — 07-03 dead code cleanup (chore)
3. `worktree-agent-ac8b88c71010a597e` — 07-02 migration v3 + forget-me
4. `worktree-agent-aca3d7fa8475ad956` — 07-04 REQUIREMENTS.md drift fix
5. `worktree-agent-a34be5bd511c91512` — 07-05 Phase 0-Ops checklist scaffold

Unlock worktrees before merging (they are marked locked), use `--force` on worktree remove.

### Task 2: Run all verification checks

- `npm run typecheck` must exit 0
- `npx vitest run` must pass all tests
- Grep checks: verify key patterns in merged code

### Task 3: Create SUMMARY.md and final commit

Create the quick task SUMMARY.md and the final docs commit.
