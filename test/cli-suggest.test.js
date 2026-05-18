/**
 * Phase 2.2 §15 step 8 — CLI integration smoke tests.
 *
 * Spawns the silo binary (single-process subprocess) and exercises:
 *   - silo write --source=...  (Phase 2.2 §12.1 — new flag)
 *   - silo suggest --status    (diagnostic verb)
 *   - silo suggest --list      (pending list, JSON output)
 *   - silo suggest --dismiss <seq>
 *
 * Skips `--run-now` end-to-end because that requires a real LLM key;
 * coverage for the detection orchestration lives in topic-proposal-detect.test.js.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const CLI = join(process.cwd(), 'src/cli/silo.js');

function runSilo(args, env = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

async function freshSiloDir() {
  return fs.mkdtemp(join(tmpdir(), 'silo-cli-suggest-'));
}

async function initSilo(siloDir) {
  const r = runSilo(['init', `--silo-dir=${siloDir}`, '--operator=helder', '--uid=1000']);
  assert.equal(r.status, 0, `init failed: ${r.stderr}`);
}

test('cli: write --source flag persists `source` in payload', async () => {
  const dir = await freshSiloDir();
  await initSilo(dir);
  const r = runSilo([
    'write',
    `--silo-dir=${dir}`,
    '--slug=general',
    '--tag=FACT',
    '--content=test',
    '--source=cli-test',
  ]);
  assert.equal(r.status, 0, `write failed: ${r.stderr}`);
  assert.match(r.stdout, /source=cli-test/);
  // Verify the payload landed on disk.
  const logDir = join(dir, 'operation-log');
  const files = (await fs.readdir(logDir)).filter((f) => f.endsWith('.jsonl')).sort();
  const lines = (await fs.readFile(join(logDir, files[files.length - 1]), 'utf8'))
    .split('\n')
    .filter(Boolean);
  const lastEntry = JSON.parse(lines[lines.length - 1]);
  assert.equal(lastEntry.payload.source, 'cli-test');
});

test('cli: suggest --status on fresh silo prints zero counts', async () => {
  const dir = await freshSiloDir();
  await initSilo(dir);
  const r = runSilo(['suggest', `--silo-dir=${dir}`, '--status']);
  assert.equal(r.status, 0, `suggest --status failed: ${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.pending, 0);
  assert.equal(parsed.accepted, 0);
  assert.equal(parsed.dismissed, 0);
  assert.deepEqual(parsed.active_cooldowns, []);
});

test('cli: suggest --list (no pending) prints sentinel', async () => {
  const dir = await freshSiloDir();
  await initSilo(dir);
  const r = runSilo(['suggest', `--silo-dir=${dir}`, '--list']);
  assert.equal(r.status, 0, `suggest --list failed: ${r.stderr}`);
  assert.match(r.stdout, /no pending suggestions/);
});

test('cli: suggest rejects when no verb passed', async () => {
  const dir = await freshSiloDir();
  await initSilo(dir);
  const r = runSilo(['suggest', `--silo-dir=${dir}`]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /one of --run-now/);
});

test('cli: suggest rejects when more than one verb passed', async () => {
  const dir = await freshSiloDir();
  await initSilo(dir);
  const r = runSilo(['suggest', `--silo-dir=${dir}`, '--status', '--list']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /only one subverb/);
});

test('cli: suggest --dismiss surfaces SuggestionOpError code for unknown seq', async () => {
  const dir = await freshSiloDir();
  await initSilo(dir);
  const r = runSilo(['suggest', `--silo-dir=${dir}`, '--dismiss', '999']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /DISMISS_INVALID_SEQS/);
});
