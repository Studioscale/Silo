/**
 * Deterministic mock embedder for logic tests (build-brief §2). Hash-seeded
 * fixed vectors — no native dep, fully reproducible. Mirrors the flock-test
 * gating idea: real-encoder tests gate on hasEmbedderSupport(); everything else
 * uses this mock so the 594+ suite runs anywhere.
 *
 * Exposes the same surface as a real getEmbedder() result:
 *   { modelKey, modelId, modelRevision, dims, config, embed(texts, kind) }
 *
 * `vectorFor(text, kind)` lets a test pin specific vectors (e.g. to make two
 * texts deliberately similar/dissimilar for ranking assertions); otherwise a
 * sha256-seeded pseudo-random unit vector is produced.
 */

import { createHash } from 'node:crypto';

const MOCK_CONFIG = {
  model_id: 'mock/test-embedder',
  transformers_id: 'mock/test-embedder',
  model_revision: 'mock-rev-1',
  dims: 8,
  dtype: 'q8',
  pooling: 'mean',
  normalize: true,
  doc_prefix: 'passage: ',
  query_prefix: 'query: ',
  tokenizer_hash: 'mock-tok-1',
  transformers_version: 'mock-tf-1',
  ort_version: 'mock-ort-1',
};

function l2normalize(v) {
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  return v.map((x) => x / norm);
}

export function hashVector(text, dims) {
  const v = new Array(dims);
  for (let i = 0; i < dims; i++) {
    const h = createHash('sha256').update(`${i}:${text}`).digest();
    // map first 4 bytes to a value in [-1, 1]
    const n = h.readUInt32BE(0) / 0xffffffff;
    v[i] = n * 2 - 1;
  }
  return l2normalize(v);
}

export function makeMockEmbedder({ dims = 8, vectorFor, config } = {}) {
  const cfg = { ...MOCK_CONFIG, dims, ...(config || {}) };
  return {
    modelKey: 'mock',
    modelId: cfg.model_id,
    modelRevision: cfg.model_revision,
    dims,
    config: cfg,
    async embed(texts, kind = 'passage') {
      const arr = Array.isArray(texts) ? texts : [texts];
      return arr.map((t) => {
        if (vectorFor) {
          const custom = vectorFor(t, kind);
          if (custom) return l2normalize(custom);
        }
        return hashVector(t, dims);
      });
    },
  };
}
