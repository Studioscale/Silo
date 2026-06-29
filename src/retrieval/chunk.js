/**
 * Chunking — hybrid-search spec §4.11. Per-`seq`, fixed-window only.
 *
 * "1 seq = 1 unit." A unit (one write_event's content) whose token estimate is
 * ≤ max_tokens becomes a single chunk (chunk_index=0). Only a unit that EXCEEDS
 * max_tokens is split by a fixed chunk_size/chunk_overlap token window — and the
 * split NEVER crosses a seq boundary (no Frankenstein chunks across events). No
 * sentence-aware path: the window is purely positional, for determinism.
 *
 * Determinism note: the model's own subword tokenizer is an optional native dep
 * (and its hash is a *separate* identity-manifest field, `tokenizer_hash`). The
 * chunk WINDOW must be computable with zero native deps — on every platform, in
 * tests, and on the lexical-only path — so this module uses its own deterministic
 * positional tokenizer (Unicode-word + standalone-punct runs). It is an estimate
 * of model tokens, deliberately conservative; because chunk_size/chunk_overlap/
 * max_tokens/CHUNKER_VERSION are identity-manifest fields, any change to this
 * algorithm rebuilds the whole vector store, so the estimate need only be stable,
 * not exact.
 */

// Identity-manifest fields (spec §4.4/§4.11). Changing ANY of these (incl.
// CHUNKER_VERSION) invalidates every cached vector → full rebuild.
export const CHUNKER_VERSION = 'fixed-window-v1';
export const MAX_TOKENS = 512;
export const CHUNK_SIZE = 256;
export const CHUNK_OVERLAP = 64;

/**
 * Deterministic positional tokenizer used ONLY for chunk-window boundaries.
 * Returns tokens with their char spans so provenance can carry token+char
 * offsets (§4.10/§4.11). A "token" is a run of word characters (Unicode-aware,
 * includes PT-BR accents + digits + underscore) OR a single non-space punct char.
 *
 * @param {string} text
 * @returns {Array<{ text:string, char_start:number, char_end:number }>}
 */
export function positionalTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const tokens = [];
  // \p{L}\p{N} keeps Unicode letters/numbers together as one token; a lone
  // non-space, non-word char (punctuation/symbol) is its own token.
  const re = /[\p{L}\p{N}_]+|[^\s]/gu;
  let m;
  while ((m = re.exec(text)) !== null) {
    tokens.push({ text: m[0], char_start: m.index, char_end: m.index + m[0].length });
  }
  return tokens;
}

/** Token count estimate for a unit (used by the cache builder + doctor). */
export function estimateTokens(text) {
  return positionalTokens(text).length;
}

/**
 * Chunk one unit's text into one or more chunks, per §4.11.
 *
 * @param {string} text - the write_event content for a single seq
 * @returns {Array<{ chunk_index:number, content:string, span:{
 *            token_start:number, token_end:number,
 *            char_start:number, char_end:number } }>}
 */
export function chunkUnit(text) {
  const src = typeof text === 'string' ? text : String(text ?? '');
  const tokens = positionalTokens(src);
  const n = tokens.length;

  // Empty unit → still emit one (empty) chunk so the occurrence is representable.
  if (n === 0) {
    return [{
      chunk_index: 0,
      content: src,
      span: { token_start: 0, token_end: 0, char_start: 0, char_end: src.length },
    }];
  }

  // Below the ceiling → exactly one chunk carrying the whole unit verbatim.
  if (n <= MAX_TOKENS) {
    return [{
      chunk_index: 0,
      content: src,
      span: { token_start: 0, token_end: n, char_start: 0, char_end: src.length },
    }];
  }

  // Oversized unit → fixed-window split, never crossing this seq's boundary.
  const chunks = [];
  const step = CHUNK_SIZE - CHUNK_OVERLAP; // 192
  let chunkIndex = 0;
  for (let start = 0; start < n; start += step) {
    const end = Math.min(start + CHUNK_SIZE, n);
    const charStart = tokens[start].char_start;
    const charEnd = tokens[end - 1].char_end;
    chunks.push({
      chunk_index: chunkIndex++,
      content: src.slice(charStart, charEnd),
      span: { token_start: start, token_end: end, char_start: charStart, char_end: charEnd },
    });
    if (end >= n) break; // last window reached the end; stop (avoid a tail dup)
  }
  return chunks;
}
