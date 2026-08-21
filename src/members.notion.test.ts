import { describe, expect, it, vi } from 'vitest';
import {
  NotionMemberDirectoryProvider,
  normalizeProfileText,
  normalizeTelegramUsername,
} from './members.notion.js';

const page = (id: string, telegram = '@anna_product', profile = 'Запускала B2B SaaS') => ({
  object: 'page',
  id,
  last_edited_time: '2026-08-21T10:00:00.000Z',
  in_trash: false,
  is_archived: false,
  properties: {
    Name: { type: 'title', title: [{ plain_text: 'Анна' }] },
    Telegram: { type: 'rich_text', rich_text: [{ plain_text: telegram }] },
    Profile: { type: 'rich_text', rich_text: [{ plain_text: profile }] },
  },
});

describe('NotionMemberDirectoryProvider', () => {
  it('queries every data-source page and maps cards', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        results: [page('page-1')],
        has_more: true,
        next_cursor: 'next',
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        results: [page('page-2', '@mikhail_saas')],
        has_more: false,
        next_cursor: null,
      }), { status: 200 }));
    const provider = new NotionMemberDirectoryProvider({
      token: 'secret',
      dataSourceId: 'source',
      fetchFn,
      delay: async () => undefined,
    });

    const result = await provider.listMembers();

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      externalId: 'page-1',
      displayName: 'Анна',
      telegramUsername: 'anna_product',
      profileText: 'Запускала B2B SaaS',
      active: true,
    });
    expect(fetchFn.mock.calls[0]?.[0]).toBe(
      'https://api.notion.com/v1/data_sources/source/query',
    );
    expect(JSON.parse(String(fetchFn.mock.calls[1]?.[1]?.body))).toMatchObject({
      page_size: 100,
      start_cursor: 'next',
    });
  });

  it('keeps incomplete cards as inactive records for snapshot deactivation', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      results: [page('page-1', 'not a username', '  B2B\u0000\n  SaaS  ')],
      has_more: false,
      next_cursor: null,
    }), { status: 200 }));
    const provider = new NotionMemberDirectoryProvider({
      token: 'secret',
      dataSourceId: 'source',
      fetchFn,
      delay: async () => undefined,
    });

    await expect(provider.listMembers()).resolves.toEqual([expect.objectContaining({
      externalId: 'page-1',
      telegramUsername: '',
      profileText: 'B2B SaaS',
      active: false,
    })]);
  });

  it('retries once for a retriable status', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response('too many requests', { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        results: [page('page-1')],
        has_more: false,
        next_cursor: null,
      }), { status: 200 }));
    const delay = vi.fn().mockResolvedValue(undefined);
    const provider = new NotionMemberDirectoryProvider({
      token: 'secret',
      dataSourceId: 'source',
      fetchFn,
      delay,
    });

    await expect(provider.listMembers()).resolves.toHaveLength(1);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenCalledTimes(1);
  });

  it('does not retry a non-retriable status', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('bad request', { status: 400 }));
    const provider = new NotionMemberDirectoryProvider({
      token: 'secret',
      dataSourceId: 'source',
      fetchFn,
      delay: async () => undefined,
    });

    await expect(provider.listMembers()).rejects.toThrow('Notion data-source query failed: 400');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe('Notion card normalization', () => {
  it('normalizes only safe public usernames', () => {
    expect(normalizeTelegramUsername('@Valid_user')).toBe('valid_user');
    expect(normalizeTelegramUsername('bad username')).toBeNull();
  });

  it('normalizes profiles to bounded visible text', () => {
    expect(normalizeProfileText('  B2B\u0000\n  SaaS  ')).toBe('B2B SaaS');
  });
});
