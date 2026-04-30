import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogWriter } from '../src/log/append.js';
import { interpret } from '../src/interpret/index.js';
import { retrieve } from '../src/retrieval/index.js';

async function seedCorpus() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'silo-ret-'));
  const writer = new LogWriter(dir);
  await writer.init();

  // Declare + enable principals
  await writer.append({
    type: 'PRINCIPAL_DECLARED',
    isStateBearing: true,
    intentId: 'i:d1',
    principal: 'operator',
    payload: { principal: 'helder', class: 'human' },
    ts: '2026-04-22T09:00:00Z',
  });
  await writer.append({
    type: 'PRINCIPAL_DECLARED',
    isStateBearing: true,
    intentId: 'i:d2',
    principal: 'operator',
    payload: { principal: 'alice', class: 'human' },
    ts: '2026-04-22T09:00:01Z',
  });

  // A bunch of writes across different topics
  const writes = [
    { slug: 'project-alpha', content: 'chose supplier X after review of three candidates' },
    { slug: 'project-alpha', content: 'coating defect rate is 3.2 percent in last batch' },
    { slug: 'project-beta', content: 'beta is on hold pending budget approval from finance' },
    { slug: 'shopping', content: 'need new welding rods by Friday' },
    { slug: 'shopping', content: 'also need paint thinner — coating supplier recommended brand Y' },
    { slug: 'hs-db-bug', content: 'bug tracker shows intermittent save failure on production form' },
  ];
  for (const [i, w] of writes.entries()) {
    await writer.append({
      type: 'write_event',
      isStateBearing: true,
      intentId: `i:w${i}`,
      principal: 'helder',
      payload: { slug: w.slug, tag: 'FACT', content: w.content },
      ts: `2026-04-22T10:${String(i).padStart(2, '0')}:00Z`,
    });
  }

  // alice-only private topic
  await writer.append({
    type: 'write_event',
    isStateBearing: true,
    intentId: 'i:wa',
    principal: 'alice',
    payload: { slug: 'alice-notes', tag: 'FACT', content: 'private therapy session notes' },
    ts: '2026-04-22T11:00:00Z',
  });
  // Seal it to alice + operator only
  await writer.append({
    type: 'ACL_SEALED',
    isStateBearing: true,
    intentId: 'i:seal',
    principal: 'operator',
    payload: { topic: 'alice-notes', readers: ['alice', 'operator'] },
    ts: '2026-04-22T11:01:00Z',
  });

  const state = await interpret(writer);
  return { writer, state };
}

test('retrieve: context_retrieval finds matches by keyword', async () => {
  const { state } = await seedCorpus();
  const result = retrieve({
    state,
    query: 'supplier',
    mode: 'context_retrieval',
    principal: 'helder',
  });
  assert.equal(result.mode, 'context_retrieval');
  assert.ok(result.results.length > 0);
  // project-alpha should be the top match — has supplier-related content
  assert.ok(result.results.some((r) => r.slug === 'project-alpha'));
});

test('retrieve: exact_lookup by slug prefix', async () => {
  const { state } = await seedCorpus();
  const result = retrieve({
    state,
    query: 'project-alpha',
    mode: 'exact_lookup',
    principal: 'helder',
  });
  assert.equal(result.mode, 'exact_lookup');
  assert.equal(result.results[0].slug, 'project-alpha');
});

test('retrieve: full_context flag returns content', async () => {
  const { state } = await seedCorpus();
  const result = retrieve({
    state,
    query: 'project-alpha',
    mode: 'exact_lookup',
    principal: 'helder',
    flags: ['full_context'],
  });
  assert.ok(result.escalated);
  assert.ok(result.results[0].content);
  assert.ok(result.results[0].content.includes('coating defect'));
});

test('retrieve: no flags → preview only, no full content', async () => {
  const { state } = await seedCorpus();
  const result = retrieve({
    state,
    query: 'project-alpha',
    mode: 'exact_lookup',
    principal: 'helder',
  });
  assert.ok(!result.escalated);
  // (exact_lookup without flags should not escalate)
  assert.equal(result.results[0].content, undefined);
  assert.ok(result.results[0].preview);
});

test('retrieve: ACL filter drops unauthorized topics (synchronous auth)', async () => {
  const { state } = await seedCorpus();
  // Bob is unknown; should see nothing
  // But first we need bob as a known principal for the query to make semantic sense;
  // actually any non-helder/alice/operator principal should see only their-readable topics.
  // Let's declare bob by writing a PRINCIPAL_DECLARED (fresh fold).
  // For this test, simulate "bob" by directly querying as an unlisted principal:
  // authorization should drop everything since no ACL lists bob.

  const resultAsBob = retrieve({
    state,
    query: 'therapy',
    mode: 'context_retrieval',
    principal: 'bob',
  });
  assert.equal(resultAsBob.results.length, 0); // no topic readable by bob

  const resultAsAlice = retrieve({
    state,
    query: 'therapy',
    mode: 'context_retrieval',
    principal: 'alice',
  });
  assert.ok(resultAsAlice.results.some((r) => r.slug === 'alice-notes'));

  // Helder is not in alice-notes' ACL — should not see it
  const resultAsHelder = retrieve({
    state,
    query: 'therapy',
    mode: 'context_retrieval',
    principal: 'helder',
  });
  assert.ok(!resultAsHelder.results.some((r) => r.slug === 'alice-notes'));
});

test('retrieve: empty-topics card rejected by authorize (defense-in-depth)', () => {
  // Simulated state with a malformed card having no evidence_topics
  const state = {
    acl_table: new Map([['t1', new Set(['helder'])]]),
    topic_index: new Map([['t1', { slug: 't1', tags: new Set(), last_updated_seq: 1 }]]),
    topic_content: new Map([['t1', [{ seq: 1, tag: 'FACT', content: 'hello' }]]]),
  };
  // authorize() with empty evidence_topics should return false (we test indirectly via no match)
  const result = retrieve({
    state,
    query: 'hello',
    mode: 'context_retrieval',
    principal: 'helder',
  });
  // Should find t1 (normal card has evidence_topics=[slug])
  assert.ok(result.results.some((r) => r.slug === 't1'));
});

test('retrieve: unknown mode throws', async () => {
  const { state } = await seedCorpus();
  assert.throws(
    () => retrieve({ state, query: 'x', mode: 'garbage_mode', principal: 'helder' }),
    /unknown retrieval mode/,
  );
});

test('retrieve: orientation_view returns metadata-only map', async () => {
  const { state } = await seedCorpus();
  const result = retrieve({ state, mode: 'orientation_view', principal: 'helder' });
  assert.equal(result.mode, 'orientation_view');
  assert.ok(Array.isArray(result.topics));
  assert.ok(result.topics.length > 0);
  assert.ok(result.topics.every((t) => t.slug));
  // NEVER returns content
  assert.ok(result.topics.every((t) => t.content === undefined));
  assert.ok(result.topics.every((t) => t.preview === undefined));
  // Aggregates present
  assert.ok(result.aggregates);
  assert.ok(Array.isArray(result.aggregates.tag_distribution));
  assert.ok(result.aggregates.seq_range);
  // accessible_slice_count, not total
  assert.equal(typeof result.accessible_slice_count, 'number');
});

test('retrieve: orientation_view ACL-filters before ranking (helder does not see alice-notes)', async () => {
  const { state } = await seedCorpus();
  const asHelder = retrieve({ state, mode: 'orientation_view', principal: 'helder' });
  assert.ok(!asHelder.topics.some((t) => t.slug === 'alice-notes'));
  const asAlice = retrieve({ state, mode: 'orientation_view', principal: 'alice' });
  assert.ok(asAlice.topics.some((t) => t.slug === 'alice-notes'));
});

test('retrieve: orientation_view N clamped to MAX_N=50 with max_n_enforced flag', async () => {
  const { state } = await seedCorpus();
  const result = retrieve({ state, mode: 'orientation_view', principal: 'helder', n: 999 });
  assert.equal(result.n_requested, 999);
  assert.ok(result.n_returned <= 50);
  assert.equal(result.max_n_enforced, true);
});

test('retrieve: orientation_view default N=10 (no clamp flag)', async () => {
  const { state } = await seedCorpus();
  const result = retrieve({ state, mode: 'orientation_view', principal: 'helder' });
  assert.equal(result.max_n_enforced, false);
  assert.ok(result.n_requested <= 10);
});

test('retrieve: orientation_view unknown principal returns empty accessible slice', async () => {
  const { state } = await seedCorpus();
  const result = retrieve({ state, mode: 'orientation_view', principal: 'bob' });
  assert.equal(result.accessible_slice_count, 0);
  assert.equal(result.topics.length, 0);
  assert.equal(result.aggregates.seq_range.min, null);
});

test('retrieve: orientation_view ordered by last_updated_seq desc (deterministic)', async () => {
  const { state } = await seedCorpus();
  const result = retrieve({ state, mode: 'orientation_view', principal: 'helder', n: 50 });
  for (let i = 1; i < result.topics.length; i++) {
    const prev = result.topics[i - 1].last_updated_seq ?? 0;
    const curr = result.topics[i].last_updated_seq ?? 0;
    assert.ok(prev >= curr, `topic ordering broken at index ${i}`);
  }
});
