/**
 * Tests for the cron status-event parsers — detector + curator. Pure
 * functions reading state.topic_content for `system`-slug events with
 * the right source tag.
 *
 * deriveDetectorStatus is exported from the projection module (it's
 * what powers PENDING-SUGGESTIONS.json's detector_status field).
 * deriveCuratorStatus is only used by cmdDoctor today, so it isn't
 * exported — these tests instead drive the parser through end-to-end
 * `silo doctor` CLI invocations.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { LogWriter } from '../src/log/append.js';
import { interpret } from '../src/interpret/index.js';
import { buildPendingSuggestionsEnvelope } from '../src/projection/regenerate-pending-suggestions.js';

const CLI = join(process.cwd(), 'src/cli/silo.js');

async function freshSilo() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'silo-status-test-'));
  const writer = new LogWriter(dir);
  await writer.init();
  return { dir, writer };
}

async function emitSystemEvent(writer, { content, source, ts, principal = 'curator' }) {
  return writer.append({
    type: 'write_event',
    isStateBearing: true,
    intentId: `intent:${Math.random()}`,
    principal,
    payload: { slug: 'system', tag: 'FACT', content, source },
    ts,
  });
}

// ── detector_status now counts "run failed" events explicitly ───────────────

test('detector_status: counts explicit `run failed` events', async () => {
  const { writer } = await freshSilo();
  await emitSystemEvent(writer, {
    content: 'silo-detect run started (run_id=a)',
    source: 'silo-topic-detector',
    ts: '2026-05-10T04:00:00Z',
  });
  await emitSystemEvent(writer, {
    content: 'silo-detect run failed (run_id=a, exit=1)',
    source: 'silo-topic-detector',
    ts: '2026-05-10T04:00:01Z',
  });
  await emitSystemEvent(writer, {
    content: 'silo-detect run started (run_id=b)',
    source: 'silo-topic-detector',
    ts: '2026-05-11T04:00:00Z',
  });
  await emitSystemEvent(writer, {
    content: 'silo-detect run failed (run_id=b, exit=1)',
    source: 'silo-topic-detector',
    ts: '2026-05-11T04:00:01Z',
  });
  const state = await interpret(writer);
  const env = buildPendingSuggestionsEnvelope(state, Date.parse('2026-05-12T00:00:00Z'));
  assert.equal(env.detector_status.consecutive_failures, 2);
  assert.equal(env.detector_status.last_run_at, '2026-05-11T04:00:01Z');
});

test('detector_status: successful complete after failure resets consecutive_failures', async () => {
  const { writer } = await freshSilo();
  await emitSystemEvent(writer, {
    content: 'silo-detect run started (run_id=a)',
    source: 'silo-topic-detector',
    ts: '2026-05-10T04:00:00Z',
  });
  await emitSystemEvent(writer, {
    content: 'silo-detect run failed (run_id=a, exit=1)',
    source: 'silo-topic-detector',
    ts: '2026-05-10T04:00:01Z',
  });
  await emitSystemEvent(writer, {
    content: 'silo-detect run started (run_id=b)',
    source: 'silo-topic-detector',
    ts: '2026-05-11T04:00:00Z',
  });
  await emitSystemEvent(writer, {
    content: 'silo-detect run complete (run_id=b)',
    source: 'silo-topic-detector',
    ts: '2026-05-11T04:00:01Z',
  });
  const state = await interpret(writer);
  const env = buildPendingSuggestionsEnvelope(state, Date.parse('2026-05-12T00:00:00Z'));
  assert.equal(env.detector_status.consecutive_failures, 0);
  assert.equal(env.detector_status.last_success_at, '2026-05-11T04:00:01Z');
});

// ── curate_status surfaces in `silo doctor` ─────────────────────────────────

function runDoctor(siloDir, env = {}) {
  return spawnSync(process.execPath, [CLI, 'doctor', `--silo-dir=${siloDir}`], {
    encoding: 'utf8',
    env: { ...process.env, SILO_DISABLE_UPDATE_CHECK: '1', ...env },
  });
}

async function initSiloViaCli() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'silo-status-cli-'));
  const r = spawnSync(process.execPath, [CLI, 'init', `--silo-dir=${dir}`, '--operator=tester', '--uid=0'], {
    encoding: 'utf8',
    env: { ...process.env, SILO_DISABLE_UPDATE_CHECK: '1' },
  });
  assert.equal(r.status, 0, `init failed: ${r.stderr}`);
  return dir;
}

test('cli doctor: curate status shows "no curate events yet" on fresh silo', async () => {
  const dir = await initSiloViaCli();
  const r = runDoctor(dir);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Curate status: no `silo-curate` events in the log yet/);
});

test('cli doctor: curate status shows "ok" after a successful run pair', async () => {
  const dir = await initSiloViaCli();
  const writer = new LogWriter(dir);
  await writer.init();
  await emitSystemEvent(writer, {
    content: 'silo-curate run started (run_id=a, days_back=14)',
    source: 'silo-curate',
    ts: '2026-05-19T05:00:00Z',
  });
  await emitSystemEvent(writer, {
    content: 'silo-curate run complete (run_id=a)',
    source: 'silo-curate',
    ts: '2026-05-19T05:00:30Z',
  });
  const r = runDoctor(dir);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Curate status:.*2026-05-19/);
  assert.match(r.stdout, /Status: ok/);
  assert.match(r.stdout, /Last successful curate: 2026-05-19/);
});

test('cli doctor: curate status shows "failing" + N consecutive failures', async () => {
  const dir = await initSiloViaCli();
  const writer = new LogWriter(dir);
  await writer.init();
  // One success, then three failures.
  await emitSystemEvent(writer, {
    content: 'silo-curate run started (run_id=a)',
    source: 'silo-curate',
    ts: '2026-05-15T05:00:00Z',
  });
  await emitSystemEvent(writer, {
    content: 'silo-curate run complete (run_id=a)',
    source: 'silo-curate',
    ts: '2026-05-15T05:00:30Z',
  });
  for (let i = 0; i < 3; i++) {
    await emitSystemEvent(writer, {
      content: `silo-curate run started (run_id=fail${i})`,
      source: 'silo-curate',
      ts: `2026-05-${16 + i}T05:00:00Z`,
    });
    await emitSystemEvent(writer, {
      content: `silo-curate run failed (run_id=fail${i}, exit=1)`,
      source: 'silo-curate',
      ts: `2026-05-${16 + i}T05:00:30Z`,
    });
  }
  const r = runDoctor(dir);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Status: failing \(3 consecutive failures\)/);
  assert.match(r.stdout, /Last failure: silo-curate run failed.*exit=1/);
  assert.match(r.stdout, /Last successful curate: 2026-05-15/);
});

test('cli doctor: curate status ignores other system events that don\'t start with silo-curate', async () => {
  const dir = await initSiloViaCli();
  const writer = new LogWriter(dir);
  await writer.init();
  // A non-curate system event must NOT flip curate status into "found events".
  await emitSystemEvent(writer, {
    content: 'silo-detect run started',
    source: 'silo-topic-detector',
    ts: '2026-05-19T04:00:00Z',
  });
  const r = runDoctor(dir);
  assert.match(r.stdout, /Curate status: no `silo-curate` events in the log yet/);
});
