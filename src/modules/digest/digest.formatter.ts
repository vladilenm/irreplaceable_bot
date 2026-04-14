// Formatter: converts LLM plain-text digest output to Telegram HTML
// Rules (per plan 03-01, D-09 / D-10):
//  - HTML-escape all LLM output first (prevents tag injection from RSS titles, T-03-01)
//  - Wrap header line (starts with "📡") in <b>...</b>
//  - Wrap each news headline line (starts with category emoji) in <b>...</b>
//  - Convert "→ https://..." into "→ <a href=\"https://...\">ссылка</a>"
//  - Keep footer separator and footer lines as-is

const CATEGORY_EMOJI = ['🤖', '🔗', '🧠', '🛠', '⚡', '💰'];

function escapeHtml(input: string): string {
  return input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Un-escape only "&amp;" inside href attribute values so URL query strings
// keep literal "&". We intentionally leave "&lt;"/"&gt;" escaped: angle
// brackets are not required in URL semantics and leaving them escaped
// preserves the T-03-01 injection guard inside the href attribute.
function unescapeAmp(input: string): string {
  return input.replace(/&amp;/g, '&');
}

function isHeaderLine(line: string): boolean {
  // Header: starts with "📡" (escape-safe: emoji not affected by escapeHtml)
  return line.trimStart().startsWith('📡');
}

function isHeadlineLine(line: string): boolean {
  const trimmed = line.trimStart();
  return CATEGORY_EMOJI.some((emoji) => trimmed.startsWith(emoji));
}

function isLinkLine(line: string): boolean {
  return /^\s*→\s+https?:\/\//.test(line);
}

function transformLinkLine(line: string): string {
  // line has already been HTML-escaped; URL may contain "&amp;" we must preserve inside href.
  // Anchor URL to end-of-line and disallow whitespace / "<" / ">" / quote chars so trailing
  // punctuation (., ), etc.) stays outside the href (WR-02).
  return line.replace(
    /(→\s+)(https?:\/\/[^\s<>"]+)\s*$/,
    (_match, arrow: string, url: string) => {
      const hrefUrl = unescapeAmp(url);
      return `${arrow}<a href="${hrefUrl}">ссылка</a>`;
    },
  );
}

export function formatDigestHtml(plainText: string): string {
  const escaped = escapeHtml(plainText);
  const lines = escaped.split('\n');

  const result: string[] = [];
  for (const line of lines) {
    if (isHeaderLine(line)) {
      result.push(`<b>${line}</b>`);
      continue;
    }
    if (isHeadlineLine(line)) {
      result.push(`<b>${line}</b>`);
      continue;
    }
    if (isLinkLine(line)) {
      result.push(transformLinkLine(line));
      continue;
    }
    result.push(line);
  }

  return result.join('\n');
}
