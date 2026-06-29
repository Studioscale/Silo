/**
 * `silo semantic install` — hybrid-search spec §4.1/§4.2.
 *
 * Opt-in installer for the local semantic feature. It makes the user pick a model
 * EXPLICITLY (no silent default), pins the embedding dep versions, and records the
 * choice + engine versions in <siloDir>/semantic/install.json — the marker the
 * triple gate (`semanticEnabled()`) reads. The embedding deps are deliberately
 * NOT in package.json (§4.1); this command is how they arrive.
 *
 * Vendoring the model files offline + recording checksums is the production step;
 * here we pin the dep versions, capture whatever engine versions are present, and
 * write the marker. `--skip-deps` writes the marker without touching npm (tests +
 * air-gapped vendoring). After install the user sets SILO_SEMANTIC=on.
 */

import { promises as fs } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { MODEL_REGISTRY, DEFAULT_INSTALL_RELPATH } from './embedder.js';

// Pinned embedding deps (§4.1). A real vendor step also records sha256 checksums.
export const DEP_PINS = {
  '@xenova/transformers': '2.17.2',
};

export const INSTALL_SCHEMA_VERSION = 1;

export function installMarkerPath(siloDir) {
  return join(siloDir, DEFAULT_INSTALL_RELPATH);
}

/** Best-effort detection of installed engine versions (null when absent). */
async function detectEngineVersions() {
  const out = { transformers_version: null, ort_version: null };
  try {
    const mod = await import('@xenova/transformers');
    out.transformers_version = mod?.env?.version ?? mod?.version ?? null;
  } catch { /* not installed */ }
  return out;
}

async function atomicWriteJson(path, obj) {
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, path);
}

/**
 * @param {Object} args
 * @param {string} args.siloDir
 * @param {string} args.model - registry key (required; no default)
 * @param {boolean} [args.skipDeps] - write the marker without running npm
 * @param {boolean} [args.dryRun] - print the plan, write nothing
 * @param {string} [args.nowIso]
 * @returns {Promise<Object>} summary
 */
export async function installSemantic({ siloDir, model, skipDeps = false, dryRun = false, nowIso }) {
  if (!siloDir) throw new Error('installSemantic: siloDir required');
  if (!model || !MODEL_REGISTRY[model]) {
    const err = new Error(
      `silo semantic install: choose a model explicitly with --model=<key>. ` +
        `Options: ${Object.keys(MODEL_REGISTRY).join(', ')}.`,
    );
    err.code = 'MODEL_REQUIRED';
    throw err;
  }

  const cfg = MODEL_REGISTRY[model];
  const plan = {
    model,
    transformers_id: cfg.transformers_id,
    model_revision: cfg.model_revision,
    dep_pins: DEP_PINS,
    marker_path: installMarkerPath(siloDir),
  };
  if (dryRun) return { dry_run: true, ...plan };

  // Best-effort dep install (production). Skipped for tests / offline vendoring.
  let deps_status = 'skipped';
  if (!skipDeps) {
    const pkgs = Object.entries(DEP_PINS).map(([n, v]) => `${n}@${v}`);
    const r = spawnSync('npm', ['install', '--no-save', ...pkgs], { encoding: 'utf-8' });
    deps_status = r.status === 0 ? 'installed' : `failed(${r.status})`;
  }

  const versions = await detectEngineVersions();
  const record = {
    schema_version: INSTALL_SCHEMA_VERSION,
    model,
    transformers_id: cfg.transformers_id,
    model_revision: cfg.model_revision,
    dep_pins: DEP_PINS,
    transformers_version: versions.transformers_version,
    ort_version: versions.ort_version,
    tokenizer_hash: null, // recorded by the offline vendoring step
    deps_status,
    installed_at: nowIso ?? new Date().toISOString(),
  };
  await atomicWriteJson(plan.marker_path, record);
  return { installed: true, marker_path: plan.marker_path, ...record };
}
