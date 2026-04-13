---
phase: 02-digest-pipeline
verified: 2026-04-13T15:00:00Z
status: human_needed
score: 10/11 must-haves verified
overrides_applied: 0
human_verification:
  - test: "Run pipeline end-to-end with real AI_API_KEY"
    expected: "runDigestPipeline() returns DigestResult with itemCount 3-5 and non-empty text"
    why_human: "Cannot call live RSS + LLM API in automated check; requires real credentials and network"
---

# Phase 2: Digest Pipeline Verification Report

**Phase Goal:** RSS fetching from 9 feeds + AI filtering produces curated digest object
**Verified:** 2026-04-13T15:00:00Z
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths (from ROADMAP success criteria and plan must-haves)

| #  | Truth | Status | Evidence |
|----|-------|--------|----------|
| SC1 | Running the pipeline fetches articles from all 9 configured RSS feeds and filters by last 24 hours | VERIFIED | `fetchFeeds(hoursBack=24)` iterates all 9 feeds in feeds.json; pubDate cutoff applied; TypeScript compiles cleanly |
| SC2 | AI filter selects 3-5 articles from the raw feed, each tagged with one of 6 categories | PARTIAL | `filterArticles()` sends articles to LLM; curator prompt instructs 3-5 selection and 6 categories; actual enforcement is LLM-side; cannot verify without live call |
| SC3 | Digest respects vc.ru quota: exactly 2 business news items from vc.ru (minimum 1 if insufficient) | PARTIAL | vc.ru quota is in the curator prompt (verified present); enforcement is purely LLM-side; no code-level validation of vc.ru count |
| SC4 | If fewer than 3 significant articles found, pipeline returns "skip" signal | VERIFIED | `countDigestItems()` counts `→ https?://` pattern; `skipped = itemCount < 3` on line 82; DigestResult.skipped returned |
| SC5 | Adding or removing an RSS feed requires only a config change, no code modification | VERIFIED | feeds.json loaded via readFileSync at module init; 9 feeds in config; zero hardcoded feed refs in rss.service.ts |
| T1-P1 | Feed list lives in config/feeds.json, adding/removing a feed requires only editing that file | VERIFIED | rss.service.ts line 6-8: loads feeds.json via import.meta.url; no feed URLs in code |
| T2-P1 | RSS service fetches all 9 feeds and returns articles filtered by pubDate within a time window | VERIFIED | loop over `feeds` array (9 entries); cutoff = Date.now() - hoursBack * 3600000; articles below cutoff skipped |
| T3-P1 | Each article has title, description, link, source name, and pubDate | VERIFIED | RawArticle interface defines all 5 fields; mapping on lines 45-52 populates all fields |
| T4-P1 | If a feed errors, it is skipped with a log warning and remaining feeds continue | VERIFIED | try/catch per feed on lines 31-58; logger.warn on failure; loop continues |
| T5-P1 | Service accepts a hoursBack parameter to support 24h and 48h windows | VERIFIED | `fetchFeeds(hoursBack: number = 24)` — default 24, accepts any number; digest.service.ts passes 48 when lastSkipped |
| T1-P2 | AI curator prompt is stored in prompts/curator.md, editable without code changes | VERIFIED | prompts/curator.md exists with full prompt; ai.service.ts loads it via readFileSync at module level |
| T2-P2 | ai.service.ts supports both Claude and OpenAI, switching via AI_MODEL env var | VERIFIED | `isClaude(config.aiModel)` branch: Anthropic SDK for claude-*, OpenAI SDK otherwise; config.aiModel from env |
| T3-P2 | filterArticles() accepts articles array and system prompt, returns LLM-generated text | VERIFIED | signature `filterArticles(articles: RawArticle[]): Promise<string>`; prompt read internally; returns string |
| T4-P2 | LLM output is ready-made Telegram post text, not structured JSON | VERIFIED | filterArticles returns raw string from LLM; no JSON parsing attempted |
| T1-P3 | runDigestPipeline() orchestrates fetch -> filter -> return in a single call | VERIFIED | digest.service.ts lines 58-99: readState -> fetchFeeds -> filterArticles -> countDigestItems -> writeState -> return |
| T2-P3 | Pipeline returns { text, itemCount, skipped, date } matching DigestResult type | VERIFIED | DigestResult interface defined lines 8-13; returned on line 98 with all fields |
| T3-P3 | If fewer than 3 items found by LLM, pipeline returns skipped: true | VERIFIED | `const skipped = itemCount < 3` line 82; returned in DigestResult |
| T4-P3 | Pipeline reads lastDigestDate from data/state.json and expands to 48h if previous was skipped | VERIFIED | readState() lines 22-44; `hoursBack = state.lastSkipped ? 48 : 24` line 60 |
| T5-P3 | vc.ru quota enforced by curator prompt (AI-04) and validated by itemCount parsing | PARTIAL | Prompt contains КВОТА ПО ИСТОЧНИКАМ section for vc.ru; itemCount counts total items but does not separately count vc.ru items; enforcement is LLM-side only |
| T6-P3 | Pipeline writes updated state to data/state.json after each run | VERIFIED | writeState() called on line 71 (no articles path) and line 93-96 (normal path) |

**Score:** 10/11 truths fully verified (2 are LLM-dependent behavior verified structurally, 1 flagged as human-needed)

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `config/feeds.json` | Array of 9 feed configs with url, name, sourceKey | VERIFIED | 9 entries confirmed; all 9 source domains present |
| `src/services/rss.service.ts` | fetchFeeds function returning RawArticle[] | VERIFIED | Exports `fetchFeeds`, full implementation, no stubs |
| `src/types/index.ts` | FeedConfig and RawArticle type definitions | VERIFIED | Both interfaces exported; all required fields present |
| `prompts/curator.md` | System prompt for AI curator | VERIFIED | 63-line prompt with РОЛЬ, АУДИТОРИЯ, ЗАДАЧА, КАТЕГОРИИ, КВОТА, ФОРМАТ, ТОНАЛЬНОСТЬ |
| `src/services/ai.service.ts` | filterArticles with dual-provider support | VERIFIED | Claude and OpenAI branches; curatorPrompt loaded; returns string |
| `src/modules/digest/digest.service.ts` | runDigestPipeline orchestrator function | VERIFIED | Exports runDigestPipeline and DigestResult; full implementation |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| rss.service.ts | config/feeds.json | import.meta.url + readFileSync | WIRED | Line 7: `new URL('../../config/feeds.json', import.meta.url)` |
| rss.service.ts | rss-parser | npm import | WIRED | Line 2: `import RssParser from 'rss-parser'`; in package.json deps |
| ai.service.ts | @anthropic-ai/sdk | npm import | WIRED | Line 1: `import Anthropic from '@anthropic-ai/sdk'`; in package.json |
| ai.service.ts | openai | npm import | WIRED | Line 2: `import OpenAI from 'openai'`; in package.json |
| ai.service.ts | src/config.ts | config.aiModel, config.aiApiKey | WIRED | Lines 34-35 (Claude path), line 49 (OpenAI path) |
| ai.service.ts | prompts/curator.md | readFileSync + import.meta.url | WIRED | Lines 8-11: `new URL('../../prompts/curator.md', import.meta.url)` |
| digest.service.ts | rss.service.ts | fetchFeeds import | WIRED | Line 4: `import { fetchFeeds } from '../../services/rss.service.js'`; called line 67 |
| digest.service.ts | ai.service.ts | filterArticles import | WIRED | Line 5: `import { filterArticles } from '../../services/ai.service.js'`; called line 80 |
| digest.service.ts | data/state.json | readFileSync/writeFileSync | WIRED | STATE_PATH line 20; readState/writeState functions |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|--------------|--------|--------------------|--------|
| digest.service.ts | articles | fetchFeeds(hoursBack) -> rss-parser.parseURL | Real HTTP RSS fetch | FLOWING (structurally; live network not tested) |
| digest.service.ts | text | filterArticles(articles) -> LLM SDK call | Live LLM API | FLOWING (structurally; live API not tested) |
| digest.service.ts | itemCount | countDigestItems(text) -> regex on LLM text | Derived from LLM output | FLOWING — regex `→ https?://` match count |
| digest.service.ts | state | readState() -> readFileSync(state.json) | File system or defaults | FLOWING — graceful fallback to defaults when missing |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| TypeScript compiles with zero errors | `cd project && npx tsc --noEmit` | Exit code 0, no output | PASS |
| feeds.json contains exactly 9 feeds | `node -e "console.log(require('./config/feeds.json').length)"` | 9 | PASS |
| No `any` types in service files | `grep -r ": any" src/services src/modules` | No matches | PASS |
| countDigestItems regex works | `node -e "text.match(/→ https?:\/\//g)"` | Counts 2 in 2-link test string | PASS |
| All deps present in package.json | grep for rss-parser, @anthropic-ai/sdk, openai | All 3 found | PASS |
| .gitignore excludes data/ | grep "^data/" .gitignore | Found | PASS |
| .gitkeep removed from digest module | ls src/modules/digest/ | Only digest.service.ts present | PASS |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| RSS-01 | 02-01 | Parser fetches 9 RSS feeds | SATISFIED | feeds.json has 9 entries; fetchFeeds iterates all; rss-parser parses each |
| RSS-02 | 02-01 | Article filtering by pubDate within last 24 hours | SATISFIED | cutoff = Date.now() - 24h; items with pubDate < cutoff skipped |
| RSS-03 | 02-01, 02-03 | Fallback: if < 3 articles, expand to 48 hours | SATISFIED | `hoursBack = state.lastSkipped ? 48 : 24`; 48h window passed to fetchFeeds |
| RSS-04 | 02-01 | Feed list configurable without code changes | SATISFIED | feeds.json is sole source; no feed URLs hardcoded in service |
| RSS-05 | 02-01 | Output JSON array with title, description, link, source, pubDate | SATISFIED | RawArticle interface and mapping in rss.service.ts |
| AI-01 | 02-02 | ai.service.ts supports Claude and OpenAI, switching via AI_MODEL | SATISFIED | isClaude() branch; Anthropic SDK and OpenAI SDK both wired |
| AI-02 | 02-02 | System prompt with selection criteria tuned to club context | SATISFIED | prompts/curator.md with КРИТЕРИИ ОТБОРА, АНТИКРИТЕРИИ, club context in РОЛЬ |
| AI-03 | 02-03 | Selection of 3-5 news items from input array | NEEDS HUMAN | Prompt instructs 3-5; itemCount measures output; actual selection is LLM behavior — requires live run |
| AI-04 | 02-02, 02-03 | Quota: exactly 2 news items from vc.ru per digest | NEEDS HUMAN | Prompt contains vc.ru quota; no code-level enforcement or per-source counting; LLM-side behavior |
| AI-05 | 02-02 | Each news item tagged with one of 6 categories | NEEDS HUMAN | 6 categories defined in prompt with emoji; actual tagging is LLM behavior |
| AI-06 | 02-03 | Fallback: if < 3 significant items, digest not published | SATISFIED | `skipped = itemCount < 3`; DigestResult.skipped returned; Phase 3 will gate publishing on this |

### Anti-Patterns Found

| File | Pattern | Severity | Impact |
|------|---------|----------|--------|
| None | — | — | No stubs, TODOs, hardcoded empty arrays, or placeholder returns found in any phase 2 file |

### Human Verification Required

#### 1. End-to-End Pipeline Run

**Test:** Set AI_API_KEY, BOT_TOKEN, and other required env vars. Run:
```
node -e "import('./src/modules/digest/digest.service.js').then(m => m.runDigestPipeline()).then(r => console.log(r))"
```
**Expected:** DigestResult with non-empty `text` (formatted Telegram post in Russian), `itemCount` between 3 and 5, `skipped: false`
**Why human:** Requires live RSS fetches (network) and live LLM API call (AI_API_KEY credential)

#### 2. vc.ru Quota Verification (AI-04)

**Test:** Inspect the `text` field from a live pipeline run. Count news items sourced from vc.ru.
**Expected:** Exactly 2 vc.ru items in the digest (or 1 if vc.ru had no worthy content that day)
**Why human:** Quota is enforced by LLM prompt only; no code-level mechanism to verify without a real output

#### 3. Category Tagging Verification (AI-05, AI-03)

**Test:** Inspect the `text` field from a live pipeline run. Verify each item has one of the 6 category emojis (🤖 🔗 🧠 🛠 ⚡ 💰) and item count is 3-5.
**Expected:** 3-5 items, each prefixed with exactly one of the 6 category emojis
**Why human:** LLM behavior; format compliance requires reading actual output

#### 4. 48h Fallback Trigger

**Test:** Manually set `data/state.json` to `{ "lastDigestDate": "...", "lastSkipped": true }`, then run `runDigestPipeline()`. Check logs for "hoursBack: 48".
**Expected:** Pipeline logs show `hoursBack: 48`; fetches from extended window
**Why human:** State persistence path requires file system interaction and log inspection

### Gaps Summary

No hard blockers found. All artifacts exist, are substantive, and are wired. TypeScript compiles clean. The 3 human-needed items (AI-03, AI-04, AI-05) are LLM-side behaviors that cannot be verified without live API calls — they are structurally supported by the code but require a real pipeline run to confirm output quality.

---

_Verified: 2026-04-13T15:00:00Z_
_Verifier: Claude (gsd-verifier)_
