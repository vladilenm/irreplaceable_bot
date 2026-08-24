import type { TelegramProxyConfig } from './types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/;
const SHORT_ID = /^[0-9a-f]{16}$/i;
const SERVER_NAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const ALLOWED_PARAMS = new Set([
  'encryption', 'flow', 'security', 'sni', 'fp', 'pbk', 'sid', 'type',
]);

function invalid(): never {
  throw new Error('Invalid TELEGRAM_PROXY_VLESS_URL');
}

export function readTelegramProxyConfig(env: NodeJS.ProcessEnv): TelegramProxyConfig | null {
  const raw = env.TELEGRAM_PROXY_VLESS_URL?.trim();
  if (!raw) return null;

  try {
    const url = new URL(raw);
    for (const key of url.searchParams.keys()) {
      if (!ALLOWED_PARAMS.has(key)) invalid();
    }
    for (const key of ALLOWED_PARAMS) {
      if (url.searchParams.getAll(key).length !== 1) invalid();
    }
    if (url.protocol !== 'vless:' || url.password !== '' || !UUID.test(url.username)) invalid();

    const port = Number(url.port);
    if (!url.hostname || !Number.isInteger(port) || port < 1 || port > 65_535) invalid();

    const encryption = url.searchParams.get('encryption');
    const flow = url.searchParams.get('flow');
    const security = url.searchParams.get('security');
    const network = url.searchParams.get('type');
    const serverName = url.searchParams.get('sni');
    const fingerprint = url.searchParams.get('fp');
    const publicKey = url.searchParams.get('pbk');
    const shortId = url.searchParams.get('sid');
    if (
      encryption !== 'none' || flow !== 'xtls-rprx-vision' ||
      security !== 'reality' || network !== 'tcp' ||
      !serverName || !SERVER_NAME.test(serverName) ||
      (fingerprint !== 'chrome' && fingerprint !== 'firefox' && fingerprint !== 'safari') ||
      !publicKey || !PUBLIC_KEY.test(publicKey) ||
      !shortId || !SHORT_ID.test(shortId)
    ) invalid();

    return {
      host: url.hostname,
      port,
      clientId: url.username,
      encryption,
      flow,
      security,
      network,
      serverName,
      fingerprint,
      publicKey,
      shortId,
    };
  } catch {
    return invalid();
  }
}
