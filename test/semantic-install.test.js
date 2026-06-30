/**
 * Step 4 — `silo semantic install` + gates + `silo doctor` semantic section.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { installSemantic, installMarkerPath, DEP_PINS } from '../src/embedding/install.js';
import { semanticEnabled, readInstallRecord } from '../src/embedding/embedder.js';
import { describeSemanticStatus } from '../src/embedding/semantic-status.js';
import { buildEmbeddingCache } from '../src/projection/embed-cache.js';
import { LogWriter } from '../src/log/append.js';
import { interpret } from '../src/interpret/index.js';
import { seedTopic } from './helpers/seed-topic.js';
import { makeMockEmbedder } from './helpers/mock-embedder.js';

const CLI = join(process.cwd(), 'src/cli/silo.js');
function runSilo(args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, SILO_DISABLE_UPDATE_CHECK: '1', ...env },
  });
}
async function freshDir(p = 'silo-sem-') {
  return fs.mkdtemp(join(tmpdir(), p));
}

test('install: ships on @huggingface/transformers v3 (package decision)', () => {
  // We migrated off the frozen @xenova/transformers v2 to the maintained v3.
  assert.ok(DEP_PINS['@huggingface/transformers'], 'pins @huggingface/transformers');
  assert.ok(!DEP_PINS['@xenova/transformers'], 'no longer pins the frozen v2');
  assert.match(DEP_PINS['@huggingface/transformers'], /^3\./, 'pinned to a v3 release');
});

test('installSemantic: requires an explicit model (no silent default)', async () => {
  const dir = await freshDir();
  await assert.rejects(installSemantic({ siloDir: dir, skipDeps: true }), /choose a model explicitly/);
  await assert.rejects(installSemantic({ siloDir: dir, model: 'nope', skipDeps: true }), /choose a model explicitly/);
});

test('installSemantic: a SUCCESSFUL dep install reports installed:true + deps_status', async () => {
  const dir = await freshDir();
  let calledWith = null;
  const res = await installSemantic({
    siloDir: dir, model: 'bge-small-en-v1.5', nowIso: 't',
    runInstall: (pkgs) => { calledWith = pkgs; return 'installed'; }, // inject a successful install
  });
  assert.equal(res.installed, true);
  assert.equal(res.deps_status, 'installed');
  // the pinned package@version is what gets installed
  assert.ok(calledWith.some((p) => p.startsWith('@huggingface/transformers@3.')));
  assert.equal(readInstallRecord(dir).deps_status, 'installed');
});

test('installSemantic: a FAILED dep install reports installed:false but still records the marker', async () => {
  const dir = await freshDir();
  const res = await installSemantic({
    siloDir: dir, model: 'bge-small-en-v1.5', nowIso: 't',
    runInstall: () => 'failed(EINVAL)', // simulate the Windows .cmd spawn failure
  });
  assert.equal(res.installed, false);
  assert.equal(res.deps_status, 'failed(EINVAL)');
  // marker IS written (so `silo doctor` can guide recovery), recording the choice
  const rec = readInstallRecord(dir);
  assert.equal(rec.model, 'bge-small-en-v1.5');
  assert.equal(rec.deps_status, 'failed(EINVAL)');
});

test('installSemantic: writes the marker; the triple gate then opens with SILO_SEMANTIC=on', async () => {
  const dir = await freshDir();
  const res = await installSemantic({ siloDir: dir, model: 'bge-small-en-v1.5', skipDeps: true, nowIso: '2026-06-29T00:00:00Z' });
  assert.equal(res.installed, true);
  assert.equal(res.model, 'bge-small-en-v1.5');
  assert.deepEqual(res.dep_pins, DEP_PINS);

  const rec = readInstallRecord(dir);
  assert.equal(rec.model, 'bge-small-en-v1.5');
  assert.equal(rec.installed_at, '2026-06-29T00:00:00Z');

  // Gate: marker present satisfies model+installed; flag is still required.
  assert.equal(semanticEnabled({ siloDir: dir, env: {} }), false);
  assert.equal(semanticEnabled({ siloDir: dir, env: { SILO_SEMANTIC: 'on' } }), true);
});

test('installSemantic: dry-run writes nothing', async () => {
  const dir = await freshDir();
  const res = await installSemantic({ siloDir: dir, model: 'multilingual-e5-small', dryRun: true });
  assert.equal(res.dry_run, true);
  await assert.rejects(fs.access(installMarkerPath(dir)));
});

test('describeSemanticStatus: reports disabled→enabled + cache health + per-tier counts', async () => {
  const dir = await freshDir();
  // disabled, no install
  let s = await describeSemanticStatus({ siloDir: dir, env: {} });
  assert.equal(s.enabled, false);
  assert.equal(s.installed, false);
  assert.equal(s.cache.status, 'missing');

  // install + build a cache with the mock embedder
  await installSemantic({ siloDir: dir, model: 'bge-small-en-v1.5', skipDeps: true });
  const writer = new LogWriter(dir);
  await writer.init();
  await seedTopic(writer, 'alpha');
  await writer.append({
    type: 'write_event', isStateBearing: true, intentId: 'i:1', principal: 'helder',
    payload: { slug: 'alpha', tag: 'CURATED', content: 'curated fact one' }, ts: '2026-06-29T10:00:00Z',
  });
  await writer.append({
    type: 'write_event', isStateBearing: true, intentId: 'i:2', principal: 'helder',
    payload: { slug: 'alpha', tag: 'FACT', content: 'a note here' }, ts: '2026-06-29T10:01:00Z',
  });
  const state = await interpret(writer);
  await buildEmbeddingCache({ logReader: writer, state, siloDir: dir, embedder: makeMockEmbedder(), nowIso: 't' });

  s = await describeSemanticStatus({ siloDir: dir, env: { SILO_SEMANTIC: 'on' } });
  assert.equal(s.enabled, true);
  assert.equal(s.installed, true);
  assert.equal(s.model, 'bge-small-en-v1.5');
  assert.ok(s.cache.chunks >= 2);
  assert.equal(s.cache.per_tier.curated, 1);
  assert.equal(s.cache.per_tier.note, 1);
  assert.ok(s.cache.bytes > 0);
});

test('cli: `silo semantic install` without --model exits 2 with the choices', async () => {
  const dir = await freshDir();
  runSilo(['init', `--silo-dir=${dir}`, '--operator=helder', '--uid=1000']);
  const r = runSilo(['semantic', 'install', `--silo-dir=${dir}`]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /choose a model explicitly/);
});

test('cli: `silo semantic install --model --skip-deps` writes the marker; doctor shows it', async () => {
  const dir = await freshDir();
  runSilo(['init', `--silo-dir=${dir}`, '--operator=helder', '--uid=1000']);
  const r = runSilo(['semantic', 'install', `--silo-dir=${dir}`, '--model=bge-small-en-v1.5', '--skip-deps']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /"installed": true/);

  const d = runSilo(['doctor', `--silo-dir=${dir}`], { SILO_SEMANTIC: 'on' });
  assert.equal(d.status, 0, d.stderr);
  assert.match(d.stdout, /Semantic search: enabled/);
  assert.match(d.stdout, /Model: bge-small-en-v1\.5/);
});
