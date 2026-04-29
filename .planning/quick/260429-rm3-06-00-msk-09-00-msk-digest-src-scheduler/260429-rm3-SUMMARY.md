---
id: 260429-rm3
type: quick
date: 2026-04-29
status: complete
---

# Quick Task 260429-rm3 — Summary

## What changed
- `src/scheduler/cron.ts` (header comment block, lines 4–8):
  digest comment `06:00 MSK` → `09:00 MSK`; added one-line note that
  cron expressions are evaluated in container TZ=UTC and MSK times
  reflect the *default* values from `.env.example`.
- `.env.example`: added explicit TZ context for all three cron knobs
  (`DIGEST_CRON`, `THREAD_SUMMARY_CRON`, `RETENTION_SWEEP_CRON`) — each
  has a comment line stating "evaluated in container TZ=UTC" and the
  default rendered to MSK + the equivalent UTC. Cron values themselves
  are byte-identical.

## What did not change
- No code logic, no runtime behavior.
- No cron expressions changed (`0 6 * * *`, `30 3 * * *`, `0 1 * * *`
  preserved).
- No tests added (docs-only).

## Verification
- `grep -n "06:00 MSK" src/scheduler/cron.ts` → empty.
- `grep -n "09:00 MSK" src/scheduler/cron.ts` → digest line present.
- `grep -n "TZ=UTC" .env.example` → 3 hits (one per cron variable).
- All three cron defaults still match values in `src/config.ts` defaults.
