// Unicode display-name normalisation (Phase 6 D-24, SUM-07).
// Applied (1) to messages.author_name BEFORE insertion into LLM transcript,
// (2) to participants[].displayName BEFORE HTML render in formatter.
// Defends against homoglyph + RTL override + zero-width display attacks.

// Strip:
// - U+200B..U+200F (zero-width + LRM/RLM)
// - U+202A..U+202E (RTL/LTR overrides)
// - U+2066..U+2069 (isolate marks)
// - \p{C} = all Unicode control / format / unassigned chars (covers \x00..\x1F, BOM, etc.)
const STRIP_RE = /[​-‏‪-‮⁦-⁩\p{C}]/gu;

export function normalizeDisplayName(name: string): string {
  return name.normalize('NFC').replace(STRIP_RE, '').trim();
}
