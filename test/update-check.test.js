/**
 * Phase 2.3 §3 — update-check core tests.
 *
 * Covers compareVersions (incl. spec acceptance examples), isOptOut env
 * parsing, cache I/O round-trip + atomic-write idempotency, performCheck
 * happy path + each failure-mode fold, and maybeFireUpdateCheck throttle
 * gating. The detached worker is exercised via a smoke spawn.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  compareVersions,
  isOptOut,
  readCache,
  writeCache,
  performCheck,
  maybeFireUpdateCheck,
  CURRENT_VERSION,
  CACHE_FILENAME,
  THROTTLE_MS,
} from '../src/util/update-check.js';

async function freshSiloDir() {
  return fs.mkdtemp(join(tmpdir(), 'silo-update-'));
}

// ── compareVersions (spec §3.3 acceptance examples) ─────────────────────────

test('compareVersions: 0.1.0 > 0.1.0-rc1 (numeric > string)', () => {
  assert.equal(compareVersions('0.1.0', '0.1.0-rc1'), 1);
  assert.equal(compareVersions('0.1.0-rc1', '0.1.0'), -1);
});

test('compareVersions: 0.1.0-m1 < 0.1.0-m2 (lexicographic pre-release counter)', () => {
  assert.equal(compareVersions('0.1.0-m1', '0.1.0-m2'), -1);
  assert.equal(compareVersions('0.1.0-m2', '0.1.0-m1'), 1);
});

test('compareVersions: 0.2.0 > 0.1.99 (numeric per-position)', () => {
  assert.equal(compareVersions('0.2.0', '0.1.99'), 1);
});

test('compareVersions: build metadata stripped (0.1.0+build1 == 0.1.0+build2)', () => {
  assert.equal(compareVersions('0.1.0+build1', '0.1.0+build2'), 0);
});

test('compareVersions: leading v stripped (v0.1.0 == 0.1.0)', () => {
  assert.equal(compareVersions('v0.1.0', '0.1.0'), 0);
});

test('compareVersions: documented limitation — m10 < m2 lexicographically', () => {
  // Pre-release counters >9 compare as strings per the spec — workaround is
  // to pad to m02 / m10. This test pins the behavior so a future reader
  // doesn't introduce a "fix" that breaks the m02-pad workaround.
  assert.equal(compareVersions('0.1.0-m10', '0.1.0-m2'), -1);
});

// ── isOptOut env parsing ────────────────────────────────────────────────────

test('isOptOut: 1/true/yes/on (case-insensitive) → true', () => {
  for (const v of ['1', 'true', 'TRUE', 'yes', 'YES', 'on', 'On']) {
    assert.equal(isOptOut({ SILO_DISABLE_UPDATE_CHECK: v }), true, `expected ${v} → true`);
  }
});

test('isOptOut: 0 / false / empty / unset → false (Node convention)', () => {
  for (const v of ['0', 'false', '', undefined]) {
    assert.equal(isOptOut(v === undefined ? {} : { SILO_DISABLE_UPDATE_CHECK: v }), false);
  }
});

// ── Cache I/O ───────────────────────────────────────────────────────────────

test('readCache: missing file → null', async () => {
  const dir = await freshSiloDir();
  assert.equal(await readCache(dir), null);
});

test('readCache: malformed file → null (treated as missing)', async () => {
  const dir = await freshSiloDir();
  await fs.writeFile(join(dir, CACHE_FILENAME), '{ not json');
  assert.equal(await readCache(dir), null);
});

test('writeCache: round-trips through readCache', async () => {
  const dir = await freshSiloDir();
  const status = { schema_version: 1, current_version: '0.1.0-m1', consecutive_failures: 0 };
  await writeCache(dir, status);
  const read = await readCache(dir);
  assert.deepEqual(read, status);
});

test('writeCache: no .tmp residue after success (atomic rename)', async () => {
  const dir = await freshSiloDir();
  await writeCache(dir, { schema_version: 1 });
  const files = await fs.readdir(dir);
  assert.equal(files.some((f) => f.endsWith('.tmp')), false);
});

// ── performCheck — happy path ───────────────────────────────────────────────

test('performCheck: ok response → update_available=true when latest is newer', async () => {
  const fetcher = async () => ({
    statusCode: 200,
    body: JSON.stringify({
      tag_name: 'v0.1.0-m2',
      html_url: 'https://github.com/Studioscale/Silo/releases/tag/v0.1.0-m2',
      published_at: '2026-05-17T14:00:00Z',
    }),
  });
  const status = await performCheck({
    fetcher,
    currentVersion: '0.1.0-m1',
    now: Date.parse('2026-05-18T05:00:00Z'),
  });
  assert.equal(status.last_check_status, 'ok');
  assert.equal(status.update_available, true);
  assert.equal(status.latest_version, '0.1.0-m2');
  assert.equal(status.last_successful_check_at, '2026-05-18T05:00:00.000Z');
  assert.equal(status.consecutive_failures, 0);
  assert.equal(status.last_error, null);
});

test('performCheck: ok response → update_available=false when at latest', async () => {
  const fetcher = async () => ({
    statusCode: 200,
    body: JSON.stringify({ tag_name: 'v0.1.0-m1', html_url: 'x', published_at: 'y' }),
  });
  const status = await performCheck({ fetcher, currentVersion: '0.1.0-m1' });
  assert.equal(status.update_available, false);
});

// ── performCheck — failure folds ────────────────────────────────────────────

test('performCheck: network error → consecutive_failures increments; preserves last_success', async () => {
  const prior = {
    last_successful_check_at: '2026-05-10T05:00:00Z',
    last_successful_latest_version: '0.1.0-m1',
    consecutive_failures: 0,
    latest_version: '0.1.0-m1',
    update_available: false,
  };
  const fetcher = async () => {
    throw new Error('ETIMEDOUT');
  };
  const status = await performCheck({
    fetcher,
    currentVersion: '0.1.0-m1',
    prior,
    now: Date.parse('2026-05-11T05:00:00Z'),
  });
  assert.equal(status.last_check_status, 'network_error');
  assert.equal(status.last_error, 'ETIMEDOUT');
  assert.equal(status.consecutive_failures, 1);
  // Preserved across the failure.
  assert.equal(status.last_successful_check_at, '2026-05-10T05:00:00Z');
  assert.equal(status.last_successful_latest_version, '0.1.0-m1');
});

test('performCheck: 404 → status=repo_not_found (immediate notice)', async () => {
  const fetcher = async () => ({ statusCode: 404, body: 'Not Found' });
  const status = await performCheck({ fetcher, currentVersion: '0.1.0-m1' });
  assert.equal(status.last_check_status, 'repo_not_found');
});

test('performCheck: 403 → status=rate_limited', async () => {
  const fetcher = async () => ({ statusCode: 403, body: 'rate limit' });
  const status = await performCheck({ fetcher, currentVersion: '0.1.0-m1' });
  assert.equal(status.last_check_status, 'rate_limited');
});

test('performCheck: bad JSON → status=parse_error', async () => {
  const fetcher = async () => ({ statusCode: 200, body: '{ not json' });
  const status = await performCheck({ fetcher, currentVersion: '0.1.0-m1' });
  assert.equal(status.last_check_status, 'parse_error');
});

test('performCheck: missing tag_name → status=parse_error', async () => {
  const fetcher = async () => ({ statusCode: 200, body: JSON.stringify({ html_url: 'x' }) });
  const status = await performCheck({ fetcher, currentVersion: '0.1.0-m1' });
  assert.equal(status.last_check_status, 'parse_error');
});

test('performCheck: ok after failures → consecutive_failures resets to 0', async () => {
  const fetcher = async () => ({
    statusCode: 200,
    body: JSON.stringify({ tag_name: 'v0.1.0-m1', html_url: 'x', published_at: 'y' }),
  });
  const status = await performCheck({
    fetcher,
    currentVersion: '0.1.0-m1',
    prior: { consecutive_failures: 3, last_successful_check_at: '2026-05-01T05:00:00Z' },
  });
  assert.equal(status.consecutive_failures, 0);
});

// ── maybeFireUpdateCheck — throttle gate ────────────────────────────────────

test('maybeFireUpdateCheck: fresh cache → no spawn (returns false)', async () => {
  const dir = await freshSiloDir();
  const now = Date.now();
  await writeCache(dir, {
    last_checked_at: new Date(now - 1000).toISOString(),
    consecutive_failures: 0,
  });
  // Worker path doesn't matter — must not be invoked.
  const fired = await maybeFireUpdateCheck(dir, {
    now,
    workerPath: '/nonexistent/path',
  });
  assert.equal(fired, false);
});

test('maybeFireUpdateCheck: stale cache → spawn (returns true)', async () => {
  const dir = await freshSiloDir();
  const now = Date.now();
  await writeCache(dir, {
    last_checked_at: new Date(now - THROTTLE_MS - 1000).toISOString(),
    consecutive_failures: 0,
  });
  const echoScript = join(dir, 'echo.js');
  await fs.writeFile(echoScript, 'process.exit(0);');
  const fired = await maybeFireUpdateCheck(dir, { now, workerPath: echoScript });
  assert.equal(fired, true);
});

test('maybeFireUpdateCheck: opt-out → no spawn even with stale cache', async () => {
  const dir = await freshSiloDir();
  const now = Date.now();
  await writeCache(dir, {
    last_checked_at: new Date(now - THROTTLE_MS - 1000).toISOString(),
    consecutive_failures: 0,
  });
  const fired = await maybeFireUpdateCheck(dir, {
    now,
    workerPath: '/nonexistent',
    env: { SILO_DISABLE_UPDATE_CHECK: '1' },
  });
  assert.equal(fired, false);
});

test('maybeFireUpdateCheck: missing cache → spawn (first run)', async () => {
  const dir = await freshSiloDir();
  const echoScript = join(dir, 'echo.js');
  await fs.writeFile(echoScript, 'process.exit(0);');
  const fired = await maybeFireUpdateCheck(dir, { workerPath: echoScript });
  assert.equal(fired, true);
});

// ── Worker smoke ────────────────────────────────────────────────────────────

test('worker: --silo-dir required (exit 2)', async () => {
  const r = spawnSync(process.execPath, [join(process.cwd(), 'src/util/update-check-worker.js')], {
    encoding: 'utf8',
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--silo-dir required/);
});

test('worker: opt-out at boot → exit 0 without fetching', async () => {
  const dir = await freshSiloDir();
  const r = spawnSync(
    process.execPath,
    [join(process.cwd(), 'src/util/update-check-worker.js'), '--silo-dir', dir],
    {
      encoding: 'utf8',
      env: { ...process.env, SILO_DISABLE_UPDATE_CHECK: '1' },
    },
  );
  assert.equal(r.status, 0);
  // No cache written.
  assert.equal(await readCache(dir), null);
});

test('worker: fresh cache → exit 0 without re-fetching', async () => {
  const dir = await freshSiloDir();
  const now = Date.now();
  await writeCache(dir, {
    last_checked_at: new Date(now - 1000).toISOString(),
    consecutive_failures: 0,
    sentinel: 'pre-existing',
  });
  const r = spawnSync(
    process.execPath,
    [join(process.cwd(), 'src/util/update-check-worker.js'), '--silo-dir', dir],
    { encoding: 'utf8', env: { ...process.env, SILO_DISABLE_UPDATE_CHECK: '' } },
  );
  assert.equal(r.status, 0);
  const after = await readCache(dir);
  // Worker didn't overwrite — sentinel field still present.
  assert.equal(after.sentinel, 'pre-existing');
});

// ── Sanity: CURRENT_VERSION is read from package.json ───────────────────────

test('CURRENT_VERSION matches package.json version', async () => {
  const pkgRaw = await fs.readFile('package.json', 'utf8');
  const pkg = JSON.parse(pkgRaw);
  assert.equal(CURRENT_VERSION, pkg.version);
});
