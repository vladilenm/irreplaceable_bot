---
phase: 07-v2-closure
plan: "05"
subsystem: ops-checklist
tags: [ops, gdpr, checklist, manual, e2e, runbook]
requirements_completed: []
dependency_graph:
  requires: []
  provides:
    - ".planning/phases/04-message-capture-persistence/04-OPS-CHECKLIST.md (Phase 0-Ops manual gate artifact)"
  affects:
    - "SETUP-09 (closure pending operator fill)"
    - "PRIV-04 (closure pending operator fill)"
tech_stack:
  added: []
  patterns: []
key_files:
  created:
    - ".planning/phases/04-message-capture-persistence/04-OPS-CHECKLIST.md"
  modified: []
decisions:
  - "Scaffold-only autonomous execution: Claude creates markdown structure; operator fills evidence post-deploy"
  - "requirements_completed: [] — SETUP-09 + PRIV-04 close only after operator works through checklist on live VPS"
  - "/forget-me runbook contains both post-Plan-07-02 (messages-only DELETE) and pre-Plan-07-02 transitional (forgotten_users INSERT + messages DELETE) paths"
metrics:
  duration: "4 min"
  completed: "2026-04-30"
  tasks_completed: 1
  tasks_total: 1
  files_created: 1
  files_modified: 0
---

# Phase 07 Plan 05: Phase 0-Ops Manual Pre-Flight Checklist Scaffold Summary

**One-liner:** Scaffold 04-OPS-CHECKLIST.md with six sections, 10 E2E test rows, and copy-paste /forget-me SQL runbook for operator-fill post-deploy.

## What Was Built

Created `.planning/phases/04-message-capture-persistence/04-OPS-CHECKLIST.md` — the manual gate artifact that closes SETUP-09 + PRIV-04 of milestone v2.0. The file is scaffold-only; field-fill (privacy-mode log evidence, screenshot URLs, E2E test results) is operator-managed and cannot be automated (requires live Telegram + production deployment).

**Artifact structure:**

| Section | Content | Markers |
|---------|---------|---------|
| 1. Privacy Mode | BotFather privacy-off procedure + `can_read_all_group_messages` log evidence placeholder | 2 OPERATOR FILLS |
| 2. Topic ID Capture | «🧵 Сводки тредов» creation steps + `THREAD_SUMMARY_THREAD_ID` placeholder | 3 OPERATOR FILLS |
| 3. Volume Permissions | `chown 1001`, `docker compose exec bot id`, write test, restart-persistence test | 4 OPERATOR FILLS |
| 4. GDPR Consent (PRIV-04) | Announcement template (GDPR Art. 13) + URL/screenshot/date/pin evidence | 4 OPERATOR FILLS |
| 5. Live E2E Tests | 7 Phase 4 rows (P4-E1..7) + 3 Phase 6 rows (P6-E1..3) + aggregate summary | 11 OPERATOR FILLS |
| 6. /forget-me Runbook | GDPR Art. 17 manual erasure SQL + audit log table | 3 OPERATOR FILLS |

**Total:** 27 `OPERATOR FILLS` markers, 10 E2E test rows, YAML frontmatter with `status: pending` + `requirements_to_close: [SETUP-09, PRIV-04]`.

## Task Commits

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Scaffold 04-OPS-CHECKLIST.md | 7b0d770 | `.planning/phases/04-message-capture-persistence/04-OPS-CHECKLIST.md` |

## Decisions Made

1. **Scaffold-only autonomous execution.** Task 1 (markdown scaffold creation) is fully autonomous. Field-fill (evidence from real Telegram + VPS + docker logs) is operator-managed — this cannot be automated and is explicitly out of scope for this autonomous executor run.

2. **requirements_completed: [].** SETUP-09 + PRIV-04 cannot be closed in this run. Closure happens post-deploy when operator fills all six sections with real evidence and flips frontmatter `status: pending → complete`.

3. **/forget-me runbook contains two paths.** Post-Plan-07-02 path (messages-only DELETE — `forgotten_users` table removed in Migration v3) is the default. Pre-Plan-07-02 transitional path (INSERT into `forgotten_users` + DELETE from `messages`) is retained as fallback with clear version note.

4. **YAML frontmatter uses `---` wrapper (B4 fix).** Body section dividers may use `***` or `---`; only the two YAML block delimiters at file start MUST be `---`. Verified with awk extraction: 13 YAML lines between first two `---` markers.

## Deviations from Plan

None — plan executed exactly as written. The scaffold content was taken verbatim from the plan's `<action>` block with date `2026-04-30` substituted for `{plan-author-date}`.

## Operator Execution Log

After production deployment, the operator fills this checklist section-by-section:

- [ ] Section 1 (Privacy Mode) complete — date, evidence link
- [ ] Section 2 (Topic ID) complete — date, evidence link
- [ ] Section 3 (Volume) complete — date, evidence link
- [ ] Section 4 (GDPR Consent) complete — date, evidence link
- [ ] Section 5 (Live E2E) complete — date, PASS/FAIL counts
- [ ] Section 6 (/forget-me Runbook) — first request processed (or 30-day no-request marker)

Once all six are checked, operator updates SETUP-09 + PRIV-04 in REQUIREMENTS.md to `[x]` (a separate small commit; not part of this milestone close).

## Known Stubs

None — this plan produces a documentation scaffold, not code. All `OPERATOR FILLS` markers are intentional placeholders awaiting post-deploy evidence; they do not block any code functionality.

## Threat Flags

No new network endpoints, auth paths, or trust boundary surface introduced. Plan creates a planning artifact only (`.planning/` directory, not tracked in production container).

## Self-Check: PASSED

| Check | Result |
|-------|--------|
| `.planning/phases/04-message-capture-persistence/04-OPS-CHECKLIST.md` exists | FOUND |
| Commit `7b0d770` exists | FOUND |
