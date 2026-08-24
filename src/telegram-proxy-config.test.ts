import { describe, expect, it } from 'vitest';
import { readTelegramProxyConfig } from './telegram-proxy-config.js';

const valid =
  'vless://8f93928e-8193-46e8-a596-9324c11e6fe4@147.45.149.185:443' +
  '?encryption=none&flow=xtls-rprx-vision&security=reality' +
  '&sni=www.cloudflare.com&fp=chrome' +
  '&pbk=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  '&sid=0123456789abcdef&type=tcp#club-bot-amsterdam';

describe('readTelegramProxyConfig', () => {
  it('keeps direct mode when the deployment secret is absent or blank', () => {
    expect(readTelegramProxyConfig({})).toBeNull();
    expect(readTelegramProxyConfig({ TELEGRAM_PROXY_VLESS_URL: '  ' })).toBeNull();
  });

  it('returns only validated Reality TCP fields', () => {
    expect(readTelegramProxyConfig({ TELEGRAM_PROXY_VLESS_URL: valid })).toEqual({
      host: '147.45.149.185',
      port: 443,
      clientId: '8f93928e-8193-46e8-a596-9324c11e6fe4',
      encryption: 'none',
      flow: 'xtls-rprx-vision',
      security: 'reality',
      network: 'tcp',
      serverName: 'www.cloudflare.com',
      fingerprint: 'chrome',
      publicKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      shortId: '0123456789abcdef',
    });
  });

  it.each([
    valid.replace('vless:', 'https:'),
    valid.replace('security=reality', 'security=none'),
    valid.replace('type=tcp', 'type=ws'),
    valid.replace('xtls-rprx-vision', 'invalid-flow'),
    valid.replace('0123456789abcdef', 'not-hex'),
    valid.replace('#club-bot-amsterdam', '&unknown=value#club-bot-amsterdam'),
    valid.replace('type=tcp', 'type=tcp&type=tcp'),
  ])('rejects unsupported input without echoing it', (secret) => {
    let thrown: unknown;
    try {
      readTelegramProxyConfig({ TELEGRAM_PROXY_VLESS_URL: secret });
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('Invalid TELEGRAM_PROXY_VLESS_URL');
    expect((thrown as Error).message).not.toContain('8f93928e');
  });
});
