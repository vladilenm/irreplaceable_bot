import type { DigestCategory, DigestItem } from '../../types/index.js';

const CATEGORY_EMOJI: Record<DigestCategory, string> = {
  agents: '🤖',
  orchestration: '🔗',
  models: '🧠',
  tools: '🛠',
  technologies: '⚡',
  business: '💰',
};

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttribute(input: string): string {
  return escapeHtml(input).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function formatDigestHtml(items: DigestItem[], date: Date): string {
  const header = `<b>📡 AI-радар | ${date.toLocaleDateString('ru-RU', {
    timeZone: 'Europe/Moscow',
  })}</b>`;
  const blocks = items.map((item) => {
    const title = `${CATEGORY_EMOJI[item.category]} ${escapeHtml(item.title)}`;
    return [
      `<b><a href="${escapeAttribute(item.url)}">${title}</a></b>`,
      escapeHtml(item.summary),
    ].join('\n');
  });
  return [header, ...blocks, '———\nДайджест Клуба Незаменимых'].join('\n\n');
}
