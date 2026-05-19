/**
 * Tests for silo-mcp/context-pack.js — the Stage 2 universal-client
 * context-pack surface.
 *
 * The module shells out to `silo search --mode=context` for ranking, so
 * rankTopicsByBM25 is unit-tested via an injected spawnFn stub. The
 * envelope builder + confidence mapper are pure data and tested directly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  rankTopicsByBM25,
  mapConfidence,
  buildRecommendedNextCalls,
  buildContextPackEnvelope,
} from '../silo-mcp/context-pack.js';

// ── rankTopicsByBM25 ───────────────────────────────────────────────────────

test('rankTopicsByBM25: missing task → TASK_REQUIRED error', () => {
  const r = rankTopicsByBM25({ task: '', maxTopics: 3, siloDir: '/x', siloCli: '/y' });
  assert.ok(r.error);
  assert.equal(r.error.code, 'TASK_REQUIRED');
});

test('rankTopicsByBM25: passes argv correctly to spawn', () => {
  const calls = [];
  const spawnFn = (cmd, args) => {
    calls.push({ cmd, args });
    return { status: 0, stdout: JSON.stringify({ results: [] }) };
  };
  rankTopicsByBM25({
    task: 'pipedrive crm migration',
    maxTopics: 5,
    siloDir: '/silo-data',
    siloCli: '/silo-src/cli.js',
    spawnFn,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'node');
  assert.deepEqual(calls[0].args, [
    '/silo-src/cli.js', 'search', 'pipedrive crm migration',
    '--mode=context',
    '--limit=5',
    '--silo-dir=/silo-data',
  ]);
});

test('rankTopicsByBM25: success → returns parsed results array', () => {
  const stub = () => ({
    status: 0,
    stdout: JSON.stringify({
      mode: 'context_retrieval',
      results: [
        { slug: 'hs-crm', score: 5.1, preview: '...' },
        { slug: 'pipedrive', score: 2.3, preview: '...' },
      ],
    }),
  });
  const r = rankTopicsByBM25({
    task: 'crm pipedrive', maxTopics: 3, siloDir: '/x', siloCli: '/y',
    spawnFn: stub,
  });
  assert.equal(r.results.length, 2);
  assert.equal(r.results[0].slug, 'hs-crm');
});

test('rankTopicsByBM25: timeout → SEARCH_TIMEOUT', () => {
  const stub = () => ({ error: { code: 'ETIMEDOUT' } });
  const r = rankTopicsByBM25({
    task: 'x', maxTopics: 3, siloDir: '/x', siloCli: '/y', spawnFn: stub,
  });
  assert.equal(r.error.code, 'SEARCH_TIMEOUT');
});

test('rankTopicsByBM25: SIGTERM (timeout via signal) → SEARCH_TIMEOUT', () => {
  const stub = () => ({ signal: 'SIGTERM' });
  const r = rankTopicsByBM25({
    task: 'x', maxTopics: 3, siloDir: '/x', siloCli: '/y', spawnFn: stub,
  });
  assert.equal(r.error.code, 'SEARCH_TIMEOUT');
});

test('rankTopicsByBM25: non-zero status → SEARCH_FAILED', () => {
  const stub = () => ({ status: 2, stderr: 'silo search: bad arg' });
  const r = rankTopicsByBM25({
    task: 'x', maxTopics: 3, siloDir: '/x', siloCli: '/y', spawnFn: stub,
  });
  assert.equal(r.error.code, 'SEARCH_FAILED');
  assert.match(r.error.message, /bad arg/);
});

test('rankTopicsByBM25: non-JSON stdout → SEARCH_PARSE_FAILED', () => {
  const stub = () => ({ status: 0, stdout: 'not json' });
  const r = rankTopicsByBM25({
    task: 'x', maxTopics: 3, siloDir: '/x', siloCli: '/y', spawnFn: stub,
  });
  assert.equal(r.error.code, 'SEARCH_PARSE_FAILED');
});

test('rankTopicsByBM25: results field missing → empty array (not error)', () => {
  const stub = () => ({ status: 0, stdout: JSON.stringify({ mode: 'context_retrieval' }) });
  const r = rankTopicsByBM25({
    task: 'x', maxTopics: 3, siloDir: '/x', siloCli: '/y', spawnFn: stub,
  });
  assert.deepEqual(r.results, []);
});

// ── mapConfidence ──────────────────────────────────────────────────────────

test('mapConfidence: ≥ 4 → high', () => {
  assert.equal(mapConfidence(4), 'high');
  assert.equal(mapConfidence(7.2), 'high');
});

test('mapConfidence: ≥ 1.5 < 4 → medium', () => {
  assert.equal(mapConfidence(1.5), 'medium');
  assert.equal(mapConfidence(3.99), 'medium');
});

test('mapConfidence: < 1.5 → low', () => {
  assert.equal(mapConfidence(1.49), 'low');
  assert.equal(mapConfidence(0), 'low');
});

test('mapConfidence: null/undefined/NaN → low (defensive)', () => {
  assert.equal(mapConfidence(null), 'low');
  assert.equal(mapConfidence(undefined), 'low');
  assert.equal(mapConfidence(NaN), 'low');
});

// ── buildRecommendedNextCalls ──────────────────────────────────────────────

test('buildRecommendedNextCalls: low confidence → leads with search', () => {
  const calls = buildRecommendedNextCalls({
    confidence: 'low',
    selectedTopics: [],
    task: 'fix the crm bug',
  });
  assert.ok(calls.length >= 1);
  assert.match(calls[0], /^search/);
  assert.match(calls[0], /fix the crm bug/);
});

test('buildRecommendedNextCalls: high confidence → fetch per topic', () => {
  const calls = buildRecommendedNextCalls({
    confidence: 'high',
    selectedTopics: [{ slug: 'hs-crm' }, { slug: 'pipedrive' }],
    task: 'crm migration',
  });
  assert.equal(calls.length, 2);
  assert.match(calls[0], /fetch.*topic:hs-crm/);
  assert.match(calls[1], /fetch.*topic:pipedrive/);
});

test('buildRecommendedNextCalls: medium confidence → fetch + search fallback', () => {
  const calls = buildRecommendedNextCalls({
    confidence: 'medium',
    selectedTopics: [{ slug: 'hs-crm' }],
    task: 'crm migration',
  });
  assert.equal(calls.length, 2);
  assert.match(calls[0], /fetch.*topic:hs-crm/);
  assert.match(calls[1], /^search/);
});

test('buildRecommendedNextCalls: empty selection forces low-confidence path', () => {
  const calls = buildRecommendedNextCalls({
    confidence: 'high', // contradiction — should still fall to search
    selectedTopics: [],
    task: 'whatever',
  });
  assert.match(calls[0], /^search/);
});

// ── buildContextPackEnvelope ───────────────────────────────────────────────

test('buildContextPackEnvelope: composes selected_topics from ranked + details', () => {
  const ranked = [
    { slug: 'hs-crm', score: 5.5, preview: 'crm preview' },
    { slug: 'pipedrive', score: 2.0, preview: 'pipedrive preview' },
  ];
  const detailsBySlug = new Map([
    ['hs-crm', { title: 'HS CRM system', layer2: 'Pipedrive at hs.pipedrive.com; admin is Helder.' }],
    ['pipedrive', { title: 'Pipedrive integration', layer2: 'Use pipeline named "Vendas Diretas".' }],
  ]);
  const env = buildContextPackEnvelope({ task: 'crm migration', ranked, detailsBySlug });
  assert.equal(env.task, 'crm migration');
  assert.equal(env.selected_topics.length, 2);
  assert.equal(env.selected_topics[0].slug, 'hs-crm');
  assert.equal(env.selected_topics[0].title, 'HS CRM system');
  assert.match(env.selected_topics[0].why_selected, /BM25 score 5\.50/);
  assert.equal(env.selected_topics[0].metadata.source_type, 'topic');
  assert.equal(env.selected_topics[0].metadata.layer, 2);
  assert.equal(env.confidence, 'high'); // best score 5.5 ≥ 4
});

test('buildContextPackEnvelope: skips slugs missing from detailsBySlug (regen race)', () => {
  const ranked = [
    { slug: 'present', score: 3.0 },
    { slug: 'missing', score: 2.5 },
  ];
  const detailsBySlug = new Map([
    ['present', { title: 't', layer2: 'l2' }],
  ]);
  const env = buildContextPackEnvelope({ task: 'x', ranked, detailsBySlug });
  assert.equal(env.selected_topics.length, 1);
  assert.equal(env.selected_topics[0].slug, 'present');
});

test('buildContextPackEnvelope: truncates Layer 2 to ~1500 chars with ellipsis', () => {
  const long = 'a'.repeat(2000);
  const env = buildContextPackEnvelope({
    task: 'x',
    ranked: [{ slug: 's', score: 3 }],
    detailsBySlug: new Map([['s', { title: 'S', layer2: long }]]),
  });
  const excerpt = env.selected_topics[0].curated_facts_excerpt;
  assert.ok(excerpt.length <= 1502); // 1500 + ellipsis char
  assert.ok(excerpt.endsWith('…'));
});

test('buildContextPackEnvelope: empty layer 2 → falls back to preview', () => {
  const env = buildContextPackEnvelope({
    task: 'x',
    ranked: [{ slug: 's', score: 3, preview: 'fallback preview' }],
    detailsBySlug: new Map([['s', { title: 'S', layer2: '' }]]),
  });
  assert.equal(env.selected_topics[0].curated_facts_excerpt, 'fallback preview');
});

test('buildContextPackEnvelope: no ranked results → confidence low + search recommendation', () => {
  const env = buildContextPackEnvelope({
    task: 'unknown task',
    ranked: [],
    detailsBySlug: new Map(),
  });
  assert.equal(env.selected_topics.length, 0);
  assert.equal(env.confidence, 'low');
  assert.match(env.recommended_next_tool_calls[0], /^search/);
});

test('buildContextPackEnvelope: medium-confidence boundary (best score = 1.5)', () => {
  const env = buildContextPackEnvelope({
    task: 't',
    ranked: [{ slug: 's', score: 1.5 }],
    detailsBySlug: new Map([['s', { title: 'S', layer2: 'content' }]]),
  });
  assert.equal(env.confidence, 'medium');
});

test('buildContextPackEnvelope: low-confidence boundary (best score = 1.49)', () => {
  const env = buildContextPackEnvelope({
    task: 't',
    ranked: [{ slug: 's', score: 1.49 }],
    detailsBySlug: new Map([['s', { title: 'S', layer2: 'content' }]]),
  });
  assert.equal(env.confidence, 'low');
  // Even when there IS a selected topic, low confidence forces the
  // search-first recommendation per spec.
  assert.match(env.recommended_next_tool_calls[0], /^search/);
});
