# Project Retrospective

*A living document updated after each milestone. Lessons feed forward into future planning.*

## Milestone: v1.0 — MVP — AI Radar Digest

**Shipped:** 2026-04-27
**Phases:** 4 (1, 2, 3, 03.1) | **Plans:** 8 | **Tasks:** 10 | **Commits:** 51 | **Wall-clock dev days:** 2

### What Was Built

- Production-ready Telegram bot on Grammy + strict TypeScript with Docker multi-stage deploy
- Config-driven RSS ingestion for 9 feeds with per-feed error isolation and 24h/48h fallback window
- Dual-provider LLM abstraction (Anthropic SDK + OpenAI SDK) with single `filterArticles()` entry point — actually validated by mid-milestone DeepSeek pivot
- Full delivery loop: cron @ 09:00 MSK → pipeline → HTML formatter → Telegram sender with retry → MSK-day idempotency
- Operational toolkit: `/start`, `/digest` (admin-gated, idempotent), `/status` (no LLM), `/dev-digest` (admin-gated, bypasses idempotency for repeatable testing)
- Threat-model hardening pass: 4 retroactive WR-* fixes (HTML escape inside href, URL regex EOL anchor, integer env validation, admin-cache against DoS)

### What Worked

- **Phase decomposition was right-sized** — 2 dev days for 8 plans / 10 tasks suggests granularity matched human attention. No phase felt too big to hold in head, none felt artificially split.
- **GSD plan-then-execute discipline** — each plan had explicit "truths" and "artifacts" frontmatter; deviations got auto-fixed inline rather than punted (RawArticle interface, safe state parsing, URL validation).
- **Dual-provider abstraction proved its worth in real-time** — when the user needed to test with DeepSeek mid-Phase 3, the only change was `AI_BASE_URL` plumbing through config; ai.service.ts logic untouched. The abstraction wasn't speculative.
- **Pattern library compounded across phases** — `requireEnv()` (Phase 1) → `requireEnvInt()` (WR-03 fix) → reused for all v2.0 ENV vars. Options-object in `runDigestPipeline` (Phase 03.1) → reusable pattern for `summarizeThread` in v2.0.
- **Threat model surfaced real gaps** — WR-01..04 weren't theoretical: angle brackets unescaped in href, URL regex grabbing trailing punctuation, NaN env values, admin-list DoS. All reachable in production.

### What Was Inefficient

- **REQUIREMENTS.md drifted from reality** — phases 2/3/03.1 shipped fully but checkboxes stayed `[ ]` and traceability stayed `Pending`. Required a sync step at milestone close. Root cause: no automated update from SUMMARY.md `requirements-completed:` frontmatter to REQUIREMENTS.md.
- **STATE.md fields never auto-updated** during phases — "Current focus: Phase 01" remained even after Phase 3 completion. CLI `gsd-tools milestone complete` warned about format mismatch.
- **Phase 03.1 inserted with `Goal: [Urgent work - to be planned]` placeholder in ROADMAP.md** — got real plan only after work started. Slightly out of process.
- **`milestone complete` CLI grabbed deviation-headers as "accomplishments"** — like `"1. [Rule 3 - Blocking] Added RawArticle interface to types"`. Required manual rewrite of MILESTONES.md. The CLI looks for first paragraph after "## Accomplishments" but doesn't filter sub-section content.
- **Worktree merge commit (`1a1071f`)** without context in commit message — opaque history.
- **Docker volume not configured from the start** — `data/state.json` survives `restart` but lost on `down`. Caught only at v2.0 planning. Should have been Phase 1 deliverable.

### Patterns Established

- **`requireEnv` / `requireEnvInt` fail-fast at config boundary** — typo in env doesn't reach runtime
- **`bot.catch()` BEFORE command registration** — every Grammy error caught
- **Options-object pattern for service signatures** — `runDigestPipeline({skipIdempotency, persistState})` is backwards-compatible and trivially extensible
- **Per-X try/catch graceful degradation** — one bad RSS feed doesn't kill digest; one bad cron tick doesn't kill bot
- **MSK calendar day comparison via `toLocaleDateString('en-CA', {timeZone: 'Europe/Moscow'})`** — UTC-midnight-safe idempotency
- **Escape-then-transform for Telegram HTML** — escape entire string first, then wrap tags; prevents `<` injection
- **Per-handler `isAdmin` check + 5-min admin-list cache** — DoS-safe and rate-limit-safe pattern for any admin command
- **`devRun: true` marker in pino structured logs** — instantly filterable signal for non-production runs
- **`/dev-X` command pattern** — admin-only mirror of production command that bypasses idempotency without polluting state

### Key Lessons

1. **REQUIREMENTS.md needs an automated sync step from SUMMARY.md frontmatter** — manual checkbox drift hides "what's done". Either tool or convention to update at phase close.
2. **State files belong in volumes from day one** — even MVP has minimum-viable persistence. Free with `volumes:` line in compose, expensive to discover at milestone-2 boundary.
3. **Dev-tool commands (`/dev-digest`) earn their keep fast** — repeatable testing of LLM output without breaking idempotency turned out to be more useful than expected mid-Phase 3.
4. **Threat model fixes deserve plan-level treatment, not just commits** — WR-01..04 fixes are good but their commits don't reference a tracked threat-id list. Hard to verify "all threats mitigated" later.
5. **Provider abstraction validated by real switch, not by spec** — Claude → DeepSeek pivot in 1 commit was the strongest signal that LLM abstraction wasn't over-engineered.
6. **`gsd-tools milestone complete` accomplishment extraction needs a filter** — auto-grab gets noise. For now: rewrite MILESTONES.md by hand after CLI runs.

### Cost Observations

- Model mix: not tracked in v1.0 (no telemetry layer)
- Sessions: ~5 distinct GSD sessions across 2 calendar days
- Notable: zero LLM calls in `/status` (decision validated — admin can poll without burning quota)

---

## Cross-Milestone Trends

### Process Evolution

| Milestone | Phases | Plans | Key Change |
|-----------|--------|-------|------------|
| v1.0 | 4 | 8 | Established baseline GSD flow |

### Cumulative Quality

| Milestone | LOC | TS Strict | Tests | Coverage |
|-----------|-----|-----------|-------|----------|
| v1.0 | 854 | ✓ (no `any`) | 0 | n/a (no test layer yet) |

### Top Lessons (Verified Across Milestones)

*Will populate after v2.0 ships.*

### Open Questions for v2.0

1. Will SQLite + Docker volume actually survive `docker compose down -v`? (volume must be NAMED, not anonymous)
2. Does GDPR `/forget-me` need to also wipe `users` table or only `messages`? Decide at v2.0 Phase 8 planning.
3. Map-reduce summarisation cost — what's actual $/day at typical club traffic? Need observability layer.
