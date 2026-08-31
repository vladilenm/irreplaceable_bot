import type { PublishedDigestV3, PublishedEvent } from './published-digest.js';

export const RICH_MESSAGE_LIMIT_CHARACTERS = 32_768;
export const RICH_MESSAGE_LIMIT_BLOCKS = 500;

const CONFIDENCE_PRESENTATION: Record<
  PublishedEvent['confidence'],
  { marker: string; label: string }
> = {
  confirmed: { marker: '🟢', label: 'Подтверждено' },
  corroborated: { marker: '🔵', label: 'Несколько источников' },
  'single-source': { marker: '🟡', label: 'Один источник' },
  rumor: { marker: '🟠', label: 'Не подтверждено' },
};

const SOURCE_LINE_LIMIT = 3_800;
const QUOTE_LIMIT = 360;
const RICH_BLOCK_PATTERN = /<(?:h1|h2|h3|p|footer|hr|details|summary|blockquote)\b/gi;

interface RichRenderProfile {
  includeLabels: boolean;
  quoteLimit: number;
  mainSourceLimit: number;
  radarSourceLimit: number;
  titleLimit: number;
  summaryLimit: number;
  whyImportantLimit: number;
  affectedLimit: number;
}

const FULL_FIELD_LIMITS = {
  titleLimit: 140,
  summaryLimit: 320,
  whyImportantLimit: 320,
  affectedLimit: 180,
};

const RICH_RENDER_PROFILES: readonly RichRenderProfile[] = [
  {
    ...FULL_FIELD_LIMITS,
    includeLabels: true,
    quoteLimit: QUOTE_LIMIT,
    mainSourceLimit: 3,
    radarSourceLimit: 1,
  },
  {
    ...FULL_FIELD_LIMITS,
    includeLabels: true,
    quoteLimit: QUOTE_LIMIT,
    mainSourceLimit: 1,
    radarSourceLimit: 1,
  },
  {
    ...FULL_FIELD_LIMITS,
    includeLabels: true,
    quoteLimit: QUOTE_LIMIT,
    mainSourceLimit: 0,
    radarSourceLimit: 0,
  },
  {
    ...FULL_FIELD_LIMITS,
    includeLabels: true,
    quoteLimit: 0,
    mainSourceLimit: 0,
    radarSourceLimit: 0,
  },
  {
    ...FULL_FIELD_LIMITS,
    includeLabels: false,
    quoteLimit: 0,
    mainSourceLimit: 0,
    radarSourceLimit: 0,
  },
  {
    includeLabels: false,
    quoteLimit: 0,
    mainSourceLimit: 0,
    radarSourceLimit: 0,
    titleLimit: 120,
    summaryLimit: 100,
    whyImportantLimit: 100,
    affectedLimit: 60,
  },
];

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function truncate(value: string, maximum: number): string {
  if (maximum <= 0) return '';
  const codePoints = [...value];
  return codePoints.length <= maximum
    ? value
    : `${codePoints.slice(0, maximum - 1).join('')}…`;
}

function uniqueLabels(labels: readonly string[]): string[] {
  const seen = new Set<string>();
  return labels.filter((label) => {
    const normalized = label.normalize('NFKC').toLocaleLowerCase();
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

const WORD_CHARACTER = /[\p{L}\p{N}]/u;

function titleContainsLabel(title: string, label: string): boolean {
  const normalizedTitle = title.normalize('NFKC').toLocaleLowerCase();
  const normalizedLabel = label.normalize('NFKC').toLocaleLowerCase();
  const startsWithWord = WORD_CHARACTER.test(normalizedLabel[0] ?? '');
  const endsWithWord = WORD_CHARACTER.test(normalizedLabel.at(-1) ?? '');
  let index = normalizedTitle.indexOf(normalizedLabel);

  while (index !== -1) {
    const before = normalizedTitle[index - 1];
    const after = normalizedTitle[index + normalizedLabel.length];
    const hasLeftBoundary = !startsWithWord || !before || !WORD_CHARACTER.test(before);
    const hasRightBoundary = !endsWithWord || !after || !WORD_CHARACTER.test(after);
    if (hasLeftBoundary && hasRightBoundary) return true;
    index = normalizedTitle.indexOf(normalizedLabel, index + normalizedLabel.length);
  }
  return false;
}

function eventLabels(event: PublishedEvent): string {
  return uniqueLabels([
    ...event.tags.map(({ label }) => label),
    ...event.entities
      .map(({ label }) => label)
      .filter((label) => !titleContainsLabel(event.title, label)),
  ]).map(escapeHtml).join(' · ');
}

function uniqueSources(event: PublishedEvent): PublishedEvent['sources'] {
  const seen = new Set<string>();
  return event.sources.filter((source) => {
    const normalized = new URL(source.url).toString();
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function renderSourceLink(source: PublishedEvent['sources'][number]): string {
  const url = new URL(source.url).toString();
  return `<a href="${escapeHtml(url)}">${escapeHtml(truncate(source.label, 100))}</a>`;
}

function renderSources(event: PublishedEvent, maximumLinks: number): string | null {
  const links: string[] = [];
  for (const source of uniqueSources(event)) {
    if (links.length >= maximumLinks) break;
    const link = renderSourceLink(source);
    const candidate = `↗ ${[...links, link].join(' · ')}`;
    if ([...candidate].length <= SOURCE_LINE_LIMIT) links.push(link);
  }
  return links.length > 0 ? `↗ ${links.join(' · ')}` : null;
}

function renderQuote(event: PublishedEvent, limit: number): string {
  return `<blockquote>${escapeHtml(truncate(event.keyQuote.text, limit))}`
    + `<cite>${escapeHtml(truncate(event.keyQuote.sourceLabel, 100))}</cite></blockquote>`;
}

function renderDetailedEvent(
  event: PublishedEvent,
  index: number,
  profile: RichRenderProfile,
): string {
  const labels = profile.includeLabels ? eventLabels(event) : '';
  const sources = renderSources(event, profile.mainSourceLimit);
  const detailSummary = sources
    ? 'Подробнее · значение и источники'
    : profile.quoteLimit > 0
      ? 'Подробнее · значение и цитата'
      : 'Подробнее · значение';
  return [
    `<h3>${String(index + 1)}. ${escapeHtml(truncate(event.title, profile.titleLimit))}</h3>`,
    ...(labels ? [`<p><i>${labels}</i></p>`] : []),
    `<p><b>Суть:</b> ${escapeHtml(truncate(event.summary, profile.summaryLimit))}</p>`,
    `<details><summary>${detailSummary}</summary>`,
    `<p><b>Значение:</b> ${escapeHtml(truncate(event.whyImportant, profile.whyImportantLimit))}</p>`,
    `<p><b>Для кого:</b> ${escapeHtml(truncate(event.affected, profile.affectedLimit))}</p>`,
    ...(profile.quoteLimit > 0 ? [renderQuote(event, profile.quoteLimit)] : []),
    ...(sources ? [`<p>${sources}</p>`] : []),
    '</details>',
  ].join('\n');
}

function renderRadarEvent(event: PublishedEvent, profile: RichRenderProfile): string {
  const confidence = CONFIDENCE_PRESENTATION[event.confidence];
  const labels = profile.includeLabels ? eventLabels(event) : '';
  const metadata = [confidence.label, labels].filter(Boolean).join(' · ');
  const sources = renderSources(event, profile.radarSourceLimit);
  return `<p>${[
    `${confidence.marker} <b>${escapeHtml(truncate(event.title, profile.titleLimit))}</b>`,
    `<i>${metadata}</i>`,
    `<b>Зачем следить:</b> ${escapeHtml(truncate(
      event.whyImportant,
      profile.whyImportantLimit,
    ))}`,
    sources,
  ].filter((line): line is string => Boolean(line)).join('<br/>')}</p>`;
}

function renderFooter(digest: PublishedDigestV3, compacted: boolean): string {
  const date = new Intl.DateTimeFormat(digest.topic.language, {
    timeZone: digest.topic.timezone,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(digest.generatedAt));
  const total = digest.sourceStats.telegram.total + digest.sourceStats.web.total;
  const succeeded = digest.sourceStats.telegram.succeeded + digest.sourceStats.web.succeeded;
  return [
    `${escapeHtml(date)} · источники ${String(succeeded)}/${String(total)}`,
    ...(digest.status === 'partial' ? ['⚠️ Неполные данные'] : []),
    ...(compacted ? ['ℹ️ Часть деталей сокращена по лимиту Telegram'] : []),
  ].join('<br/>');
}

function renderDigestWithProfile(
  digest: PublishedDigestV3,
  profile: RichRenderProfile,
  compacted: boolean,
): string {
  const blocks = [
    `<h1>🗞 ${escapeHtml(digest.topic.title)}</h1>`,
    `<footer>${renderFooter(digest, compacted)}</footer>`,
    '<hr/>',
  ];

  if (digest.selectionMode === 'focus') {
    blocks.push(
      `<h2>🎯 В фокусе · ${String(digest.sections.focus.length)}</h2>`,
      '<p><i>Пояснение: информационный сигнал сегодня слабее обычного, поэтому выбраны самые релевантные проверенные события.</i></p>',
      ...digest.sections.focus.map((event, index) => renderDetailedEvent(event, index, profile)),
    );
    return blocks.join('\n');
  }

  if (digest.sections.main.length > 0) {
    blocks.push(
      `<h2>🔥 Главное · ${String(digest.sections.main.length)}</h2>`,
      ...digest.sections.main.map((event, index) => renderDetailedEvent(event, index, profile)),
    );
  }
  if (digest.sections.radar.length > 0) {
    if (digest.sections.main.length > 0) blocks.push('<hr/>');
    blocks.push(
      `<h2>📡 На радаре · ${String(digest.sections.radar.length)}</h2>`,
      ...digest.sections.radar.map((event) => renderRadarEvent(event, profile)),
    );
  }
  return blocks.join('\n');
}

export function countRichBlocks(html: string): number {
  return html.match(RICH_BLOCK_PATTERN)?.length ?? 0;
}

export function renderDigestRichHtml(digest: PublishedDigestV3): string {
  for (const [index, profile] of RICH_RENDER_PROFILES.entries()) {
    const html = renderDigestWithProfile(digest, profile, index > 0);
    if (
      [...html].length <= RICH_MESSAGE_LIMIT_CHARACTERS
      && countRichBlocks(html) <= RICH_MESSAGE_LIMIT_BLOCKS
    ) {
      return html;
    }
  }
  throw new Error('Telegram rich digest exceeds Rich Message limits after compaction');
}
