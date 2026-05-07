---
status: diagnosed
trigger: "Thread-summary pipeline failed with LLM error at 9:30 MSK while digest at 9:00 MSK succeeded. Additionally, digest appears to have published twice (double-send bug)."
created: 2026-05-04T09:45:00Z
updated: 2026-05-04T10:15:00Z
---

## Current Focus

hypothesis: CONFIRMED — double digest caused by rolling-deploy TOCTOU race; LLM failure root cause indeterminate without err object details
test: traced code paths for both issues
expecting: n/a — diagnosis complete
next_action: return diagnosis

## Symptoms

expected: |
  1. Thread summary (Самара тред) published at 9:30 MSK
  2. Digest published once at 9:00 MSK
actual: |
  1. Thread summary NOT published — LLM call failed for ALL threads
  2. Digest published TWICE — two concurrent Telegram sendMessage and two "Digest published" log entries
errors: |
  - Double digest: two "Digest ready", two "Telegram sendMessage ok", two "Digest published" in logs
  - Thread-summary: "summarizeThread: LLM call failed" for ALL threads
  - "Thread-summary: ALL threads failed with llm-error"
reproduction: |
  - Double digest: reproducible on any rolling deployment that overlaps a cron window
  - Thread-summary LLM failure: unclear — transient or deployment-related
started: 2026-05-04
timeline: Digest 9:00 MSK, thread-summary 9:30 MSK

## Eliminated

- hypothesis: Two Docker replicas configured in docker-compose
  evidence: No replicas/scale config in docker-compose.yml; single service definition
  timestamp: 2026-05-04T10:00:00Z

- hypothesis: node-cron registerJob called twice in same process
  evidence: registerJob has `tasks.has(name)` guard (cron.ts:41-44); cannot register duplicate job name
  timestamp: 2026-05-04T10:02:00Z

## Evidence

- timestamp: 2026-05-04T10:00:00Z
  checked: Log sequence pattern — first vs second digest run
  found: First digest run shows SINGLE AI/send/publish log entries. Second run shows INTERLEAVED PAIRS (two AI raw response, two AI filtering complete, two Digest ready, two sendMessage, two published). This proves two concurrent executions of the SECOND run, not the first.
  implication: Something changed between first and second runs that introduced a second executor. Consistent with a new container starting mid-cycle (rolling deploy).

- timestamp: 2026-05-04T10:03:00Z
  checked: index.ts startup sequence — startScheduler() vs bot.start()
  found: startScheduler() is called SYNCHRONOUSLY at line 33, BEFORE bot.start() at line 37. bot.start() is fire-and-forget (void + .catch). If bot.start() fails with 409, the catch handler sleeps 60s then exits. But cron jobs are ALREADY ticking from line 33.
  implication: During rolling deploy, new container registers cron jobs immediately. If a cron fires during the 60s backoff window, BOTH old and new containers execute the handler. This is the TOCTOU race.

- timestamp: 2026-05-04T10:05:00Z
  checked: Digest idempotency guard in digest.service.ts:56-67
  found: Guard reads state.json (file I/O, no lock). If two processes read before either writes, both see pre-today lastDigestDate, both pass the guard, both run the full pipeline and publish.
  implication: state.json file-based idempotency is insufficient for multi-process concurrency. The atomic write (rename) protects against corruption but NOT against TOCTOU.

- timestamp: 2026-05-04T10:07:00Z
  checked: Digest state write timing (Phase 8 fix A)
  found: State is written AFTER sendMessageWithRetry in digest.sender.ts:34-45. This means during the entire pipeline (RSS fetch + LLM filter + Telegram send), state is NOT updated. A concurrent reader always sees stale state.
  implication: The Phase 8 fix A (post-send write) is correct for single-process crash safety but WIDENS the TOCTOU window for multi-process races.

- timestamp: 2026-05-04T10:09:00Z
  checked: Thread-summary LLM error logging (summarizer.service.ts:241-245)
  found: Error logged as `{ err, threadId, messageCount, model }` with msg "summarizeThread: LLM call failed". The `err` object contains Anthropic SDK error details (HTTP status, error type, message) but these are in pino's serialized `err` field, not in the `msg` string. Same visibility gap as the Telegram error surfacing issue fixed in recent commits.
  implication: Cannot determine LLM failure root cause from dashboard — need raw pino JSON logs. Could be rate-limit, transient network, or deployment-related (new container firing summarizer while shutting down).

- timestamp: 2026-05-04T10:11:00Z
  checked: Whether thread-summary was also doubled
  found: Log shows single "Starting thread-summary pipeline" and single set of thread-summary logs. NOT doubled.
  implication: By the time thread-summary cron fired (9:30 MSK), the old container had likely exited (the 60s backoff from 409 would have elapsed). Only the new container ran thread-summary. LLM failure is NOT a race — it's a genuine API call failure on a single instance.

## Resolution

root_cause: |
  TWO SEPARATE ISSUES:

  1. DOUBLE DIGEST (confirmed root cause): Rolling-deployment TOCTOU race.
     In index.ts, startScheduler() registers cron jobs BEFORE bot.start() connects to Telegram.
     During a rolling deploy, the new container's cron jobs start ticking immediately. If bot.start()
     fails with 409 Conflict (because old container still polls), the catch handler sleeps 60s before
     exiting — but cron jobs fire during that window. Both old and new containers execute digestHandler(),
     both read state.json before either writes, both pass idempotency, both publish.
     The Phase 8 fix A (post-send state write) widens this TOCTOU window because state remains stale
     throughout the entire pipeline duration.

  2. THREAD-SUMMARY LLM FAILURE (root cause indeterminate — needs log data):
     The actual Anthropic API error details (HTTP status, error body) are in pino's serialized `err`
     field but NOT surfaced in the log `msg` string. Dashboard visibility gap — same class of issue
     as the Telegram error surfacing fixed in commits 896ade5/53d3329. Without raw JSON logs, cannot
     distinguish between: (a) rate-limit 429, (b) transient 500/503 from Anthropic, (c) network
     failure during container shutdown, (d) model/tool_use incompatibility. The thread-summary was
     NOT doubled (only one instance ran it), so it's a genuine single-instance LLM failure.
fix:
verification:
files_changed: []
