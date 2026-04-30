---
phase: 07-v2-closure
plan: 04
subsystem: documentation
tags: [docs, requirements, traceability, frontmatter]
dependency_graph:
  requires:
    - ".planning/REQUIREMENTS.md (pre-cleanup state: 57 reqs, stale wording, unchecked Phase 6)"
    - ".planning/STATE.md (stale path reference line 110)"
    - ".planning/phases/06-thread-summary-pipeline/06-0{1,2,3}-SUMMARY.md (missing frontmatter key)"
  provides:
    - ".planning/REQUIREMENTS.md — cleaned v2.0 requirements doc: 39 in-scope, 18 deferred, traceability + coverage rebuilt"
    - ".planning/STATE.md — Phase 0-Ops checklist path fixed to 04-message-capture-persistence/"
    - ".planning/phases/06-thread-summary-pipeline/06-01-SUMMARY.md — requirements_completed: [SUM-01..07, AI-07]"
    - ".planning/phases/06-thread-summary-pipeline/06-02-SUMMARY.md — requirements_completed: [STATE-01/02, SCHED-01..04]"
    - ".planning/phases/06-thread-summary-pipeline/06-03-SUMMARY.md — requirements_completed: [DLV-06..10]"
  affects:
    - "milestone audit tooling (gsd-tools frontmatter validate / audit-milestone v2.0)"
tech_stack:
  added: []
  patterns: []
key_files:
  created: []
  modified:
    - ".planning/REQUIREMENTS.md"
    - ".planning/STATE.md"
    - ".planning/phases/06-thread-summary-pipeline/06-01-SUMMARY.md"
    - ".planning/phases/06-thread-summary-pipeline/06-02-SUMMARY.md"
    - ".planning/phases/06-thread-summary-pipeline/06-03-SUMMARY.md"
decisions:
  - "PRIV-03 flipped to [x] in this plan atomically with Plan 07-01 impl (both wave 1) — per ROADMAP success criterion 4"
  - "18 cancelled/deferred reqs moved to Future Requirements deferred-block with date 2026-04-29, preserving historical traceability"
  - "Traceability table rebuilt to 39 rows (was 57); Coverage by Phase rebuilt to 4 rows (was 5)"
  - "SETUP-09 and STATE.md paths fixed: 04-message-capture/ -> 04-message-capture-persistence/ (W1 fix)"
metrics:
  duration: "~10 minutes"
  completed_date: "2026-04-30"
  tasks_completed: 2
  files_modified: 5
requirements_completed: []
---

# Phase 7 Plan 04: Requirements Drift Fix + Phase 6 SUMMARY Frontmatter Backfill Summary

Doc-only plan closing Success Criteria 4 + 5 of the v2.0 milestone: REQUIREMENTS.md drift fix, Phase 6 SUMMARY.md frontmatter `requirements_completed` backfill, and path-drift fix in STATE.md and REQUIREMENTS.md SETUP-09.

## What Was Done

### Task 1: REQUIREMENTS.md drift fix + STATE.md path fix

**13 changes applied to `.planning/REQUIREMENTS.md`:**

1. **MSG-04 wording fix** — replaced stale `INSERT OR IGNORE` with `ON CONFLICT(chat_id, tg_message_id) DO UPDATE SET text/author_name/edited_at`; cited PITFALLS TG-01 and MSG-02 linkage.
2. **TRK-01..05 section removed** — entire `### Thread Tracking (TRK-*)` section deleted (Phase 5 cancelled).
3. **19 Phase 6 checkboxes flipped `[ ]` → `[x]`** — SUM-01..07 (7), AI-07 (1), DLV-06..10 (5), STATE-01/02 (2), SCHED-01..04 (4).
4. **CMD-04..08 section removed** — entire `### Operational Commands (CMD-*)` section deleted.
5. **Privacy section cleaned** — PRIV-01, PRIV-02, PRIV-05 removed; PRIV-03 flipped to `[x]` (atomic with Plan 07-01 impl, same wave 1); PRIV-04 retained as `[ ]` with explicit Phase 0-Ops reference.
6. **OBS-01..04 section removed** — entire `### Observability (OBS-*)` section deleted.
7. **REL-05 removed** — single bullet deleted from Reliability section; REL-04 `[x]` retained.
8. **Deferred-block added** — `### v2.0 originally-scoped requirements deferred 2026-04-29` block added in Future Requirements, listing all 18 removed IDs with rationale.
9. **Traceability table rebuilt** — 39 rows (was 57): removed TRK-*/CMD-*/OBS-*/PRIV-01/02/05/REL-05 rows; updated PRIV-03 → Phase 7 (v2.0 closure) Complete; updated SETUP-09 → Phase 0-Ops Pending.
10. **Coverage by Phase rebuilt** — 4-row table replacing the 5-row (Phase 0-Ops 2, Phase 4 17, Phase 6 19, Phase 7 v2.0 closure 1); total 39; updated caption with post-cleanup date.
11. **Last updated bumped** — `2026-04-27` → `2026-04-30`.
12. **SETUP-09 path fixed** — `04-message-capture/04-OPS-CHECKLIST.md` → `04-message-capture-persistence/04-OPS-CHECKLIST.md` (W1 fix).
13. **Traceability caption updated** — reflects 39/39 mapping + 36 Complete + 3 Pending breakdown.

**1 change to `.planning/STATE.md`:**

- Line 110 path fixed: `04-message-capture/04-OPS-CHECKLIST.md` → `04-message-capture-persistence/04-OPS-CHECKLIST.md` (W1 fix).

**Before/after coverage totals:**

| Metric | Before | After |
|--------|--------|-------|
| In-scope requirements | 57 | 39 |
| Deferred/historical | 0 (mixed in) | 18 (in deferred block) |
| Pending (genuinely) | 37 | 3 (SETUP-09, PRIV-03*, PRIV-04) |
| Complete | 20 | 36 |
| Phase 5 row in coverage | Yes | Removed |
| Coverage phases | 5 | 4 |

*PRIV-03 flipped to Complete in this plan; code lands in Plan 07-01 within the same wave 1.

### Task 2: Phase 6 SUMMARY frontmatter backfill

`requirements_completed:` YAML key added to each Phase 6 SUMMARY after the `metrics:` block:

| File | Key Added | REQ-IDs (count) |
|------|-----------|-----------------|
| `06-01-SUMMARY.md` | `requirements_completed: [SUM-01, SUM-02, SUM-03, SUM-04, SUM-05, SUM-06, SUM-07, AI-07]` | 8 |
| `06-02-SUMMARY.md` | `requirements_completed: [STATE-01, STATE-02, SCHED-01, SCHED-02, SCHED-03, SCHED-04]` | 6 |
| `06-03-SUMMARY.md` | `requirements_completed: [DLV-06, DLV-07, DLV-08, DLV-09, DLV-10]` | 5 |

Total: 19 IDs distributed across 3 plans, no duplicates, matching Phase 6 `06-VERIFICATION.md` status.

## Verification Results

All acceptance criteria passed:

- `grep -c "^| TRK-0" REQUIREMENTS.md` → 0 (TRK rows removed from traceability)
- `grep -c "ON CONFLICT(chat_id, tg_message_id) DO UPDATE" REQUIREMENTS.md` → 1
- `grep -c "INSERT OR IGNORE" REQUIREMENTS.md` → 1 (only in PITFALLS historical note in MSG-04 wording)
- `grep -cE "^- \[x\] \*\*SUM-0[1-7]" REQUIREMENTS.md` → 7
- `grep -cE "^- \[x\] \*\*AI-07" REQUIREMENTS.md` → 1
- `grep -cE "^- \[x\] \*\*DLV-0[6-9]|^- \[x\] \*\*DLV-10" REQUIREMENTS.md` → 5
- `grep -cE "^- \[x\] \*\*STATE-0[12]" REQUIREMENTS.md` → 2
- `grep -cE "^- \[x\] \*\*SCHED-0[1-4]" REQUIREMENTS.md` → 4
- `grep -cE "^- \[x\] \*\*PRIV-03" REQUIREMENTS.md` → 1 (PRIV-03 flipped)
- `grep -cE "^- \[ \] \*\*PRIV-04\b" REQUIREMENTS.md` → 1 (retained)
- `grep -c "PRIV-04.*Phase 0-Ops" REQUIREMENTS.md` → 4 (section + traceability + coverage + deferred note)
- CMD-04..08, OBS-01..04, PRIV-01/02/05, REL-05 → 0 in main list
- `grep -c "Phase 7 (v2.0 closure)" REQUIREMENTS.md` → 2
- `grep -c "deferred 2026-04-29" REQUIREMENTS.md` → 1
- `grep -c "Last updated:.*2026-04-30" REQUIREMENTS.md` → 1
- `grep -c "04-message-capture-persistence/04-OPS-CHECKLIST.md" REQUIREMENTS.md` → 3
- `grep -c "04-message-capture-persistence/04-OPS-CHECKLIST.md" STATE.md` → 1
- Stale `04-message-capture/04-OPS` paths → 0 in both files
- `requirements_completed:` key count per SUMMARY → 1 each (3 files)

## Deviations from Plan

None — plan executed exactly as written. All 13 REQUIREMENTS.md changes and 1 STATE.md change applied. All three SUMMARY frontmatters backfilled with correct REQ-IDs. No code touched (doc-only plan).

## Known Stubs

None — this is a documentation-only plan. No code stubs exist.

## Threat Flags

None — no new network endpoints, auth paths, file access patterns, or schema changes introduced. All changes are to `.planning/` documentation artifacts.

## Self-Check: PASSED

**Files modified exist on disk:**
- `.planning/REQUIREMENTS.md` — FOUND (rewritten, 39-req table, post-cleanup)
- `.planning/STATE.md` — FOUND (path fixed line 110)
- `.planning/phases/06-thread-summary-pipeline/06-01-SUMMARY.md` — FOUND (requirements_completed: [...AI-07])
- `.planning/phases/06-thread-summary-pipeline/06-02-SUMMARY.md` — FOUND (requirements_completed: [...SCHED-04])
- `.planning/phases/06-thread-summary-pipeline/06-03-SUMMARY.md` — FOUND (requirements_completed: [...DLV-10])

**Commits exist:**
- `54db583` — docs(07-04): fix REQUIREMENTS.md drift + flip Phase 6 + PRIV-03 checkboxes + rebuild traceability
- `b65d59f` — docs(07-04): backfill requirements_completed YAML in Phase 6 SUMMARY frontmatters
