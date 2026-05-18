/**
 * Phase 2.3 §4 — `silo doctor` CLI smoke tests.
 *
 * Spawns the binary in a subprocess so we exercise the full
 * parseArgs → dispatcher → command path. Auto-check on entry is
 * suppressed by SILO_DISABLE_UPDATE_CHECK to keep tests offline.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const CLI = join(process.cwd(), 'src/cli/silo.js');

function runSilo(args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, SILO_DISABLE_UPDATE_CHECK: '1', ...env },
  });
}

async function initSilo() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'silo-doctor-'));
  const r = runSilo(['init', `--silo-dir=${dir}`, '--operator=helder', '--uid=1000']);
  assert.equal(r.status, 0, `init failed: ${r.stderr}`);
  return dir;
}

test('cli doctor: fresh silo (no cache) prints "no cache yet"', async () => {
  const dir = await initSilo();
  // Run doctor WITHOUT opt-out so the "Next non-doctor command will fire..."
  // line shows. Doctor itself doesn't auto-fire — verified separately.
  const r = runSilo(['doctor', `--silo-dir=${dir}`], { SILO_DISABLE_UPDATE_CHECK: '' });
  assert.equal(r.status, 0, `doctor failed: ${r.stderr}`);
  assert.match(r.stdout, /Silo v\d/);
  assert.match(r.stdout, /Update check: no cache yet/);
  assert.match(r.stdout, /Operation log:/);
  assert.match(r.stdout, /Cache file:[\s\S]+Exists: no/);
});

test('cli doctor: reads a synthetic cache + reports ok status', async () => {
  const dir = await initSilo();
  const cachePath = join(dir, 'update-status.json');
  await fs.writeFile(cachePath, JSON.stringify({
    schema_version: 1,
    last_checked_at: '2026-05-18T05:00:00Z',
    last_successful_check_at: '2026-05-18T05:00:00Z',
    last_successful_latest_version: '0.1.0-m1',
    current_version: '0.1.0-m1',
    latest_version: '0.1.0-m1',
    tag_url: 'https://example/v0.1.0-m1',
    released_at: '2026-05-17T14:00:00Z',
    update_available: false,
    last_check_status: 'ok',
    last_error: null,
    consecutive_failures: 0,
  }, null, 2));
  const r = runSilo(['doctor', `--silo-dir=${dir}`]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Status: ok/);
  assert.match(r.stdout, /Latest available: v0\.1\.0-m1/);
  assert.match(r.stdout, /No upgrade needed/);
});

test('cli doctor: shows upgrade hint when update_available', async () => {
  const dir = await initSilo();
  const cachePath = join(dir, 'update-status.json');
  await fs.writeFile(cachePath, JSON.stringify({
    schema_version: 1,
    last_checked_at: '2026-05-18T05:00:00Z',
    last_successful_check_at: '2026-05-18T05:00:00Z',
    last_successful_latest_version: '0.1.0-m2',
    current_version: '0.1.0-m1',
    latest_version: '0.1.0-m2',
    tag_url: 'https://example/v0.1.0-m2',
    released_at: '2026-05-17T14:00:00Z',
    update_available: true,
    last_check_status: 'ok',
    last_error: null,
    consecutive_failures: 0,
  }, null, 2));
  const r = runSilo(['doctor', `--silo-dir=${dir}`]);
  assert.match(r.stdout, /Upgrade: run `git pull && npm install`/);
});

test('cli doctor: shows opt-out banner when SILO_DISABLE_UPDATE_CHECK=1', async () => {
  const dir = await initSilo();
  const r = runSilo(['doctor', `--silo-dir=${dir}`], { SILO_DISABLE_UPDATE_CHECK: '1' });
  assert.match(r.stdout, /Update checks are disabled/);
});

test('cli doctor: --check-updates honors opt-out without --force', async () => {
  const dir = await initSilo();
  const r = runSilo(
    ['doctor', `--silo-dir=${dir}`, '--check-updates'],
    { SILO_DISABLE_UPDATE_CHECK: '1' },
  );
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Update check skipped — SILO_DISABLE_UPDATE_CHECK is set/);
  // No cache written since the check was skipped.
  const cacheExists = await fs.access(join(dir, 'update-status.json')).then(() => true).catch(() => false);
  assert.equal(cacheExists, false);
});

test('cli doctor: shows failure status with consecutive_failures from cache', async () => {
  const dir = await initSilo();
  const cachePath = join(dir, 'update-status.json');
  await fs.writeFile(cachePath, JSON.stringify({
    schema_version: 1,
    last_checked_at: '2026-05-18T05:00:00Z',
    last_successful_check_at: '2026-05-10T05:00:00Z',
    last_successful_latest_version: '0.1.0-m1',
    current_version: '0.1.0-m1',
    latest_version: '0.1.0-m1',
    tag_url: 'https://example/v0.1.0-m1',
    released_at: null,
    update_available: false,
    last_check_status: 'network_error',
    last_error: 'ETIMEDOUT',
    consecutive_failures: 3,
  }, null, 2));
  const r = runSilo(['doctor', `--silo-dir=${dir}`]);
  assert.match(r.stdout, /Status: network_error \(ETIMEDOUT\)/);
  assert.match(r.stdout, /Consecutive failures: 3/);
  assert.match(r.stdout, /Last successful check: 2026-05-10/);
});

test('cli doctor: auto-check is NOT fired when running `silo doctor` itself', async () => {
  // Sanity: doctor must not invoke maybeFireUpdateCheck (which would create
  // a cache via the worker). We run without opt-out and verify no cache
  // appears within the short test window. (Worker is async + detached, but
  // we exit immediately after; the worker would still write eventually if
  // it had been spawned. We allow a 200ms grace then assert no file.)
  const dir = await initSilo();
  runSilo(['doctor', `--silo-dir=${dir}`], { SILO_DISABLE_UPDATE_CHECK: '' });
  // Brief wait — but more importantly the dispatcher's auto-check skip
  // for `doctor` is what we're really verifying. Doctor's read path can
  // legitimately create the cache directory but not the file.
  await new Promise((r) => setTimeout(r, 50));
  const cacheExists = await fs.access(join(dir, 'update-status.json'))
    .then(() => true)
    .catch(() => false);
  // Doctor itself doesn't write a cache (only --check-updates does).
  // The auto-check skip means no worker fires either.
  assert.equal(cacheExists, false);
});
