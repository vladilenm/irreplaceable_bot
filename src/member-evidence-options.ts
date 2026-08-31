export interface EvidenceOption {
  evidenceId: string;
  text: string;
}

const MAX_EVIDENCE_LENGTH = 300;
const SENTENCE_BOUNDARY = /[.!?](?:[»"')\]]?)(?=\s|$)/gu;

function sentenceSlices(line: string): string[] {
  const slices: string[] = [];
  let start = 0;
  for (const match of line.matchAll(SENTENCE_BOUNDARY)) {
    const token = match[0];
    if (match.index === undefined || token === undefined) continue;
    const end = match.index + token.length;
    const slice = line.slice(start, end).trim();
    if (slice !== '') slices.push(slice);
    start = end;
  }
  const tail = line.slice(start).trim();
  if (tail !== '') slices.push(tail);
  return slices.length === 0 && line.trim() !== '' ? [line.trim()] : slices;
}

function boundedSlices(value: string): string[] {
  const result: string[] = [];
  let remaining = value.trim();
  while (remaining.length > MAX_EVIDENCE_LENGTH) {
    const whitespace = remaining.lastIndexOf(' ', MAX_EVIDENCE_LENGTH);
    const cut = whitespace > 0 ? whitespace : MAX_EVIDENCE_LENGTH;
    const chunk = remaining.slice(0, cut).trimEnd();
    if (chunk !== '') result.push(chunk);
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining !== '') result.push(remaining);
  return result;
}

export function buildEvidenceOptions(profileText: string): EvidenceOption[] {
  const seen = new Set<string>();
  const texts: string[] = [];
  for (const line of profileText.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const sentences = trimmed.length <= MAX_EVIDENCE_LENGTH
      ? [trimmed]
      : sentenceSlices(trimmed);
    for (const sentence of sentences) {
      for (const text of boundedSlices(sentence)) {
        if (
          text.length < 1 ||
          text.length > MAX_EVIDENCE_LENGTH ||
          !profileText.includes(text) ||
          seen.has(text)
        ) {
          continue;
        }
        seen.add(text);
        texts.push(text);
      }
    }
  }
  return texts.map((text, index) => ({
    evidenceId: `e${String(index)}`,
    text,
  }));
}
