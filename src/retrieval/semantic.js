/**
 * Search ranker — hybrid-search spec §4.3/§4.5/§4.6 + build-brief §1/§3.
 *
 * THE RANKER. This is the module the no-write call-graph ban targets: write/
 * curate/distill modules may NOT import this (or retrieval/index.js). It produces
 * retrieval *results*; it never writes.
 *
 * Candidate set is driven from current State (live seqs, retired excluded), and
 * each unit's tier + vector are obtained by LOOKUP in the cache's occurrence
 * index — the cache is never enumerated as a candidate source (§4.4), so a seq
 * retired after the last regenerate can never re-surface. Chunk text is re-derived
 * deterministically from State content (same chunker → same (seq,chunk_index) key
 * and same vector_key as the cache builder produced).
 */

import MiniSearch from 'minisearch';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { chunkUnit } from './chunk.js';
import { classifyTier, TIER_CURATED, TIER_SOURCE, TIER_NOTE } from './tiers.js';
import { rrf } from './fusion.js';
import { buildIdentityManifest, identityDigest } from '../projection/embed-cache.js';

// Fusion / candidate knobs (§4.6). Surfaced in provenance.
export const N_PRE = 100;
export const SIMILARITY_FLOOR = 0.30;
export const BOUNDED_PRIOR_CAP = 0; // v1: tier is a pure label, zero ranking effect

const CACHE_RELPATH = join('projections', 'embeddings.json');

/** Load the embedding cache from disk; null if absent/unreadable. */
export async function loadCache(siloDir) {
  if (!siloDir) return null;
  try {
    const raw = await fs.readFile(join(siloDir, CACHE_RELPATH), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Build the occurrence lookup: `${slug}::${seq}::${chunk_index}` → {tier, vector_key, span}. */
export function buildOccMap(cache) {
  const m = new Map();
  if (!cache || !Array.isArray(cache.occurrences)) return m;
  for (const o of cache.occurrences) {
    m.set(`${o.slug}::${o.seq}::${o.chunk_index}`, {
      tier: o.tier, vector_key: o.vector_key, span: o.span,
    });
  }
  return m;
}

/**
 * Coarse tier fallback when a current-live chunk is not (yet) in the cache's
 * occurrence index (partial cache). Uses the State tag only — it cannot see
 * payload.imported, so it is an approximation of the precise tier the cache
 * builder assigns; the precise tier always wins when the occurrence is cached.
 */
function coarseTier(tag, seq, retired) {
  if (tag === 'CURATED') return retired.has(seq) ? null : TIER_CURATED;
  if (tag === 'SOURCE') return TIER_SOURCE;
  return TIER_NOTE;
}

/**
 * Enumerate the live, rankable chunk units from State.
 *
 * @param {Object} state
 * @param {Map} [occMap] - occurrence lookup from the cache (precise tier+vector)
 * @returns {Array<{ key, slug, seq, chunk_index, tier, content, vector_key }>}
 */
export function liveSearchUnits(state, occMap = null) {
  const retired = state?.retired_curated_seqs ?? new Set();
  const content = state?.topic_content ?? new Map();
  const units = [];
  for (const [slug, history] of content.entries()) {
    for (const ev of history) {
      if (retired.has(ev.seq)) continue; // retired curated → history-only
      const chunks = chunkUnit(typeof ev.content === 'string' ? ev.content : String(ev.content ?? ''));
      for (const chunk of chunks) {
        const key = `${slug}::${ev.seq}::${chunk.chunk_index}`;
        const occ = occMap ? occMap.get(key) : null;
        const tier = occ?.tier ?? coarseTier(ev.tag, ev.seq, retired);
        if (!tier) continue; // belt-and-suspenders: retired
        units.push({
          key, slug, seq: ev.seq, chunk_index: chunk.chunk_index,
          tier, content: chunk.content, vector_key: occ?.vector_key ?? null,
          span: occ?.span ?? chunk.span,
        });
      }
    }
  }
  return units;
}

/** cosine of two L2-normalized vectors = dot product. */
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

/**
 * Lexical arm — MiniSearch over per-unit text (#17: per-unit, retired already
 * excluded by liveSearchUnits). Returns up to n_pre unit keys in rank order.
 */
export function lexicalRank(units, normalizedQuery, { nPre = N_PRE } = {}) {
  if (units.length === 0 || !normalizedQuery) return [];
  const index = new MiniSearch({
    fields: ['content', 'slug'],
    storeFields: ['key'],
    idField: 'key',
  });
  index.addAll(units.map((u) => ({ key: u.key, content: u.content, slug: u.slug })));
  const opts = { boost: { slug: 2, content: 1 }, fuzzy: 0.3, prefix: true, combineWith: 'AND' };
  let hits = index.search(normalizedQuery, opts);
  if (hits.length === 0) hits = index.search(normalizedQuery, { ...opts, combineWith: 'OR' });
  return hits.slice(0, nPre).map((h) => h.key);
}

/**
 * Semantic arm — cosine of the query vector against each unit's cached vector.
 * Units below similarity_floor are dropped (§4.6). Returns up to n_pre keys.
 *
 * @returns {Promise<{ ranked: string[], scores: Map<string,number> }>}
 */
export async function semanticRank(units, query, cache, embedder, { floor = SIMILARITY_FLOOR, nPre = N_PRE } = {}) {
  if (!embedder || !cache || units.length === 0) return { ranked: [], scores: new Map() };
  const [qvec] = await embedder.embed([query], 'query');
  const scored = [];
  const scores = new Map();
  for (const u of units) {
    if (!u.vector_key) continue;
    const vec = cache.vectors?.[u.vector_key];
    if (!vec) continue;
    const sim = cosine(qvec, vec);
    if (sim < floor) continue;
    scored.push({ key: u.key, sim });
    scores.set(u.key, sim);
  }
  scored.sort((a, b) => (b.sim - a.sim) || a.key.localeCompare(b.key));
  return { ranked: scored.slice(0, nPre).map((s) => s.key), scores };
}

/**
 * Derive cache_status (§4.12, first match wins) for the CURRENT model config.
 *   missing → no store; stale → identity mismatch (unusable); partial → identity
 *   OK but freshness drift OR ≥1 live chunk has no vector; fresh → all present.
 */
export function deriveCacheStatus({ cache, liveUnits, state, modelConfig }) {
  if (!cache || !cache.manifest) return 'missing';
  // identity: does the store's model/engine/chunker identity match what we'd build now?
  if (modelConfig) {
    const currentDigest = identityDigest(buildIdentityManifest(modelConfig));
    if (cache.manifest.identity_digest !== currentDigest) return 'stale';
  }
  // freshness: log head moved?
  const headSeq = state?.last_seq ?? 0;
  const headDrift = (cache.manifest.freshness?.log_head_seq ?? -1) !== headSeq;
  // any current live chunk missing a vector?
  let anyMissing = false;
  for (const u of liveUnits) {
    if (!u.vector_key || !cache.vectors?.[u.vector_key]) { anyMissing = true; break; }
  }
  if (headDrift || anyMissing) return 'partial';
  return 'fresh';
}

/**
 * Re-classify a raw event's tier (re-export of the shared predicate so callers
 * that hold raw events — e.g. history mode — share one definition).
 */
export { classifyTier };
