# Roadmap: Telegram-bot "Nezamenimye"

## Overview

Three phases transform an empty repo into a working daily AI digest bot. Phase 1 stands up the bot skeleton with infrastructure (TypeScript, Grammy, Docker, logging, graceful shutdown). Phase 2 builds the core digest pipeline -- RSS fetching and AI filtering that turns 20-40 raw articles into 3-5 curated news items. Phase 3 wires the pipeline to Telegram delivery (cron, formatting, publishing, retry, idempotency) and adds operational commands (/digest, /status).

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [ ] **Phase 1: Foundation & Bot Shell** - Project scaffolding, bot connects to Telegram, /start command, logging, Docker, graceful shutdown
- [ ] **Phase 2: Digest Pipeline** - RSS fetching from 9 feeds + AI filtering produces curated digest object
- [ ] **Phase 3: Delivery & Operations** - Cron-scheduled publishing to Telegram thread, /digest and /status commands, retry, idempotency

## Phase Details

### Phase 1: Foundation & Bot Shell
**Goal**: Bot is deployed in Docker, connects to Telegram via long-polling, responds to /start, logs structured output, and shuts down cleanly
**Depends on**: Nothing (first phase)
**Requirements**: SETUP-01, SETUP-02, SETUP-03, SETUP-04, CMD-01, REL-01, REL-02, REL-03
**Success Criteria** (what must be TRUE):
  1. Running `docker compose up` starts the bot and it connects to Telegram (visible in logs)
  2. Sending /start to the bot returns a welcome message describing AI-radar
  3. Bot logs are structured JSON (pino) with configurable log level via .env
  4. Sending SIGTERM to the container stops the bot gracefully without error logs
  5. Project compiles with strict TypeScript (no `any`, strict: true)
**Plans:** 2 plans

Plans:
- [x] 01-01-PLAN.md — Project scaffolding, TypeScript strict, config with env validation, pino logger, shared types
- [ ] 01-02-PLAN.md — Grammy bot with /start command, graceful shutdown, Docker deployment, stub modules

### Phase 2: Digest Pipeline
**Goal**: The core pipeline fetches RSS feeds and filters articles through LLM to produce a structured digest object ready for publishing
**Depends on**: Phase 1
**Requirements**: RSS-01, RSS-02, RSS-03, RSS-04, RSS-05, AI-01, AI-02, AI-03, AI-04, AI-05, AI-06
**Success Criteria** (what must be TRUE):
  1. Running the pipeline fetches articles from all 9 configured RSS feeds and filters by last 24 hours
  2. AI filter selects 3-5 articles from the raw feed, each tagged with one of 6 categories
  3. Digest respects vc.ru quota: exactly 2 business news items from vc.ru (minimum 1 if insufficient)
  4. If fewer than 3 significant articles found, pipeline returns "skip" signal (no digest produced)
  5. Adding or removing an RSS feed requires only a config change, no code modification
**Plans**: TBD

Plans:
- [ ] 02-01: TBD
- [ ] 02-02: TBD

### Phase 3: Delivery & Operations
**Goal**: Bot autonomously publishes daily digest to the AI-radar thread and provides operational commands for manual control and monitoring
**Depends on**: Phase 2
**Requirements**: DLV-01, DLV-02, DLV-03, DLV-04, DLV-05, CMD-02, CMD-03
**Success Criteria** (what must be TRUE):
  1. At 09:00 MSK daily, bot publishes a formatted HTML digest into the AI-radar thread (with date header, categorized news, footer)
  2. Sending /digest triggers an immediate pipeline run and publishes the result
  3. Sending /status shows bot uptime and the date/result of the last digest
  4. If Telegram API returns an error on publish, bot retries once before logging failure
  5. Running the pipeline twice in the same day does not produce a duplicate message
**Plans**: TBD

Plans:
- [ ] 03-01: TBD
- [ ] 03-02: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 -> 2 -> 3

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Foundation & Bot Shell | 0/2 | Not started | - |
| 2. Digest Pipeline | 0/2 | Not started | - |
| 3. Delivery & Operations | 0/2 | Not started | - |
