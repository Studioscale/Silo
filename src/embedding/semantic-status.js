/**
 * Semantic feature status for `silo doctor` (hybrid-search §6 / §4.12).
 *
 * Honest reporting: the triple-gate state, the chosen model, whether the native
 * dep loads, and the embedding-cache health (size, vector/chunk + per-tier
 * counts, fresh/stale/partial/missing). Pure-ish: reads the install marker + the
 * cache file; never builds anything.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import {
  semanticEnabled, resolveModelKey, readInstallRecord, modelConfig, hasEmbedderSupport,
} from './embedder.js';
import { TIER_ORDER } from '../retrieval/tiers.js';
import { buildIdentityManifest, identityDigest } from '../projection/embed-cache.js';

const CACHE_RELPATH = join('projections', 'embeddings.json');

export async function describeSemanticStatus({ siloDir, env = process.env } = {}) {
  const enabled = semanticEnabled({ siloDir, env });
  const modelKey = resolveModelKey({ siloDir, env });
  const install = readInstallRecord(siloDir);
  const depSupport = await hasEmbedderSupport();

  const out = {
    enabled,
    flag_on: env.SILO_SEMANTIC === 'on',
    model: modelKey,
    installed: !!install,
    installed_at: install?.installed_at ?? null,
    dep_support: depSupport,
    cache: { status: 'missing', vectors: 0, chunks: 0, bytes: 0, per_tier: {} },
  };

  // Cache file diagnostics.
  const cachePath = siloDir ? join(siloDir, CACHE_RELPATH) : null;
  if (cachePath) {
    try {
      const stat = await fs.stat(cachePath);
      const raw = await fs.readFile(cachePath, 'utf8');
      const cache = JSON.parse(raw);
      const perTier = {};
      for (const t of TIER_ORDER) perTier[t] = 0;
      for (const o of cache.occurrences ?? []) perTier[o.tier] = (perTier[o.tier] ?? 0) + 1;
      out.cache = {
        status: 'present',
        vectors: Object.keys(cache.vectors ?? {}).length,
        chunks: (cache.occurrences ?? []).length,
        bytes: stat.size,
        per_tier: perTier,
        model_id: cache.manifest?.identity?.model_id ?? null,
        created_at: cache.manifest?.freshness?.created_at ?? null,
        identity_matches: null,
      };
      // identity match vs the currently-chosen model.
      if (modelKey) {
        const cfg = modelConfig(modelKey, { siloDir });
        const current = identityDigest(buildIdentityManifest({ ...cfg, model_id: cfg.model_id }));
        out.cache.identity_matches = cache.manifest?.identity_digest === current;
        out.cache.status = out.cache.identity_matches ? 'fresh' : 'stale';
      }
    } catch {
      out.cache = { status: 'missing', vectors: 0, chunks: 0, bytes: 0, per_tier: {} };
    }
  }
  return out;
}
