import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogWriter } from '../src/log/append.js';
import { interpret } from '../src/interpret/index.js';
import { retireBullet } from '../src/topic-proposal/retire-ops.js';
import { contextRetrievalHybrid } from '../src/retrieval/index.js';
import { buildEmbeddingCache } from '../src/projection/embed-cache.js';
import { cosine, liveSearchUnits } from '../src/retrieval/semantic.js';
import { RETRIEVAL_ORIGIN_MARKER } from '../src/admission/retrieval-origin-guard.js';
import { rejectRetrievalOrigin } from '../src/admission/retrieval-origin-guard.js';
import { seedTopic } from './helpers/seed-topic.js';
import { makeMockEmbedder } from './helpers/mock-embedder.js';

const ENABLED = { SILO_SEMANTIC: 'on', SILO_SEMANTIC_MODEL: 'bge-small-en-v1.5' };

// Controlled vectors: cosine is fully determined by which "basis token" a text
// contains, so ranking assertions are deterministic.
function vectorFor(text) {
  if (text.includes('apple')) return [1, 0, 0];
  if (text.includes('groceries')) return [1, 0, 0]; // query + list-note collide on purpose
  if (text.includes('supplier')) return [0, 0, 1];
  if (text.includes('carrot')) return [0, 1, 0];
  return [0.01, 0.01, 0.01];
}
const mock = () => makeMockEmbedder({ dims: 3, vectorFor });

async function fresh() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'silo-hybrid-'));
  const writer = new LogWriter(dir);
  await writer.init();
  return { dir, writer };
}

let seqCtr = 0;
async function write(writer, slug, tag, content) {
  return writer.append({
    type: 'write_event', isStateBearing: true,
    intentId: `i:${slug}:${tag}:${seqCtr++}`,
    principal: 'helder', payload: { slug, tag, content },
    ts: new Date(Date.parse('2026-04-01T10:00:00Z') + seqCtr * 1000).toISOString(),
  });
}
async function declare(writer, name) {
  await writer.append({
    type: 'PRINCIPAL_DECLARED', socket: 'admin', isStateBearing: true,
    intentId: `i:dec:${name}:${seqCtr++}`, principal: 'operator',
    payload: { principal: name, class: 'human' }, ts: '2026-04-01T09:00:00Z',
  });
}
async function seal(writer, slug, readers) {
  await writer.append({
    type: 'ACL_SEALED', socket: 'admin', isStateBearing: true,
    intentId: `i:seal:${slug}:${seqCtr++}`, principal: 'operator',
    payload: { topic: slug, readers }, ts: '2026-04-01T11:00:00Z',
  });
}

// Build a corpus + its embedding cache; return state ready for hybrid search.
// The cache MUST be built with the same embedder used at search time (identity
// match) — pass `embedder` to control the semantic vectors in a test.
async function corpus(writes, { seals = [], embedder = mock() } = {}) {
  const { dir, writer } = await fresh();
  await declare(writer, 'helder');
  await declare(writer, 'alice');
  const slugs = [...new Set(writes.map((w) => w[0]))];
  for (const s of slugs) await seedTopic(writer, s);
  for (const [slug, tag, content] of writes) await write(writer, slug, tag, content);
  for (const [slug, readers] of seals) await seal(writer, slug, readers);
  let state = await interpret(writer);
  await buildEmbeddingCache({ logReader: writer, state, siloDir: dir, embedder, nowIso: '2026-04-01T12:00:00Z' });
  return { dir, writer, state };
}

async function search(ctx, query, opts = {}) {
  return contextRetrievalHybrid({
    state: ctx.state, query, principal: opts.principal ?? 'helder',
    scope: opts.scope ?? 'curated', siloDir: ctx.dir, env: ENABLED,
    embedder: opts.embedder ?? mock(), flags: opts.flags ?? [], limit: opts.limit ?? 10,
  });
}

// ── cosine ──────────────────────────────────────────────────────────────────
test('cosine: dot of normalized vectors', () => {
  assert.equal(cosine([1, 0, 0], [1, 0, 0]), 1);
  assert.equal(cosine([1, 0, 0], [0, 1, 0]), 0);
  assert.ok(Math.abs(cosine([0.6, 0.8, 0], [0.6, 0.8, 0]) - 1) < 1e-9);
});

// ── semantic-only paraphrase the lexical arm misses ──────────────────────────
test('hybrid: semantic arm surfaces a unit lexical misses; snippet + ranks present', async () => {
  const ctx = await corpus([['fruit-notes', 'CURATED', 'apple banana orange harvest']]);
  const r = await search(ctx, 'groceries'); // no lexical overlap with the unit
  assert.equal(r.semantic_status, 'ready');
  assert.equal(r.cache_status, 'fresh');
  const hit = r.results.find((x) => x.slug === 'fruit-notes');
  assert.ok(hit, 'semantic-only hit surfaced');
  assert.equal(hit.tier, 'curated');
  assert.equal(hit.lexical_rank, null);   // lexical missed it
  assert.equal(hit.semantic_rank, 1);     // semantic found it
  assert.ok(hit.similarity >= 0.99);
  assert.ok(hit.snippet.includes('apple'));
});

// ── exact-term value preserved despite the lexical down-weight (w_L=0.5) ──────
// The fusion down-weights lexical to cut RRF noise on paraphrase queries; these
// confirm exact identifiers (part numbers etc. — which LongMemEval never probes)
// still land at the top, in the two realistic cases.

test('exact-term: semantic AGREES → exact-id doc wins #1 (both arms contribute)', async () => {
  // query token "xk9920" is an exact identifier; the model also encodes it (agrees).
  const ev = makeMockEmbedder({ dims: 3, vectorFor: (t) =>
    t.includes('xk9920') ? [0, 0, 1] : t.includes('apple') ? [1, 0, 0] : [0.01, 0.01, 0.01] });
  const ctx = await corpus([
    ['parts', 'CURATED', 'gasket part number xk9920 in stock'],
    ['decoy', 'CURATED', 'apple banana orange harvest'],
  ], { embedder: ev });
  const r = await search(ctx, 'xk9920', { scope: 'curated', embedder: ev });
  assert.equal(r.results[0].slug, 'parts', 'exact-id doc ranks first');
  assert.equal(r.results[0].lexical_rank, 1, 'lexical arm matched the exact term');
  assert.equal(r.results[0].semantic_rank, 1, 'semantic agreed');
});

test('exact-term: semantic BLIND (below floor) → lexical arm carries the exact id', async () => {
  // The model has no confident neighbour for the identifier (similarity_floor cuts
  // it), so the lexical arm alone must surface it — and does.
  const ev = makeMockEmbedder({ dims: 3, vectorFor: (t) =>
    t.includes('serial') ? [1, 0, 0]            // the exact-id DOC (orthogonal to query → cosine 0)
      : t.includes('qz7788') ? [0, 1, 0]        // the QUERY (only it lacks "serial")
      : [0, 0, 1] });                            // decoy (also orthogonal to query)
  const ctx = await corpus([
    ['parts', 'CURATED', 'widget serial qz7788 shipped monday'],
    ['decoy', 'CURATED', 'unrelated meeting notes here'],
  ], { embedder: ev });
  const r = await search(ctx, 'qz7788', { scope: 'curated', embedder: ev });
  assert.equal(r.results[0].slug, 'parts', 'exact-id doc surfaces via lexical alone');
  assert.equal(r.results[0].lexical_rank, 1);
  assert.equal(r.results[0].semantic_rank, null, 'semantic found nothing above the floor');
});

// ── scope=curated excludes non-curated from BOTH arms ────────────────────────
test('hybrid: scope=curated drops note units from both arms; scope=all includes them', async () => {
  const ctx = await corpus([
    ['fruit-notes', 'CURATED', 'apple banana orange harvest'],
    ['list-notes', 'FACT', 'groceries list milk eggs'], // note; lexical match for "groceries"
  ]);
  const curatedOnly = await search(ctx, 'groceries', { scope: 'curated' });
  assert.ok(!curatedOnly.results.some((x) => x.slug === 'list-notes'), 'note excluded under scope=curated');
  assert.equal(curatedOnly.scope, 'curated');

  const all = await search(ctx, 'groceries', { scope: 'all' });
  assert.ok(all.results.some((x) => x.slug === 'list-notes'), 'note included under scope=all');
  assert.ok(all.grouped_by_tier.note.some((x) => x.slug === 'list-notes'));
  assert.ok(all.grouped_by_tier.curated.some((x) => x.slug === 'fruit-notes'));
});

// ── per-chunk tiering; no topic-level inheritance ────────────────────────────
test('hybrid: one slug contributes a curated unit AND a note unit to separate tiers', async () => {
  const ctx = await corpus([
    ['mixed', 'CURATED', 'supplier decision was finalized in review'],
    ['mixed', 'FACT', 'supplier called today about the order'],
  ]);
  const r = await search(ctx, 'supplier', { scope: 'all' });
  const mixedTiers = r.results.filter((x) => x.slug === 'mixed').map((x) => x.tier).sort();
  assert.deepEqual(mixedTiers, ['curated', 'note']);
  assert.ok(r.grouped_by_tier.curated.some((x) => x.slug === 'mixed'));
  assert.ok(r.grouped_by_tier.note.some((x) => x.slug === 'mixed'));
});

// ── tier is a LABEL, not a sort key (bounded_prior_cap=0) ─────────────────────
test('hybrid: a note with higher fused relevance outranks a curated unit (tier never dominates)', async () => {
  const ctx = await corpus([
    ['fruit-notes', 'CURATED', 'apple banana orange harvest'], // semantic only
    ['list-notes', 'FACT', 'groceries list milk eggs'],        // lexical AND semantic (groceries)
  ]);
  const r = await search(ctx, 'groceries', { scope: 'all' });
  assert.equal(r.bounded_prior_cap, 0);
  assert.equal(r.results[0].slug, 'list-notes', 'note ranks first on fused relevance');
  assert.equal(r.results[0].tier, 'note');
  assert.equal(r.results[0].tier_outranks_curated, true);
});

// ── ACL applied before fusion (private slug never leaks) ─────────────────────
test('hybrid: ACL filters before ranking — helder cannot see alice-sealed curated unit', async () => {
  const ctx = await corpus(
    [['secret', 'CURATED', 'apple secret plan'], ['fruit-notes', 'CURATED', 'apple pie recipe']],
    { seals: [['secret', ['alice', 'operator']]] },
  );
  const asHelder = await search(ctx, 'groceries', { principal: 'helder' });
  assert.ok(!asHelder.results.some((x) => x.slug === 'secret'), 'helder must not see sealed slug');
  const asAlice = await search(ctx, 'groceries', { principal: 'alice' });
  assert.ok(asAlice.results.some((x) => x.slug === 'secret'), 'alice sees her sealed slug');
});

// ── candidates from State only: retired-after-build never surfaces ───────────
test('hybrid: a seq retired AFTER the cache was built never surfaces (cache lookup-only)', async () => {
  const { dir, writer } = await fresh();
  await declare(writer, 'helder');
  await seedTopic(writer, 'pets');
  const a = await write(writer, 'pets', 'CURATED', 'apple the cat is orange');
  await write(writer, 'pets', 'CURATED', 'apple the dog is brown');
  let state = await interpret(writer);
  await buildEmbeddingCache({ logReader: writer, state, siloDir: dir, embedder: mock(), nowIso: 't' });

  // Retire one curated seq AFTER building; do NOT rebuild the cache.
  await retireBullet(writer, { slug: 'pets', seqs: [a.seq] });
  state = await interpret(writer);

  const r = await contextRetrievalHybrid({
    state, query: 'groceries', principal: 'helder', scope: 'curated',
    siloDir: dir, env: ENABLED, embedder: mock(),
  });
  assert.ok(!r.results.some((x) => x.seq === a.seq), 'retired seq excluded though its vector lingers in cache');
  // cache_status reflects drift (head moved + a vector now orphaned by retire).
  assert.equal(r.cache_status, 'partial');
});

// ── whole-path try/catch fallback (§4.8) ─────────────────────────────────────
test('hybrid: a throwing embedder degrades to lexical, never crashes the search', async () => {
  const ctx = await corpus([['list-notes', 'CURATED', 'groceries list milk eggs']]);
  const boom = { ...mock(), async embed() { throw new Error('model exploded'); } };
  const r = await search(ctx, 'groceries', { embedder: boom });
  assert.equal(r.semantic_status, 'degraded');
  // lexical still returns the match
  assert.ok(r.results.some((x) => x.slug === 'list-notes'));
});

// ── disabled off-path = lexical, as today (modulo #17) ───────────────────────
test('hybrid: gate off → lexical path, semantic_status=disabled', async () => {
  const ctx = await corpus([['list-notes', 'CURATED', 'groceries list milk eggs']]);
  const r = await contextRetrievalHybrid({
    state: ctx.state, query: 'groceries', principal: 'helder', siloDir: ctx.dir, env: {},
  });
  assert.equal(r.semantic_status, 'disabled');
  assert.ok(r.results.some((x) => x.slug === 'list-notes'));
});

// ── envelope contract + provenance + no-write marker ─────────────────────────
test('hybrid: envelope carries tier policy, statuses, provenance; result is write-rejected', async () => {
  const ctx = await corpus([['fruit-notes', 'CURATED', 'apple banana orange harvest']]);
  const r = await search(ctx, 'groceries');
  assert.deepEqual(r.authoritative_tiers, ['curated']);
  assert.deepEqual(r.advisory_tiers, ['note', 'source']);
  assert.deepEqual(r.must_not_write_from_tiers, ['note', 'source']);
  assert.ok(['disabled', 'ready', 'unavailable', 'degraded'].includes(r.semantic_status));
  assert.ok(['fresh', 'stale', 'partial', 'missing'].includes(r.cache_status));
  // provenance shape (§4.10)
  assert.equal(r.provenance.retriever, 'hybrid');
  assert.equal(r.provenance.retrieval_config.rrf_k, 60);
  assert.equal(r.provenance.retrieval_config.similarity_floor, 0.3);
  assert.equal(r.provenance.retrieval_config.bounded_prior_cap, 0);
  assert.ok(r.provenance.query_digest);
  assert.ok(Array.isArray(r.provenance.matched));
  // no-write choke-point: the envelope is stamped and refused as a write payload
  assert.ok(r[RETRIEVAL_ORIGIN_MARKER]);
  assert.throws(() => rejectRetrievalOrigin(r), /no-write invariant/);
  assert.throws(() => rejectRetrievalOrigin(JSON.stringify(r.results[0])), /no-write invariant/);
});

// ── duplicate text, one occurrence retired, one live → live still surfaces ───
test('hybrid: shared vector — retiring one occurrence leaves the live duplicate searchable', async () => {
  const { dir, writer } = await fresh();
  await declare(writer, 'helder');
  await seedTopic(writer, 'alpha');
  await seedTopic(writer, 'beta');
  const dup = 'apple identical curated line';
  const ra = await write(writer, 'alpha', 'CURATED', dup);
  await write(writer, 'beta', 'CURATED', dup);
  let state = await interpret(writer);
  await buildEmbeddingCache({ logReader: writer, state, siloDir: dir, embedder: mock(), nowIso: 't' });
  await retireBullet(writer, { slug: 'alpha', seqs: [ra.seq] });
  state = await interpret(writer);

  const r = await contextRetrievalHybrid({
    state, query: 'groceries', principal: 'helder', scope: 'curated',
    siloDir: dir, env: ENABLED, embedder: mock(),
  });
  assert.ok(!r.results.some((x) => x.slug === 'alpha'), 'retired occurrence gone');
  assert.ok(r.results.some((x) => x.slug === 'beta'), 'live duplicate still found via shared vector');
});
