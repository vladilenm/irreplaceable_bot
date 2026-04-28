// Formatter: converts LLM plain-text digest output to Telegram HTML
// Rules (per plan 03-01, D-09 / D-10; updated in quick-260428-o92):
//  - HTML-escape all LLM output first (prevents tag injection from RSS titles, T-03-01)
//  - Wrap header line (starts with "📡") in <b>...</b>
//  - Wrap each news headline line (starts with category emoji) in <b>...</b> with
//    a clickable <a href="..."> taken from the next "→ https?://..." line in the
//    same block (block = up to next blank line). Link line is then dropped from output.
//  - Headline without a link line in its block stays as <b>headline</b> (back-compat).
//  - Orphan link lines (no preceding headline in block) are also dropped — formatter
//    output never contains literal "→ https://...".
//  - Idempotency metric (digest.service.countDigestItems) reads RAW LLM text BEFORE
//    formatDigestHtml, so dropping link lines here is safe (unchanged contract).

const CATEGORY_EMOJI = ['🤖', '🔗', '🧠', '🛠', '⚡', '💰'];

// Capture-regex used to extract URL from a link line. Mirrors the WR-02 pattern
// (no whitespace / "<" / ">" / quote in URL) used by the legacy transformLinkLine.
const LINK_LINE_CAPTURE = /^\s*→\s+(https?:\/\/[^\s<>"]+)\s*$/;

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

export function formatDigestHtml(plainText: string): string {
  const escaped = escapeHtml(plainText);
  const lines = escaped.split('\n');

  const result: string[] = [];
  const skip = new Set<number>();

  for (let i = 0; i < lines.length; i++) {
    if (skip.has(i)) {
      // Link line already consumed by a previous headline — drop it.
      continue;
    }

    const line = lines[i] ?? '';

    if (isHeaderLine(line)) {
      result.push(`<b>${line}</b>`);
      continue;
    }

    if (isHeadlineLine(line)) {
      // Look ahead for the first link line in the same block (until blank line / EOF).
      let hrefUrl: string | null = null;
      for (let j = i + 1; j < lines.length; j++) {
        const peek = lines[j] ?? '';
        if (peek.trim() === '') {
          break;
        }
        if (isLinkLine(peek)) {
          const match = LINK_LINE_CAPTURE.exec(peek);
          if (match !== null && match[1] !== undefined) {
            hrefUrl = unescapeAmp(match[1]);
            skip.add(j);
          }
          break;
        }
      }

      if (hrefUrl !== null) {
        result.push(`<b><a href="${hrefUrl}">${line}</a></b>`);
      } else {
        result.push(`<b>${line}</b>`);
      }
      continue;
    }

    if (isLinkLine(line)) {
      // Orphan link line (no preceding headline in block) — drop silently.
      // Rationale: formatter output should never contain literal "→ https://..."
      // and idempotency metric reads RAW LLM text, so this is metric-safe.
      continue;
    }

    result.push(line);
  }

  return result.join('\n');
}
