---
phase: 03-delivery-operations
reviewed: 2026-04-14T00:00:00Z
depth: standard
files_reviewed: 9
files_reviewed_list:
  - src/bot.ts
  - src/config.ts
  - src/modules/digest/digest.formatter.ts
  - src/modules/digest/digest.sender.ts
  - src/modules/digest/digest.service.ts
  - src/scheduler/cron.ts
  - src/services/ai.service.ts
  - src/types/index.ts
  - src/utils/telegram.ts
findings:
  critical: 0
  warning: 4
  info: 5
  total: 9
status: issues_found
---

# Phase 03: Code Review Report

**Reviewed:** 2026-04-14
**Depth:** standard
**Files Reviewed:** 9
**Status:** issues_found

## Summary

Delivery pipeline (cron -> pipeline -> formatter -> sender -> Telegram) is well-structured, strictly typed, and matches the plan. Idempotency, retry, admin gating, and HTML escaping for LLM output are implemented correctly. No critical security or correctness bugs found.

Main concerns are second-order: the HTML formatter un-escapes `&lt;`/`&gt;` inside `href` attributes (weakens the T-03-01 mitigation), the URL regex `\S+` captures trailing punctuation into the link, `Number(threadId)` silently produces `NaN` if the env var is malformed, and `isAdmin` performs an extra Telegram API roundtrip on every command (rate-limit and DoS surface for non-admins). A few minor smells: thread-only check assumes group context, formatter requires LLM to use exact emoji set, and `BOT_TOKEN` checked only via truthiness.

## Warnings

### WR-01: Formatter unescapes `&lt;`/`&gt;` inside href attribute, weakening HTML-injection guard

**File:** `src/modules/digest/digest.formatter.ts:17-19, 35-41`
**Issue:** `unescapeHtml` reverses `&amp;`, `&lt;`, AND `&gt;` before injecting the URL into `<a href="...">`. Reversing `<`/`>` is unnecessary for URL semantics (Telegram and browsers do not require literal angle brackets in href values) and re-introduces an attack surface: a crafted RSS link containing `<` could inject characters that Telegram's HTML parser treats as tag boundaries inside the attribute. The plan (D-09 / T-03-01) explicitly requires HTML escaping of all LLM output. Only `&amp;` -> `&` is needed to preserve query strings; `&lt;`/`&gt;` should remain escaped.
**Fix:**
```typescript
function unescapeAmp(input: string): string {
  return input.replace(/&amp;/g, '&');
}

function transformLinkLine(line: string): string {
  return line.replace(/(→\s+)(https?:\/\/\S+)/, (_m, arrow: string, url: string) => {
    const hrefUrl = unescapeAmp(url);
    return `${arrow}<a href="${hrefUrl}">ссылка</a>`;
  });
}
```

### WR-02: URL regex `\S+` captures trailing punctuation/whitespace artifacts into link

**File:** `src/modules/digest/digest.formatter.ts:37`
**Issue:** `https?:\/\/\S+` greedily matches every non-whitespace character. If the LLM output ends a link line with a trailing period, comma, closing parenthesis, or other punctuation (common in narrative text), it gets folded into the href and the visible link still says "ссылка" but points to a 404. Also breaks if two links appear on the same line.
**Fix:** Anchor to end-of-line (the format guarantees URL is the last token on its line) and disallow common trailing chars:
```typescript
return line.replace(/(→\s+)(https?:\/\/[^\s<>"]+)\s*$/, (_m, arrow, url) => { ... });
```

### WR-03: `Number(threadId)` silently yields `NaN` for malformed env value

**File:** `src/utils/telegram.ts:20`
**Issue:** `message_thread_id: Number(params.threadId)`. `AI_RADAR_THREAD_ID` is loaded as a string via `requireEnv` (which only checks for non-empty), so a typo like `THREAD_ID=abc` produces `NaN` and a Telegram API error at first send -- 9 hours after startup if the cron triggers. Should fail fast at config load.
**Fix:** Validate at config boundary in `src/config.ts`:
```typescript
function requireEnvInt(name: string): string {
  const v = requireEnv(name);
  if (!/^-?\d+$/.test(v)) throw new Error(`${name} must be an integer, got "${v}"`);
  return v;
}
// targetChatId: requireEnvInt('TARGET_CHAT_ID'),
// aiRadarThreadId: requireEnvInt('AI_RADAR_THREAD_ID'),
```
Then `Number(params.threadId)` is guaranteed safe.

### WR-04: `isAdmin` calls `getChatAdministrators` on every command invocation (DoS / rate-limit surface)

**File:** `src/bot.ts:19-28, 49, 101`
**Issue:** Every `/digest` and `/status` -- including from non-admin spammers -- triggers a Telegram API roundtrip to fetch the admin list. A non-admin can flood the bot with `/status` and burn the bot's API quota (Telegram applies per-bot rate limits) and add latency to legitimate commands. Also: the helper does not check `ctx.chat.type` -- in a private DM `getChatAdministrators` will error and `isAdmin` returns false (handled), but the error log noise is avoidable. Mentioned in T-03-09 as mitigated via idempotency, but idempotency only covers `/digest`, not `/status`.
**Fix:** Cache admin list per-chat with a short TTL (e.g. 5 min), and short-circuit in non-group chats:
```typescript
const adminCache = new Map<number, { ids: Set<number>; expires: number }>();
async function isAdmin(ctx: Context): Promise<boolean> {
  if (!ctx.chat || !ctx.from) return false;
  if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') return false;
  const cached = adminCache.get(ctx.chat.id);
  const now = Date.now();
  if (cached && cached.expires > now) return cached.ids.has(ctx.from.id);
  try {
    const admins = await ctx.api.getChatAdministrators(ctx.chat.id);
    const ids = new Set(admins.map((a) => a.user.id));
    adminCache.set(ctx.chat.id, { ids, expires: now + 5 * 60_000 });
    return ids.has(ctx.from.id);
  } catch (err: unknown) {
    logger.error({ err }, 'Failed to check admin status');
    return false;
  }
}
```

## Info

### IN-01: `aiBaseUrl` typed as optional but `requireEnv('AI_API_KEY')` mandatory even when using OpenAI-compatible local server

**File:** `src/services/ai.service.ts:49-52`, `src/config.ts:16`
**Issue:** When `aiBaseUrl` points to a local proxy, an API key may not be required. Currently `requireEnv('AI_API_KEY')` will throw at startup. Low priority -- typical SaaS use-case is fine; flag for plug-and-play LLM swapping mentioned in CLAUDE.md.
**Fix:** Allow empty string for `AI_API_KEY` when `AI_BASE_URL` is set, or pass a placeholder.

### IN-02: Formatter coupled to a fixed emoji whitelist

**File:** `src/modules/digest/digest.formatter.ts:9`
**Issue:** `CATEGORY_EMOJI` lists six emojis. If the curator prompt is updated to add a category (or the LLM picks `🔬`, `🎯`, etc.), the headline silently loses bold formatting. No test catches this.
**Fix:** Either (a) make headline detection structural (e.g. "second non-empty line of an item block, until `→` line"), or (b) export the emoji list from a single source shared with the curator prompt and document the contract.

### IN-03: `requireEnv` rejects empty string AND `'0'`-like falsy values silently OK

**File:** `src/config.ts:3-9`
**Issue:** `if (!value)` rejects `''` (good) but would also reject `'0'` -- not a realistic scenario for these vars, just noting. More importantly, `BOT_TOKEN` is not format-validated; a clearly malformed token (no colon) fails only on first Telegram API call.
**Fix:** Optional defensive validation: `if (!/^\d+:[\w-]+$/.test(token)) throw ...`.

### IN-04: `digest.service.ts` re-reads state on each `isDigestPublishedToday()` and again inside `runDigestPipeline()`

**File:** `src/modules/digest/digest.service.ts:54-62, 80-91`
**Issue:** `runDigestPipeline()` calls `readState()` once, then `isDigestPublishedToday()` calls `readState()` again -- two synchronous file reads per cron tick. Negligible cost but redundant.
**Fix:** Extract the date-comparison logic into a pure helper that takes `state` as arg:
```typescript
function isPublishedTodayMsk(state: PipelineState): boolean { ... }
// in runDigestPipeline:
if (isPublishedTodayMsk(state) && !state.lastSkipped) { ... }
```
Keep the public `isDigestPublishedToday()` as a thin wrapper for `bot.ts`.

### IN-05: `/status` chat type not constrained -- responds in DMs with "admin only" denial

**File:** `src/bot.ts:97-143`
**Issue:** When invoked in a private DM with the bot, `getChatAdministrators` fails, `isAdmin` returns false, and the user gets "Команда доступна только администраторам." That message is misleading (private chats have no admins). Minor UX nit.
**Fix:** Reply with a clearer message in non-group chats: "Команда работает только в группе клуба."

---

_Reviewed: 2026-04-14_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
