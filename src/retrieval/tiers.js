/**
 * Trust tiers — hybrid-search spec §4.3 / §4.12 + build-brief §1.
 *
 * A searchable unit's tier is a property of the CHUNK, derived from the raw
 * write_event (its tag + `payload.imported` hint) at cache-build time. Tier is
 * never rolled up to the slug: a topic with a CURATED chunk and a FACT chunk
 * contributes one unit to `curated` and one to `note`.
 *
 *   curated  — distilled, verified truth (Layer 2). The only AUTHORITATIVE tier.
 *   note     — short event-log writes (FACT/DECISION/CHANGED/PROCEDURE/TODO/EVENT).
 *   source   — raw imported material (Layer 3).
 *
 * Retirement (TOPIC_BULLETS_RETIRED) tracks CURATED seqs only; a retired curated
 * seq is EXCLUDED from relevance search entirely (returns null here), reachable
 * only via history mode. note/source have no retirement mechanism today — the
 * "landfill" limitation that keeps `scope=all` off by default (§4.3).
 *
 * This module is a PURE leaf: it imports nothing from the ranker, so the
 * cache-projection builder may use the classifier without violating the
 * no-write call-graph ban (§4.9). The lint targets the ranker
 * (retrieval/index.js + retrieval/semantic.js), not these leaf utilities.
 */

export const TIER_CURATED = 'curated';
export const TIER_NOTE = 'note';
export const TIER_SOURCE = 'source';

/** Display/grouping order: most-trusted first. NOT a rank key in v1 (§4.6). */
export const TIER_ORDER = [TIER_CURATED, TIER_NOTE, TIER_SOURCE];

/** Envelope tier-policy fields (§4.12). The consumer contract is load-bearing. */
export const AUTHORITATIVE_TIERS = [TIER_CURATED];
export const ADVISORY_TIERS = [TIER_NOTE, TIER_SOURCE];
export const MUST_NOT_WRITE_FROM_TIERS = [TIER_NOTE, TIER_SOURCE];

/**
 * Classify a raw log event into a trust tier, or null if it is not a live
 * searchable unit.
 *
 * Mirrors the eligibility predicates in regenerate-topic-file.js exactly
 * (buildLayer2:149-160, buildLayer3:168-175) so lexical, semantic, and Layer 2
 * never drift:
 *   - curated: write_event ∧ tag==='CURATED' ∧ !retired(seq)
 *              ∧ !(imported ∧ imported.field!=='curated')
 *   - source:  write_event ∧ tag==='SOURCE'
 *              ∧ !(imported ∧ imported.field!=='source')
 *   - note:    any other live write_event
 *
 * A CURATED/SOURCE-tagged event whose `imported.field` points elsewhere (an
 * event-log-origin import) is NOT eligible for that tier — it falls through to
 * `note` (advisory), matching buildLayer2/3 excluding it from the curated/source
 * layers. A retired CURATED seq returns null (excluded from relevance search).
 *
 * @param {Object} event - raw log entry: { type, seq, payload:{ tag, imported } }
 * @param {Set<number>} retiredSeqs - state.retired_curated_seqs
 * @returns {('curated'|'note'|'source'|null)}
 */
export function classifyTier(event, retiredSeqs) {
  if (!event || event.type !== 'write_event') return null;
  const tag = event.payload?.tag;
  const imp = event.payload?.imported;

  if (tag === 'CURATED') {
    if (retiredSeqs && retiredSeqs.has(event.seq)) return null; // retired → history-only
    if (imp && imp.field !== 'curated') return TIER_NOTE; // event-log-origin import
    return TIER_CURATED;
  }
  if (tag === 'SOURCE') {
    if (imp && imp.field !== 'source') return TIER_NOTE;
    return TIER_SOURCE;
  }
  // FACT / DECISION / CHANGED / PROCEDURE / TODO / EVENT (or untagged) → note.
  return TIER_NOTE;
}

/**
 * Scope predicate (§4.3). `curated` (default) keeps only the authoritative tier;
 * `all` keeps every live tier (explicit opt-in, off by default until §5's
 * over-trust eval promotes it).
 */
export function tierInScope(tier, scope) {
  if (scope === 'all') return true;
  return tier === TIER_CURATED; // default scope=curated
}
