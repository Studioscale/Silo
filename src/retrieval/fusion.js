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
 * Fuse one or more ranked arms.
 *
 * @param {Object<string, string[]>} arms - e.g. { L: [key,...], S: [key,...] }
 *        each a list of unit keys in rank order (index 0 = rank 1).
 * @param {Object} [opts]
 * @param {number} [opts.k=RRF_K]
 * @returns {Array<{ key:string, score:number, ranks:Object<string,number> }>}
 *          sorted by fused score desc, key asc as tiebreak.
 */
export function rrf(arms, { k = RRF_K } = {}) {
  const acc = new Map(); // key -> { key, score, ranks }
  for (const armName of Object.keys(arms)) {
    const list = arms[armName];
    if (!Array.isArray(list)) continue;
    for (let i = 0; i < list.length; i++) {
      const key = list[i];
      const rank = i + 1; // 1-based
      let cur = acc.get(key);
      if (!cur) {
        cur = { key, score: 0, ranks: {} };
        acc.set(key, cur);
      }
      cur.score += 1 / (k + rank);
      cur.ranks[armName] = rank;
    }
  }
  return [...acc.values()].sort(
    (a, b) => (b.score - a.score) || String(a.key).localeCompare(String(b.key)),
  );
}
