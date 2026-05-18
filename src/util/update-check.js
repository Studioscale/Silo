/**
 * Update-check core — Phase 2.3 §3.
 *
 * Probes github.com/Studioscale/Silo for newer releases and writes a
 * cache file the MCP server reads (mtime-checked) to surface the
 * `update_available` and `update_check_unhealthy` notices.
 *
 * Pieces:
 *   - compareVersions: pure version comparator (semver-lite; documents the
 *     pre-release counter limitation in spec §3.3).
 *   - readCache / writeCache: cache I/O at `<silo-dir>/update-status.json`.
 *     Writes are atomic via unique `${pid}.${ts}.tmp` + fs.rename so
 *     concurrent detached workers don't trample each other.
 *   - performCheck: pure-ish driver — takes an injected fetcher, returns
 *     the new status object. Failure folds preserve last_successful_*
 *     fields so the projection's notice can stay informative across
 *     transient errors.
 *   - fetchLatestRelease: built-in https fetcher (no new deps).
 *   - maybeFireUpdateCheck: detached-worker entry the CLI calls on every
 *     non-`doctor` invocation. Respects opt-out + 24h throttle.
 *   - isOptOut: SILO_DISABLE_UPDATE_CHECK predicate.
 */

import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import https from 'node:https';

// ── ESM-safe equivalents (spec §3.1) ────────────────────────────────────────
const require = createRequire(import.meta.url);
const packageJson = require('../../package.json');
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Constants ───────────────────────────────────────────────────────────────
export const CURRENT_VERSION = packageJson.version;
export const CACHE_FILENAME = 'update-status.json';
export const THROTTLE_MS = 24 * 60 * 60 * 1000;
export const SCHEMA_VERSION = 1;
export const HEALTHY_FAILURE_THRESHOLD = 7;
const GITHUB_LATEST = 'https://api.github.com/repos/Studioscale/Silo/releases/latest';
const DEFAULT_TIMEOUT_MS = 5000;
const OPT_OUT_VALUES = new Set(['1', 'true', 'yes', 'on']);

// ── Opt-out (spec §3.6) ─────────────────────────────────────────────────────

export function isOptOut(env = process.env) {
  const v = env.SILO_DISABLE_UPDATE_CHECK;
  if (v == null) return false;
  return OPT_OUT_VALUES.has(String(v).toLowerCase().trim());
}

// ── Version comparator (spec §3.3) ──────────────────────────────────────────

/**
 * Returns -1 / 0 / +1 (a < b / a == b / a > b).
 *
 * Properties:
 *   - Strips build metadata (anything after `+`) BEFORE splitting, so
 *     0.1.0+build1 == 0.1.0+build2.
 *   - Strips leading `v` so v0.1.0 == 0.1.0.
 *   - Numeric segments > string segments (so 0.1.0 > 0.1.0-rc1).
 *   - Documented limitation (spec §3.3): pre-release counters >9 compare
 *     lexicographically (m10 < m2). Pad to m02/m10 if you reach double
 *     digits.
 */
export function compareVersions(a, b) {
  const parse = (v) =>
    String(v)
      .replace(/^v/, '')
      .split('+')[0]
      .split(/[.-]/)
      .map((p) => (/^\d+$/.test(p) ? parseInt(p, 10) : p));
  const aa = parse(a);
  const bb = parse(b);
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
    const x = aa[i] ?? 0;
    const y = bb[i] ?? 0;
    if (typeof x === typeof y) {
      if (x < y) return -1;
      if (x > y) return 1;
    } else {
      // numeric > string (0.1.0 > 0.1.0-rc1)
      return typeof x === 'number' ? 1 : -1;
    }
  }
  return 0;
}

// ── Cache I/O ───────────────────────────────────────────────────────────────

const cachePath = (siloDir) => join(siloDir, CACHE_FILENAME);

export async function readCache(siloDir) {
  try {
    const raw = await fs.readFile(cachePath(siloDir), 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    // Malformed → treat as missing (per spec §5; MCP also treats as missing).
    return null;
  }
}

export async function writeCache(siloDir, status) {
  await fs.mkdir(siloDir, { recursive: true });
  const finalPath = cachePath(siloDir);
  // Unique tmp per worker — prevents collisions between concurrent
  // detached workers (round-1 ChatGPT F3).
  const tmp = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(status, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, finalPath);
}

// ── performCheck (pure-ish) ─────────────────────────────────────────────────

/**
 * Build the next cache status from a fetcher result + the prior cache.
 *
 * @param {Object} opts
 * @param {Function} [opts.fetcher]        - returns {statusCode, body}
 * @param {string}   [opts.currentVersion] - defaults to package.json
 * @param {Object|null} [opts.prior]       - prior cache contents
 * @param {number}   [opts.now]            - wall-clock ms (test seam)
 * @returns {Promise<Object>}
 */
export async function performCheck({
  fetcher = fetchLatestRelease,
  currentVersion = CURRENT_VERSION,
  prior = null,
  now = Date.now(),
} = {}) {
  const nowIso = new Date(now).toISOString();
  let response;
  try {
    response = await fetcher();
  } catch (err) {
    return foldFailure(prior, currentVersion, nowIso, err, 'network_error');
  }
  if (response.statusCode === 404) {
    return foldFailure(
      prior,
      currentVersion,
      nowIso,
      new Error('repo_not_found'),
      'repo_not_found',
    );
  }
  if (response.statusCode === 403 || response.statusCode === 429) {
    return foldFailure(
      prior,
      currentVersion,
      nowIso,
      new Error(`rate_limited (${response.statusCode})`),
      'rate_limited',
    );
  }
  if (response.statusCode < 200 || response.statusCode >= 300) {
    return foldFailure(
      prior,
      currentVersion,
      nowIso,
      new Error(`HTTP ${response.statusCode}`),
      'network_error',
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(response.body);
  } catch (err) {
    return foldFailure(prior, currentVersion, nowIso, err, 'parse_error');
  }
  const tag = parsed.tag_name;
  if (typeof tag !== 'string' || tag.length === 0) {
    return foldFailure(
      prior,
      currentVersion,
      nowIso,
      new Error('missing_tag_name'),
      'parse_error',
    );
  }
  const latestVersion = tag.replace(/^v/, '');
  const updateAvailable = compareVersions(currentVersion, latestVersion) < 0;
  return {
    schema_version: SCHEMA_VERSION,
    last_checked_at: nowIso,
    last_successful_check_at: nowIso,
    last_successful_latest_version: latestVersion,
    current_version: currentVersion,
    latest_version: latestVersion,
    tag_url: parsed.html_url ?? null,
    released_at: parsed.published_at ?? parsed.created_at ?? null,
    update_available: updateAvailable,
    last_check_status: 'ok',
    last_error: null,
    consecutive_failures: 0,
  };
}

function foldFailure(prior, currentVersion, nowIso, err, status) {
  return {
    schema_version: SCHEMA_VERSION,
    last_checked_at: nowIso,
    // Preserve last-success fields across transient failures (spec §3.4 fold rules).
    last_successful_check_at: prior?.last_successful_check_at ?? null,
    last_successful_latest_version: prior?.last_successful_latest_version ?? null,
    current_version: currentVersion,
    latest_version: prior?.latest_version ?? null,
    tag_url: prior?.tag_url ?? null,
    released_at: prior?.released_at ?? null,
    update_available: prior?.update_available ?? false,
    last_check_status: status,
    last_error: err?.message ?? String(err),
    consecutive_failures: (prior?.consecutive_failures ?? 0) + 1,
  };
}

// ── HTTPS fetcher ───────────────────────────────────────────────────────────

export function fetchLatestRelease(timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      GITHUB_LATEST,
      {
        headers: {
          // Privacy: bare "Silo" — no version to avoid IP+version fingerprinting.
          'User-Agent': 'Silo',
          Accept: 'application/vnd.github+json',
        },
        timeout: timeoutMs,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => resolve({ statusCode: res.statusCode, body }));
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error('ETIMEDOUT'));
    });
    req.on('error', (err) => reject(err));
  });
}

// ── Detached worker entry ───────────────────────────────────────────────────

/**
 * Maybe fire a detached update-check worker.
 *
 * No-op when:
 *   - SILO_DISABLE_UPDATE_CHECK is truthy
 *   - cache is fresh (last_checked_at within THROTTLE_MS)
 *
 * Otherwise spawns the worker as a detached, unref'd subprocess that
 * survives the parent CLI exiting.
 *
 * @returns {Promise<boolean>} true iff a worker was spawned.
 */
export async function maybeFireUpdateCheck(siloDir, opts = {}) {
  if (isOptOut(opts.env ?? process.env)) return false;
  const cache = await readCache(siloDir);
  const now = opts.now ?? Date.now();
  if (cache?.last_checked_at) {
    const ms = Date.parse(cache.last_checked_at);
    if (Number.isFinite(ms) && now - ms < THROTTLE_MS) return false;
  }
  const workerPath = opts.workerPath ?? join(__dirname, 'update-check-worker.js');
  const exe = opts.execPath ?? process.execPath;
  spawn(exe, [workerPath, '--silo-dir', siloDir], {
    detached: true,
    stdio: 'ignore',
  }).unref();
  return true;
}
