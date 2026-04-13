---
phase: 02-digest-pipeline
plan: 02
subsystem: ai-service
tags: [ai, llm, claude, openai, prompt, curator]
dependency_graph:
  requires: [config.ts, types/index.ts, logger.ts]
  provides: [filterArticles, curatorPrompt]
  affects: [digest-pipeline]
tech_stack:
  added: ["@anthropic-ai/sdk", "openai"]
  patterns: ["dual-provider LLM abstraction", "external prompt file", "provider auto-detection"]
key_files:
  created:
    - prompts/curator.md
  modified:
    - src/services/ai.service.ts
    - src/types/index.ts
    - package.json
    - package-lock.json
decisions:
  - "Provider detection via model name prefix (claude* vs gpt*/o*)"
  - "Prompt loaded at module level via readFileSync for simplicity"
  - "No retry logic — deferred to Phase 3 per plan"
metrics:
  duration: "2min"
  completed: "2026-04-13T13:18:39Z"
  tasks: 2
  files: 5
---

# Phase 02 Plan 02: AI Service & Curator Prompt Summary

Dual-provider AI service (Claude + OpenAI) with external curator prompt for digest curation pipeline.

## Completed Tasks

| Task | Name | Commit | Key Files |
|------|------|--------|-----------|
| 1 | Create curator prompt file | 1253fcd | prompts/curator.md |
| 2 | Implement AI service with dual-provider support | 5718570 | src/services/ai.service.ts, src/types/index.ts, package.json |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Added RawArticle interface to types**
- **Found during:** Task 2
- **Issue:** Plan 01 (wave 1 parallel) adds RawArticle type but hasn't been merged yet; ai.service.ts imports it
- **Fix:** Added RawArticle interface to src/types/index.ts with fields: title, description, link, source, sourceKey, pubDate
- **Files modified:** src/types/index.ts
- **Commit:** 5718570

## Decisions Made

1. **Provider detection via model prefix** -- `isClaude()` checks if model starts with "claude"; everything else routes to OpenAI. Simple and extensible.
2. **Prompt loaded at module level** -- `readFileSync` at import time, not per-call. Prompt file doesn't change at runtime, avoids repeated I/O.
3. **Error on empty Anthropic response** -- Throws explicit error if first content block is not text type, rather than returning empty string silently.

## Verification Results

- TypeScript compiles with zero errors (`npx tsc --noEmit`)
- prompts/curator.md contains full curator prompt with all required sections
- ai.service.ts exports filterArticles with dual-provider logic
- No `any` types in any modified files
- Both @anthropic-ai/sdk and openai in package.json dependencies

## Self-Check: PASSED
