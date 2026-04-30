/**
 * Parse + validate LLM-extracted memory entries.
 *
 * Accepted shape (matches the prompt contract used by Jarvis session-extract
 * today so existing prompts/models can be reused during cutover):
 *
 *   [AUTO-TAG:CONFIDENCE] slug: content
 *
 * Valid TAG:        FACT | DECISION | CHANGED | PROCEDURE | TODO | EVENT
 * Valid CONFIDENCE: CONFIRMED | TENTATIVE | CONTEXT
 * Valid slug:       [a-z0-9][a-z0-9_-]*   (Silo slug regex)
 *
 * The LLM may also output the literal NOTHING_TO_EXTRACT sentinel — handled
 * separately (returns []).
 */

const ENTRY_RE =
  /^\[AUTO-(?<tag>FACT|DECISION|CHANGED|PROCEDURE|TODO|EVENT):(?<confidence>CONFIRMED|TENTATIVE|CONTEXT)\]\s+(?<slug>[a-z0-9][a-z0-9_-]*)\s*:\s*(?<content>.+)$/;

export function parseExtractedEntry(line) {
  if (!line) return null;
  const trimmed = line.trim();
  if (!trimmed) return null;
  const m = ENTRY_RE.exec(trimmed);
  if (!m) return null;
  return {
    tag: m.groups.tag,
    confidence: m.groups.confidence,
    slug: m.groups.slug,
    content: m.groups.content.trim(),
    raw: trimmed,
  };
}

/**
 * Parse an LLM response into a list of valid entries. Ignores malformed lines,
 * blank lines, and NOTHING_TO_EXTRACT.
 */
export function parseExtractedBatch(text) {
  if (!text) return [];
  if (text.trim() === 'NOTHING_TO_EXTRACT') return [];
  return text
    .split('\n')
    .map((l) => parseExtractedEntry(l))
    .filter(Boolean);
}
