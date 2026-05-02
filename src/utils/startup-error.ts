// Phase 8 fix D — classify a failed bot.start() rejection so the bootstrap can
// react differently to a Telegram 409 Conflict (another instance is polling)
// vs everything else.
//
// Why a separate module: src/index.ts registers process-level signal handlers
// at import time, which makes it hostile to unit-testing. The classifier is
// extracted here so the discriminator logic is exercised in isolation.

import { GrammyError } from 'grammy';

export type StartupErrorKind = 'polling-conflict-409' | 'unknown';

/**
 * Classify a bot.start() rejection.
 *
 * Telegram returns 409 when more than one client (long-poll OR webhook) is
 * connected to the same bot token at the same time. grammy 1.42 wraps that
 * response in a GrammyError with error_code === 409 and rethrows it from
 * bot.start() (see node_modules/grammy/out/bot.js handlePollingError).
 *
 * Operationally this is almost always:
 *   • a stale container from a rolling deploy that hasn't been killed yet, or
 *   • a parallel local dev process reading the same .env, or
 *   • a Timeweb App Platform replicas>1 setting.
 *
 * For all of those the right boot behaviour is to back off long enough that
 * the parallel client probably dies on its own — see handleStartupFailure.
 */
export function classifyStartupError(err: unknown): StartupErrorKind {
  if (err instanceof GrammyError && err.error_code === 409) {
    return 'polling-conflict-409';
  }
  return 'unknown';
}

/**
 * Default backoff before re-exiting on a 409 Conflict. Chosen at 60s because:
 *   • Faster than docker-compose's `restart: unless-stopped` flap detector
 *     would care about, but slow enough that a rolling-deploy lingering pod
 *     usually finishes shutting down within the wait.
 *   • A typical Telegram-side cooldown for a competing getUpdates client is
 *     a few seconds; 60s is comfortable margin.
 */
export const POLLING_CONFLICT_BACKOFF_MS = 60_000;
