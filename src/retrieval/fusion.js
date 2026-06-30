/**
 * Reciprocal Rank Fusion — hybrid-search spec §4.6.
 *
 * rrf(u) = Σ_{arm where u present} 1 / (k + rank_arm(u))
 *   - k = 60, ranks are 1-BASED.
 *   - An ABSENT arm is OMITTED from the sum (NOT rank-0, NOT a penalty) — the
 *     standard RRF. A semantic-only unit fuses on its semantic term alone.
 *
 * Tier is NOT a fusion input (§4.6): primary order is pure fused relevance. Tier
 * is applied later as a LABEL plus a bounded prior whose v1 cap is 0 (zero
 * ranking effect). Deterministic tiebreak on the unit key keeps output stable.
 */

export const RRF_K = 60;

/**
 * Lexical-arm fusion weight (the semantic arm is 1.0). Tuned off-prod on
 * LongMemEval (resumable harness, re-fused offline from stored per-arm rankings):
 * at full weight (1.0) the lexical arm added enough RRF noise that hybrid sat
 * just BELOW semantic-alone; down-weighting it lands on a wide, flat plateau
 * (w_L ∈ [0.15, 0.8] all gave the same recall_all@5) where hybrid BEATS both
 * semantic-alone and the equal-weight hybrid. 0.5 is the conservative midpoint of
 * that plateau — the lexical arm still contributes at HALF weight (not zeroed), so
 * exact-term matches (part numbers, names — which LongMemEval doesn't probe but
 * real Silo queries hit) keep their pull; see test/hybrid-search.test.js exact-term
 * cases. A small, deliberate down-weight, not a benchmark over-fit.
 */
export const LEXICAL_FUSION_WEIGHT = 0.5;

/** Default per-arm weights for the product ranker (lexical down-weighted). */
export const DEFAULT_ARM_WEIGHTS = { L: LEXICAL_FUSION_WEIGHT, S: 1 };

/**
 * Fuse one or more ranked arms with optional per-arm weights.
 *
 *   score(u) = Σ_{arm where u present} w_arm / (k + rank_arm(u))
 *
 * @param {Object<string, string[]>} arms - e.g. { L: [key,...], S: [key,...] }
 *        each a list of unit keys in rank order (index 0 = rank 1).
 * @param {Object} [opts]
 * @param {number} [opts.k=RRF_K]
 * @param {Object<string, number>} [opts.weights] - per-arm weight; missing → 1.
 *        Omit entirely to fuse with equal weights (standard RRF).
 * @returns {Array<{ key:string, score:number, ranks:Object<string,number> }>}
 *          sorted by fused score desc, key asc as tiebreak.
 */
export function rrf(arms, { k = RRF_K, weights } = {}) {
  const acc = new Map(); // key -> { key, score, ranks }
  for (const armName of Object.keys(arms)) {
    const list = arms[armName];
    if (!Array.isArray(list)) continue;
    const w = weights && weights[armName] != null ? weights[armName] : 1;
    for (let i = 0; i < list.length; i++) {
      const key = list[i];
      const rank = i + 1; // 1-based
      let cur = acc.get(key);
      if (!cur) {
        cur = { key, score: 0, ranks: {} };
        acc.set(key, cur);
      }
      cur.score += w / (k + rank);
      cur.ranks[armName] = rank;
    }
  }
  return [...acc.values()].sort(
    (a, b) => (b.score - a.score) || String(a.key).localeCompare(String(b.key)),
  );
}
