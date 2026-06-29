/**
 * Retrieval layer — v12.5 §6.2.
 *
 * Three explicit modes:
 *   - exact_lookup       → "find this specific thing" (card-first, strict escalation)
 *   - context_retrieval  → "most relevant surrounding memory" (default)
 *   - orientation_view   → "show me the map" (metadata-only, ACL-filtered; MAX_N=50)
 *
 * Auth-before-ranking per §6.2.5: authorization filter runs BEFORE scoring.
 * Orientation-filter-before-rank per §6.2.3: ACL applies to candidate set
 * BEFORE top-N ranking; global ranking is never observable through orientation.
 */

import MiniSearch from 'minisearch';
import { tokenize } from '../distill/tokenize.js';
import {
  liveSearchUnits, lexicalRank, semanticRank, loadCache, buildOccMap,
  deriveCacheStatus, N_PRE, SIMILARITY_FLOOR, BOUNDED_PRIOR_CAP,
} from './semantic.js';
import { rrf, RRF_K } from './fusion.js';
import {
  tierInScope, TIER_ORDER, AUTHORITATIVE_TIERS, ADVISORY_TIERS, MUST_NOT_WRITE_FROM_TIERS,
} from './tiers.js';
import { buildProvenance, queryDigest } from './provenance.js';
import { CHUNKER_VERSION, CHUNK_SIZE, CHUNK_OVERLAP } from './chunk.js';
import { stampRetrievalOrigin, RETRIEVAL_ORIGIN_MARKER } from '../admission/retrieval-origin-guard.js';
import { semanticEnabled, getEmbedder, resolveModelKey, modelConfig as resolveModelConfig } from '../embedding/embedder.js';

export const ORIENTATION_MAX_N = 50;
export const ORIENTATION_DEFAULT_N = 10;

/**
 * Normalize a free-text query before lexical search: drop stop-words / very
 * short tokens via Silo's shared tokenizer, so signal terms aren't drowned by
 * function words in the AND→OR fallback. Falls back to the raw query when
 * everything was filtered (an all-stop-word query, or a bare slug).
 *
 * Measured on LongMemEval (eval/longmemeval/): lifts session recall_any@5 from
 * 76%→91% (_S, official scorer), at zero added dependency. Lexical retrieval
 * still trails semantic — more so on large histories and on the strict
 * recall_all metric. Applied to context_retrieval (natural-language "relevant
 * memory" queries); exact_lookup keeps the raw query for precise slug/term
 * matching.
 */
export function normalizeQuery(query) {
  if (typeof query !== 'string') return query;
  const kw = tokenize(query).join(' ');
  return kw || query;
}

/**
 * Build a per-TOPIC search index from State.topic_index + State.topic_content,
 * used by exact_lookup (card-first "find this specific thing"). Per-unit lexical
 * search for context_retrieval lives in semantic.js#lexicalRank.
 *
 * #17 (standalone, hybrid-search §6): retired CURATED seqs are EXCLUDED from the
 * indexed content — a retired bullet must not surface in keyword search. This is
 * a behavior change for everyone; documented in CHANGELOG. exact_lookup keeps its
 * per-topic shape otherwise.
 */
export function buildIndex(state) {
  const retired = state.retired_curated_seqs ?? new Set();
  const index = new MiniSearch({
    fields: ['slug', 'content', 'tags'],
    storeFields: ['slug', 'last_updated_seq', 'tags', 'evidence_topics', 'content_preview'],
    searchOptions: {
      boost: { slug: 3, content: 1 }, // slug match weighted highest for exact_lookup
      fuzzy: 0.2,
    },
  });

  const docs = [];
  for (const [slug, meta] of state.topic_index.entries()) {
    const history = state.topic_content.get(slug) ?? [];
    const content = history
      .filter((h) => !retired.has(h.seq)) // #17: retired bullets never surface
      .map((h) => h.content)
      .join('\n');
    docs.push({
      id: slug,
      slug,
      content,
      content_preview: content.slice(0, 240),
      tags: [...meta.tags].join(' '),
      last_updated_seq: meta.last_updated_seq,
      evidence_topics: [slug], // per-topic cards for M1; synthesis cards come in M2
    });
  }
  index.addAll(docs);
  return index;
}

/**
 * Authorize a candidate doc against requesting principal's ACL.
 * v12.5 §5.3: intersection of current_readers_of_topic across evidence_topics.
 */
function authorize(state, evidenceTopics, requestingPrincipal) {
  if (!evidenceTopics || evidenceTopics.length === 0) return false; // v12.5 empty-topics reject
  let intersection = null;
  for (const topic of evidenceTopics) {
    const readers = state.acl_table.get(topic);
    if (!readers) return false; // topic missing from ACL table: fail closed
    if (intersection === null) {
      intersection = new Set(readers);
    } else {
      for (const r of intersection) {
        if (!readers.has(r)) intersection.delete(r);
      }
    }
    if (intersection.size === 0) return false;
  }
  return intersection.has(requestingPrincipal);
}

/**
 * Default retrieval entry point. Dispatches to mode.
 *
 * @param {Object} args
 * @param {Object} args.state - interpret() output
 * @param {string} args.query
 * @param {string} args.mode - 'exact_lookup' | 'context_retrieval' | 'orientation_view'
 * @param {string} args.principal - requesting principal (for auth)
 * @param {string[]} [args.flags] - retrieval flags per §6.2 (full_context, exact_wording, ...)
 * @param {number} [args.limit]
 * @returns {Object} { mode, results, query }
 */
export function retrieve({ state, query, mode = 'context_retrieval', principal, flags = [], limit = 10, n, scope = 'curated', siloDir, env }) {
  if (!state) throw new Error('state required');
  if (!principal) throw new Error('principal required');

  switch (mode) {
    case 'exact_lookup':
      return exactLookup(state, query, principal, flags, limit);
    case 'context_retrieval':
      return contextRetrieval(state, query, principal, flags, limit, { scope, siloDir, env });
    case 'orientation_view':
      return orientationView(state, principal, { n: n ?? limit });
    default:
      throw new Error(`unknown retrieval mode: ${mode}`);
  }
}

/**
 * exact_lookup: slug/title/tag exact match preferred. Narrow fuzzy fallback.
 * Escalation only on full_context / exact_wording flags (per §6.2.1).
 */
function exactLookup(state, query, principal, flags, limit) {
  const index = buildIndex(state);
  // Tighter search params for exact lookup: prefix match, no heavy fuzzy
  const raw = index.search(query, {
    boost: { slug: 5, tags: 2, content: 0.5 },
    fuzzy: 0.1,
    prefix: true,
  });

  // Auth-before-ranking: filter first
  const authed = raw.filter((hit) => authorize(state, hit.evidence_topics, principal));

  const escalate =
    flags.includes('full_context') || flags.includes('exact_wording') || flags.includes('exact_source');

  const results = authed.slice(0, limit).map((hit) => ({
    slug: hit.slug,
    score: hit.score,
    last_updated_seq: hit.last_updated_seq,
    tags: [...(hit.tags ? hit.tags.split(' ').filter(Boolean) : [])],
    preview: hit.content_preview,
    // full content returned only when escalation flag present
    content: escalate ? contentFor(state, hit.slug) : undefined,
  }));

  return {
    mode: 'exact_lookup',
    query,
    results,
    escalated: escalate,
  };
}

/**
 * Shared assembler for context_retrieval (hybrid-search §4.5–§4.7, §4.10, §4.12).
 *
 * Drives the candidate set from current State (per-unit, retired excluded), applies
 * ACL once per slug then scope, runs the lexical arm, intersects a (possibly empty)
 * semantic arm, fuses via RRF, and emits the tiered envelope. Tier is a LABEL +
 * bounded prior whose v1 cap is 0 — order is pure fused relevance. Every result and
 * the envelope are stamped with the retrieval-origin marker (§4.9 choke-point).
 */
function assembleContext({
  state, query, principal, flags, limit, scope,
  enabled, occMap, cache, semantic, semantic_status, cache_status, modelCfg, corpus, retriever,
}) {
  const digest = queryDigest(query);

  let units = liveSearchUnits(state, occMap);

  // ACL once per slug (§4.5), BEFORE ranking.
  const slugAllowed = new Map();
  units = units.filter((u) => {
    if (!slugAllowed.has(u.slug)) slugAllowed.set(u.slug, authorize(state, [u.slug], principal));
    return slugAllowed.get(u.slug);
  });

  // scope filter — meaningful only when tiers are real (semantic enabled). When
  // disabled, behave "as today": return all keyword matches (§3 off-path).
  if (enabled) units = units.filter((u) => tierInScope(u.tier, scope));

  const unitByKey = new Map(units.map((u) => [u.key, u]));

  // Lexical arm (always). Semantic arm intersected with the ACL/scope-filtered set.
  const L = lexicalRank(units, normalizeQuery(query));
  const sRanked = (semantic?.ranked ?? []).filter((k) => unitByKey.has(k));
  const sScores = semantic?.scores ?? new Map();
  const fused = sRanked.length ? rrf({ L, S: sRanked }) : rrf({ L });

  const escalate = flags.includes('full_context') || flags.includes('exact_wording');

  // best curated fused-rank, for the "lower tier outranks curated" display marker.
  let bestCuratedRank = Infinity;
  for (let i = 0; i < fused.length; i++) {
    const u = unitByKey.get(fused[i].key);
    if (u && u.tier === 'curated') { bestCuratedRank = i + 1; break; }
  }

  const results = fused.slice(0, limit).map((f, i) => {
    const u = unitByKey.get(f.key);
    const fusedRank = i + 1;
    return stampRetrievalOrigin({
      slug: u.slug, seq: u.seq, chunk_index: u.chunk_index, tier: u.tier,
      score: f.score,
      fused_rank: fusedRank,
      lexical_rank: f.ranks.L ?? null,
      semantic_rank: f.ranks.S ?? null,
      similarity: sScores.has(f.key) ? sScores.get(f.key) : null,
      snippet: u.content.slice(0, 240),
      content: escalate ? u.content : undefined,
      tier_outranks_curated: u.tier !== 'curated' && fusedRank < bestCuratedRank,
    }, digest);
  });

  const grouped = {};
  for (const t of TIER_ORDER) grouped[t] = [];
  for (const r of results) (grouped[r.tier] ?? (grouped[r.tier] = [])).push(r);

  const provenance = buildProvenance({
    retriever, modelConfig: modelCfg, corpus, principal,
    retrievalConfig: {
      rrf_k: RRF_K, n_pre: N_PRE, similarity_floor: SIMILARITY_FLOOR,
      tier_order: TIER_ORDER, bounded_prior_cap: BOUNDED_PRIOR_CAP,
      chunker_version: CHUNKER_VERSION, chunk_size: CHUNK_SIZE, chunk_overlap: CHUNK_OVERLAP,
    },
    query,
    perResult: results.map((r) => ({
      key: `${r.slug}::${r.seq}::${r.chunk_index}`,
      lexical_rank: r.lexical_rank, semantic_rank: r.semantic_rank,
      fused_rank: r.fused_rank, tier: r.tier,
    })),
    matched: results.map((r) => {
      const u = unitByKey.get(`${r.slug}::${r.seq}::${r.chunk_index}`);
      return { slug: r.slug, seq: r.seq, chunk_index: r.chunk_index, tier: r.tier, span: u?.span ?? null };
    }),
  });

  return stampRetrievalOrigin({
    mode: 'context_retrieval',
    query, scope,
    results,
    grouped_by_tier: grouped,
    fused_rank: results.map((r) => `${r.slug}::${r.seq}::${r.chunk_index}`),
    authoritative_tiers: AUTHORITATIVE_TIERS,
    advisory_tiers: ADVISORY_TIERS,
    must_not_write_from_tiers: MUST_NOT_WRITE_FROM_TIERS,
    semantic_status,
    cache_status,
    bounded_prior_cap: BOUNDED_PRIOR_CAP,
    escalated: escalate,
    provenance,
  }, digest);
}

/**
 * context_retrieval (SYNC) — the lexical entry. Used by retrieve() and all legacy
 * callers. The semantic arm is never run here (it is async); when the triple gate
 * is open this returns keyword-only with semantic_status='disabled'. For the
 * hybrid path use contextRetrievalHybrid().
 */
function contextRetrieval(state, query, principal, flags, limit, opts = {}) {
  const { scope = 'curated', siloDir, env = process.env } = opts;
  const enabled = semanticEnabled({ siloDir, env });
  return assembleContext({
    state, query, principal, flags, limit, scope,
    enabled,
    occMap: null, cache: null, semantic: null,
    semantic_status: enabled ? 'unavailable' : 'disabled',
    cache_status: 'missing',
    modelCfg: null,
    corpus: {
      log_head_seq: state.last_seq ?? null,
      log_head_hash: state.tail_hash ?? null,
      cache_manifest_digest: null,
    },
    retriever: 'lexical',
  });
}

/**
 * context_retrieval (ASYNC) — hybrid when the triple gate is open. Loads the cache
 * + embedder, runs both arms, fuses. The ENTIRE semantic block is wrapped so any
 * error degrades to lexical with semantic_status='degraded' (§4.8). When the gate
 * is closed it delegates to the sync lexical path.
 */
export async function contextRetrievalHybrid({
  state, query, principal, flags = [], limit = 10, scope = 'curated',
  siloDir, env = process.env, embedder, cache,
}) {
  if (!state) throw new Error('state required');
  if (!principal) throw new Error('principal required');

  const enabled = semanticEnabled({ siloDir, env });
  if (!enabled) {
    return contextRetrieval(state, query, principal, flags, limit, { scope, siloDir, env });
  }

  // Model config comes from the actual embedder when one is injected (tests +
  // correctness — the cache identity must match the model that built it);
  // otherwise resolve from the install marker.
  const modelKey = resolveModelKey({ siloDir, env });
  const modelCfg = embedder?.config ?? (modelKey ? resolveModelConfig(modelKey, { siloDir }) : null);

  try {
    const theCache = cache ?? (await loadCache(siloDir));
    const occMap = buildOccMap(theCache);
    const liveUnits = liveSearchUnits(state, occMap);
    const cache_status = deriveCacheStatus({ cache: theCache, liveUnits, state, modelConfig: modelCfg });

    const emb = embedder ?? (await getEmbedder({ siloDir, env }));
    let semantic = { ranked: [], scores: new Map() };
    let semantic_status = 'ready';
    if (!emb) {
      semantic_status = 'unavailable';
    } else if (cache_status === 'missing' || cache_status === 'stale') {
      // Embedder present but the store is unusable → semantic arm contributes
      // nothing; search degrades to lexical until regenerate runs (§4.12).
      semantic_status = 'ready';
    } else {
      const scopedUnits = liveUnits.filter((u) => tierInScope(u.tier, scope));
      semantic = await semanticRank(scopedUnits, query, theCache, emb);
    }

    return assembleContext({
      state, query, principal, flags, limit, scope,
      enabled, occMap, cache: theCache, semantic, semantic_status, cache_status, modelCfg,
      corpus: {
        log_head_seq: state.last_seq ?? null,
        log_head_hash: state.tail_hash ?? null,
        cache_manifest_digest: theCache?.manifest?.identity_digest ?? null,
      },
      retriever: semantic.ranked.length ? 'hybrid' : 'lexical',
    });
  } catch (err) {
    // §4.8 — the whole semantic block failed; fall back to lexical, mark degraded.
    const lex = contextRetrieval(state, query, principal, flags, limit, { scope, siloDir, env });
    lex.semantic_status = 'degraded';
    return lex;
  }
}

function contentFor(state, slug) {
  const history = state.topic_content.get(slug);
  if (!history) return null;
  const retired = state.retired_curated_seqs ?? new Set();
  return history
    .filter((h) => !retired.has(h.seq)) // #17: retired bullets never surface
    .map((h) => `[seq ${h.seq}] [${h.tag ?? 'EVENT'}] ${h.content}`)
    .join('\n');
}

/**
 * orientation_view (v12.5 §6.2.3): "show me the map."
 *
 * Metadata-only, never returns Layer 2/3 content. ACL filter is applied to the
 * candidate set BEFORE top-N ranking so global ordering is never observable.
 * N is clamped to ORIENTATION_MAX_N (50); default is 10. Aggregates (tags,
 * entities, seq-range) are computed only over the caller-authorized source set.
 *
 * Returned fields per topic: slug, topic_type, topic_tags, topic_entities,
 * topic_summary, topic_status, topic_sensitivity, last_updated_seq,
 * last_verified_ts, last_curated_ts, event_tags (union of tags seen on writes).
 * Explicitly NOT returned: content, previews, history.
 */
function orientationView(state, principal, { n = ORIENTATION_DEFAULT_N } = {}) {
  const requested = Number.isFinite(n) ? n : ORIENTATION_DEFAULT_N;
  const clamped = Math.min(Math.max(1, requested), ORIENTATION_MAX_N);
  const maxNEnforced = requested > ORIENTATION_MAX_N;

  // Filter candidates by ACL BEFORE ranking (§6.2.3).
  const accessible = [];
  for (const [slug, meta] of state.topic_index.entries()) {
    if (!authorize(state, [slug], principal)) continue;
    accessible.push({ slug, meta });
  }

  // Rank by last_updated_seq desc (proxy for recent write-rate in M2).
  // Tiebreak alphabetically for deterministic output.
  accessible.sort((a, b) => {
    const sa = a.meta.last_updated_seq ?? 0;
    const sb = b.meta.last_updated_seq ?? 0;
    if (sb !== sa) return sb - sa;
    return a.slug.localeCompare(b.slug);
  });

  const top = accessible.slice(0, clamped);

  // Aggregates computed over ACL-accessible source set only (§6.2.3)
  const tagCounts = new Map();
  const entityCounts = new Map();
  let minSeq = Infinity;
  let maxSeq = -Infinity;
  for (const { meta } of accessible) {
    for (const t of meta.tags ?? []) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
    for (const t of meta.topic_tags ?? []) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
    for (const e of meta.topic_entities ?? []) entityCounts.set(e, (entityCounts.get(e) ?? 0) + 1);
    const s = meta.last_updated_seq ?? 0;
    if (s && s < minSeq) minSeq = s;
    if (s && s > maxSeq) maxSeq = s;
  }

  const topics = top.map(({ slug, meta }) => ({
    slug,
    topic_type: meta.topic_type ?? null,
    topic_tags: meta.topic_tags ? [...meta.topic_tags] : [],
    topic_entities: meta.topic_entities ? [...meta.topic_entities] : [],
    topic_summary: meta.topic_summary ?? null,
    topic_status: meta.topic_status ?? null,
    topic_sensitivity: meta.topic_sensitivity ?? null,
    last_updated_seq: meta.last_updated_seq ?? null,
    last_verified_ts: meta.last_verified_ts ?? null,
    last_curated_ts: meta.last_curated_ts ?? null,
    event_tags: meta.tags ? [...meta.tags] : [],
  }));

  return {
    mode: 'orientation_view',
    topics,
    aggregates: {
      tag_distribution: sortedTopN(tagCounts, ORIENTATION_MAX_N),
      entity_distribution: sortedTopN(entityCounts, ORIENTATION_MAX_N),
      seq_range:
        minSeq === Infinity
          ? { min: null, max: null }
          : { min: minSeq, max: maxSeq },
    },
    accessible_slice_count: accessible.length,
    n_requested: requested,
    n_returned: topics.length,
    max_n_enforced: maxNEnforced,
  };
}

function sortedTopN(countMap, n) {
  return [...countMap.entries()]
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([name, count]) => ({ name, count }));
}
