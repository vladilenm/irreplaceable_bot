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
 * Redacted metadata for errors received from external systems. Error messages
 * can echo prompts, responses, SQL, or connection strings, so they must never
 * enter logs. Standard PostgreSQL SQLSTATE and Node system error codes are safe
 * enough to retain for operational diagnosis.
 */
export function safeErrorMetadata(err: unknown): {
  errorClass: string;
  status?: number;
  code?: string;
} {
  const errorClass =
    err !== null && typeof err === 'object' && err.constructor?.name
      ? err.constructor.name
      : typeof err;
  const record = err !== null && typeof err === 'object'
    ? err as { status?: unknown; code?: unknown }
    : undefined;
  const metadata: { errorClass: string; status?: number; code?: string } = { errorClass };

  if (typeof record?.status === 'number' && Number.isFinite(record.status) &&
      Number.isInteger(record.status)) {
    metadata.status = record.status;
  }
  if (typeof record?.code === 'string' &&
      /^(?:[0-9A-Z]{5}|E[A-Z0-9_]+)$/.test(record.code)) {
    metadata.code = record.code;
  }
  return metadata;
}

export const logger = pino({
  level: RUNTIME_DEFAULTS.logging.level,
  transport:
    process.env['NODE_ENV'] === 'development'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
}).child({ bootId });
