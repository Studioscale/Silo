/**
 * Tests for `silo regenerate --strict` + chain-break surface in `silo doctor`.
 *
 * Strict mode refuses to project Zone B (topic files, event logs, TOPIC-
 * INDEX.md, PENDING-SUGGESTIONS.json) when state.skipped contains
 * hash_chain_break or malformed_entry_shape entries — the new
 * verify-on-fold check from the interpret-chain-verify commit.
 *
 * Doctor surfaces the same information for diagnosis: how many breaks,
 * the first few details, and a pointer at `silo regenerate --strict`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { LogWriter } from '../src/log/append.js';
import { buildEntry, serializeEntry } from '../src/log/entry.js';

const CLI = join(process.cwd(), 'src/cli/silo.js');

function runSilo(args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, SILO_DISABLE_UPDATE_CHECK: '1', ...env },
  });
}

async function freshSilo() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'silo-strict-test-'));
  // Initialize via CLI so we get a real principal + chain.
  const r = runSilo(['init', `--silo-dir=${dir}`, '--operator=helder', '--uid=0']);
  assert.equal(r.status, 0, `init failed: ${r.stderr}`);
  return dir;
}

async function appendForgedChainBreak(siloDir, validSeq, validHash) {
  // Forge an entry at validSeq+1 with a deliberately-wrong hash_prev.
  const forged = buildEntry({
    type: 'write_event',
    isStateBearing: true,
    seq: validSeq + 1,
    hashPrev: 'd'.repeat(64),
    intentId: 'intent:forged',
    principal: 'attacker',
    payload: { slug: 'demo', tag: 'FACT', content: 'injected' },
    ts: '2026-05-19T10:00:00Z',
  });
  const logDir = join(siloDir, 'operation-log');
  const files = (await fs.readdir(logDir)).filter((f) => f.endsWith('.jsonl')).sort();
  await fs.appendFile(join(logDir, files[files.length - 1]), serializeEntry(forged));
}

// ── Clean log: --strict allows regen ────────────────────────────────────────

test('cli regenerate --strict: clean log allows regen', async () => {
  const dir = await freshSilo();
  const target = await fs.mkdtemp(join(tmpdir(), 'silo-strict-target-'));
  // Add a write_event so there's something to project.
  runSilo(['write', `--silo-dir=${dir}`, '--slug=demo', '--tag=FACT', '--content=hello']);

  const r = runSilo(['regenerate', `--silo-dir=${dir}`, `--to=${target}`, '--strict']);
  assert.equal(r.status, 0, `strict regen failed on clean log: ${r.stderr}`);
});

// ── Chain break: --strict refuses to regen ─────────────────────────────────

test('cli regenerate --strict: chain break refuses regen with structured error', async () => {
  const dir = await freshSilo();
  // Get the current tail so we can forge a break after it.
  const writer = new LogWriter(dir);
  await writer.init();
  const tail = writer.tail();
  await appendForgedChainBreak(dir, tail.seq, tail.hash);

  const target = await fs.mkdtemp(join(tmpdir(), 'silo-strict-target-'));
  const r = runSilo(['regenerate', `--silo-dir=${dir}`, `--to=${target}`, '--strict']);

  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /log integrity issues detected/);
  assert.match(r.stderr, /skipped entries \(chain breaks or shape errors\)/);
});

// ── Chain break: regen WITHOUT --strict still works (tolerant default) ─────

test('cli regenerate without --strict: chain break gets skipped, projection completes', async () => {
  const dir = await freshSilo();
  const writer = new LogWriter(dir);
  await writer.init();
  const tail = writer.tail();
  await appendForgedChainBreak(dir, tail.seq, tail.hash);

  const target = await fs.mkdtemp(join(tmpdir(), 'silo-strict-target-'));
  const r = runSilo(['regenerate', `--silo-dir=${dir}`, `--to=${target}`]);
  // Non-strict mode: the chain-broken entry lands in state.skipped, but
  // regenerate doesn't refuse — the previously-folded clean entries still
  // produce a valid projection.
  assert.equal(r.status, 0, `non-strict regen unexpectedly failed: ${r.stderr}`);
});

// ── Doctor surfaces chain breaks ────────────────────────────────────────────

test('cli doctor: surfaces hash chain break count + first few details', async () => {
  const dir = await freshSilo();
  const writer = new LogWriter(dir);
  await writer.init();
  const tail = writer.tail();
  await appendForgedChainBreak(dir, tail.seq, tail.hash);

  const r = runSilo(['doctor', `--silo-dir=${dir}`]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /⚠ Hash chain integrity: 1 break detected/);
  assert.match(r.stdout, /Run `silo regenerate --strict`/);
});

test('cli doctor: clean log shows "Hash chain: ok"', async () => {
  const dir = await freshSilo();
  runSilo(['write', `--silo-dir=${dir}`, '--slug=demo', '--tag=FACT', '--content=hello']);

  const r = runSilo(['doctor', `--silo-dir=${dir}`]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Hash chain: ok/);
});
