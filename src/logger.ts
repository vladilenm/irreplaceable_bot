import pino from 'pino';
import { randomBytes } from 'node:crypto';
import { RUNTIME_DEFAULTS } from './runtime-defaults.js';

// 8-char random hex stamped into every log entry as `bootId`. Lets us tell
// processes apart when several container instances share a log stream — see
// prod-digest-delivery-conflict where two parallel polling clients caused a 409.
export const bootId = randomBytes(4).toString('hex');

/** Extract a printable message from any thrown value. Used to surface error
 *  details inside pino `msg` strings for dashboards that render only `msg`. */
export function errMsg(err: unknown): string {
  if (err instanceof Error) {
    const status = (err as Error & { status?: unknown }).status;
    return status !== undefined ? `status=${String(status)} ${err.message}` : err.message;
  }
  return String(err);
}

/**
 * Redacted metadata for errors received from an LLM provider. Provider error
 * messages can echo prompts or responses, so they must never enter logs.
 */
export function safeErrorMetadata(err: unknown): { errorClass: string; status?: number } {
  const errorClass =
    err !== null && typeof err === 'object' && err.constructor?.name
      ? err.constructor.name
      : typeof err;
  const status =
    err !== null && typeof err === 'object'
      ? (err as { status?: unknown }).status
      : undefined;

  return typeof status === 'number' && Number.isFinite(status) && Number.isInteger(status)
    ? { errorClass, status }
    : { errorClass };
}

export const logger = pino({
  level: RUNTIME_DEFAULTS.logging.level,
  transport:
    process.env['NODE_ENV'] === 'development'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
}).child({ bootId });
