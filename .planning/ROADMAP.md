# Roadmap: Telegram-bot "Nezamenimye"

## Milestones

- ✅ **v1.0 MVP — AI Radar Digest** — Phases 1-3 + 03.1 (shipped 2026-04-27) — see [milestones/v1.0-ROADMAP.md](milestones/v1.0-ROADMAP.md)
- 📋 **v2.0 Thread Summaries** — planned (not yet roadmapped — run `/gsd-new-milestone`)

## Phases

<details>
<summary>✅ v1.0 MVP — AI Radar Digest (Phases 1-3 + 03.1) — SHIPPED 2026-04-27</summary>

- [x] Phase 1: Foundation & Bot Shell (2/2 plans) — completed 2026-04-12
- [x] Phase 2: Digest Pipeline (3/3 plans) — completed 2026-04-13
- [x] Phase 3: Delivery & Operations (2/2 plans) — completed 2026-04-14
- [x] Phase 03.1: dev-digest command for repeatable digest testing (1/1 plan, INSERTED) — completed 2026-04-14

Full details: [milestones/v1.0-ROADMAP.md](milestones/v1.0-ROADMAP.md)

</details>

### 📋 v2.0 Thread Summaries (Planned)

Bot becomes a *listening* agent: captures messages from whitelisted forum threads into SQLite, summarises last 24h via LLM at 06:30 MSK, publishes a single consolidated post to a dedicated summary thread. Adds GDPR-compliant `/forget-me` and 90-day retention.

Pre-flight: BotFather privacy mode off, bot promoted to admin, summary topic created, Docker volume added.

Phases (to be roadmapped via `/gsd-new-milestone`):
- [ ] Phase 4: Message Capture & Persistence (SQLite + better-sqlite3 + bot.on('message') handler)
- [ ] Phase 5: Thread Tracking Commands (/track, /untrack, /tracked)
- [ ] Phase 6: Thread Summarizer Service (summarizeThread() with map-reduce)
- [ ] Phase 7: Daily Summary Delivery (06:30 MSK cron, single consolidated post)
- [ ] Phase 8: Operational Commands & Privacy Controls (/summary, /storage, /forget-me, retention sweep)

## Progress

**Execution Order:** Phases execute in numeric order: 1 → 2 → 3 → (03.1) → 4 → 5 → ...

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Foundation & Bot Shell | v1.0 | 2/2 | Complete | 2026-04-12 |
| 2. Digest Pipeline | v1.0 | 3/3 | Complete | 2026-04-13 |
| 3. Delivery & Operations | v1.0 | 2/2 | Complete | 2026-04-14 |
| 03.1. dev-digest (INSERTED) | v1.0 | 1/1 | Complete | 2026-04-14 |
| 4-8. Thread Summaries | v2.0 | 0/N | Planned | - |
