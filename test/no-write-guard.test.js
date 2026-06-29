import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, sep } from 'node:path';
import { LogWriter } from '../src/log/append.js';
import { seedTopic } from './helpers/seed-topic.js';
import {
  RETRIEVAL_ORIGIN_MARKER, stampRetrievalOrigin,
  containsRetrievalOrigin, rejectRetrievalOrigin,
} from '../src/admission/retrieval-origin-guard.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(__dirname, '..', 'src');

// ── Layer 1: import-graph / call-graph ban (§4.9) ───────────────────────────
// Write / curate / distill modules may not import the search ranker
// (src/retrieval/index.js + semantic.js). The leaf utilities (chunk/tiers/
// fusion) are NOT the ranker; importing the admission origin-guard is also fine.

const GUARDED_GLOBS = [
  'distill', 'curate', 'admission', 'topic-proposal', 'import-jarvis',
];
const GUARDED_FILES = ['log/append.js'];

async function* walk(dir) {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith('.js')) yield p;
  }
}

function importSpecifiers(source) {
  const specs = [];
  const re = /\bimport\s+(?:[^'"]*?\bfrom\s+)?['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(source)) !== null) specs.push(m[1] ?? m[2]);
  return specs;
}

test('no-write lint: write/curate/distill modules never import the ranker (src/retrieval/)', async () => {
  const files = [];
  for (const g of GUARDED_GLOBS) for await (const f of walk(join(SRC, g))) files.push(f);
  for (const f of GUARDED_FILES) files.push(join(SRC, f));

  const rankerDir = join(SRC, 'retrieval') + sep;
  const violations = [];
  for (const file of files) {
    const src = await fs.readFile(file, 'utf8');
    for (const spec of importSpecifiers(src)) {
      if (!spec.startsWith('.')) continue; // bare/pkg imports can't be src/retrieval
      const resolved = resolve(dirname(file), spec);
      if (resolved.startsWith(rankerDir)) {
        violations.push(`${file} imports ranker: ${spec}`);
      }
    }
  }
  assert.deepEqual(violations, [], `no-write call-graph ban violated:\n${violations.join('\n')}`);
});

test('no-write lint: scanner would CATCH a planted ranker import (self-check)', () => {
  // Guards against a no-op lint: prove the matcher fires on a real violation.
  const planted = `import { retrieve } from '../retrieval/index.js';`;
  const specs = importSpecifiers(planted);
  const resolved = resolve(join(SRC, 'distill'), specs[0]);
  assert.ok(resolved.startsWith(join(SRC, 'retrieval') + sep));
});

// ── Layer 2: choke-point — reject a retrieval-origin payload (all forms) ────

// The ranker stamps BOTH the envelope and each per-result item (Step 3), so a
// single lifted snippet is just as detectable as the whole result.
function fakeRetrievalResult() {
  return stampRetrievalOrigin({
    mode: 'context_retrieval',
    results: [stampRetrievalOrigin(
      { slug: 'alpha', seq: 7, tier: 'curated', snippet: 'chose supplier X' }, 'q:digest123',
    )],
  }, 'q:digest123');
}

test('choke-point: marker present after stamping; survives JSON round-trip', () => {
  const r = fakeRetrievalResult();
  assert.equal(r[RETRIEVAL_ORIGIN_MARKER], 'q:digest123');
  assert.ok(containsRetrievalOrigin(JSON.parse(JSON.stringify(r))));
  assert.ok(JSON.stringify(r).includes(RETRIEVAL_ORIGIN_MARKER));
});

test('choke-point: rejects across object / JSON / stringified / handoff / curate / distill / CLI', () => {
  const r = fakeRetrievalResult();
  // object passthrough
  assert.throws(() => rejectRetrievalOrigin(r), /no-write invariant/);
  // JSON round-trip (object)
  assert.throws(() => rejectRetrievalOrigin(JSON.parse(JSON.stringify(r))), /no-write invariant/);
  // stringified snippet (string contains marker)
  assert.throws(() => rejectRetrievalOrigin(JSON.stringify(r.results[0])), /no-write invariant/);
  // handoff summary shape
  assert.throws(() => rejectRetrievalOrigin({ summary: r }), /no-write invariant/);
  // curate input shape
  assert.throws(() => rejectRetrievalOrigin({ bullets: [r] }), /no-write invariant/);
  // distill input shape (deeply nested)
  assert.throws(() => rejectRetrievalOrigin({ candidates: [{ from: r }] }), /no-write invariant/);
  // CLI pipe: content = stringified result
  assert.throws(() => rejectRetrievalOrigin({ slug: 'x', content: JSON.stringify(r) }), /no-write invariant/);
});

test('choke-point: a normal author-constructed payload passes', () => {
  assert.doesNotThrow(() => rejectRetrievalOrigin({ slug: 'alpha', tag: 'FACT', content: 'supplier chosen' }));
  assert.equal(containsRetrievalOrigin('an ordinary sentence about suppliers'), false);
});

// ── Layer 2 integration: real admission refuses a retrieval-origin write_event ─

async function freshSilo() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'silo-nowrite-'));
  const writer = new LogWriter(dir);
  await writer.init();
  return writer;
}

test('choke-point integration: admission rejects a write_event carrying a stringified result', async () => {
  const writer = await freshSilo();
  await seedTopic(writer, 'alpha');
  const r = fakeRetrievalResult();
  await assert.rejects(
    writer.append({
      type: 'write_event',
      isStateBearing: true,
      intentId: 'i:bad',
      principal: 'helder',
      payload: { slug: 'alpha', tag: 'FACT', content: JSON.stringify(r) },
      ts: '2026-04-22T10:00:00Z',
    }),
    /no-write invariant/,
  );
  // A clean write to the same slug still works.
  const ok = await writer.append({
    type: 'write_event',
    isStateBearing: true,
    intentId: 'i:ok',
    principal: 'helder',
    payload: { slug: 'alpha', tag: 'FACT', content: 'supplier chosen after review' },
    ts: '2026-04-22T10:01:00Z',
  });
  assert.ok(ok.seq > 0);
});
