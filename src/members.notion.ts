import { z } from 'zod';
import type { MemberDirectoryProvider, MemberSourceRecord } from './members.js';

const RichTextSchema = z.object({ plain_text: z.string() });
const PropertySchema = z.object({
  type: z.string(),
  title: z.array(RichTextSchema).optional(),
  rich_text: z.array(RichTextSchema).optional(),
});
const PageSchema = z.object({
  object: z.literal('page'),
  id: z.string().min(1),
  last_edited_time: z.string().min(1),
  in_trash: z.boolean().optional().default(false),
  is_archived: z.boolean().optional().default(false),
  archived: z.boolean().optional().default(false),
  properties: z.record(PropertySchema),
});
const DataSourcePageSchema = z.object({
  results: z.array(PageSchema),
  has_more: z.boolean(),
  next_cursor: z.string().nullable(),
});

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export function normalizeTelegramUsername(raw: string): string | null {
  const value = raw.trim().replace(/^@/, '').toLowerCase();
  return /^[a-z][a-z0-9_]{4,31}$/.test(value) ? value : null;
}

export function normalizeProfileText(raw: string): string {
  return raw
    .normalize('NFC')
    .replace(/[\p{C}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2000);
}

function propertyText(
  properties: Record<string, z.infer<typeof PropertySchema>>,
  name: string,
  type: 'title' | 'rich_text',
): string {
  const property = properties[name];
  if (!property || property.type !== type) return '';
  const parts = type === 'title' ? property.title : property.rich_text;
  return parts?.map((part) => part.plain_text).join('') ?? '';
}

function mapPage(page: z.infer<typeof PageSchema>): MemberSourceRecord {
  const displayName = normalizeProfileText(propertyText(page.properties, 'Name', 'title'));
  const telegramUsername = normalizeTelegramUsername(
    propertyText(page.properties, 'Telegram', 'rich_text'),
  );
  const profileText = normalizeProfileText(propertyText(page.properties, 'Profile', 'rich_text'));

  return {
    source: 'notion',
    externalId: page.id,
    displayName,
    telegramUsername: telegramUsername ?? '',
    profileText,
    sourceUpdatedAt: page.last_edited_time,
    active: !page.in_trash && !page.is_archived && !page.archived &&
      displayName !== '' && telegramUsername !== null && profileText !== '',
  };
}

export class NotionMemberDirectoryProvider implements MemberDirectoryProvider {
  private readonly token: string;
  private readonly dataSourceId: string;
  private readonly fetchFn: FetchLike;
  private readonly delay: (milliseconds: number) => Promise<void>;

  constructor(options: {
    token: string;
    dataSourceId: string;
    fetchFn?: FetchLike;
    delay?: (milliseconds: number) => Promise<void>;
  }) {
    this.token = options.token;
    this.dataSourceId = options.dataSourceId;
    this.fetchFn = options.fetchFn ?? fetch;
    this.delay = options.delay ?? ((milliseconds) => new Promise((resolve) => {
      setTimeout(resolve, milliseconds);
    }));
  }

  async listMembers(): Promise<MemberSourceRecord[]> {
    const records: MemberSourceRecord[] = [];
    let cursor: string | null = null;

    do {
      const page = await this.queryPage(cursor);
      records.push(...page.results.map(mapPage));
      cursor = page.has_more ? page.next_cursor : null;
      if (page.has_more && cursor === null) {
        throw new Error('Notion data-source query returned no next cursor');
      }
    } while (cursor !== null);

    return records;
  }

  private async queryPage(cursor: string | null): Promise<z.infer<typeof DataSourcePageSchema>> {
    const url = `https://api.notion.com/v1/data_sources/${encodeURIComponent(this.dataSourceId)}/query`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await this.fetchFn(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
          'Notion-Version': '2026-03-11',
        },
        body: JSON.stringify({
          page_size: 100,
          ...(cursor === null ? {} : { start_cursor: cursor }),
        }),
      });

      if (response.ok) {
        const parsed = DataSourcePageSchema.safeParse(await response.json());
        if (!parsed.success) throw new Error('Notion data-source query returned invalid response');
        return parsed.data;
      }

      if (attempt === 0 && (response.status === 429 || response.status >= 500)) {
        await this.delay(1_000);
        continue;
      }
      throw new Error(`Notion data-source query failed: ${String(response.status)}`);
    }
    throw new Error('Notion data-source query failed after retry');
  }
}
