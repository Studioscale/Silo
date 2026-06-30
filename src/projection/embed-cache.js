/**
 * Embedding cache-projection builder — hybrid-search spec §4.4 + build-brief §1/§3.
 *
 * This is the cache-PROJECTION builder, not the ranker. It runs as part of
 * `silo regenerate` (gated by semanticEnabled() — zero cost when disabled),
 * embeds CORPUS text into vectors, and writes a content-addressed store. It
 * imports the embedder primitive + the chunk/tier leaf utilities, NEVER the
 * ranker (src/retrieval/index.js or semantic.js) — so the write→regenerate→
 * embed-corpus chain stays clear of the no-write call-graph ban (§4.9).
 *
 * Two stores (§4.4):
 *   - vector store:  vector_key = canonicalHash(chunk_text)  →  number[]
 *                    (dedup across identical text; store is identity-homogeneous)
 *   - occurrence index:  { slug, seq, chunk_index, tier, vector_key, span }
 *                    (tier is assigned ONCE here, where raw events + payload.imported
 *                     are available — build-brief §1; State drops `imported`)
 *
 * Manifest, two field classes (§4.4):
 *   identity  (mismatch ⇒ rebuild whole store): model/engine/chunker pins
 *   freshness (drift ⇒ use cache as-is, no nuke): log_head_seq/hash, created_at
 *
 * Reuse: when the on-disk identity manifest matches, vectors for unchanged chunk
 * text are reused (cache-hit on re-chunk); only new vector_keys are embedded.
 * Pruning falls out: the occurrence index is rebuilt from current live units, so
 * a retired/deleted seq's occurrence vanishes; its shared vector is dropped only
 * when NO live occurrence references it (preserving dedup, §4.4).
 */

import { promises as fs } from 'node:fs';
import { join, dirname } from 'node:path';
import { canonicalHash } from '../log/canonical.js';
import { classifyTier, TIER_ORDER } from '../retrieval/tiers.js';
import { chunkUnit, CHUNKER_VERSION, CHUNK_SIZE, CHUNK_OVERLAP, MAX_TOKENS } from '../retrieval/chunk.js';
import { getEmbedder, semanticEnabled, modelConfig, resolveModelKey } from '../embedding/embedder.js';
import { withProjectionLock } from './projection-lock.js';

export const CACHE_SCHEMA_VERSION = 1;
export const CACHE_RELPATH = join('projections', 'embeddings.json');

export function cachePath(siloDir) {
  return join(siloDir, CACHE_RELPATH);
}

/** vector_key for a chunk's text — content-addressed, NFC+JCS+sha256. */
export function vectorKey(chunkText) {
  return canonicalHash(chunkText);
}

/**
 * Enumerate the live corpus as chunk units, in a single pass over the log.
 *
 * For each write_event: classify its tier from the RAW event (tag +
 * payload.imported), skip if null (retired curated / non-unit), else chunk its
 * content per §4.11 and emit one unit per (seq, chunk_index) carrying its tier.
 *
 * @returns {Promise<Array<{ slug, seq, chunk_index, tier, content, span }>>}
 */
export async function enumerateCorpusUnits({ logReader, state }) {
  const retired = state?.retired_curated_seqs ?? new Set();
  const units = [];
  for await (const { entry } of logReader.readAll()) {
    if (entry.type !== 'write_event') continue;
    const tier = classifyTier(entry, retired);
    if (!tier) continue; // retired curated, or not a searchable unit
    const slug = entry.payload?.slug;
    if (!slug) continue;
    const content = typeof entry.payload?.content === 'string'
      ? entry.payload.content
      : JSON.stringify(entry.payload?.content ?? '');
    for (const chunk of chunkUnit(content)) {
      units.push({
        slug,
        seq: entry.seq,
        chunk_index: chunk.chunk_index,
        tier,
        content: chunk.content,
        span: chunk.span,
      });
    }
  }
  return units;
}

/** Build the identity-manifest object from the embedder's model config + chunker pins. */
export function buildIdentityManifest(cfg) {
  return {
    schema_version: CACHE_SCHEMA_VERSION,
    model_id: cfg.model_id,
    model_revision: cfg.model_revision,
    tokenizer_hash: cfg.tokenizer_hash ?? null,
    transformers_version: cfg.transformers_version ?? null,
    ort_version: cfg.ort_version ?? null,
    dtype: cfg.dtype,
    pooling: cfg.pooling,
    normalize: cfg.normalize,
    doc_prefix: cfg.doc_prefix,
    query_prefix: cfg.query_prefix,
    chunker_version: CHUNKER_VERSION,
    chunk_size: CHUNK_SIZE,
    chunk_overlap: CHUNK_OVERLAP,
    max_tokens: MAX_TOKENS,
  };
}

/** Stable digest of the identity manifest (provenance: cache_manifest_digest). */
export function identityDigest(identity) {
  return canonicalHash(identity);
}

/** Load the on-disk cache, or null if absent/unreadable. */
export async function loadCacheFile(siloDir) {
  try {
    const raw = await fs.readFile(cachePath(siloDir), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function atomicWriteJson(path, obj) {
  await fs.mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const fh = await fs.open(tmp, 'w');
  try {
    await fh.writeFile(JSON.stringify(obj), 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, path);
}

/**
 * Build (or refresh) the embedding cache.
 *
 * @param {Object} args
 * @param {LogReader} args.logReader
 * @param {Object} args.state
 * @param {string} args.siloDir
 * @param {Object} [args.embedder] - inject a (mock or real) embedder; when absent
 *                 and semanticEnabled(), resolves the real one via getEmbedder().
 * @param {Object} [args.env]
 * @param {string} [args.nowIso] - timestamp for the freshness manifest (testable)
 * @returns {Promise<Object>} summary
 */
export async function buildEmbeddingCache({ logReader, state, siloDir, embedder, env = process.env, nowIso }) {
  // Resolve the embedder. Injected (tests) wins; otherwise only when enabled.
  let emb = embedder;
  let modelKey = emb?.modelKey ?? resolveModelKey({ siloDir, env });
  if (!emb) {
    if (!semanticEnabled({ siloDir, env })) {
      return { skipped: true, reason: 'semantic_disabled' };
    }
    emb = await getEmbedder({ siloDir, env });
    if (!emb) return { skipped: true, reason: 'embedder_unavailable' };
    modelKey = emb.modelKey;
  }

  const cfg = emb.config ?? modelConfig(modelKey, { siloDir });
  const identity = buildIdentityManifest(cfg);
  const idDigest = identityDigest(identity);

  // Enumerate live corpus units (single log pass).
  const units = await enumerateCorpusUnits({ logReader, state });

  // Vector reuse: if the existing store's identity matches, reuse known vectors.
  const existing = await loadCacheFile(siloDir);
  const reusable = (existing && existing.manifest?.identity_digest === idDigest)
    ? (existing.vectors ?? {})
    : {};

  // Determine the distinct vector_keys we need; embed only the missing ones.
  const occurrences = [];
  const neededKeys = new Map(); // vector_key -> chunk_text (for embedding)
  for (const u of units) {
    const vk = vectorKey(u.content);
    occurrences.push({
      slug: u.slug,
      seq: u.seq,
      chunk_index: u.chunk_index,
      tier: u.tier,
      vector_key: vk,
      span: u.span,
    });
    if (!neededKeys.has(vk)) neededKeys.set(vk, u.content);
  }

  const vectors = {};
  const toEmbed = [];
  for (const [vk, text] of neededKeys) {
    if (reusable[vk]) {
      vectors[vk] = reusable[vk]; // cache-hit on re-chunk
    } else {
      toEmbed.push({ vk, text });
    }
  }
  if (toEmbed.length > 0) {
    const embedded = await emb.embed(toEmbed.map((t) => t.text), 'passage');
    for (let i = 0; i < toEmbed.length; i++) {
      vectors[toEmbed[i].vk] = embedded[i];
    }
  }

  // Freshness manifest from current log head (drift ⇒ use-as-is, never nuke).
  const tail = typeof logReader.tail === 'function' ? logReader.tail() : null;
  const freshness = {
    log_head_seq: tail?.seq ?? state?.last_seq ?? 0,
    log_head_hash: tail?.hash ?? state?.tail_hash ?? null,
    created_at: nowIso ?? new Date().toISOString(),
  };

  const cache = {
    manifest: { identity, freshness, identity_digest: idDigest },
    vectors,
    occurrences,
  };

  await withProjectionLock(siloDir, () => atomicWriteJson(cachePath(siloDir), cache));

  // Per-tier occurrence counts for doctor.
  const perTier = {};
  for (const t of TIER_ORDER) perTier[t] = 0;
  for (const o of occurrences) perTier[o.tier] = (perTier[o.tier] ?? 0) + 1;

  return {
    skipped: false,
    model_id: cfg.model_id,
    vectors: Object.keys(vectors).length,
    chunks: occurrences.length,
    embedded_new: toEmbed.length,
    reused: neededKeys.size - toEmbed.length,
    per_tier: perTier,
    identity_digest: idDigest,
    path: cachePath(siloDir),
  };
}
