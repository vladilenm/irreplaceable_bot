import { isIP } from 'node:net';
import { z } from 'zod';

function isSafePublicUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;

    const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
    const forbidden = [
      /^localhost$/i,
      /^0\./,
      /^10\./,
      /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
      /^127\./,
      /^169\.254\./,
      /^172\.(1[6-9]|2\d|3[01])\./,
      /^192\.0\.0\./,
      /^192\.0\.2\./,
      /^192\.168\./,
      /^198\.(1[89])\./,
      /^198\.51\.100\./,
      /^203\.0\.113\./,
      /^(22[4-9]|23\d|24\d|25[0-5])\./,
      /^::/,
      /^64:ff9b:/i,
      /^2001:(?:0:|db8:)/i,
      /^2002:/i,
      /^f[cd][0-9a-f]{2}:/i,
      /^fe[89a-f][0-9a-f]:/i,
      /^ff[0-9a-f]{2}:/i,
    ];

    return !forbidden.some((pattern) => pattern.test(hostname))
      && (isIP(hostname) !== 0 || (
        !hostname.endsWith('.local')
        && !hostname.endsWith('.localhost')
      ));
  } catch {
    return false;
  }
}

function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

const UtcTimestamp = z.string().datetime({ offset: true }).refine(
  (value) => value.endsWith('Z'),
  'timestamp must be UTC',
);
const PublicationDate = z.string().refine(isCalendarDate, 'invalid publication date');
const PublicUrl = z.string().url().refine(isSafePublicUrl, 'url must be a public HTTP(S) URL');
const Label = z.string().trim().min(1).max(160);
const SourceStatsSchema = z.object({
  total: z.number().int().nonnegative(),
  succeeded: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
}).strict();
const LabeledIdSchema = z.object({ id: Label, label: Label }).strict();
const PublishedSourceSchema = z.object({
  url: PublicUrl,
  label: Label,
  role: z.enum(['primary', 'discovery', 'linked', 'analysis']),
}).strict();

export const PublishedEventSchema = z.object({
  eventId: Label,
  title: z.string().trim().min(1).max(240),
  claimKind: z.enum(['fact', 'research', 'analysis', 'rumor']),
  confidence: z.enum(['confirmed', 'corroborated', 'single-source', 'rumor']),
  summary: z.string().trim().min(1).max(2_000),
  whyImportant: z.string().trim().min(1).max(2_000),
  affected: z.string().trim().min(1).max(1_000),
  keyQuote: z.object({
    text: z.string().trim().min(1).max(2_000),
    url: PublicUrl,
    sourceLabel: Label,
  }).strict(),
  tags: z.array(LabeledIdSchema).max(20),
  entities: z.array(LabeledIdSchema).max(100),
  sources: z.array(PublishedSourceSchema).min(1).max(20),
  publishedAt: UtcTimestamp,
}).strict();

export const PublishedDigestSchema = z.object({
  schemaVersion: z.literal(3),
  digestId: z.string().uuid(),
  topic: z.object({
    id: Label,
    title: Label,
    language: z.string().regex(/^[a-z]{2}$/),
    timezone: Label,
  }).strict(),
  publicationDate: PublicationDate,
  generatedAt: UtcTimestamp,
  status: z.enum(['complete', 'partial']),
  selectionMode: z.enum(['standard', 'focus']),
  sourceStats: z.object({
    telegram: SourceStatsSchema,
    web: SourceStatsSchema,
  }).strict(),
  sections: z.object({
    main: z.array(PublishedEventSchema).max(20),
    radar: z.array(PublishedEventSchema).max(20),
    focus: z.array(PublishedEventSchema).max(3),
  }).strict(),
}).strict().superRefine((digest, ctx) => {
  const hasStandardEvents = digest.sections.main.length + digest.sections.radar.length > 0;
  const hasFocusEvents = digest.sections.focus.length > 0;
  if (digest.selectionMode === 'standard' && (!hasStandardEvents || hasFocusEvents)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'invalid standard sections',
      path: ['sections'],
    });
  }
  if (digest.selectionMode === 'focus' && (hasStandardEvents || !hasFocusEvents)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'invalid focus sections',
      path: ['sections'],
    });
  }
});

export type PublishedDigestV3 = z.infer<typeof PublishedDigestSchema>;
export type PublishedEvent = z.infer<typeof PublishedEventSchema>;
