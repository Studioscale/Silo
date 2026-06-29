import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogWriter } from '../src/log/append.js';
import { interpret } from '../src/interpret/index.js';
import { retireBullet } from '../src/topic-proposal/retire-ops.js';
import {
  buildEmbeddingCache, enumerateCorpusUnits, loadCacheFile, cachePath, vectorKey,
} from '../src/projection/embed-cache.js';
import { seedTopic } from './helpers/seed-topic.js';
import { makeMockEmbedder } from './helpers/mock-embedder.js';

async function freshSilo() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'silo-embcache-'));
  const writer = new LogWriter(dir);
  await writer.init();
  return { dir, writer };
}

async function write(writer, slug, tag, content, i = 0, extra = {}) {
  return writer.append({
    type: 'write_event',
    isStateBearing: true,
    intentId: `i:${slug}:${tag}:${i}:${Math.random()}`,
    principal: 'helder',
    payload: { slug, tag, content, ...extra },
    ts: new Date(Date.parse('2026-04-01T10:00:00Z') + i * 60_000).toISOString(),
  });
}

async function seedCorpus() {
  const { dir, writer } = await freshSilo();
  await seedTopic(writer, 'alpha');
  await seedTopic(writer, 'beta');
  // curated, note, source, plus a duplicate-text note (dedup), all on alpha
  await write(writer, 'alpha', 'CURATED', 'chose supplier X after careful review', 0);
  await write(writer, 'alpha', 'FACT', 'coating defect rate is 3.2 percent', 1);
  await write(writer, 'alpha', 'SOURCE', 'raw imported invoice blob text', 2);
  await write(writer, 'beta', 'FACT', 'coating defect rate is 3.2 percent', 3); // dup text → dedup
  const state = await interpret(writer);
  return { dir, writer, state };
}

test('embed-cache: enumerateCorpusUnits assigns per-chunk tiers from raw events', async () => {
  const { writer, state } = await seedCorpus();
  const units = await enumerateCorpusUnits({ logReader: writer, state });
  const byTier = (t) => units.filter((u) => u.tier === t);
  assert.equal(byTier('curated').length, 1);
  assert.equal(byTier('source').length, 1);
  assert.equal(byTier('note').length, 2); // two FACTs
  // curated on alpha, not rolled up
  assert.ok(units.some((u) => u.slug === 'alpha' && u.tier === 'curated'));
});

test('embed-cache: writes store+occurrences+split manifest; dedups identical text', async () => {
  const { dir, writer, state } = await seedCorpus();
  const emb = makeMockEmbedder();
  const summary = await buildEmbeddingCache({
    logReader: writer, state, siloDir: dir, embedder: emb, nowIso: '2026-04-01T12:00:00Z',
  });
  assert.equal(summary.skipped, false);
  assert.equal(summary.chunks, 4); // 4 occurrences
  assert.equal(summary.vectors, 3); // 2 FACTs share one vector (dedup)
  assert.deepEqual(summary.per_tier, { curated: 1, note: 2, source: 1 });

  const cache = await loadCacheFile(dir);
  assert.ok(cache.manifest.identity);
  assert.ok(cache.manifest.freshness);
  assert.equal(cache.manifest.freshness.created_at, '2026-04-01T12:00:00Z');
  assert.ok(cache.manifest.identity_digest);
  // identity fields present
  assert.equal(cache.manifest.identity.chunk_size, 256);
  assert.equal(cache.manifest.identity.chunker_version, 'fixed-window-v1');
  // dedup: the duplicate-text note vector_key appears in two occurrences
  const dupKey = vectorKey('coating defect rate is 3.2 percent');
  const occ = cache.occurrences.filter((o) => o.vector_key === dupKey);
  assert.equal(occ.length, 2);
  assert.ok(cache.vectors[dupKey]);
});

test('embed-cache: retired curated seq is excluded from occurrences', async () => {
  const { dir, writer } = await freshSilo();
  await seedTopic(writer, 'pets');
  const a = await write(writer, 'pets', 'CURATED', '- cat named mittens', 0);
  await write(writer, 'pets', 'CURATED', '- dog named rex', 1);
  await retireBullet(writer, { slug: 'pets', seqs: [a.seq] });
  const state = await interpret(writer);

  const emb = makeMockEmbedder();
  await buildEmbeddingCache({ logReader: writer, state, siloDir: dir, embedder: emb, nowIso: '2026-04-01T12:00:00Z' });
  const cache = await loadCacheFile(dir);
  assert.ok(!cache.occurrences.some((o) => o.seq === a.seq), 'retired seq must not appear');
  assert.equal(cache.occurrences.filter((o) => o.tier === 'curated').length, 1);
});

test('embed-cache: identity match → vectors reused, nothing re-embedded', async () => {
  const { dir, writer, state } = await seedCorpus();
  let embedCalls = 0;
  const base = makeMockEmbedder();
  const counting = {
    ...base,
    async embed(texts, kind) { embedCalls += Array.isArray(texts) ? texts.length : 1; return base.embed(texts, kind); },
  };
  const s1 = await buildEmbeddingCache({ logReader: writer, state, siloDir: dir, embedder: counting, nowIso: '2026-04-01T12:00:00Z' });
  assert.equal(s1.embedded_new, 3);
  const firstCalls = embedCalls;
  // Rebuild with same identity, same corpus → all reused.
  const s2 = await buildEmbeddingCache({ logReader: writer, state, siloDir: dir, embedder: counting, nowIso: '2026-04-01T13:00:00Z' });
  assert.equal(s2.embedded_new, 0);
  assert.equal(s2.reused, 3);
  assert.equal(embedCalls, firstCalls, 'no new embed calls on identity-matched rebuild');
});

test('embed-cache: identity mismatch (different model) rebuilds the whole store', async () => {
  const { dir, writer, state } = await seedCorpus();
  await buildEmbeddingCache({ logReader: writer, state, siloDir: dir, embedder: makeMockEmbedder(), nowIso: 't1' });
  // Different model_id → different identity_digest → no reuse.
  const other = makeMockEmbedder({ config: { model_id: 'mock/other', transformers_id: 'mock/other' } });
  const s2 = await buildEmbeddingCache({ logReader: writer, state, siloDir: dir, embedder: other, nowIso: 't2' });
  assert.equal(s2.embedded_new, 3, 'all re-embedded under new identity');
  const cache = await loadCacheFile(dir);
  assert.equal(cache.manifest.identity.model_id, 'mock/other');
});

test('embed-cache: disabled (no embedder, gate off) → skipped no-op, no file', async () => {
  const { dir, writer, state } = await seedCorpus();
  const summary = await buildEmbeddingCache({ logReader: writer, state, siloDir: dir, env: {} });
  assert.equal(summary.skipped, true);
  assert.equal(summary.reason, 'semantic_disabled');
  await assert.rejects(fs.access(cachePath(dir)));
});
