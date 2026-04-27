# Milestones

## v1.0 MVP — AI Radar Digest (Shipped: 2026-04-27)

**Phases completed:** 4 phases (1, 2, 3, 03.1), 8 plans, 10 tasks
**Timeline:** 2026-04-13 → 2026-04-14 (2 dev days, 51 commits)
**Codebase:** 854 LOC TypeScript across 12 source files (8283 insertions in milestone diff)
**Requirements:** 26/26 v1 requirements complete (100%)

### Key accomplishments

- **Bootstrapped infrastructure**: Strict TypeScript + ESM + Grammy bot + pino structured logging + node-cron + Docker multi-stage build with non-root user + graceful SIGTERM/SIGINT shutdown (Phase 1)
- **Built config-driven RSS layer**: 9 feeds in `config/feeds.json` with per-feed error isolation, 24h/48h fallback window, URL validation as T-02-01 mitigation (Phase 2-01)
- **Implemented dual-provider AI service**: Single `filterArticles()` abstraction routes to Anthropic SDK or OpenAI SDK based on model prefix; supports OpenAI-compatible providers like DeepSeek via `AI_BASE_URL`; external curator prompt with 6-category quota and vc.ru rule (Phase 2-02)
- **Wired full delivery pipeline**: HTML formatter with escape-then-transform, `sendMessageWithRetry` with single 3s retry, MSK-day idempotency via `state.json`, cron scheduler with crash isolation (Phase 3-01)
- **Shipped operational commands**: Admin-gated `/digest`, `/status`, `/dev-digest` with 5-minute admin-list cache (DoS mitigation WR-04), `dev-digest` bypasses idempotency without polluting state (Phase 3-02 + 03.1)
- **Hardened against threat model**: 4 retroactive WR-* fixes — HTML escape inside href attributes (WR-01), URL regex anchored to EOL (WR-02), integer env validation at config boundary (WR-03), admin-list cache + non-group skip (WR-04)

### Notable patterns established

- `requireEnv()`/`requireEnvInt()` fail-fast env validation pattern
- `bot.catch()` registered BEFORE command handlers for error isolation
- Idempotency keyed on MSK calendar day via `toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' })` to avoid UTC midnight drift
- Options-object pattern for backwards-compatible service signature evolution (`runDigestPipeline(opts)`)
- Per-feed try/catch graceful degradation (one bad feed doesn't kill the digest)

### Tech stack delivered

- Runtime: Node.js 20 (Alpine), TypeScript 5.x strict
- Telegram: Grammy 1.42 (long-polling)
- Cron: node-cron 4.2
- Logging: pino 10.3 (JSON in prod, pino-pretty in dev)
- LLM: @anthropic-ai/sdk + openai (dual-provider)
- RSS: rss-parser
- Persistence: file-based `data/state.json` (no DB in v1)

### Known v1 limitations / debt rolled into v2 scope

- `data/state.json` not in Docker volume — survives `docker compose restart`, lost on `docker compose down`
- No `bot.on("message")` handler — bot only sees commands, cannot read chat history
- Single hardcoded `aiRadarThreadId` — no dynamic thread discovery
- No persistent storage for messages/users/admin-list (admin cache is in-memory only)

### Archives

- `milestones/v1.0-ROADMAP.md` — full phase details
- `milestones/v1.0-REQUIREMENTS.md` — all 26 requirements with traceability

---
