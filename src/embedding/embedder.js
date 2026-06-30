/**
 * Embedder primitive — hybrid-search spec §4.1 / §4.2 + build-brief §3.
 *
 * The local embedding model pipeline: triple-gate loader, pinned model registry,
 * prefix profiles, and `embed(text) → vector`. This is the PRIMITIVE — shared,
 * importable by the cache-projection builder AND the search ranker (it embeds the
 * QUERY at search time). It embeds text into vectors; it never ranks, never reads
 * a retrieval result, and never writes the log. It is therefore outside the
 * no-write call-graph ban (§4.9) — that ban targets the ranker.
 *
 * Strictly opt-in (§4.1, triple gate): all three must hold for `semanticEnabled()`
 *   1. deps installed + model vendored via `silo semantic install`
 *      (recorded in <siloDir>/semantic/install.json),
 *   2. SILO_SEMANTIC=on,
 *   3. a model explicitly chosen (recorded in install.json; or, as a documented
 *      dev/test escape hatch, SILO_SEMANTIC_MODEL).
 * The embedding deps are NOT in package.json — they install on demand. When any
 * gate is open the cache projection + semantic arm are a zero-cost no-op.
 *
 * Degrade-on-missing (copied from log/file-lock.js:29-43, NOT the auto-install
 * half): the native lib (`@xenova/transformers`) loads via dynamic import inside
 * try/catch; on failure `getEmbedder()` resolves null and `hasEmbedderSupport()`
 * reports false, so logic tests run with no native dep and search degrades to
 * lexical (§4.8).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Pinned model registry (§4.2). Explicit choice at install time — no silent
 * default. Each entry pins the transformers id + revision + prefix profile +
 * pooling/normalize/dtype. Both are 384-dim, q8, mean-pooled, L2-normalized.
 *
 * Prefix profiles are load-bearing: the WRONG prefix silently wrecks recall
 * (§4.2, test §8). e5 uses symmetric `query:`/`passage:` prefixes; bge uses a
 * query-side instruction and NO document prefix.
 */
export const MODEL_REGISTRY = {
  'multilingual-e5-small': {
    key: 'multilingual-e5-small',
    transformers_id: 'Xenova/multilingual-e5-small',
    // Pin the revision (commit hash) for reproducibility. `silo semantic install`
    // resolves + records the exact revision it vendored; this is the expected pin.
    model_revision: 'main',
    dims: 384,
    dtype: 'q8',
    pooling: 'mean',
    normalize: true,
    query_prefix: 'query: ',
    doc_prefix: 'passage: ',
    languages: 'multilingual (~100)',
  },
  'bge-small-en-v1.5': {
    key: 'bge-small-en-v1.5',
    transformers_id: 'Xenova/bge-small-en-v1.5',
    model_revision: 'main',
    dims: 384,
    dtype: 'q8',
    pooling: 'mean',
    normalize: true,
    query_prefix: 'Represent this sentence for searching relevant passages: ',
    doc_prefix: '', // bge: no document-side prefix
    languages: 'en',
  },
};

export const DEFAULT_INSTALL_RELPATH = join('semantic', 'install.json');

// ── Optional native dep, degrade-on-missing (file-lock.js pattern) ──────────
let transformersMod = null;
let transformersUnavailableReason = null;
let triedTransformers = false;

async function tryLoadTransformers() {
  if (triedTransformers) return transformersMod;
  triedTransformers = true;
  try {
    transformersMod = await import('@xenova/transformers');
  } catch (err) {
    transformersUnavailableReason = err?.message || String(err);
    transformersMod = null;
  }
  return transformersMod;
}

/**
 * True iff the native embedding lib can be imported on this platform. Real-
 * encoder integration tests gate on this (mirrors isFlockAvailable()); logic
 * tests inject a mock embedder instead.
 */
export async function hasEmbedderSupport() {
  return (await tryLoadTransformers()) !== null;
}

export function embedderUnavailableReason() {
  return transformersUnavailableReason;
}

/**
 * Read the install record written by `silo semantic install`. Synchronous +
 * tolerant: returns null when absent/unreadable. Carries the chosen model and
 * the engine versions captured at install time (for the cache identity manifest).
 */
export function readInstallRecord(siloDir) {
  if (!siloDir) return null;
  try {
    const raw = readFileSync(join(siloDir, DEFAULT_INSTALL_RELPATH), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Resolve the chosen model key from (a) an injected install record, (b) the
 * on-disk install.json, or (c) the SILO_SEMANTIC_MODEL dev/test escape hatch.
 * Returns the registry key or null.
 */
export function resolveModelKey({ siloDir, env = process.env, install } = {}) {
  const fromEnv = env.SILO_SEMANTIC_MODEL;
  if (fromEnv && MODEL_REGISTRY[fromEnv]) return fromEnv;
  const rec = install ?? readInstallRecord(siloDir);
  if (rec && rec.model && MODEL_REGISTRY[rec.model]) return rec.model;
  return null;
}

/**
 * Triple-gate (§4.1). Pure + cheap: reads env + the install marker, never imports
 * the native lib. Gating the cache projection on this keeps disabled installs at
 * zero cost.
 *
 * @returns {boolean}
 */
export function semanticEnabled({ siloDir, env = process.env, install } = {}) {
  if (env.SILO_SEMANTIC !== 'on') return false; // gate 2: flag
  const modelKey = resolveModelKey({ siloDir, env, install }); // gate 3: model
  if (!modelKey) return false;
  // gate 1: installed. The install marker is the record of `silo semantic
  // install` having vendored deps+model. SILO_SEMANTIC_MODEL is a documented
  // dev/test escape hatch that stands in for the marker.
  const installed = !!(install ?? readInstallRecord(siloDir)) || !!env.SILO_SEMANTIC_MODEL;
  return installed;
}

/**
 * Static config for a model key (pins + prefixes). Merges any engine versions
 * recorded in the install marker (transformers/ort versions captured at install).
 */
export function modelConfig(modelKey, { siloDir, install } = {}) {
  const base = MODEL_REGISTRY[modelKey];
  if (!base) return null;
  const rec = install ?? (siloDir ? readInstallRecord(siloDir) : null);
  return {
    ...base,
    model_id: base.transformers_id,
    transformers_version: rec?.transformers_version ?? null,
    ort_version: rec?.ort_version ?? null,
    // The install step may pin a concrete revision it actually vendored.
    model_revision: rec?.model_revision ?? base.model_revision,
    tokenizer_hash: rec?.tokenizer_hash ?? null,
  };
}

/**
 * Apply the model's prefix profile to a piece of text before encoding.
 * `kind` is 'query' or 'passage'/'doc'.
 */
export function applyPrefix(text, kind, modelKey) {
  const cfg = MODEL_REGISTRY[modelKey];
  if (!cfg) return text;
  const prefix = kind === 'query' ? cfg.query_prefix : cfg.doc_prefix;
  return (prefix || '') + text;
}

// ── Embedder singleton (§4.1: try import / catch → unavailable) ─────────────
let embedderSingleton = undefined; // undefined = not built; null = unavailable

/**
 * Build (once) and return the embedder, or null if unavailable.
 *
 * The returned object:
 *   { modelKey, modelId, modelRevision, dims, config,
 *     embed(texts, kind) → Promise<number[][]> }   // L2-normalized vectors
 *
 * `embed` applies the model's prefix profile per `kind` and returns one vector
 * per input text. On any failure to load the model, returns null (→ semantic
 * status 'unavailable').
 *
 * @param {Object} opts
 * @param {string} [opts.siloDir]
 * @param {Object} [opts.env]
 * @param {Object} [opts.install] - injected install record (tests)
 */
export async function getEmbedder({ siloDir, env = process.env, install } = {}) {
  if (embedderSingleton !== undefined) return embedderSingleton;

  const modelKey = resolveModelKey({ siloDir, env, install });
  if (!modelKey) {
    embedderSingleton = null;
    return null;
  }
  const mod = await tryLoadTransformers();
  if (!mod) {
    embedderSingleton = null;
    return null;
  }

  const cfg = modelConfig(modelKey, { siloDir, install });
  try {
    const pipe = await mod.pipeline('feature-extraction', cfg.transformers_id, {
      quantized: cfg.dtype === 'q8',
    });
    embedderSingleton = {
      modelKey,
      modelId: cfg.transformers_id,
      modelRevision: cfg.model_revision,
      dims: cfg.dims,
      config: cfg,
      async embed(texts, kind = 'passage', { batchSize = 1 } = {}) {
        const arr = Array.isArray(texts) ? texts : [texts];
        const prefixed = arr.map((t) => applyPrefix(t, kind, modelKey));
        // Default batchSize=1 is the DETERMINISTIC path (no padding): each text is
        // encoded alone, so the cache projection's vectors never depend on batch
        // composition. batchSize>1 is an opt-in THROUGHPUT path (eval / bulk
        // rebuilds): padding to the longest item in a batch shifts q8 outputs by
        // ~1e-2 per component (cosine ≈ 0.999, ranking-equivalent) — fine for
        // eval, NOT used by the gated cache builder so identity stays stable.
        if (batchSize > 1) {
          const out = [];
          for (let i = 0; i < prefixed.length; i += batchSize) {
            const res = await pipe(prefixed.slice(i, i + batchSize), { pooling: cfg.pooling, normalize: cfg.normalize });
            for (const row of res.tolist()) out.push(row);
          }
          return out;
        }
        const out = [];
        for (const p of prefixed) {
          const res = await pipe(p, { pooling: cfg.pooling, normalize: cfg.normalize });
          out.push(Array.from(res.data));
        }
        return out;
      },
    };
  } catch {
    embedderSingleton = null;
  }
  return embedderSingleton;
}

/** Test hook: reset the singleton so a fresh getEmbedder() re-resolves. */
export function _resetEmbedderForTests() {
  embedderSingleton = undefined;
}
