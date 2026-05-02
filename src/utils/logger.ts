import pino from 'pino';
import { randomBytes } from 'node:crypto';
import { config } from '../config.js';

// 8-char random hex stamped into every log entry as `bootId`. Lets us tell
// processes apart when several container instances share a log stream — see
// prod-digest-delivery-conflict where two parallel polling clients caused a 409.
export const bootId = randomBytes(4).toString('hex');

export const logger = pino({
  level: config.logLevel,
  transport:
    config.nodeEnv === 'development'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
}).child({ bootId });
