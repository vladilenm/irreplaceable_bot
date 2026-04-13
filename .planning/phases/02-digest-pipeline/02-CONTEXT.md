# Phase 2: Digest Pipeline - Context

**Gathered:** 2026-04-13
**Status:** Ready for planning

<domain>
## Phase Boundary

Build the core digest pipeline: RSS fetching from 9 configured feeds → AI filtering through LLM → structured digest object ready for publishing. This phase produces the data — Phase 3 handles delivery to Telegram.

</domain>

<decisions>
## Implementation Decisions

### RSS Parser
- **D-01:** Feed list stored in a JSON config file (feeds.json) with array of {url, name, category} objects — git-tracked, easy to edit without code changes
- **D-02:** Use `rss-parser` library (as specified in rss.md)
- **D-03:** On feed fetch error: skip the broken feed, log error via pino, continue with remaining feeds — no retry
- **D-04:** All 9 feeds from rss.md are the initial set (Habr, vc.ru, OpenAI, HuggingFace, LangChain, VentureBeat, Anthropic, Cursor, Tproger)

### AI Curator Prompt
- **D-05:** Use the system prompt from rss.md as-is (role, audience, task, categories, quota, criteria, format, tone sections)
- **D-06:** Store prompt in a separate file (e.g., `prompts/curator.md` or `prompts/curator.txt`) — editable without touching code
- **D-07:** LLM returns ready-made post text (not structured JSON) — the formatter in rss.md format with emoji categories, titles, summaries, links, footer

### LLM Abstraction
- **D-08:** Use official SDKs: `@anthropic-ai/sdk` for Claude, `openai` for OpenAI
- **D-09:** ai.service.ts provides a single `filterArticles(articles, systemPrompt)` function that switches provider based on AI_MODEL env var
- **D-10:** LLM output is ready-made text (the Telegram post body), not structured JSON — the curator prompt handles formatting

### Pipeline Architecture
- **D-11:** Single orchestrator function `runDigestPipeline()` in digest.service.ts that calls fetch → filter → return in sequence
- **D-12:** Pipeline returns a result object: `{ text: string, itemCount: number, skipped: boolean, date: Date }`
- **D-13:** Fallback 48h logic: store `lastDigestDate` in a file (data/state.json) — persists across restarts. If last digest was skipped, expand RSS window to 48 hours
- **D-14:** Skip signal: if LLM returns fewer than 3 items or explicitly signals low quality, pipeline returns `{ skipped: true }`

### Claude's Discretion
- Timeout values for RSS fetch requests
- Exact error messages and log formats
- Internal data structures between pipeline stages
- How to parse LLM text output for item count validation

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Specifications
- `SPEC.md` — Project structure, module layout, .env variables, bot commands, dev principles
- `rss.md` — RSS sources (URLs, categories, frequencies), AI curator prompt, post format, publication rules, categories

### Existing Code
- `src/config.ts` — BotConfig interface, requireEnv(), env var loading
- `src/types/index.ts` — DigestItem, DigestCategory, DigestPayload types (defined in Phase 1)
- `src/services/ai.service.ts` — Empty stub, to be implemented
- `src/modules/digest/.gitkeep` — Empty module directory, to be populated

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/config.ts` — Already loads AI_API_KEY, AI_MODEL from .env — AI service can import directly
- `src/types/index.ts` — DigestItem, DigestCategory, DigestPayload types already defined
- `src/utils/logger.ts` — Pino logger ready for use

### Established Patterns
- ESM modules with `.js` extensions in imports
- Config validation via `requireEnv()` — new required vars should use same pattern
- Strict TypeScript (no any, noUncheckedIndexedAccess)

### Integration Points
- `src/services/ai.service.ts` — stub exists, replace with real implementation
- `src/modules/digest/` — empty directory, populate with digest.service.ts, digest.formatter.ts, digest.types.ts per SPEC.md structure

</code_context>

<specifics>
## Specific Ideas

- vc.ru quota: exactly 2 news items per digest (minimum 1 if insufficient worthy items) — this is a hard requirement from rss.md
- Categories must use exact emoji mapping from rss.md: 🤖 Агенты, 🔗 Оркестрация, 🧠 Модели, 🛠 Инструменты, ⚡ Технологии, 💰 Бизнес
- Post format follows the example in rss.md exactly: "📡 AI-радар | [дата]" header, news items with emoji + title + summary + link, footer "Дайджест Клуба Незаменимых / Система > Навык"
- Tone: "Как разведка докладывает штабу" — direct, no hype

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 02-digest-pipeline*
*Context gathered: 2026-04-13*
