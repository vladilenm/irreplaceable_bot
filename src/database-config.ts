import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { RUNTIME_DEFAULTS } from './runtime-defaults.js';
import type { DatabaseConfig } from './types.js';

function requireDatabaseUrl(env: NodeJS.ProcessEnv): string {
  const value = env['DATABASE_URL'];
  if (!value) {
    throw new Error('Missing required environment variable: DATABASE_URL');
  }
  return value;
}

function loadBundledTimewebCa(): string {
  return readFileSync(new URL('../config/timeweb-cloud-ca.crt', import.meta.url), 'utf8');
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' ||
    hostname === '[::1]' || hostname === '::1';
}

function isPrivateIpv4(hostname: string): boolean {
  if (isIP(hostname) !== 4) return false;
  const [first, second] = hostname.split('.').map(Number);
  return first === 10 ||
    (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
    (first === 192 && second === 168);
}

export function readDatabaseConfig(
  env: NodeJS.ProcessEnv,
  loadCa: () => string = loadBundledTimewebCa,
): DatabaseConfig {
  const url = requireDatabaseUrl(env);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL URL');
  }
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new Error('DATABASE_URL must use postgresql: or postgres:');
  }
  const ssl = !isLoopbackHost(parsed.hostname) && !isPrivateIpv4(parsed.hostname);
  return {
    url,
    ssl,
    ...(ssl ? { caCert: loadCa() } : {}),
    poolMax: RUNTIME_DEFAULTS.database.poolMax,
    statementTimeoutMs: RUNTIME_DEFAULTS.database.statementTimeoutMs,
  };
}
