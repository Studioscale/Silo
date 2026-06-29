/**
 * Read-time provenance — hybrid-search spec §4.10.
 *
 * Additive read metadata attached to a retrieval result. NEVER logged, never an
 * audit-safety mechanism (that is the call-graph guard, §4.9). There is no
 * `rollup` field: tier is per-chunk, never rolled up to the slug.
 */

import { canonicalHash } from '../log/canonical.js';

/** Stable digest of a query string (no raw query leaks into provenance). */
export function queryDigest(query) {
  return canonicalHash(typeof query === 'string' ? query : String(query ?? ''));
}

/**
 * @param {Object} args
 * @param {string} args.retriever - 'lexical' | 'semantic' | 'hybrid'
 * @param {Object|null} args.modelConfig - the embedder's model config (or null)
 * @param {Object} args.corpus - { log_head_seq, log_head_hash, cache_manifest_digest }
 * @param {string} args.principal
 * @param {Object} args.retrievalConfig - { rrf_k, n_pre, similarity_floor, tier_order, bounded_prior_cap, chunker_version, chunk_size, chunk_overlap }
 * @param {string} args.query
 * @param {Array} args.perResult - [{ key, lexical_rank?, semantic_rank?, fused_rank, tier }]
 * @param {Array} args.matched - [{ slug, seq, chunk_index, tier, span }]
 * @returns {Object}
 */
export function buildProvenance({
  retriever, modelConfig, corpus, principal, retrievalConfig, query, perResult, matched,
}) {
  return {
    retriever,
    model_id: modelConfig?.model_id ?? null,
    model_revision: modelConfig?.model_revision ?? null,
    engine: {
      transformers_version: modelConfig?.transformers_version ?? null,
      ort_version: modelConfig?.ort_version ?? null,
      dtype: modelConfig?.dtype ?? null,
    },
    corpus: {
      log_head_seq: corpus?.log_head_seq ?? null,
      log_head_hash: corpus?.log_head_hash ?? null,
      cache_manifest_digest: corpus?.cache_manifest_digest ?? null,
    },
    principal,
    retrieval_config: { ...retrievalConfig },
    query_digest: queryDigest(query),
    per_result: perResult ?? [],
    matched: matched ?? [],
  };
}
