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

export const ORIENTATION_MAX_N = 50;
export const ORIENTATION_DEFAULT_N = 10;

/**
 * Build a search index from State.topic_index + State.topic_content.
 * Each indexed doc is a "topic summary" for M1 (M2 will move to memory cards).
 */
export function buildIndex(state) {
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
    const content = history.map((h) => h.content).join('\n');
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
export function retrieve({ state, query, mode = 'context_retrieval', principal, flags = [], limit = 10, n }) {
  if (!state) throw new Error('state required');
  if (!principal) throw new Error('principal required');

  switch (mode) {
    case 'exact_lookup':
      return exactLookup(state, query, principal, flags, limit);
    case 'context_retrieval':
      return contextRetrieval(state, query, principal, flags, limit);
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
 * context_retrieval: broader match across content + tags + slug.
 * Deterministic escalation rules per v12.5 §6.2.2.
 */
function contextRetrieval(state, query, principal, flags, limit) {
  const index = buildIndex(state);
  const raw = index.search(query, {
    boost: { slug: 2, tags: 1.5, content: 1 },
    fuzzy: 0.3,
    prefix: true,
    combineWith: 'AND',
  });

  // Relax to OR if AND returned nothing
  const hits = raw.length === 0
    ? index.search(query, { boost: { slug: 2, tags: 1.5, content: 1 }, fuzzy: 0.3, prefix: true, combineWith: 'OR' })
    : raw;

  const authed = hits.filter((hit) => authorize(state, hit.evidence_topics, principal));

  // Escalation rules (v12.5 §6.2.2):
  // - score margin: (s[0] - s[1]) / s[0] < 0.15 → escalate
  // - evidence-count: len(top.evidence_topics) < 2 in context_retrieval → escalate
  // - flags: full_context / exact_wording → escalate
  let escalate = false;
  if (flags.includes('full_context') || flags.includes('exact_wording')) {
    escalate = true;
  } else if (authed.length >= 2) {
    const margin = (authed[0].score - authed[1].score) / authed[0].score;
    if (margin < 0.15) escalate = true;
  }
  if (authed[0] && authed[0].evidence_topics.length < 2) {
    // M1: evidence_topics is always [slug] (single-topic cards). So this fires often.
    // M2 will add multi-topic synthesis cards.
    escalate = true;
  }

  const results = authed.slice(0, limit).map((hit) => ({
    slug: hit.slug,
    score: hit.score,
    last_updated_seq: hit.last_updated_seq,
    tags: [...(hit.tags ? hit.tags.split(' ').filter(Boolean) : [])],
    preview: hit.content_preview,
    content: escalate ? contentFor(state, hit.slug) : undefined,
  }));

  return {
    mode: 'context_retrieval',
    query,
    results,
    escalated: escalate,
  };
}

function contentFor(state, slug) {
  const history = state.topic_content.get(slug);
  if (!history) return null;
  return history
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
