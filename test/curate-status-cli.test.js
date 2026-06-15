/**
 * `silo curate-status` end-to-end CLI tests (SPEC-curate-liveness §8, T34–T37).
 *
 * Drives the real CLI via spawnSync (mirrors test/status-events.test.js), with
 * curate heartbeat events seeded through a LogWriter. Verifies the subcommand
 * writes a valid curate-status.json (and ONLY that file — never curate-emit.json),
 * stays in the update-check exclusion gate, and reflects in-band recovery.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { LogWriter } from '../src/log/append.js';
import { writeCurateStatus, STATUS_FILENAME } from '../src/util/curate-liveness.js';
import {
  loadCurateStatus,
  loadCurateEmit,
  buildSiloNotices,
  _resetCurateCache,
  _resetCurateEmitCache,
} from '../silo-mcp/notices.js';

const CLI = join(process.cwd(), 'src/cli/silo.js');
const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (n) => new Date(Date.now() - n * DAY_MS).toISOString();

function runCli(siloDir, args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args, `--silo-dir=${siloDir}`], {
    encoding: 'utf8',
    env: { ...process.env, SILO_DISABLE_UPDATE_CHECK: '1', ...env },
  });
}

async function initSiloViaCli() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'silo-curate-status-cli-'));
  const r = spawnSync(
    process.execPath,
    [CLI, 'init', `--silo-dir=${dir}`, '--operator=tester', '--uid=0'],
    { encoding: 'utf8', env: { ...process.env, SILO_DISABLE_UPDATE_CHECK: '1' } },
  );
  assert.equal(r.status, 0, `init failed: ${r.stderr}`);
  return dir;
}

async function emitSystemEvent(writer, { content, source = 'silo-curate', ts, principal = 'curator' }) {
  return writer.append({
    type: 'write_event',
    isStateBearing: true,
    intentId: `intent:${Math.random()}`,
    principal,
    payload: { slug: 'system', tag: 'FACT', content, source },
    ts,
  });
}

const readStatus = async (dir) => JSON.parse(await fs.readFile(join(dir, STATUS_FILENAME), 'utf8'));

// ── T34 — stale history writes is_stale=true, no emit stamp ────────────────────

test('T34 curate-status CLI: stale history → is_stale=true cache, no curate-emit.json', async () => {
  const dir = await initSiloViaCli();
  const writer = new LogWriter(dir);
  await writer.init();
  // Last success ~30d ago → far past STALE_DAYS, prior dark → lights up.
  await emitSystemEvent(writer, { content: 'silo-curate run started (run_id=a)', ts: daysAgo(30) });
  await emitSystemEvent(writer, { content: 'silo-curate run complete (run_id=a)', ts: daysAgo(30) });

  const r = runCli(dir, ['curate-status']);
  assert.equal(r.status, 0, r.stderr);

  const cache = await readStatus(dir);
  assert.equal(cache.is_stale, true);
  assert.equal(cache.schema_version, 1);
  assert.ok(cache.last_success_at);
  // The read-path cooldown stamp must NOT be created by the cron writer (§5.5).
  assert.equal((await fs.readdir(dir)).includes('curate-emit.json'), false);
});

// ── T35 — fresh silo (no curate events) writes a dark never-succeeded record ───

test('T35 curate-status CLI: fresh silo (no curate events) → dark cache, null success, stamped first_observed_at, exit 0', async () => {
  const dir = await initSiloViaCli();
  const r = runCli(dir, ['curate-status']);
  assert.equal(r.status, 0, r.stderr); // must NEVER fail a cron

  const cache = await readStatus(dir);
  assert.equal(cache.is_stale, false);
  assert.equal(cache.last_success_at, null);
  assert.equal(cache.last_event_kind, null);
  assert.equal(cache.in_progress, false);
  assert.ok(cache.first_observed_at, 'first_observed_at stamped');
  assert.equal(cache.schema_version, 1);
});

// ── T36 — does not fire an update-check worker (exclusion gate, §5.2) ──────────

test('T36 curate-status CLI: does not fire an update-check worker (no update-status.json)', async () => {
  const dir = await initSiloViaCli();
  // Run with update-check ENABLED: only the exclusion gate prevents the worker.
  const r = runCli(dir, ['curate-status'], { SILO_DISABLE_UPDATE_CHECK: '' });
  assert.equal(r.status, 0, r.stderr);

  // A spawned detached worker writes update-status.json after fetch OR after its
  // network timeout (DEFAULT_TIMEOUT_MS=5000) folds to a failure status. Wait
  // past that ceiling so this is deterministic: if the gate regressed, the file
  // WILL exist by now; if the gate holds, no worker ever spawned. (In the
  // passing case this is pure idle — no network call happens at all.)
  await new Promise((res) => setTimeout(res, 6000));
  assert.equal(
    (await fs.readdir(dir)).includes('update-status.json'),
    false,
    'curate-status must be in the update-check exclusion gate',
  );
});

// ── T37 — in-band recovery: refreshes computed_at over an older prior cache ────

test('T37 curate-status CLI: refreshes computed_at over an older prior cache + clears stale (recovery path)', async () => {
  const dir = await initSiloViaCli();
  const writer = new LogWriter(dir);
  await writer.init();

  // A prior cache "written by detect" 5 days ago, marked stale.
  const old = daysAgo(5);
  await writeCurateStatus(dir, {
    last_run_at: old,
    last_success_at: null,
    consecutive_failures: 0,
    last_failure_msg: null,
    last_event_kind: null,
    in_progress: false,
    computed_at: old,
    days_since_success: null,
    is_stale: true,
    first_observed_at: old,
  });

  // A fresh successful curate run happens now (in-band recovery reflector).
  await emitSystemEvent(writer, { content: 'silo-curate run started (run_id=r)', ts: daysAgo(0.02) });
  await emitSystemEvent(writer, { content: 'silo-curate run complete (run_id=r)', ts: daysAgo(0.01) });

  const r = runCli(dir, ['curate-status']);
  assert.equal(r.status, 0, r.stderr);

  const cache = await readStatus(dir);
  assert.ok(Date.parse(cache.computed_at) > Date.parse(old), 'computed_at advanced to ~now');
  assert.equal(cache.is_stale, false, 'fresh success cleared the light (prior stale, days ≤ CLEAR_DAYS)');
  assert.equal(cache.first_observed_at, old, 'first_observed_at carried forward from the prior cache');
});

// ── Integration: writer → read-path contract (what server.js glues) ───────────
// The CLI writes curate-status.json; the bridge's read path (loadCurateStatus →
// buildSiloNotices) must consume that exact file and raise the notice. This
// guards the schema contract between the two halves end-to-end — the bridge
// itself isn't in the test suite.
test('integration: CLI-written curate-status.json is consumable by the read path → curate_liveness_stale', async () => {
  _resetCurateCache();
  _resetCurateEmitCache();
  const dir = await initSiloViaCli();
  const writer = new LogWriter(dir);
  await writer.init();
  await emitSystemEvent(writer, { content: 'silo-curate run started (run_id=a)', ts: daysAgo(30) });
  await emitSystemEvent(writer, { content: 'silo-curate run complete (run_id=a)', ts: daysAgo(30) });

  const r = runCli(dir, ['curate-status']);
  assert.equal(r.status, 0, r.stderr);

  // Exactly what siloNoticesForRead does in server.js.
  const curateStatus = await loadCurateStatus(join(dir, STATUS_FILENAME));
  const curateEmit = await loadCurateEmit(join(dir, 'curate-emit.json'));
  assert.equal(curateStatus.kind, 'ok');
  const notices = await buildSiloNotices({
    curateStatus,
    curateEmit,
    curateLivenessDisabled: false,
    curateEmitPath: join(dir, 'curate-emit.json'),
  });
  assert.ok(notices, 'expected a notice');
  assert.ok(notices.some((n) => n.kind === 'curate_liveness_stale'), 'curate_liveness_stale fires from the CLI-written file');
});
