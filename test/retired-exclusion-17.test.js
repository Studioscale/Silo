/**
 * #17 (hybrid-search §6 / §11) — retired CURATED bullets no longer surface in
 * keyword search. Shipped as its own documented change with its own test. This is
 * a behavior change for EVERY install (independent of the semantic feature):
 * retired = removed; it must not appear in exact_lookup OR context_retrieval, and
 * remains reachable only via the audit log / future history mode.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogWriter } from '../src/log/append.js';
import { interpret } from '../src/interpret/index.js';
import { retireBullet } from '../src/topic-proposal/retire-ops.js';
import { retrieve } from '../src/retrieval/index.js';
import { hasEmbedderSupport } from '../src/embedding/embedder.js';
import { contextRetrievalHybrid } from '../src/retrieval/index.js';
import { buildEmbeddingCache } from '../src/projection/embed-cache.js';
import { seedTopic } from './helpers/seed-topic.js';

async function fresh() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'silo-17-'));
  const writer = new LogWriter(dir);
  await writer.init();
  return { dir, writer };
}
async function writeCurated(writer, slug, content, i) {
  return writer.append({
    type: 'write_event', isStateBearing: true, intentId: `i:${slug}:${i}`,
    principal: 'helder', payload: { slug, tag: 'CURATED', content },
    ts: new Date(Date.parse('2026-04-01T10:00:00Z') + i * 1000).toISOString(),
  });
}

test('#17: retired bullet absent from context_retrieval AND exact_lookup; live one present', async () => {
  const { writer } = await fresh();
  await seedTopic(writer, 'recipes');
  const stale = await writeCurated(writer, 'recipes', 'use margarine in the cake batter', 0);
  await writeCurated(writer, 'recipes', 'use butter in the cake batter', 1);
  await retireBullet(writer, { slug: 'recipes', seqs: [stale.seq] });
  const state = await interpret(writer);

  const ctx = retrieve({ state, query: 'margarine cake', mode: 'context_retrieval', principal: 'helder' });
  assert.ok(!ctx.results.some((r) => r.seq === stale.seq), 'retired seq not in context results');
  assert.ok(!JSON.stringify(ctx.results).includes('margarine'), 'retired content not surfaced');

  const exact = retrieve({ state, query: 'recipes', mode: 'exact_lookup', principal: 'helder', flags: ['full_context'] });
  const content = exact.results[0]?.content ?? '';
  assert.ok(content.includes('butter'), 'live bullet present');
  assert.ok(!content.includes('margarine'), 'retired bullet excluded from exact_lookup content (#17)');
});

// ── Real-encoder integration (gated on hasEmbedderSupport(); skips offline) ───
test('integration: real encoder finds a paraphrase the lexical arm misses', async (t) => {
  if (!(await hasEmbedderSupport())) {
    t.skip('embedding native dep not installed (run after `silo semantic install`)');
    return;
  }
  const { dir, writer } = await fresh();
  await seedTopic(writer, 'auto');
  await writeCurated(writer, 'auto', 'the vehicle would not start this morning', 0);
  const state = await interpret(writer);
  const env = { SILO_SEMANTIC: 'on', SILO_SEMANTIC_MODEL: 'bge-small-en-v1.5' };
  await buildEmbeddingCache({ logReader: writer, state, siloDir: dir, env, nowIso: 't' });
  const r = await contextRetrievalHybrid({
    state, query: 'my car did not turn over', principal: 'helder', scope: 'curated', siloDir: dir, env,
  });
  assert.ok(r.results.some((x) => x.slug === 'auto'), 'paraphrase retrieved via semantic arm');
});
